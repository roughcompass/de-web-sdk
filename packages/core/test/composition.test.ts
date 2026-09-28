import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadWorkspace, SdkError } from "../src/index.ts";
import { installPack, makeKeys, makeRepo, write } from "./helpers.ts";
import { addDevDependency, machine, RUNTIME_PACK, scenario, setConfig } from "./scenario.ts";

const load = (root: string) => loadWorkspace({ root, rootKeys: [], network: false });

describe("composition", () => {
  it("collects the rules of both packs a bundle depends on", async () => {
    const keys = makeKeys();
    const root = makeRepo({ devDependencies: { "@example-platform/baseline": "1.0.0" }, trust: { scopes: { "@example-platform": { keys: [keys.encoded] } } } });
    const nested = `${root}/node_modules`;
    await installPack(root, { name: "@example-platform/a", keys, into: nested, manifest: { rules: [{ id: "a1", title: "A1", enforcement: "advisory", rationale: "x" }] } });
    await installPack(root, { name: "@example-platform/b", keys, into: nested, manifest: { rules: [{ id: "b1", title: "B1", enforcement: "advisory", rationale: "x" }] } });
    await installPack(root, { name: "@example-platform/baseline", keys, dependencies: { "@example-platform/a": "^1", "@example-platform/b": "^1" } });
    const ws = await load(root);
    assert.deepEqual(ws.ruleSet.rules.map((r) => r.ref).sort(), ["@example-platform/a#a1", "@example-platform/b#b1"]);
    assert.equal(ws.collection.packs.find((p) => p.ref === "@example-platform/baseline")?.kind, "bundle");
  });

  it("collects a library's embedded pack at the installed version", async () => {
    const keys = makeKeys();
    const root = makeRepo({ dependencies: { "@example-ds/core": "^4.0.0" }, trust: { scopes: { "@example-ds": { keys: [keys.encoded] } } } });
    await installPack(root, { name: "@example-ds/core", version: "4.0.0", embedAt: "agent-pack", keys, manifest: { rules: [{ id: "v4-api", title: "Use the v4 API", enforcement: "advisory", rationale: "x" }] } });
    const ws = await load(root);
    assert.deepEqual(ws.ruleSet.rules.map((r) => `${r.ref}@${r.packVersion}`), ["@example-ds/core#v4-api@4.0.0"]);
    assert.equal(ws.collection.packs[0]?.kind, "embedded");
  });

  it("doesn't collect a pack embedded in an indirect dependency", async () => {
    const keys = makeKeys();
    const root = makeRepo({ dependencies: { "lib-a": "1.0.0" }, trust: { scopes: { "@example-ds": { keys: [keys.encoded] } } } });
    write(root, "node_modules/lib-a/package.json", { name: "lib-a", version: "1.0.0", dependencies: { "@example-ds/core": "^1" } });
    await installPack(root, { name: "@example-ds/core", embedAt: "agent-pack", keys, manifest: { rules: [{ id: "x", title: "X", enforcement: "advisory", rationale: "x" }] } });
    const ws = await load(root);
    assert.deepEqual(ws.collection.packs, []);
  });

  it("keeps same-named rules from two packs apart by pack", async () => {
    const keys = makeKeys();
    const root = makeRepo({ devDependencies: { "@example-platform/a": "1", "@example-platform/b": "1" }, trust: { scopes: { "@example-platform": { keys: [keys.encoded] } } } });
    for (const name of ["@example-platform/a", "@example-platform/b"]) {
      await installPack(root, { name, keys, manifest: { rules: [{ id: "no-raw-values", title: "No raw values", enforcement: "advisory", rationale: "x" }] } });
    }
    const ws = await load(root);
    assert.deepEqual(ws.ruleSet.rules.map((r) => r.ref), ["@example-platform/a#no-raw-values", "@example-platform/b#no-raw-values"]);
  });

  it("excludes an MF2-only rule in an MF1 repo and names the failed condition", async () => {
    const s = await scenario({ mf: "1" });
    const ws = await load(s.root);
    const ex = ws.ruleSet.exclusions.find((e) => e.ref === `${RUNTIME_PACK}#mf2-only`);
    assert.ok(ex);
    assert.match(ex.reason, /moduleFederation 2.*has 1/);
  });

  it("excludes rules that depend on an unknown fact and reports each", async () => {
    const s = await scenario();
    write(s.root, "dist/mf-manifest.json", "{}");
    const ws = await load(s.root);
    assert.equal(ws.facts.facts.role, "unknown");
    const ex = ws.ruleSet.exclusions.find((e) => e.ref === `${RUNTIME_PACK}#lazy-remotes`);
    assert.match(ex!.reason, /role fact is unknown/);
  });

  it("applies MF2 remote rules in a new repo that declares its facts", async () => {
    const s = await scenario({ config: { mode: "enforce", facts: { moduleFederation: "2", role: "remote" } } });
    const ws = await load(s.root);
    assert.ok(ws.ruleSet.rules.some((r) => r.id === "mf2-only"));
  });

  it("excludes a pack whose governed package is outside the range", async () => {
    const keys = makeKeys();
    const root = makeRepo({ dependencies: { "@example-ds/core": "2.4.1" }, devDependencies: { "@example-platform/ds-pack": "1" }, trust: { scopes: { "@example-platform": { keys: [keys.encoded] } } } });
    write(root, "node_modules/@example-ds/core/package.json", { name: "@example-ds/core", version: "2.4.1" });
    await installPack(root, { name: "@example-platform/ds-pack", keys, manifest: { governs: { "@example-ds/core": "^3.0.0" }, rules: [{ id: "x", title: "X", enforcement: "advisory", rationale: "x" }] } });
    const ws = await load(root);
    assert.deepEqual(ws.ruleSet.exclusions, [{ kind: "pack", ref: "@example-platform/ds-pack", reason: "it governs @example-ds/core ^3.0.0, and 2.4.1 is installed" }]);
  });

  it("includes local rules as local#<rule>", async () => {
    const s = await scenario();
    write(s.root, ".de-web-sdk/local/pack.json", {
      specVersion: "0",
      owner: { team: "Payments Web" },
      feedback: "https://git.example.com/payments/issues/new",
      rules: [{ id: "use-api-client", title: "Call services through src/api/client.ts", enforcement: "advisory", paths: ["src/api/**"], rationale: "Headers." }],
    });
    const ws = await load(s.root);
    assert.ok(ws.ruleSet.rules.some((r) => r.ref === "local#use-api-client"));
  });

  it("fails on an invalid local pack and names the file and field", async () => {
    const s = await scenario();
    write(s.root, ".de-web-sdk/local/pack.json", { specVersion: "0", owner: { team: "P" }, feedback: "https://x/issues", rules: [{ id: "r", title: "R", enforcement: "advisory" }] });
    await assert.rejects(load(s.root), (e: unknown) => {
      assert.ok(e instanceof SdkError);
      assert.equal(e.kind, "config");
      assert.equal(e.diagnostics[0]!.file, ".de-web-sdk/local/pack.json");
      assert.equal(e.diagnostics[0]!.field, "rules[0].rationale");
      return true;
    });
  });

  it("refuses configuration that turns off a pack's rule and points to exceptions and ignored paths", async () => {
    const s = await scenario();
    setConfig(s.root, { mode: "enforce", rules: { [`${RUNTIME_PACK}#react-singleton`]: "off" } });
    await assert.rejects(load(s.root), (e: unknown) => {
      assert.ok(e instanceof SdkError && e.kind === "config");
      assert.match(e.diagnostics[0]!.message, /exception.*ignore/s);
      return true;
    });
  });

  it("fails closed on a trust error even in report mode", async () => {
    const s = await scenario({ config: { mode: "report" } });
    write(s.runtimeDir, "guidance/lazy-remotes.md", "tampered\n");
    await assert.rejects(load(s.root), (e: unknown) => e instanceof SdkError && e.exitCode === 3);
  });

  it("refuses a published pack whose rule uses an adapter from a pack it doesn't depend on", async () => {
    const s = await scenario({ rules: [machine("needs-other", "grep", {}, "@example-platform/not-installed")] });
    addDevDependency(s.root, "@example-platform/unused");
    await assert.rejects(load(s.root), (e: unknown) => e instanceof SdkError && e.kind === "trust");
  });
});
