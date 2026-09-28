import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { verifyKeySignature } from "@de-web-sdk/core";
import { tmpDir, write } from "../../core/test/helpers.ts";
import { producerRepo, toolkit } from "./fixture.ts";

const read = (dir: string, rel: string) => readFileSync(path.join(dir, rel), "utf8");

describe("producer toolkit: new and validate", () => {
  it("scaffolds a pack that passes validate unedited", async () => {
    const parent = tmpDir();
    const created = await toolkit(parent, ["new", "@example-analytics/tracking", "--owner", "Analytics", "--feedback", "https://git.example.com/analytics/issues/new"]);
    assert.equal(created.code, 0, created.stderr);
    const dir = path.join(parent, "tracking");
    const manifest = JSON.parse(read(dir, "pack.json"));
    assert.equal(manifest.rules.length, 1);
    assert.ok(existsSync(path.join(dir, "guidance/example-rule.md")));
    assert.ok(existsSync(path.join(dir, "evals/config.json")));
    assert.ok(existsSync(path.join(dir, "evals/tasks/example-task.json")));
    assert.match(read(dir, ".gitignore"), /^keys\/$/m, "keygen's suggested folder stays out of git");
    assert.match(created.stdout, /Run `npm install` there, then `npx --no de-web-sdk-pack validate`/);
    const validated = await toolkit(dir, ["validate"]);
    assert.equal(validated.code, 0, validated.stderr + validated.stdout);
  });

  it("reports three invalid fields in two files in one run, with files and fields", async () => {
    const { dir } = producerRepo();
    const manifest = JSON.parse(read(dir, "pack.json"));
    manifest.rules[1].enforcement = "mandatory";
    delete manifest.owner;
    write(dir, "pack.json", manifest);
    const task = JSON.parse(read(dir, "evals/tasks/confirm.json"));
    task.graders = [];
    write(dir, "evals/tasks/confirm.json", task);
    const out = await toolkit(dir, ["validate", "--format", "json"]);
    assert.equal(out.code, 1);
    const errors = JSON.parse(out.stdout).diagnostics.filter((d: { severity: string }) => d.severity === "error");
    const where = errors.map((d: { file: string; field: string }) => `${d.file}:${d.field}`).sort();
    assert.deepEqual(where, ["evals/tasks/confirm.json:graders", "pack.json:owner", "pack.json:rules[1].enforcement"]);
  });

  it("fails when a check misses a positive fixture, naming the rule and fixture", async () => {
    const { dir } = producerRepo();
    write(dir, "fixtures/no-console/positive/sneaky/src/b.ts", "console.info('not caught');\n");
    const out = await toolkit(dir, ["validate"]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /Machine rule "no-console": its check doesn't flag positive fixture fixtures\/no-console\/positive\/sneaky/);
  });

  it("fails when a machine rule has no fixtures", async () => {
    const { dir } = producerRepo();
    const { rmSync } = await import("node:fs");
    rmSync(path.join(dir, "fixtures"), { recursive: true });
    const out = await toolkit(dir, ["validate"]);
    assert.match(out.stderr, /needs at least one positive fixture/);
  });

  it("names the directory when a library's named pack directory has no manifest", async () => {
    const dir = tmpDir();
    write(dir, "package.json", { name: "@example-ds/core", version: "4.0.0", agentPack: "./agent-pack" });
    const out = await toolkit(dir, ["validate"]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /"\.\/agent-pack".*no pack\.json/);
  });

  it("requires an eval task for a pack with rules, and not for an adapter-only pack", async () => {
    const { dir } = producerRepo();
    const { rmSync } = await import("node:fs");
    rmSync(path.join(dir, "evals"), { recursive: true });
    const out = await toolkit(dir, ["validate"]);
    assert.match(out.stderr, /at least one eval task/);

    const adapters = tmpDir();
    write(adapters, "package.json", { name: "@example-platform/adapters", version: "1.0.0", files: ["pack.json", "adapters"] });
    write(adapters, "adapters/grep.mjs", "export default () => ({ results: [] });\n");
    write(adapters, "pack.json", { $schema: "https://schemas.example.com/agent-pack/v0.json", specVersion: "0", id: "@example-platform/adapters", version: "1.0.0", owner: { team: "P" }, feedback: "https://x/issues", adapters: [{ name: "grep", module: "adapters/grep.mjs" }] });
    assert.equal((await toolkit(adapters, ["validate"])).code, 0);
  });

  it("warns about a rule no eval task exercises", async () => {
    const { dir } = producerRepo();
    const task = JSON.parse(read(dir, "evals/tasks/confirm.json"));
    task.exercises = ["no-console"];
    write(dir, "evals/tasks/confirm.json", task);
    const out = await toolkit(dir, ["validate"]);
    assert.equal(out.code, 0);
    assert.match(out.stderr, /warning: No eval task exercises rule "use-dialog"/);
  });

  it("refuses endpoints and credentials in eval configuration", async () => {
    const { dir } = producerRepo();
    const config = JSON.parse(read(dir, "evals/config.json"));
    config.endpoint = "https://llm.example.com";
    write(dir, "evals/config.json", config);
    const out = await toolkit(dir, ["validate"]);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /can't hold endpoints or credentials \(endpoint\)/);
  });
});

describe("producer toolkit: build and sign", () => {
  it("fails a pack with rules when no eval results match its content, and says to run the evals", async () => {
    const { dir, profile } = producerRepo();
    const out = await toolkit(dir, ["build", "--profile", profile, "--no-tarball"]);
    assert.equal(out.code, 1);
    assert.match(out.stdout, /No eval results match this pack's content for fake-model\. Run `de-web-sdk-pack eval run`/);
  });

  it("rejects a zero-width space in guidance, naming the file, line, and code point", async () => {
    const { dir, profile } = producerRepo();
    write(dir, "guidance/no-console.md", "Line one.\nUse the​logger.\n");
    const out = await toolkit(dir, ["build", "--profile", profile, "--no-tarball"]);
    assert.equal(out.code, 2);
    assert.match(out.stderr, /guidance\/no-console\.md contains a hidden character, U\+200B .* at line 2/);
  });

  it("builds an adapter-only pack deterministically, with a tarball", async () => {
    const dir = tmpDir();
    write(dir, "package.json", { name: "@example-platform/adapters", version: "1.0.0", files: ["pack.json", "pack.sigstore.json", "adapters"] });
    write(dir, "adapters/grep.mjs", "export default () => ({ results: [] });\n");
    write(dir, "pack.json", { $schema: "https://schemas.example.com/agent-pack/v0.json", specVersion: "0", id: "@example-platform/adapters", version: "1.0.0", owner: { team: "P" }, feedback: "https://x/issues", adapters: [{ name: "grep", module: "adapters/grep.mjs" }] });
    const first = await toolkit(dir, ["build", "--out", "out"]);
    assert.equal(first.code, 0, first.stderr);
    const a = read(dir, "pack.json");
    const second = await toolkit(dir, ["build", "--out", "out"]);
    assert.equal(second.code, 0);
    assert.equal(read(dir, "pack.json"), a);
    const manifest = JSON.parse(a);
    assert.deepEqual(Object.keys(manifest.files).sort(), ["adapters/grep.mjs", "package.json"]);
    assert.ok(existsSync(path.join(dir, "out/example-platform-adapters-1.0.0.tgz")));
    assert.equal((await toolkit(dir, ["validate"])).code, 0, "a built pack validates with its digests");
  });

  it("signs the built manifest so the producer's key verifies it, and a one-byte edit fails", async () => {
    const dir = tmpDir();
    write(dir, "package.json", { name: "@example-platform/adapters", version: "1.0.0", files: ["pack.json", "pack.sigstore.json", "adapters"] });
    write(dir, "adapters/grep.mjs", "export default () => ({ results: [] });\n");
    write(dir, "pack.json", { $schema: "https://schemas.example.com/agent-pack/v0.json", specVersion: "0", id: "@example-platform/adapters", version: "1.0.0", owner: { team: "P" }, feedback: "https://x/issues", adapters: [{ name: "grep", module: "adapters/grep.mjs" }] });
    assert.equal((await toolkit(dir, ["keygen", "--out", "keys"])).code, 0);
    assert.equal((await toolkit(dir, ["sign", "--key", "keys/private.pem"])).code, 2, "sign refuses an unbuilt manifest");
    await toolkit(dir, ["build", "--no-tarball"]);
    const signed = await toolkit(dir, ["sign", "--key", "env:PACK_KEY", "--out", "out"], { PACK_KEY: read(dir, "keys/private.pem") });
    assert.equal(signed.code, 0, signed.stderr);
    const bundle = JSON.parse(read(dir, "pack.sigstore.json"));
    const pub = createPublicKey(read(dir, "keys/public.pem"));
    const bytes = readFileSync(path.join(dir, "pack.json"));
    assert.equal(verifyKeySignature(bundle, bytes, [pub]).ok, true);
    bytes[bytes.length - 3] ^= 1;
    assert.equal(verifyKeySignature(bundle, bytes, [pub]).ok, false);
    const tar = (await import("node:child_process")).execFileSync("tar", ["-tzf", path.join(dir, "out/example-platform-adapters-1.0.0.tgz")], { encoding: "utf8" });
    assert.match(tar, /package\/pack\.sigstore\.json/);
  });

  it("warns in validate and refuses to sign after an edit since the last build", async () => {
    const dir = tmpDir();
    write(dir, "package.json", { name: "@example-platform/adapters", version: "1.0.0", files: ["pack.json", "pack.sigstore.json", "adapters"] });
    write(dir, "adapters/grep.mjs", "export default () => ({ results: [] });\n");
    write(dir, "pack.json", { $schema: "https://schemas.example.com/agent-pack/v0.json", specVersion: "0", id: "@example-platform/adapters", version: "1.0.0", owner: { team: "P" }, feedback: "https://x/issues", adapters: [{ name: "grep", module: "adapters/grep.mjs" }] });
    await toolkit(dir, ["build", "--no-tarball"]);
    write(dir, "adapters/grep.mjs", "export default () => ({ results: [], note: 1 });\n");
    const validated = await toolkit(dir, ["validate"]);
    assert.equal(validated.code, 0, validated.stderr);
    assert.match(validated.stderr, /pack\.json lists digests from an earlier build, and adapters\/grep\.mjs has changed since\. Run build again before sign/);
    await toolkit(dir, ["keygen", "--out", "keys"]);
    const refused = await toolkit(dir, ["sign", "--key", "keys/private.pem"]);
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /Files changed since the last build: adapters\/grep\.mjs\. Run build again, then sign/);
  });

  it("writes a private key only its owner can read, won't replace it, and warns when git would commit it", async () => {
    const dir = tmpDir();
    (await import("node:child_process")).execFileSync("git", ["init", "-q"], { cwd: dir });
    const first = await toolkit(dir, ["keygen", "--out", "keys"]);
    assert.equal(first.code, 0);
    assert.match(first.stderr, /keys\/private\.pem is in a git repository and isn't ignored/);
    if (process.platform !== "win32") assert.equal((await import("node:fs")).statSync(path.join(dir, "keys/private.pem")).mode & 0o777, 0o600);
    const again = await toolkit(dir, ["keygen", "--out", "keys"]);
    assert.equal(again.code, 2);
    assert.match(again.stderr, /keys\/private\.pem already exists/);
    write(dir, ".gitignore", "keys/\n");
    const ignored = await toolkit(dir, ["keygen", "--out", "keys2"]);
    assert.match(ignored.stderr, /isn't ignored/);
    write(dir, ".gitignore", "keys/\nkeys2/\n");
    (await import("node:fs")).rmSync(path.join(dir, "keys2"), { recursive: true });
    assert.doesNotMatch((await toolkit(dir, ["keygen", "--out", "keys2"])).stderr, /isn't ignored/);
  });

  it("signs the enterprise trust policy file with a root key", async () => {
    const dir = tmpDir();
    write(dir, "package.json", { name: "@example-platform/trust", version: "1.0.0" });
    write(dir, "trust-policy.json", { policyVersion: 1, scopes: {} });
    write(dir, "pack.json", { $schema: "x", specVersion: "0", id: "@example-platform/trust", version: "1.0.0", owner: { team: "P" }, feedback: "https://x/i" });
    await toolkit(dir, ["keygen", "--out", "root"]);
    const out = await toolkit(dir, ["sign", "--key", "root/private.pem", "--file", "trust-policy.json"]);
    assert.equal(out.code, 0, out.stderr);
    assert.ok(existsSync(path.join(dir, "trust-policy.sigstore.json")));
    writeFileSync(path.join(dir, "unused"), "");
  });
});
