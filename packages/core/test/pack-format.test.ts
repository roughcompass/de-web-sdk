import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import {
  findHiddenCharacter,
  loadSchemas,
  schemaErrorFields,
  validatePackDir,
  validateSchema,
  type Manifest,
} from "../src/index.ts";
import { baseManifest, installPack, makeRepo, tmpDir, write } from "./helpers.ts";

const require = createRequire(import.meta.url);

function codes(ds: Array<{ code: string }>) {
  return ds.map((d) => d.code);
}

describe("pack format: schema", () => {
  it("accepts a complete manifest", () => {
    assert.deepEqual(validateSchema(baseManifest("@example-platform/runtime")), []);
  });

  it("names both missing fields when owner and feedback are absent", () => {
    const m = baseManifest("@example-platform/runtime") as Partial<Manifest>;
    delete m.owner;
    delete m.feedback;
    const ds = validateSchema(m);
    const fields = ds.map((d) => d.field).sort();
    assert.deepEqual(fields, ["feedback", "owner"]);
    assert.ok(ds.every((d) => d.file === "pack.json"));
  });

  it("names the rule that has no rationale", () => {
    const m = baseManifest("@x/p", { rules: [{ id: "no-raw", title: "No raw values", enforcement: "advisory" } as never] });
    const ds = validateSchema(m);
    assert.equal(ds.length, 1);
    assert.match(ds[0]!.message, /Rule "no-raw"/);
    assert.equal(ds[0]!.field, "rules[0].rationale");
  });

  it("lists the allowed values for an unknown enforcement mode", () => {
    const m = baseManifest("@x/p", { rules: [{ id: "r", title: "T", enforcement: "strict", rationale: "why" } as never] });
    const ds = validateSchema(m);
    assert.equal(ds.length, 1);
    assert.match(ds[0]!.message, /"machine", "advisory"/);
  });

  it("fails a machine rule without a check and names it", () => {
    const m = baseManifest("@x/p", { rules: [{ id: "needs-check", title: "T", enforcement: "machine", rationale: "why" }] });
    const ds = validateSchema(m);
    assert.equal(ds.length, 1);
    assert.match(ds[0]!.message, /Rule "needs-check".*check/);
  });

  it("names an undefined fact in a condition", () => {
    const m = baseManifest("@x/p", { rules: [{ id: "r", title: "T", enforcement: "advisory", rationale: "why", appliesWhen: { framework: ["next"] } as never }] });
    const ds = validateSchema(m);
    assert.equal(ds[0]!.code, "schema.undefinedFact");
    assert.match(ds[0]!.message, /"framework"/);
  });

  it("ignores fields from a newer minor version", () => {
    const m = { ...baseManifest("@x/p", { specVersion: "0.3" }), mcpTools: [{ name: "x" }] };
    assert.deepEqual(validateSchema(m), []);
  });

  it("reports the same fields as a generic JSON Schema validator", () => {
    const Ajv2020 = require("ajv/dist/2020.js").default;
    const generic = new Ajv2020({ allErrors: true, strict: false });
    const schemas = loadSchemas();
    generic.addSchema(schemas.published);
    const validate = generic.getSchema("https://schemas.example.com/agent-pack/v0.json");
    const bad = {
      $schema: "x",
      specVersion: "zero",
      id: "Not A Name",
      version: "1",
      owner: {},
      rules: [{ id: "r", title: "T", enforcement: "machine", rationale: "" }],
      files: { "a.md": "md5:abc" },
    };
    validate(bad);
    const genericFields = (validate.errors as Array<{ keyword: string; instancePath: string; params: Record<string, string> }>)
      .filter((e) => e.keyword !== "if")
      .map((e) => (e.keyword === "required" ? `${e.instancePath}/${e.params.missingProperty}` : e.instancePath))
      .sort();
    assert.deepEqual(schemaErrorFields(bad), genericFields);
    assert.ok(genericFields.length >= 7);
  });

  it("publishes a local variant without identifier or version", () => {
    const local = { $schema: "https://schemas.example.com/agent-pack/v0-local.json", specVersion: "0", owner: { team: "Payments" }, feedback: "https://x/issues" };
    assert.deepEqual(validateSchema(local, { local: true }), []);
    assert.ok(validateSchema(local).some((d) => d.field === "id"));
  });
});

describe("pack format: semantic validation", () => {
  it("fails an adapter from an undeclared pack and names the rule and pack", () => {
    const dir = tmpDir();
    const m = baseManifest("@x/p", {
      rules: [{ id: "r", title: "T", enforcement: "machine", rationale: "why", check: { pack: "@x/adapters", adapter: "a" } }],
    });
    const { diagnostics } = validatePackDir(dir, m, { packageJson: { name: "@x/p", version: "1.0.0" } });
    const d = diagnostics.find((x) => x.code === "manifest.adapterPackUndeclared");
    assert.ok(d);
    assert.match(d.message, /Rule "r".*@x\/adapters/);
  });

  it("fails a declared adapter without code", () => {
    const dir = tmpDir();
    const m = baseManifest("@x/p", { adapters: [{ name: "grep", module: "adapters/grep.mjs" }] });
    const { diagnostics } = validatePackDir(dir, m, { packageJson: { name: "@x/p", version: "1.0.0" } });
    assert.ok(diagnostics.some((d) => d.code === "manifest.adapterMissing" && /"grep"/.test(d.message)));
  });

  it("fails a skill without a description", () => {
    const dir = tmpDir();
    write(dir, "skills/setup/SKILL.md", "---\nname: setup\n---\n\nDo it.\n");
    const m = baseManifest("@x/p", { skills: [{ name: "setup", path: "skills/setup" }] });
    const { diagnostics } = validatePackDir(dir, m, { packageJson: { name: "@x/p", version: "1.0.0" } });
    assert.ok(diagnostics.some((d) => d.code === "manifest.skillDescription" && /"setup"/.test(d.message)));
  });

  it("fails a doc entry without a title", () => {
    const m = baseManifest("@x/p", { docs: [{ path: "docs/guide.md" } as never] });
    assert.ok(validateSchema(m).some((d) => d.field === "docs[0].title"));
  });

  it("fails a command whose binary comes from a package the pack doesn't depend on", () => {
    const dir = tmpDir();
    const m = baseManifest("@x/p", { commands: [{ name: "ctx", run: "salt-ds context x", use: "Before UI work", from: "@salt-ds/cli" }] });
    const { diagnostics } = validatePackDir(dir, m, { packageJson: { name: "@x/p", version: "1.0.0" } });
    assert.ok(diagnostics.some((d) => d.code === "manifest.commandUndeclared" && /"ctx"/.test(d.message)));
  });

  it("accepts a wrapper that references a skill in a peer dependency", async () => {
    const repo = makeRepo();
    await installPack(repo, {
      name: "@salt-ds/knowledge",
      files: { "skills/salt-design-system/SKILL.md": "---\nname: salt-design-system\ndescription: Use Salt.\n---\nBody\n" },
      skipDigests: true,
    });
    const dir = path.join(repo, "node_modules/@x/salt-pack");
    write(dir, "package.json", { name: "@x/salt-pack", version: "1.0.0", peerDependencies: { "@salt-ds/knowledge": "^1.0.0" } });
    const m = baseManifest("@x/salt-pack", { skills: [{ name: "salt-design-system", from: "@salt-ds/knowledge", path: "skills/salt-design-system" }] });
    const { diagnostics, delivered } = validatePackDir(dir, m, { packageJson: { name: "@x/salt-pack", version: "1.0.0", peerDependencies: { "@salt-ds/knowledge": "^1.0.0" } } });
    assert.deepEqual(diagnostics.filter((d) => d.severity === "error"), []);
    assert.ok(delivered.some((f) => f.display === "@salt-ds/knowledge/skills/salt-design-system/SKILL.md"));
  });

  it("names the package when a doc references a package that isn't a dependency", () => {
    const dir = tmpDir();
    const m = baseManifest("@x/p", { docs: [{ title: "Guides", from: "@salt-ds/knowledge", path: "markdown/guides" }] });
    const { diagnostics } = validatePackDir(dir, m, { packageJson: { name: "@x/p", version: "1.0.0" } });
    assert.ok(diagnostics.some((d) => d.code === "manifest.fromUndeclared" && /@salt-ds\/knowledge/.test(d.message)));
  });

  it("accepts a bundle that only depends on other packs", () => {
    const dir = tmpDir();
    const m = baseManifest("@x/baseline", { files: {} });
    write(dir, "package.json", "{}");
    const { diagnostics } = validatePackDir(dir, m, {
      packageJson: { name: "@x/baseline", version: "1.0.0", dependencies: { "@x/a": "^1", "@x/b": "^1" } },
      publishedFiles: [],
    });
    assert.deepEqual(diagnostics, []);
  });

  it("names an unlisted file and a file whose digest doesn't match", () => {
    const dir = tmpDir();
    write(dir, "guidance/a.md", "A\n");
    write(dir, "guidance/b.md", "B\n");
    const m = baseManifest("@x/p", { files: { "guidance/a.md": "sha256:" + "0".repeat(64) } });
    const { diagnostics } = validatePackDir(dir, m, { packageJson: { name: "@x/p", version: "1.0.0" } });
    assert.ok(diagnostics.some((d) => d.code === "digest.unlisted" && d.file === "guidance/b.md"));
    assert.ok(diagnostics.some((d) => d.code === "digest.mismatch" && d.file === "guidance/a.md"));
  });

  it("refuses an unsupported major version and names both versions", () => {
    const { diagnostics } = validatePackDir(tmpDir(), baseManifest("@x/p", { specVersion: "1" }), { label: "@x/p" });
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0]!.message, /version 1.*supports version 0/);
  });

  it("reports several errors across files in one run", () => {
    const dir = tmpDir();
    write(dir, "guidance/a.md", "Tag\u{E0041}here\n");
    const m = baseManifest("@x/p", {
      rules: [
        { id: "a", title: "A", enforcement: "advisory", rationale: "why", guidance: "guidance/a.md" },
        { id: "b", title: "B", enforcement: "bogus" as never, rationale: "why" },
        { id: "c", title: "C", enforcement: "advisory", rationale: "why", guidance: "guidance/missing.md" },
      ],
    });
    const { diagnostics } = validatePackDir(dir, m, { packageJson: { name: "@x/p", version: "1.0.0" } });
    const errs = diagnostics.filter((d) => d.severity === "error");
    assert.deepEqual(codes(errs).sort(), ["hidden.character", "manifest.guidanceMissing", "schema.enum"]);
    assert.deepEqual([...new Set(errs.map((d) => d.file))].sort(), ["guidance/a.md", "pack.json"]);
  });
});

describe("hidden characters", () => {
  const cases: Array<[string, number]> = [
    ["tag start", 0xe0000],
    ["tag end", 0xe007f],
    ["LRE", 0x202a],
    ["RLO", 0x202e],
    ["LRI", 0x2066],
    ["PDI", 0x2069],
    ["ZWSP", 0x200b],
    ["ZWJ", 0x200d],
    ["word joiner", 0x2060],
    ["BOM", 0xfeff],
  ];
  for (const [name, cp] of cases) {
    it(`finds ${name} with its line and code point`, () => {
      const hit = findHiddenCharacter(`line one\nline ${String.fromCodePoint(cp)} two\n`);
      assert.ok(hit);
      assert.equal(hit.line, 2);
      assert.equal(hit.codePoint, `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
    });
  }
  it("accepts ordinary text, including emoji and accents", () => {
    assert.equal(findHiddenCharacter("Café ✓ 🚀 naïve\n"), undefined);
  });
});
