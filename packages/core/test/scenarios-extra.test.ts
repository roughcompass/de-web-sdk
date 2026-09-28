import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkJson, loadWorkspace, runCheck, sync } from "../src/index.ts";
import { git, installPack, write, GREP_ADAPTER } from "./helpers.ts";
import { ADAPTER_PACK, RUNTIME_PACK, scenario } from "./scenario.ts";

const opts = (root: string) => ({ root, rootKeys: [], network: false });

describe("pack format, as consumers see it", () => {
  it("shows the pack's owner as the owner of a rule that declares none", async () => {
    const s = await scenario();
    const ws = await loadWorkspace(opts(s.root));
    const result = await runCheck(ws);
    const report = checkJson({ workspace: ws, result, sdkVersion: "0" }) as { violations: Array<{ owner: { team: string } }> };
    assert.equal(report.violations[0]!.owner.team, "Platform Web Runtime");
  });

  it("puts an advisory rule in the agent context and never fails check on it", async () => {
    const s = await scenario({ files: { "dist/mf-manifest.json": JSON.stringify({ exposes: [{}], shared: [] }) } });
    await sync(opts(s.root));
    assert.match(readFileSync(path.join(s.root, "AGENTS.md"), "utf8"), /`@example-platform\/runtime#mf2-only` \[advisory\]/);
    const result = await runCheck(await loadWorkspace(opts(s.root)));
    assert.equal(result.exitCode, 0);
  });

  it("uses a pack that has a field from a newer minor version", async () => {
    const s = await scenario({ runtimeManifest: { specVersion: "0.4", mcpTools: [{ name: "future" }] } as never });
    const ws = await loadWorkspace(opts(s.root));
    assert.ok(ws.ruleSet.rules.some((r) => r.id === "react-singleton"));
  });

  it("excludes an item whose condition uses a fact this SDK doesn't know, instead of refusing the pack", async () => {
    const s = await scenario({ rules: [{ id: "future", title: "Future", enforcement: "advisory", rationale: "x", appliesWhen: { framework: ["next"] } as never }] });
    const ws = await loadWorkspace(opts(s.root));
    assert.match(ws.ruleSet.exclusions.find((e) => e.ref.endsWith("#future"))!.reason, /fact "framework", which this SDK version doesn't support/);
  });
});

describe("composition: conditions on docs and commands", () => {
  it("excludes docs and commands whose conditions fail, naming each reason", async () => {
    const s = await scenario({
      runtimeFiles: { "docs/mf1.md": "# MF1\n", "bin/ctx.js": "#!/usr/bin/env node\n" },
      runtimeManifest: {
        docs: [{ title: "MF1 migration notes", path: "docs/mf1.md", appliesWhen: { moduleFederation: ["1"] } }],
        commands: [{ name: "ctx", run: "runtime-ctx", use: "Hosts only", appliesWhen: { role: ["host"] } }],
      },
    });
    await installPack(s.root, {
      name: RUNTIME_PACK,
      keys: s.keys,
      dependencies: { [ADAPTER_PACK]: "^1.0.0" },
      bin: { "runtime-ctx": "bin/ctx.js" },
      files: { "docs/mf1.md": "# MF1\n", "bin/ctx.js": "#!/usr/bin/env node\n" },
      manifest: {
        docs: [{ title: "MF1 migration notes", path: "docs/mf1.md", appliesWhen: { moduleFederation: ["1"] } }],
        commands: [{ name: "ctx", run: "runtime-ctx", use: "Hosts only", appliesWhen: { role: ["host"] } }],
      },
    });
    const ws = await loadWorkspace(opts(s.root));
    const reasons = Object.fromEntries(ws.ruleSet.exclusions.map((e) => [`${e.kind}:${e.ref}`, e.reason]));
    assert.match(reasons[`doc:${RUNTIME_PACK}#MF1 migration notes`]!, /requires moduleFederation 1, and the repo has 2/);
    assert.match(reasons[`command:${RUNTIME_PACK}#ctx`]!, /requires role host, and the repo has remote/);
  });
});

describe("checks from the local pack", () => {
  it("runs a local adapter in the same isolated process", async () => {
    const s = await scenario({ files: { "src/api/raw.ts": "fetch('/api/orders');\n", "dist/mf-manifest.json": JSON.stringify({ exposes: [{}], shared: [] }) } });
    write(s.root, ".de-web-sdk/local/adapters/grep.mjs", GREP_ADAPTER);
    write(s.root, ".de-web-sdk/local/pack.json", {
      specVersion: "0",
      owner: { team: "Payments Web" },
      feedback: "https://git.example.com/payments/issues/new",
      adapters: [{ name: "grep", module: "adapters/grep.mjs" }],
      rules: [{ id: "use-api-client", title: "Use the API client", enforcement: "machine", paths: ["src/**"], rationale: "Headers.", check: { adapter: "grep", options: { needle: "fetch(" } } }],
    });
    const result = await runCheck(await loadWorkspace(opts(s.root)));
    const local = result.rules.find((r) => r.rule === "local#use-api-client")!;
    assert.equal(local.status, "violated");
    assert.equal(local.violations[0]!.file, "src/api/raw.ts");
    assert.equal(result.exitCode, 1);
  });
});

describe("sync in git", () => {
  it("leaves git status clean when rerun after its entry points are committed", async () => {
    const s = await scenario({ git: true, skills: [{ name: "migrate-to-mf2", path: "skills/migrate-to-mf2" }], runtimeFiles: { "skills/migrate-to-mf2/SKILL.md": "---\nname: migrate-to-mf2\ndescription: Migrate.\n---\n" } });
    write(s.root, ".gitignore", "node_modules/\n");
    await sync(opts(s.root));
    git(s.root, "add", "-A");
    git(s.root, "commit", "-qm", "adopt");
    await sync(opts(s.root));
    assert.equal(git(s.root, "status", "--porcelain", "--untracked-files=all"), "");
    const committed = git(s.root, "ls-files").split("\n");
    assert.ok(!committed.some((f) => f.includes("skills/") || f.startsWith(".de-web-sdk/context") || f.startsWith("node_modules")), committed.join(", "));
  });
});
