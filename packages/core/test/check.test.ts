import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  checkJson,
  checkJunit,
  checkSarif,
  checkText,
  loadWorkspace,
  readBaseline,
  resolutionRecord,
  runCheck,
  sync,
  type CheckOptions,
} from "../src/index.ts";
import { git, installPack, write } from "./helpers.ts";
import { ADAPTER_PACK, machine, readConfig, RUNTIME_PACK, scenario, setConfig } from "./scenario.ts";

const opts = (root: string) => ({ root, rootKeys: [], network: false });
async function check(root: string, options: CheckOptions = {}) {
  const ws = await loadWorkspace(opts(root));
  const result = await runCheck(ws, options);
  return { ws, result };
}

const grepRule = (id: string, needle: string, extra = {}) =>
  machine(id, "grep", { paths: ["src/**"], check: { pack: ADAPTER_PACK, adapter: "grep", options: { needle } }, ...extra });

describe("check: exit codes and modes", () => {
  it("exits with 1 on a new violation in enforce mode and explains it", async () => {
    const s = await scenario();
    const { ws, result } = await check(s.root);
    assert.equal(result.exitCode, 1);
    const report = checkJson({ workspace: ws, result, sdkVersion: "0.1.0" }) as { violations: Array<Record<string, unknown>> };
    const v = report.violations[0]!;
    for (const key of ["rule", "owner", "rationale", "file", "fix", "contest"]) assert.ok(v[key], `missing ${key}`);
    assert.equal(v.rule, `${RUNTIME_PACK}#react-singleton`);
    assert.equal(v.file, "dist/mf-manifest.json");
  });

  it("exits with 0 when there are no violations", async () => {
    const s = await scenario({ files: { "dist/mf-manifest.json": JSON.stringify({ exposes: [{}], shared: [{ name: "react", singleton: true }] }) } });
    assert.equal((await check(s.root)).result.exitCode, 0);
  });

  it("lists violations in report mode and exits with 0", async () => {
    const s = await scenario({ config: { mode: "report" } });
    const { ws, result } = await check(s.root);
    assert.equal(result.exitCode, 0);
    assert.equal(result.counts.new, 1);
    assert.match(checkText({ workspace: ws, result, sdkVersion: "0" }), /report mode, so they don't fail/);
  });

  it("doesn't fail on advisory rules", async () => {
    const s = await scenario({ files: { "dist/mf-manifest.json": JSON.stringify({ exposes: [{}], remotes: [{}], shared: [] }) } });
    const { result } = await check(s.root);
    assert.ok(result.advisory.includes(`${RUNTIME_PACK}#lazy-remotes`));
    assert.equal(result.exitCode, 0);
  });

  it("exits with 3 and names the rule when an adapter can't evaluate it", async () => {
    const s = await scenario({ files: { "dist/mf-manifest.json": "" } });
    await import("node:fs").then((fs) => fs.rmSync(path.join(s.root, "dist"), { recursive: true }));
    setConfig(s.root, { mode: "enforce", facts: { role: "remote" } });
    const { result } = await check(s.root);
    assert.equal(result.exitCode, 3);
    const outcome = result.rules.find((r) => r.rule === `${RUNTIME_PACK}#react-singleton`)!;
    assert.equal(outcome.status, "error");
    assert.match(outcome.error!, /No MF2 manifest at dist\/mf-manifest.json/);
  });

  it("lists adapter errors in report mode without failing", async () => {
    const s = await scenario({ rules: [grepRule("crashy", "x", { check: { pack: ADAPTER_PACK, adapter: "crash", options: {} } })], config: { mode: "report" } });
    const { result } = await check(s.root);
    assert.equal(result.exitCode, 0);
    assert.equal(result.counts.adapterErrors, 1);
  });

  it("reports an adapter error that names a missing adapter pack", async () => {
    const s = await scenario({ rules: [machine("r", "grep", {}, "@example-platform/absent")] });
    const pkg = JSON.parse(readFileSync(path.join(s.runtimeDir, "package.json"), "utf8"));
    assert.ok(pkg);
    await installPack(s.root, {
      name: RUNTIME_PACK,
      keys: s.keys,
      dependencies: { "@example-platform/absent": "^1.0.0" },
      manifest: { rules: [machine("r", "grep", {}, "@example-platform/absent")] },
    });
    const { result } = await check(s.root);
    assert.equal(result.exitCode, 3);
    assert.match(result.rules[0]!.error!, /@example-platform\/absent isn't installed/);
  });
});

describe("check: adapter contract and isolation", () => {
  for (const [adapter, pattern] of [
    ["writer", /allow-fs-write|access denied/],
    ["spawner", /allow-child-process|access denied/],
    ["crash", /crashed: boom/],
  ] as const) {
    it(`reports an adapter error for an adapter that ${adapter === "crash" ? "crashes" : adapter === "writer" ? "writes a file" : "starts a process"}`, async () => {
      const s = await scenario({ rules: [machine(adapter, adapter)] });
      const { result } = await check(s.root);
      assert.equal(result.rules[0]!.status, "error");
      assert.match(result.rules[0]!.error!, pattern);
      assert.match(result.rules[0]!.error!, new RegExp(`${ADAPTER_PACK}#${adapter}`));
      assert.equal(existsSync(path.join(s.root, "pwned.txt")), false);
    });
  }

  it("stops an adapter that exceeds its time limit", async () => {
    const s = await scenario({ rules: [machine("hang", "hang")], config: { mode: "enforce", adapterTimeoutSeconds: 1 } });
    const { result } = await check(s.root);
    assert.match(result.rules[0]!.error!, /time limit of 1 seconds/);
    assert.equal(result.exitCode, 3);
  });

  it("reports a wrapped analyzer's SARIF without conversion", async () => {
    const s = await scenario({ rules: [machine("salt-deprecations", "sarif", { paths: ["src/**"] })] });
    const { result } = await check(s.root);
    const v = result.rules[0]!.violations[0]!;
    assert.equal(v.message, "ButtonBar is deprecated");
    assert.equal(v.file, "src/app.tsx");
    assert.equal(v.line, 3);
  });

  it("keeps a violation's stable key when lines are added above it", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")], files: { "src/a.ts": "console.log(1);\n" } });
    const first = (await check(s.root)).result.rules[0]!.violations[0]!;
    write(s.root, "src/a.ts", "// one\n// two\n\nconsole.log(1);\n");
    const second = (await check(s.root)).result.rules[0]!.violations[0]!;
    assert.equal(second.line, 4);
    assert.equal(first.fingerprint, second.fingerprint);
  });
});

describe("check: exceptions and ignored paths", () => {
  const future = "2099-12-31";

  it("skips a violation that an active exception covers and lists the exception", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")], files: { "src/legacy/a.ts": "console.log(1)\n" } });
    setConfig(s.root, { mode: "enforce", exceptions: [{ rule: `${RUNTIME_PACK}#no-console`, paths: ["src/legacy/**"], owner: "payments-web", reason: "Deleted in Q1.", expires: future }] });
    const { ws, result } = await check(s.root);
    assert.equal(result.exitCode, 0);
    assert.equal(result.counts.excepted, 1);
    assert.match(checkText({ workspace: ws, result, sdkVersion: "0" }), /Active exceptions:\n.*no-console in src\/legacy\/\*\*: owner payments-web/);
  });

  it("fails on an expired exception and names it and its owner", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")] });
    setConfig(s.root, { mode: "enforce", exceptions: [{ rule: `${RUNTIME_PACK}#no-console`, owner: "payments-web", reason: "Old.", expires: "2020-01-01" }] });
    const { result } = await check(s.root);
    assert.equal(result.exitCode, 2);
    assert.match(result.diagnostics.find((d) => d.code === "exception.expired")!.message, /no-console expired on 2020-01-01.*payments-web/);
  });

  it("reports a configuration error for an exception without a reason", async () => {
    const s = await scenario();
    setConfig(s.root, { mode: "enforce", exceptions: [{ rule: `${RUNTIME_PACK}#react-singleton`, owner: "x", expires: future }] });
    await assert.rejects(loadWorkspace(opts(s.root)), (e: { kind?: string; diagnostics?: Array<{ field?: string }> }) => e.kind === "config" && e.diagnostics![0]!.field === "exceptions[0].reason");
  });

  it("requires the owner's approval for an exception to a locked rule", async () => {
    const s = await scenario();
    setConfig(s.root, { mode: "enforce", exceptions: [{ rule: `${RUNTIME_PACK}#react-singleton`, owner: "payments-web", reason: "Partner widget.", expires: future }] });
    const { result } = await check(s.root);
    assert.equal(result.exitCode, 2);
    assert.match(result.diagnostics.find((d) => d.code === "exception.unapproved")!.message, /react-singleton.*Platform Web Runtime/);
  });

  it("skips violations under an approved exception to a locked rule and lists the approval", async () => {
    const s = await scenario();
    setConfig(s.root, { mode: "enforce", exceptions: [{ rule: `${RUNTIME_PACK}#react-singleton`, owner: "payments-web", reason: "Partner widget.", expires: future, approvedBy: "platform-web-runtime", approval: "https://git.example.com/issues/412" }] });
    const { ws, result } = await check(s.root);
    assert.equal(result.exitCode, 0);
    assert.match(checkText({ workspace: ws, result, sdkVersion: "0" }), /Approved by platform-web-runtime: https:\/\/git.example.com\/issues\/412/);
  });

  it("ignores generated code and states how many files it ignored", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")], files: { "src/generated/a.ts": "console.log(1)\n", "src/generated/b.ts": "x\n" } });
    setConfig(s.root, { mode: "enforce", ignore: [{ path: "src/generated/**", reason: "OpenAPI client" }] });
    const { result } = await check(s.root);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.ignore, [{ path: "src/generated/**", reason: "OpenAPI client", files: 2 }]);
  });

  it("still reports a locked rule's violation in an ignored path", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log", { locked: true })], files: { "src/generated/a.ts": "console.log(1)\n" } });
    setConfig(s.root, { mode: "enforce", ignore: [{ path: "src/generated/**", reason: "OpenAPI client" }] });
    const { result } = await check(s.root);
    assert.equal(result.exitCode, 1);
    assert.equal(result.rules[0]!.violations[0]!.file, "src/generated/a.ts");
  });
});

describe("check: baselines", () => {
  const forty = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`src/f${String(i).padStart(2, "0")}.ts`, "console.log(1)\n"]));

  it("records all 40 existing violations and exits with 0", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")], files: forty, config: { mode: "report" } });
    const { result } = await check(s.root, { baseline: true });
    assert.equal(result.exitCode, 0);
    assert.equal(readBaseline(s.root)!.length, 40);
    const text = readFileSync(path.join(s.root, ".de-web-sdk/baseline.json"), "utf8");
    assert.equal(text.split("\n").filter((l) => l.includes('"rule"')).length, 40);
  });

  it("switches to enforce mode with --enforce and then fails only on new violations", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")], files: { "src/a.ts": "console.log(1)\n" }, config: { mode: "report", targets: ["claude-code"] } });
    await check(s.root, { baseline: true, enforce: true });
    const config = readConfig(s.root);
    assert.equal(config.mode, "enforce");
    assert.deepEqual(config.targets, ["claude-code"]);

    const clean = await check(s.root);
    assert.equal(clean.result.exitCode, 0);
    assert.equal(clean.result.counts.baselined, 1);

    write(s.root, "src/b.ts", "console.log(2)\n");
    const dirty = await check(s.root);
    assert.equal(dirty.result.exitCode, 1);
    const failing = dirty.result.rules[0]!.violations.filter((v) => v.state === "new");
    assert.deepEqual(failing.map((v) => v.file), ["src/b.ts"]);
  });

  it("fails every violation in enforce mode without a baseline file", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")], files: { "src/a.ts": "console.log(1)\n", "src/b.ts": "console.log(2)\n" } });
    const { result } = await check(s.root);
    assert.equal(result.baseline.present, false);
    assert.equal(result.counts.new, 2);
    assert.equal(result.exitCode, 1);
  });

  it("fails a regenerated baseline that hides a new violation, and passes the first adoption", async () => {
    const s = await scenario({ git: true, rules: [grepRule("no-console", "console.log")], files: { "src/a.ts": "console.log(1)\n" }, config: { mode: "report" } });
    git(s.root, "add", "-A");
    git(s.root, "commit", "-qm", "init");
    await check(s.root, { baseline: true, enforce: true });
    const first = await check(s.root, { baselineRef: "main" });
    assert.equal(first.result.exitCode, 0);
    assert.equal(first.result.baseline.shrinkOnly?.status, "introduced");
    git(s.root, "add", "-A");
    git(s.root, "commit", "-qm", "baseline");

    git(s.root, "checkout", "-qb", "feature");
    write(s.root, "src/b.ts", "console.log(2)\n");
    await check(s.root, { baseline: true });
    const { result } = await check(s.root, { baselineRef: "main" });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.baseline.shrinkOnly?.added.map((e) => e.file), ["src/b.ts"]);
  });

  it("reports a fixed violation's entry as stale, and prunes it", async () => {
    const s = await scenario({ git: true, rules: [grepRule("no-console", "console.log")], files: { "src/a.ts": "console.log(1)\n", "src/b.ts": "console.log(2)\n" } });
    await check(s.root, { baseline: true });
    git(s.root, "add", "-A");
    git(s.root, "commit", "-qm", "baseline");
    write(s.root, "src/a.ts", "export {};\n");
    const stale = await check(s.root);
    assert.deepEqual(stale.result.baseline.stale.map((e) => e.file), ["src/a.ts"]);
    await check(s.root, { pruneBaseline: true });
    assert.deepEqual(readBaseline(s.root)!.map((e) => e.file), ["src/b.ts"]);
    const shrink = await check(s.root, { baselineRef: "main" });
    assert.equal(shrink.result.exitCode, 0);
  });
});

describe("check: named files", () => {
  it("reports and fails only on violations in the files an agent names", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")], files: { "src/a.ts": "console.log(1)\n", "src/b.ts": "console.log(2)\n" } });
    const ws = await loadWorkspace(opts(s.root));
    const mine = await runCheck(ws, { files: ["src/a.ts"] });
    assert.deepEqual(mine.rules[0]!.violations.map((v) => v.file), ["src/a.ts"]);
    assert.equal(mine.exitCode, 1);
    write(s.root, "src/a.ts", "export {};\n");
    const fixed = await runCheck(await loadWorkspace(opts(s.root)), { files: ["src/a.ts"] });
    assert.equal(fixed.exitCode, 0);
  });

  it("refuses file arguments with --baseline", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log")] });
    const result = await runCheck(await loadWorkspace(opts(s.root)), { baseline: true, files: ["src/a.ts"] });
    assert.equal(result.exitCode, 2);
  });
});

describe("check: outputs", () => {
  it("writes JSON with a schema version, relative paths, and no absolute paths", async () => {
    const s = await scenario();
    const { ws, result } = await check(s.root);
    const json = JSON.stringify(checkJson({ workspace: ws, result, sdkVersion: "0.1.0" }));
    assert.match(json, /"schemaVersion":1/);
    assert.ok(!json.includes(s.root), "JSON contains the repo root");
  });

  it("writes a JUnit case per machine rule, failing rules with new violations", async () => {
    const s = await scenario({ rules: [grepRule("no-console", "console.log"), grepRule("no-debugger", "debugger")], files: { "src/a.ts": "console.log(1)\n" } });
    const { ws, result } = await check(s.root);
    const xml = checkJunit({ workspace: ws, result, sdkVersion: "0" });
    assert.equal((xml.match(/<testcase /g) ?? []).length, 2);
    assert.match(xml, /name="@example-platform\/runtime#no-console"[^>]*>\s*<failure message="1 new violation">/);
    assert.match(xml, /name="@example-platform\/runtime#no-debugger"[^>]*\/>/);
  });

  it("writes SARIF 2.1.0 with partial fingerprints and baseline states", async () => {
    const s = await scenario();
    const { ws, result } = await check(s.root);
    const sarif = checkSarif({ workspace: ws, result, sdkVersion: "0" }) as { version: string; runs: Array<{ results: Array<{ partialFingerprints: object; baselineState: string }> }> };
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0]!.results[0]!.baselineState, "new");
    assert.ok(Object.keys(sarif.runs[0]!.results[0]!.partialFingerprints).length);
  });

  it("writes a resolution record with packs, digests, facts, exceptions, ignored paths, and results", async () => {
    const s = await scenario();
    setConfig(s.root, { mode: "enforce", ignore: [{ path: "src/generated/**", reason: "gen" }] });
    const { ws, result } = await check(s.root);
    const record = resolutionRecord(ws, result, "0.1.0") as Record<string, unknown>;
    const packs = record.packs as Array<{ id: string; digest: string }>;
    assert.deepEqual(packs.map((p) => p.id), [ADAPTER_PACK, RUNTIME_PACK]);
    assert.ok(packs.every((p) => /^sha256:[0-9a-f]{64}$/.test(p.digest)));
    for (const key of ["facts", "exceptions", "ignored", "results", "rules"]) assert.ok(key in record, key);
    assert.equal((record.results as unknown[]).length, 1);
  });

  it("warns that entry points are stale after a pack adds a rule, without failing", async () => {
    const s = await scenario({ files: { "dist/mf-manifest.json": JSON.stringify({ exposes: [{}], shared: [] }) } });
    await sync(opts(s.root));
    assert.deepEqual((await check(s.root)).result.staleEntryPoints, []);
    await installPack(s.root, {
      name: RUNTIME_PACK,
      keys: s.keys,
      dependencies: { [ADAPTER_PACK]: "^1.0.0" },
      manifest: { rules: [grepRule("no-console", "console.log")] },
    });
    const { result } = await check(s.root);
    assert.deepEqual(result.staleEntryPoints, ["AGENTS.md"]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.rules.some((r) => r.rule.endsWith("#no-console")));
    assert.match(result.diagnostics.find((d) => d.code === "entryPoints.stale")!.message, /npx --no de-web-sdk sync/);
  });
});
