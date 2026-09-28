import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { makeKeys, signBundle, tmpDir, write } from "../../core/test/helpers.ts";
import { usesExpectedApis } from "../src/evals/adoption.ts";
import { claudeCodeDriver, allowedTools, cliUse } from "../src/evals/drivers/claude-code.ts";
import { checkBridge, vsixName } from "../src/evals/drivers/clients.ts";
import { runHarness, type ModelClient } from "../src/evals/drivers/harness.ts";
import { commandAllowed, Pacer } from "../src/evals/drivers/types.ts";
import { evaluateGate } from "../src/evals/gate.ts";
import type { EvalProfile } from "../src/evals/profile.ts";
import { readRuns, type RunRecord, type TrialRecord } from "../src/evals/records.ts";
import { allowedCommandsFor } from "../src/evals/runner.ts";
import { fakeState, PACK_ID, producerRepo, resetFake, toolkit } from "./fixture.ts";

const profile: EvalProfile = { required: ["claude-sonnet"], gate: { confidence: 0.95, minTrials: 20, resolveThreshold: 0.8 }, models: { "claude-sonnet": { model: "claude-sonnet-5", routes: [{ driver: "claude-code", local: true }] } } };
const DIGEST = "sha256:candidate";

function trials(condition: TrialRecord["condition"], n: number, passed: number, opts: { api?: number; env?: "local" | "pipeline"; model?: string } = {}): TrialRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${condition}-${i}`,
    task: "t",
    taskDigest: "x",
    startDigest: "y",
    model: opts.model ?? "claude-sonnet",
    modelId: "claude-sonnet-5",
    condition,
    packDigest: condition === "candidate" ? DIGEST : null,
    environment: opts.env ?? "local",
    driver: "claude-code",
    route: "claude-code:local",
    toolVersion: "2.1",
    status: "completed",
    passed: i < passed,
    graders: [],
    api: opts.api === undefined ? null : i < opts.api,
    retried: false,
    durationMs: 1,
  }));
}

function run(id: string, env: "local" | "pipeline", ts: TrialRecord[]): RunRecord {
  return { schemaVersion: 1, kind: "eval-run", id, createdAt: `2026-10-0${id}T00:00:00Z`, environment: env, pack: { id: PACK_ID, version: "1.0.0", candidateDigest: DIGEST }, trials: ts.map((t) => ({ ...t, environment: env })) };
}

describe("publish gate", () => {
  it("fails when the candidate lowers the pass rate, naming the model and both rates", () => {
    const gate = evaluateGate([run("1", "local", [...trials("candidate", 20, 10), ...trials("without", 20, 17)])], DIGEST, profile, undefined, "2026-10-10");
    assert.equal(gate.ok, false);
    assert.match(gate.decisions[0]!.reasons[0]!, /claude-sonnet: the pass rate is lower with the candidate, 50% \(10\/20\), than without the pack, 85% \(17\/20\)/);
  });

  it("fails when the candidate lowers API adoption, naming both adoption rates", () => {
    const gate = evaluateGate([run("1", "local", [...trials("candidate", 20, 18, { api: 6 }), ...trials("without", 20, 18, { api: 15 })])], DIGEST, profile, undefined, "2026-10-10");
    assert.equal(gate.ok, false);
    assert.match(gate.decisions[0]!.reasons.join(" "), /API adoption is lower with the candidate, 30% \(6\/20\), than without the pack, 75% \(15\/20\)/);
  });

  it("passes a difference within noise", () => {
    const gate = evaluateGate([run("1", "local", [...trials("candidate", 20, 15), ...trials("without", 20, 16)])], DIGEST, profile, undefined, "2026-10-10");
    assert.equal(gate.ok, true);
  });

  it("fails with too few trials and states how many are needed", () => {
    const gate = evaluateGate([run("1", "local", [...trials("candidate", 10, 9), ...trials("without", 10, 5)])], DIGEST, profile, undefined, "2026-10-10");
    assert.equal(gate.ok, false);
    assert.match(gate.decisions[0]!.reasons[0]!, /has 10 trials per condition .* the profile requires 20/);
  });

  it("passes on a local Claude Code run with enough trials", () => {
    const gate = evaluateGate([run("1", "local", [...trials("candidate", 20, 18, { api: 17 }), ...trials("without", 20, 12, { api: 7 })])], DIGEST, profile, undefined, "2026-10-10");
    assert.equal(gate.ok, true);
    assert.equal(gate.summary["claude-sonnet"]!.ranIn, "local, claude-code with the developer's sign-in");
    assert.deepEqual(gate.summary["claude-sonnet"]!.pass, { without: 0.6, with: 0.9 });
    assert.deepEqual(gate.summary["claude-sonnet"]!.api, { without: 0.35, with: 0.85 });
  });

  it("uses a later pipeline run over an earlier local run, and names its environment", () => {
    const runs = [run("1", "local", [...trials("candidate", 20, 10), ...trials("without", 20, 17)]), run("2", "pipeline", [...trials("candidate", 20, 18), ...trials("without", 20, 12)])];
    const gate = evaluateGate(runs, DIGEST, profile, undefined, "2026-10-10");
    assert.equal(gate.ok, true);
    assert.equal(gate.decisions[0]!.environment, "pipeline");
    assert.equal(gate.decisions[0]!.run, "2");
  });

  it("accepts a recorded override until it expires, and records it", () => {
    const runs = [run("1", "local", [...trials("candidate", 20, 10), ...trials("without", 20, 17)])];
    const config = { models: [], runs: 5, tasks: [], overrides: [{ model: "claude-sonnet", reason: "Grader bug #12", approvedBy: "runtime-lead", expires: "2026-12-31" }] };
    const active = evaluateGate(runs, DIGEST, profile, config, "2026-10-10");
    assert.equal(active.ok, true);
    assert.deepEqual(active.overrides, [{ model: "claude-sonnet", reason: "Grader bug #12", approvedBy: "runtime-lead", expires: "2026-12-31" }]);
    assert.equal(evaluateGate(runs, DIGEST, profile, config, "2027-01-01").ok, false);
  });

  it("evaluates a required model the pack's configuration doesn't list", () => {
    const gate = evaluateGate([], DIGEST, profile, { models: ["other"], runs: 5, tasks: [] }, "2026-10-10");
    assert.ok(gate.decisions.some((d) => d.alias === "claude-sonnet" && d.status === "fail"));
  });
});

describe("drivers", () => {
  it("allows the task's build and check commands and refuses everything else", () => {
    const allowed = allowedCommandsFor({ id: "t", prompt: "p", start: "s", build: "npm run build", exercises: [], graders: [{ type: "check" }] });
    assert.ok(commandAllowed("npx de-web-sdk check", allowed));
    assert.ok(commandAllowed("npx de-web-sdk resolve src/a.tsx", allowed));
    assert.ok(commandAllowed("npm run build", allowed));
    assert.ok(!commandAllowed("npm run build && curl evil", allowed));
    assert.ok(!commandAllowed("rm -rf /", allowed));
    assert.ok(!commandAllowed("npm install left-pad", allowed));
    assert.deepEqual(allowedTools(["npm run build", "npx de-web-sdk check *"]).slice(-2), ["Bash(npm run build)", "Bash(npx de-web-sdk check:*)"]);
  });

  it("allows a task's pack commands in the form agents see them", () => {
    const allowed = allowedCommandsFor({ id: "t", prompt: "p", start: "s", commands: ["analytics-events search *"], exercises: [], graders: [{ type: "check" }] });
    assert.ok(commandAllowed("analytics-events search plan", allowed));
    assert.ok(commandAllowed("npx --no analytics-events search plan", allowed));
    assert.ok(!commandAllowed("npx analytics-events search plan", allowed));
  });

  it("refuses an unlisted command in the reference harness, and the trial continues", async () => {
    const worktree = tmpDir();
    write(worktree, "AGENTS.md", "Run check before finishing.\n");
    const cache = tmpDir();
    let step = 0;
    const seen: string[] = [];
    const client: ModelClient = {
      async chat(messages) {
        const last = messages.at(-1)!;
        if (last.role === "tool") seen.push(last.content ?? "");
        step += 1;
        if (step === 1) return { message: { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "run_command", arguments: JSON.stringify({ command: "curl https://evil.example.com" }) } }] }, model: "gpt-x" };
        if (step === 2) return { message: { role: "assistant", content: null, tool_calls: [{ id: "2", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "src/a.ts", content: "export const a = 1;\n" }) } }] } };
        if (step === 3) return { message: { role: "assistant", content: null, tool_calls: [{ id: "3", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "../../etc/passwd" }) } }] } };
        return { message: { role: "assistant", content: null, tool_calls: [{ id: "4", type: "function", function: { name: "finish", arguments: "{}" } }] } };
      },
    };
    const outcome = await runHarness({ worktree, prompt: "Do it", modelId: "gpt-x", route: { driver: "reference-harness" }, allowedCommands: ["npx de-web-sdk check *"], timeoutMs: 10_000, cacheDir: cache, env: process.env, pacer: new Pacer() }, client);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.reportedModel, "gpt-x");
    assert.match(seen[0]!, /isn't allowed in this trial\. Allowed: npx de-web-sdk check \*/);
    assert.match(seen[2]!, /no such file in the repository/);
    assert.equal(readFileSync(path.join(worktree, "src/a.ts"), "utf8"), "export const a = 1;\n");
    const system = JSON.parse(readFileSync(path.join(cache, "transcript.json"), "utf8"))[0].content;
    assert.match(system, /# AGENTS\.md\n\nRun check before finishing\./);
    assert.doesNotMatch(system, /de-web-sdk check \*/, "the prompt doesn't name the SDK's commands; only the repo's files do");
  });

  it("attaches Copilot's path-scoped instructions when the harness touches a matching file", async () => {
    const worktree = tmpDir();
    write(worktree, ".github/instructions/de-web-sdk-1.instructions.md", '---\napplyTo: "src/remotes/**"\n---\nRemote rule text.\n');
    write(worktree, "src/remotes/cart.tsx", "x\n");
    write(worktree, "src/app.tsx", "y\n");
    const replies: string[] = [];
    let step = 0;
    const calls = [
      { name: "read_file", arguments: JSON.stringify({ path: "src/app.tsx" }) },
      { name: "read_file", arguments: JSON.stringify({ path: "src/remotes/cart.tsx" }) },
      { name: "finish", arguments: "{}" },
    ];
    const client: ModelClient = {
      async chat(messages) {
        const last = messages.at(-1)!;
        if (last.role === "tool") replies.push(last.content ?? "");
        const call = calls[step++]!;
        return { message: { role: "assistant", content: null, tool_calls: [{ id: String(step), type: "function", function: call }] } };
      },
    };
    await runHarness({ worktree, prompt: "p", modelId: "m", route: { driver: "reference-harness" }, allowedCommands: [], timeoutMs: 10_000, cacheDir: tmpDir(), env: process.env, pacer: new Pacer() }, client);
    assert.ok(!replies[0]!.includes("Remote rule text"));
    assert.match(replies[1]!, /Instructions from \.github\/instructions\/de-web-sdk-1\.instructions\.md[\s\S]*Remote rule text/);
  });

  it("starts a fresh headless Claude Code session with the model, dontAsk permissions, and the allowed commands", async () => {
    const bin = tmpDir();
    const log = path.join(bin, "args.json");
    write(bin, "claude", `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("2.1.186 (Claude Code)"); process.exit(0); }
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5-20260901" }));
console.log(JSON.stringify({ type: "assistant", message: { content: [] } }));
fs.writeFileSync("done.txt", "ok");
console.log(JSON.stringify({ type: "result", subtype: "success" }));
`);
    chmodSync(path.join(bin, "claude"), 0o755);
    const env = { ...process.env, DE_WEB_SDK_CLAUDE_BIN: path.join(bin, "claude") };
    assert.deepEqual(await claudeCodeDriver.available({ driver: "claude-code", local: true }, env), { ok: true });
    assert.equal(await claudeCodeDriver.version({ driver: "claude-code", local: true }, env), "2.1.186");
    const worktree = tmpDir();
    const outcome = await claudeCodeDriver.run({ worktree, prompt: "Do the task", modelId: "claude-sonnet-5", route: { driver: "claude-code", local: true }, allowedCommands: ["npm run build", "npx de-web-sdk check *"], timeoutMs: 20_000, cacheDir: tmpDir(), env, pacer: new Pacer() });
    assert.deepEqual(outcome, { status: "completed", acted: true, reportedModel: "claude-sonnet-5-20260901", sdkUse: {} });
    const { args, cwd } = JSON.parse(readFileSync(log, "utf8"));
    assert.equal(cwd, worktree);
    assert.deepEqual(args.slice(0, 4), ["-p", "Do the task", "--model", "claude-sonnet-5"]);
    assert.ok(args.includes("dontAsk"));
    assert.ok(args.includes("Bash(npx de-web-sdk check:*)"));
    assert.ok(existsSync(path.join(worktree, "done.txt")));
  });

  it("names the VSIX to install when the VS Code extension's version doesn't match", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: "0.0.9", protocol: 1, models: [] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const file = path.join(tmpDir(), "bridge.json");
    write(path.dirname(file), "bridge.json", { port, token: "t", version: "0.0.9", protocol: 1 });
    const result = await checkBridge({ DE_WEB_SDK_VSCODE_BRIDGE: file }, "0.1.0");
    server.close();
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.reason.includes(`code --install-extension ${vsixName("0.1.0")}`));
    const missing = await checkBridge({ DE_WEB_SDK_VSCODE_BRIDGE: path.join(tmpDir(), "none.json") }, "0.1.0");
    assert.ok(!missing.ok && /Start the eval bridge/.test(missing.reason));
  });
});

describe("drivers reach the SDK's MCP server", () => {
  it("lets the reference harness call the SDK's tools, never the one that sends feedback, and counts each use", async () => {
    const { sync } = await import("@de-web-sdk/core");
    const { scenario } = await import("../../core/test/scenario.ts");
    const s = await scenario();
    await sync({ root: s.root, rootKeys: [], network: false });
    const { mkdirSync, symlinkSync } = await import("node:fs");
    mkdirSync(path.join(s.root, "node_modules/@de-web-sdk"), { recursive: true });
    symlinkSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../cli"), path.join(s.root, "node_modules/@de-web-sdk/cli"));
    const offered: string[] = [];
    const replies: string[] = [];
    let step = 0;
    const calls = [
      { name: "mcp__de-web-sdk__resolve", arguments: JSON.stringify({ files: ["src/app.tsx"] }) },
      { name: "mcp__de-web-sdk__check", arguments: "{}" },
      { name: "finish", arguments: "{}" },
    ];
    const client: ModelClient = {
      async chat(messages, tools) {
        if (!offered.length) offered.push(...tools.map((t) => t.function.name));
        const last = messages.at(-1)!;
        if (last.role === "tool") replies.push(last.content ?? "");
        const call = calls[step++]!;
        return { message: { role: "assistant", content: null, tool_calls: [{ id: String(step), type: "function", function: call }] } };
      },
    };
    const outcome = await runHarness({ worktree: s.root, prompt: "p", modelId: "m", route: { driver: "reference-harness" }, allowedCommands: [], timeoutMs: 30_000, cacheDir: tmpDir(), env: process.env, pacer: new Pacer() }, client);
    assert.equal(outcome.status, "completed");
    assert.ok(offered.includes("mcp__de-web-sdk__check") && offered.includes("mcp__de-web-sdk__get_skill"));
    assert.ok(!offered.includes("mcp__de-web-sdk__submit_feedback"));
    assert.match(replies[0]!, /react-singleton/);
    assert.match(replies[1]!, /1 new violation/);
    assert.deepEqual(outcome.sdkUse, { "mcp:resolve": 1, "mcp:check": 1 });
  });

  it("gives Claude Code only the trial's MCP server and its read-only SDK tools", () => {
    const tools = allowedTools(["npm run build"], true);
    assert.ok(tools.includes("mcp__de-web-sdk__check") && tools.includes("mcp__de-web-sdk__get_skill"));
    assert.ok(!tools.includes("mcp__de-web-sdk__submit_feedback"));
    assert.equal(cliUse("npx --no de-web-sdk check src/a.ts"), "cli:check");
    assert.equal(cliUse("npm test"), undefined);
  });
});

describe("API adoption", () => {
  const expects = [{ package: "@salt-ds/core", export: "Dialog" }];
  it("counts a trial that builds its own dialog against adoption", () => {
    assert.equal(usesExpectedApis(expects, [{ path: "src/confirm.tsx", text: "export function Modal() { return <div role=\"dialog\" />; }\n" }]), false);
  });
  it("counts named, subpath, and namespace imports", () => {
    assert.equal(usesExpectedApis(expects, [{ path: "a.tsx", text: 'import { Button, Dialog as D } from "@salt-ds/core";' }]), true);
    assert.equal(usesExpectedApis(expects, [{ path: "a.tsx", text: 'import * as Salt from "@salt-ds/core";\nconst x = <Salt.Dialog />;' }]), true);
    assert.equal(usesExpectedApis(expects, [{ path: "a.ts", text: 'const { Dialog } = require("@salt-ds/core");' }]), true);
    assert.equal(usesExpectedApis(expects, [{ path: "notes.md", text: 'import { Dialog } from "@salt-ds/core";' }]), false);
  });
  it("has no adoption rate for tasks without expected APIs", () => {
    assert.equal(usesExpectedApis(undefined, []), null);
  });
});

describe("eval runs end to end, with a team's own driver", () => {
  beforeEach(() => resetFake());

  it("asks before spending the developer's quota, and names --yes without a terminal", async () => {
    const { dir, profile } = producerRepo();
    const noTty = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none"]);
    assert.equal(noTty.code, 2);
    assert.match(noTty.stderr, /starts 4 trials on your own access and quota \(fake-model via .*: 4\).*--yes/s);
    let asked = "";
    const declined = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none"], {}, { interactive: true, ask: async (q) => ((asked = q), "n") });
    assert.equal(declined.code, 2);
    assert.match(asked, /starts 4 trials/);
    assert.equal(fakeState().calls.length, 0);
  });

  it("runs paired trials, grades them with check, records where they ran, and passes the gate for a helpful pack", async () => {
    const { dir, profile } = producerRepo();
    const out = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"]);
    assert.equal(out.code, 0, out.stderr);
    assert.deepEqual(fakeState().calls.map((c) => c.withPack), [false, false, true, true]);
    const [run] = readRuns(dir);
    assert.equal(run!.trials.length, 4);
    const cand = run!.trials.filter((t) => t.condition === "candidate");
    const without = run!.trials.filter((t) => t.condition === "without");
    assert.ok(cand.every((t) => t.passed && t.api === true && t.reportedModel === "fake-1-reported" && t.environment === "local"));
    assert.ok(without.every((t) => !t.passed && t.api === false));
    assert.match(out.stdout, /candidate +100% \(2\/2\) +100% \(2\/2\)/);
    assert.match(out.stdout, /Gate: passes/);
    assert.ok(readFileSync(path.join(dir, "evals/.gitignore"), "utf8").includes(".cache/"));
    const cacheRuns = readdirSync(path.join(dir, "evals/.cache"));
    assert.ok(existsSync(path.join(dir, "evals/.cache", cacheRuns[0]!, "1", "diff.patch")));

    const built = await toolkit(dir, ["build", "--profile", profile, "--no-tarball"]);
    assert.equal(built.code, 0, built.stdout + built.stderr);
    const manifest = JSON.parse(readFileSync(path.join(dir, "pack.json"), "utf8"));
    assert.deepEqual(manifest.evals.summary["fake-model"].pass, { without: 0, with: 1 });
    assert.deepEqual(manifest.evals.summary["fake-model"].api, { without: 0, with: 1 });
    assert.match(manifest.evals.summary["fake-model"].ranIn, /^local, fake/);
    const again = await toolkit(dir, ["build", "--profile", profile, "--no-tarball"]);
    assert.equal(again.code, 0);
    assert.equal(readFileSync(path.join(dir, "pack.json"), "utf8"), JSON.stringify(manifest, null, 2) + "\n");
  });

  it("refuses to build a pack that makes agents worse", async () => {
    const { dir, profile } = producerRepo({ minTrials: 6, runs: 6 });
    const out = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"], { FAKE_MODE: "harmful" });
    assert.equal(out.code, 0, out.stderr);
    const built = await toolkit(dir, ["build", "--profile", profile, "--no-tarball"]);
    assert.equal(built.code, 1);
    assert.match(built.stdout, /fake-model: the pass rate is lower with the candidate, 0% \(0\/6\), than without the pack, 100% \(6\/6\)/);
  });

  it("reuses no-pack results for a second candidate and runs only the candidate condition", async () => {
    const { dir, profile } = producerRepo();
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"]);
    resetFake();
    write(dir, "guidance/use-dialog.md", "Import Dialog from @example/ui. It traps focus.\n");
    const second = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"]);
    assert.equal(second.code, 0, second.stderr);
    assert.deepEqual(fakeState().calls.map((c) => c.withPack), [true, true]);
    const runs = readRuns(dir);
    assert.equal(runs.length, 2);
    assert.equal(runs[1]!.trials.filter((t) => t.reusedFrom === runs[0]!.id).length, 2);
  });

  it("runs script graders from the pack's repo and keeps a failing grader's reason", async () => {
    const { dir, profile } = producerRepo({ runs: 1, minTrials: 1 });
    const task = JSON.parse(readFileSync(path.join(dir, "evals/tasks/confirm.json"), "utf8"));
    task.graders = [{ type: "check" }, { type: "script", run: "node evals/graders/needs-file.mjs" }];
    write(dir, "evals/tasks/confirm.json", task);
    write(dir, "evals/graders/needs-file.mjs", 'import { existsSync } from "node:fs";\nif (!existsSync(process.env.DE_WEB_SDK_TRIAL_DIR + "/src/reset.ts")) { console.error("No src/reset.ts in the trial"); process.exit(1); }\n');
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"]);
    const script = readRuns(dir).at(-1)!.trials[0]!.graders.find((g) => g.type === "script")!;
    assert.equal(script.passed, false);
    assert.equal(script.detail, "No src/reset.ts in the trial");
  });

  it("keeps both records when two runs start in the same second", async () => {
    const { dir, profile } = producerRepo();
    const now = () => new Date("2026-09-28T07:00:00.123Z");
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"], {}, { now });
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"], {}, { now });
    assert.deepEqual(readRuns(dir).map((r) => r.id).sort(), ["2026-09-28T07:00:00Z", "2026-09-28T07:00:00Z-r2"]);
  });

  it("compares the candidate with a published version when one exists", async () => {
    const { dir, profile } = producerRepo();
    await toolkit(dir, ["build", "--no-tarball", "--profile", profile]).catch(() => undefined);
    // Publish a copy of the current pack as version 0.9.0.
    const published = tmpDir();
    for (const f of ["package.json", "pack.json", "guidance/no-console.md", "guidance/use-dialog.md", "adapters/grep.mjs"]) write(published, f, readFileSync(path.join(dir, f), "utf8"));
    const pj = JSON.parse(readFileSync(path.join(published, "package.json"), "utf8"));
    pj.version = "0.9.0";
    write(published, "package.json", pj);
    const { computeDigests, contentDigest, loadSource, publishedFiles } = await import("../src/source.ts");
    const src = loadSource(published);
    const manifest = { ...src.manifest, version: "0.9.0", files: computeDigests(src, publishedFiles(src)) };
    write(published, "pack.json", manifest);
    void contentDigest;
    // The published version is signed, and the producer repo trusts its own key.
    const keys = makeKeys();
    write(published, "pack.sigstore.json", (await signBundle(readFileSync(path.join(published, "pack.json")), keys)) as object);
    const untrusted = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", published, "--yes"]);
    assert.equal(untrusted.code, 3, "without the repo's own trust policy, the run stops before any trial");
    assert.match(untrusted.stderr, /The published version 0\.9\.0 doesn't verify with the trust policy in your pack repo's \.de-web-sdk\/trust\.json/);
    assert.equal(readRuns(dir).length, 0);
    write(dir, ".de-web-sdk/trust.json", { scopes: { "@example-platform": { keys: [keys.encoded] } } });
    const out = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", published, "--yes"]);
    assert.equal(out.code, 0, out.stderr);
    const run = readRuns(dir).at(-1)!;
    assert.equal(run.pack.published?.version, "0.9.0");
    assert.equal(run.trials.filter((t) => t.condition === "published").length, 2);
    assert.match(out.stdout, /Published version 0\.9\.0/);
  });

  it("retries a trial once when the driver fails before the agent acts", async () => {
    const { dir, profile } = producerRepo({ runs: 1, minTrials: 1 });
    const out = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"], { FAKE_MODE: "outage" });
    assert.equal(out.code, 0, out.stderr);
    const run = readRuns(dir).at(-1)!;
    assert.equal(run.trials[0]!.retried, true);
    assert.equal(run.trials[1]!.retried, false);
  });

  it("fails a trial that times out without retrying it", async () => {
    const { dir, profile } = producerRepo({ runs: 1, minTrials: 1 });
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"], { FAKE_MODE: "timeout" });
    const run = readRuns(dir).at(-1)!;
    assert.ok(run.trials.every((t) => t.status === "timeout" && !t.passed && !t.retried));
  });
});

describe("human review and feedback", () => {
  beforeEach(() => resetFake());

  it("shows trials without their condition, stores verdicts in the pack's repo, and lists disagreements in the next report", async () => {
    const { dir, profile } = producerRepo();
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"]);
    const queue = JSON.parse((await toolkit(dir, ["eval", "review", "--list", "--format", "json"])).stdout).trials;
    assert.equal(queue.length, 4);
    const text = JSON.stringify(queue);
    for (const word of ["candidate", "without", "condition", "packDigest", "sha256:"]) assert.ok(!text.includes(word), `the review queue reveals ${word}`);
    const passing = queue.find((t: { grader: string }) => t.grader === "pass");
    const rec = await toolkit(dir, ["eval", "review", "--record", passing.trial, "--verdict", "disagree", "--reason", "Loads the dialog eagerly.", "--unsupported", "1", "--reviewer", "rev-1"]);
    assert.equal(rec.code, 0, rec.stderr);
    const files = readdirSync(path.join(dir, "evals/reviews/confirm-dialog"));
    const stored = JSON.parse(readFileSync(path.join(dir, "evals/reviews/confirm-dialog", files[0]!), "utf8"));
    assert.equal(stored.condition, "candidate");
    assert.equal(stored.verdict, "disagree");
    const report = await toolkit(dir, ["eval", "report", "--profile", profile]);
    assert.match(report.stdout, /Trials where reviewers disagreed with graders:\n.*grader pass, reviewer disagrees\. "Loads the dialog eagerly\."/);
    assert.match(report.stdout, /Unsupported claims: 1 of 1 reviewed trials/);
  });

  it("reviews in the terminal", async () => {
    const { dir, profile } = producerRepo({ runs: 1, minTrials: 1 });
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"]);
    const answers = ["a", "Looks right.", "0", "s"];
    const out = await toolkit(dir, ["eval", "review"], {}, { interactive: true, ask: async () => answers.shift() ?? "s" });
    assert.equal(out.code, 0);
    assert.doesNotMatch(out.stdout, /candidate|without/);
    assert.equal(readdirSync(path.join(dir, "evals/reviews/confirm-dialog")).length, 1);
  });

  it("imports a report, drafts a task that references its rule and message, and resolves it when the task meets the threshold", async () => {
    const { dir, profile } = producerRepo();
    const report = { reportVersion: 1, pack: PACK_ID, packVersion: "1.0.0", rule: "use-dialog", kind: "unclear-guidance", message: "Which dialog for destructive actions?", facts: { bundler: "vite", moduleFederation: "2", role: "remote" }, sdkVersion: "0.1.0" };
    write(dir, "report.json", report);
    const imported = await toolkit(dir, ["feedback", "import", "report.json"]);
    assert.equal(imported.code, 0, imported.stderr);
    const id = /Imported report (\w+)/.exec(imported.stdout)![1]!;
    const listed = JSON.parse((await toolkit(dir, ["feedback", "list", "--format", "json"])).stdout);
    assert.equal(listed.open["use-dialog"].length, 1);
    await toolkit(dir, ["eval", "add", "--from-feedback", id]);
    const task = JSON.parse(readFileSync(path.join(dir, `evals/tasks/feedback-${id}.json`), "utf8"));
    assert.deepEqual(task.exercises, ["use-dialog"]);
    assert.match(task.prompt, /Which dialog for destructive actions\?/);
    // Make the drafted task runnable, then run the evals.
    task.prompt = "Ask for confirmation before deleting the account.";
    task.expects = [{ package: "@example/ui", export: "Dialog" }];
    write(dir, `evals/tasks/feedback-${id}.json`, task);
    const run = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"]);
    assert.equal(run.code, 0, run.stderr);
    const stored = JSON.parse(readFileSync(path.join(dir, `feedback/${id}.json`), "utf8"));
    assert.equal(stored.status, "resolved");
  });

  it("reports both measures by model, condition, and task, with trial counts, where trials ran, versions, and the digest", async () => {
    const { dir, profile } = producerRepo();
    const out = await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes", "--format", "json"]);
    const report = JSON.parse(out.stdout);
    assert.equal(report.kind, "eval-report");
    assert.match(report.pack.candidateDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(report.pack.version, "1.0.0");
    const m = report.models[0];
    assert.equal(m.alias, "fake-model");
    assert.deepEqual(m.toolVersions, ["fake 1.0"]);
    assert.deepEqual(m.reportedModels, ["fake-1-reported"]);
    assert.match(m.routes[0], /^local: /);
    assert.deepEqual(m.conditions.candidate, { trials: 2, passed: 2, passRate: 1, apiTrials: 2, apiAdopted: 2, apiRate: 1 });
    assert.deepEqual(m.conditions.without, { trials: 2, passed: 0, passRate: 0, apiTrials: 2, apiAdopted: 0, apiRate: 0 });
    assert.ok(m.tasks["confirm-dialog"].candidate);
    assert.deepEqual(report.disagreements, []);
    assert.equal(report.gate.ok, true);
  });

  it("stores a side-by-side comparison with the task, both versions, and the reason", async () => {
    const { dir, profile } = producerRepo({ runs: 1, minTrials: 1 });
    const published = tmpDir();
    for (const f of ["package.json", "pack.json", "guidance/no-console.md", "guidance/use-dialog.md", "adapters/grep.mjs"]) write(published, f, readFileSync(path.join(dir, f), "utf8"));
    const pj = JSON.parse(readFileSync(path.join(published, "package.json"), "utf8"));
    pj.version = "0.9.0";
    write(published, "package.json", pj);
    const { computeDigests, loadSource, publishedFiles } = await import("../src/source.ts");
    const src = loadSource(published);
    write(published, "pack.json", { ...src.manifest, version: "0.9.0", files: computeDigests(src, publishedFiles(src)) });
    const keys = makeKeys();
    write(published, "pack.sigstore.json", (await signBundle(readFileSync(path.join(published, "pack.json")), keys)) as object);
    write(dir, ".de-web-sdk/trust.json", { scopes: { "@example-platform": { keys: [keys.encoded] } } });
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", published, "--yes"]);
    const pairs = JSON.parse((await toolkit(dir, ["eval", "review", "--compare", "--list", "--format", "json"])).stdout).pairs;
    assert.equal(pairs.length, 1);
    assert.ok(!JSON.stringify(pairs).includes("candidate"));
    const rec = await toolkit(dir, ["eval", "review", "--compare", "--record", pairs[0].pair, "--choice", "A", "--reason", "Clearer confirmation copy.", "--reviewer", "rev-2"]);
    assert.equal(rec.code, 0, rec.stderr);
    const file = readdirSync(path.join(dir, "evals/reviews/comparisons"))[0]!;
    const stored = JSON.parse(readFileSync(path.join(dir, "evals/reviews/comparisons", file), "utf8"));
    assert.equal(stored.task, "confirm-dialog");
    assert.deepEqual(stored.versions, { candidate: "1.0.0", published: "0.9.0" });
    assert.equal(stored.reason, "Clearer confirmation copy.");
    assert.ok(["candidate", "published"].includes(stored.choice));
  });

  it("records a guided trial beside the harness results without counting it toward the gate", async () => {
    const { dir, profile } = producerRepo();
    await toolkit(dir, ["eval", "run", "--profile", profile, "--published", "none", "--yes"]);
    const prepared = JSON.parse((await toolkit(dir, ["eval", "guided", "prepare", "--task", "confirm-dialog", "--model", "fake-model"])).stdout);
    assert.ok(existsSync(path.join(prepared.worktree, ".de-web-sdk-trial.json")));
    assert.match(path.basename(path.dirname(prepared.worktree)), /^dws-trials-/, "guided trials share one parent folder the developer can trust once");
    assert.match(readFileSync(path.join(prepared.worktree, "AGENTS.md"), "utf8"), /no-console/);
    mkdirSync(path.join(prepared.worktree, "src"), { recursive: true });
    write(prepared.worktree, "src/confirm.tsx", 'import { Dialog } from "@example/ui";\nexport const C = Dialog;\n');
    const finished = await toolkit(dir, ["eval", "guided", "finish", "--worktree", prepared.worktree]);
    assert.equal(finished.code, 0, finished.stderr);
    assert.match(finished.stdout, /passed\. It appears beside harness results and doesn't count toward the gate/);
    const report = await toolkit(dir, ["eval", "report", "--profile", profile]);
    assert.match(report.stdout, /Guided Copilot trials \(they don't count toward the gate\):\n  confirm-dialog on fake-model: guided 100% \(1\/1\); reference harness/);
    const gateTrials = readRuns(dir).flatMap((r) => r.trials).filter((t) => t.guided);
    assert.equal(gateTrials.length, 1);
  });
});
