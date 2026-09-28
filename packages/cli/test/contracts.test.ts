import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSchema } from "@de-web-sdk/core";
import { main } from "../src/main.ts";
import { write } from "../../core/test/helpers.ts";
import { machine, ADAPTER_PACK, RUNTIME_PACK, scenario, setConfig } from "../../core/test/scenario.ts";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.resolve(here, "../../core/schema");
const goldenDir = path.join(here, "golden");

function ajv() {
  const Ajv2020 = require("ajv/dist/2020.js").default;
  const a = new Ajv2020({ allErrors: true, strict: false });
  for (const f of readdirSync(path.join(schemaDir, "output"))) a.addSchema(JSON.parse(readFileSync(path.join(schemaDir, "output", f), "utf8")));
  return a;
}

function assertValid(name: string, value: unknown) {
  const validate = ajv().getSchema(`https://schemas.example.com/de-web-sdk/output/${name}.v1.json`);
  assert.ok(validate, `no schema for ${name}`);
  const ok = validate(value);
  assert.ok(ok, `${name} output doesn't match its schema: ${JSON.stringify(validate.errors)}`);
}

async function run(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, { cwd, env: { ...process.env, DE_WEB_SDK_OFFLINE: "1", ...env }, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), interactive: false, rootKeys: [], version: "0.1.0" });
  return { code, stdout, stderr };
}

/** Compares output with a committed golden file. Set UPDATE_GOLDEN=1 to rewrite them. */
function golden(name: string, actual: string) {
  const file = path.join(goldenDir, name);
  if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
    mkdirSync(goldenDir, { recursive: true });
    writeFileSync(file, actual);
  }
  assert.equal(actual, readFileSync(file, "utf8"), `${name} differs from its golden file`);
}

describe("example manifests", () => {
  const examples = readdirSync(path.join(schemaDir, "examples")).filter((f) => f.endsWith(".json"));
  it("covers every pack kind", () => {
    assert.deepEqual(examples.sort(), ["adapter.json", "bundle.json", "embedded.json", "local.json", "standalone.json", "wrapper.json"]);
  });
  for (const file of examples) {
    it(`validates ${file} against the schema`, () => {
      const manifest = JSON.parse(readFileSync(path.join(schemaDir, "examples", file), "utf8"));
      assert.deepEqual(validateSchema(manifest, { local: file === "local.json" }), []);
    });
  }
  it("fails on an invalid edit", () => {
    const manifest = JSON.parse(readFileSync(path.join(schemaDir, "examples", "standalone.json"), "utf8"));
    manifest.rules[0].enforcement = "required";
    assert.equal(validateSchema(manifest).length, 1);
  });
});

describe("JSON output contracts", () => {
  it("matches the published schemas for check, resolve, sync, init, feedback, the resolution record, and failures", async () => {
    const s = await scenario();
    assertValid("sync", JSON.parse((await run(s.root, ["sync", "--format", "json"])).stdout));
    assertValid("init", JSON.parse((await run(s.root, ["init", "--format", "json", "--no-install"])).stdout));
    assertValid("check", JSON.parse((await run(s.root, ["check", "--format", "json", "--record", "record.json"])).stdout));
    assertValid("resolution-record", JSON.parse(readFileSync(path.join(s.root, "record.json"), "utf8")));
    assertValid("resolve", JSON.parse((await run(s.root, ["resolve", "src/app.tsx", "--format", "json"])).stdout));
    assertValid("feedback", JSON.parse((await run(s.root, ["feedback", `${RUNTIME_PACK}#react-singleton`, "--kind", "false-positive", "--message", "x", "--format", "json"])).stdout));
    const withSkill = await scenario({ skills: [{ name: "setup", path: "skills/setup" }], runtimeFiles: { "skills/setup/SKILL.md": "---\nname: setup\ndescription: Set up.\n---\nDo it.\n", "skills/setup/notes.md": "Notes.\n" } });
    assertValid("skills", JSON.parse((await run(withSkill.root, ["skill", "--format", "json"])).stdout));
    assertValid("skill", JSON.parse((await run(withSkill.root, ["skill", "example-platform-runtime-setup", "--format", "json"])).stdout));
    assertValid("skill-file", JSON.parse((await run(withSkill.root, ["skill", "example-platform-runtime-setup", "--file", "notes.md", "--format", "json"])).stdout));
    write(s.runtimeDir, "guidance/lazy-remotes.md", "tampered\n");
    const failure = await run(s.root, ["check", "--format", "json"]);
    assert.equal(failure.code, 3);
    assertValid("failure", JSON.parse(failure.stdout));
  });

  it("fails schema validation when a field is renamed", () => {
    const validate = ajv().getSchema("https://schemas.example.com/de-web-sdk/output/resolve.v1.json");
    assert.equal(validate({ schemaVersion: 1, kind: "resolve", paths: [], rules: [], skills: [], docs: [], commands: [], omitted: [], budgetBytes: 1 }), false);
  });
});

describe("check output for each exit code", () => {
  const cases: Array<[string, number, (root: string) => void]> = [
    ["exit-0", 0, (root) => write(root, "dist/mf-manifest.json", JSON.stringify({ exposes: [{}], shared: [{ name: "react", singleton: true }] }))],
    ["exit-1", 1, () => undefined],
    ["exit-2", 2, (root) => setConfig(root, { mode: "enforce", exceptions: [{ rule: `${RUNTIME_PACK}#react-singleton`, owner: "payments-web", reason: "Old.", expires: "2020-01-01" }] })],
    ["exit-3", 3, (root) => write(root, "dist/mf-manifest.json", "{\"shared\": []}")],
  ];
  for (const [name, code, setup] of cases) {
    it(`explains itself and exits with ${code}`, async () => {
      const rules = name === "exit-3" ? [machine("crashes", "crash")] : undefined;
      const s = await scenario({ rules, files: { "dist/mf-manifest.json": JSON.stringify({ exposes: [{}], shared: [{ name: "react", singleton: false }] }) } });
      await run(s.root, ["sync"]);
      setup(s.root);
      const text = await run(s.root, ["check"]);
      const json = await run(s.root, ["check", "--format", "json"]);
      assert.equal(text.code, code, text.stdout + text.stderr);
      assert.equal(json.code, code);
      golden(`check-${name}.txt`, text.stdout + text.stderr);
      golden(`check-${name}.json`, json.stdout);
    });
  }
  void ADAPTER_PACK;
});
