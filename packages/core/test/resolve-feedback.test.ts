import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFeedback, loadWorkspace, resolveRules, SdkError } from "../src/index.ts";
import { write } from "./helpers.ts";
import { RUNTIME_PACK, scenario } from "./scenario.ts";

const load = (root: string) => loadWorkspace({ root, rootKeys: [], network: false });

describe("resolve", () => {
  it("lists a path-scoped rule only for matching files", async () => {
    const s = await scenario({ rules: [{ id: "remote-exports", title: "Export remotes lazily", enforcement: "advisory", rationale: "x", paths: ["src/remotes/**"] }, { id: "everywhere", title: "Everywhere", enforcement: "advisory", rationale: "y" }] });
    const ws = await load(s.root);
    const json = JSON.parse(resolveRules(ws, { files: ["src/remotes/cart.tsx", "src/app.tsx"], format: "json" }));
    assert.equal(json.schemaVersion, 1);
    const scoped = json.rules.find((r: { id: string }) => r.id === "remote-exports");
    assert.deepEqual(scoped.appliesTo, ["src/remotes/cart.tsx"]);
    const only = JSON.parse(resolveRules(ws, { files: ["src/app.tsx"], format: "json" }));
    assert.deepEqual(only.rules.map((r: { id: string }) => r.id), ["everywhere"]);
  });

  it("includes each rule's pack, identifier, mode, guidance, and check, plus skills, docs, and commands", async () => {
    const s = await scenario({
      skills: [{ name: "migrate-to-mf2", path: "skills/migrate-to-mf2" }],
      runtimeFiles: { "skills/migrate-to-mf2/SKILL.md": "---\nname: migrate-to-mf2\ndescription: Migrate.\n---\n", "docs/guide.md": "# Guide\n" },
      runtimeManifest: { docs: [{ title: "Runtime guide", path: "docs/guide.md" }] },
    });
    const ws = await load(s.root);
    const md = resolveRules(ws, { format: "markdown" });
    assert.match(md, /## `@example-platform\/runtime#react-singleton` \[machine, locked\]/);
    assert.match(md, /Checked by: `@example-platform\/mf2-adapter#shared-singletons`/);
    assert.match(md, /## Skills\n\n- `example-platform-runtime-migrate-to-mf2`/);
    assert.match(md, /## Reference docs\n\n- Runtime guide \(@example-platform\/runtime\): `node_modules\/@example-platform\/runtime\/docs\/guide.md`/);
    assert.ok(!md.includes(s.root));
  });

  it("returns the rules that fit the budget and names each omitted rule with its command", async () => {
    const long = "Guidance line that is long enough to take space. ".repeat(40);
    const rules = Array.from({ length: 30 }, (_, i) => ({ id: `rule-${String(i).padStart(2, "0")}`, title: `Rule ${i}`, enforcement: "advisory" as const, rationale: "x", guidance: `guidance/r${i}.md` }));
    const files = Object.fromEntries(rules.map((_, i) => [`guidance/r${i}.md`, `${long}\n`]));
    const s = await scenario({ rules, runtimeFiles: files });
    const ws = await load(s.root);
    const out = resolveRules(ws, { format: "markdown", budgetBytes: 16 * 1024 });
    assert.ok(Buffer.byteLength(out) <= 16 * 1024);
    assert.match(out, /## Omitted to stay within 16 KiB/);
    const omitted = [...out.matchAll(/run `npx --no de-web-sdk resolve --rule (\S+)`/g)].map((m) => m[1]);
    const included = [...out.matchAll(/^## `(\S+)`/gm)].map((m) => m[1]);
    assert.equal(new Set([...omitted, ...included]).size, 30);
  });

  it("returns one rule by reference", async () => {
    const s = await scenario();
    const ws = await load(s.root);
    const json = JSON.parse(resolveRules(ws, { format: "json", rule: `${RUNTIME_PACK}#react-singleton` }));
    assert.deepEqual(json.rules.map((r: { ref: string }) => r.ref), [`${RUNTIME_PACK}#react-singleton`]);
  });
});

describe("feedback", () => {
  it("prints the channel's link with the report filled in", async () => {
    const s = await scenario();
    const ws = await load(s.root);
    const fb = createFeedback(ws, { rule: `${RUNTIME_PACK}#react-singleton`, kind: "false-positive", message: "Our widget ships its own React.", sdkVersion: "0.1.0" });
    assert.equal(fb.prefilled, true);
    assert.match(fb.link, /^https:\/\/git\.example\.com\/platform\/pack\/issues\/new\?title=%5Bfalse-positive%5D/);
    assert.match(decodeURIComponent(fb.link), /"rule": "react-singleton"/);
    assert.equal(fb.report.packVersion, "1.0.0");
    assert.match(fb.report.packDigest!, /^sha256:/);
  });

  it("prints a support page's link and the report to paste when the channel takes no prefilled content", async () => {
    const s = await scenario({ runtimeManifest: { feedback: "https://support.example.com/web-runtime" } });
    const ws = await load(s.root);
    const fb = createFeedback(ws, { rule: `${RUNTIME_PACK}#react-singleton`, kind: "unclear-guidance", message: "Which version?", sdkVersion: "0" });
    assert.equal(fb.prefilled, false);
    assert.equal(fb.link, "https://support.example.com/web-runtime");
  });

  it("includes no file contents unless the reporter names lines", async () => {
    const s = await scenario({ files: { "src/secret.ts": "const token = 'abc';\nconst other = 1;\n" } });
    const ws = await load(s.root);
    const plain = createFeedback(ws, { rule: `${RUNTIME_PACK}#react-singleton`, kind: "false-positive", message: "Wrong.", sdkVersion: "0" });
    assert.ok(!JSON.stringify(plain.report).includes("abc"));
    assert.equal(plain.report.lines, undefined);
    const withLines = createFeedback(ws, { rule: `${RUNTIME_PACK}#react-singleton`, kind: "false-positive", message: "Wrong.", lines: ["src/secret.ts:2"], sdkVersion: "0" });
    assert.deepEqual(withLines.report.lines, [{ file: "src/secret.ts", start: 2, end: 2, text: "const other = 1;" }]);
  });

  it("files feedback on local rules against the local pack's channel", async () => {
    const s = await scenario();
    write(s.root, ".de-web-sdk/local/pack.json", { specVersion: "0", owner: { team: "Payments" }, feedback: "https://git.example.com/payments/issues/new?title={title}", rules: [{ id: "use-api-client", title: "Use the client", enforcement: "advisory", rationale: "x" }] });
    const ws = await load(s.root);
    const fb = createFeedback(ws, { rule: "local#use-api-client", kind: "unclear-guidance", message: "Which client?", sdkVersion: "0" });
    assert.match(fb.link, /^https:\/\/git\.example\.com\/payments\/issues\/new\?title=/);
  });

  it("refuses an unknown kind and names the allowed ones", async () => {
    const s = await scenario();
    const ws = await load(s.root);
    assert.throws(() => createFeedback(ws, { rule: `${RUNTIME_PACK}#react-singleton`, kind: "rant" as never, message: "x", sdkVersion: "0" }), (e: unknown) => e instanceof SdkError && /false-positive/.test(e.message));
  });
});
