import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.ts";
import { git, installPack, makeKeys, makeRepo, tmpDir, write } from "../../core/test/helpers.ts";
import { RUNTIME_PACK, scenario } from "../../core/test/scenario.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, "../bin/de-web-sdk.js");

async function run(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, DE_WEB_SDK_OFFLINE: "1", ...env },
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    interactive: false,
    rootKeys: [],
  });
  return { code, stdout, stderr };
}

/** Builds a signed pack and packs it into an npm tarball, as a producer would publish it. */
async function packTarball(name: string, keys: ReturnType<typeof makeKeys>, manifest: object = {}) {
  const out = tmpDir("dws-tgz-");
  const into = tmpDir("dws-src-");
  const dir = await installPack(into, { name, keys, manifest, files: { "guidance/a.md": "Do A.\n" } });
  const file = execFileSync("npm", ["pack", "--pack-destination", out, "--silent"], { cwd: dir, encoding: "utf8" }).trim().split("\n").pop()!;
  return path.join(out, file);
}

describe("consumer CLI", () => {
  it("sets up an existing repo with npm: adds the pack, writes configuration, runs sync, and changes no source file", async () => {
    const keys = makeKeys();
    const tarball = await packTarball("@example-platform/baseline", keys, { rules: [{ id: "a", title: "Rule A", enforcement: "advisory", rationale: "x", guidance: "guidance/a.md" }] });
    const root = makeRepo({ git: true, files: { "src/app.tsx": "export {};\n" }, trust: { scopes: { "@example-platform": { keys: [keys.encoded] } } } });
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const { code, stdout } = await run(root, ["init", tarball, "--yes"]);
    assert.equal(code, 0, stdout);
    const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    assert.ok(pkg.devDependencies["@example-platform/baseline"]);
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".de-web-sdk/config.json"), "utf8")), { mode: "report" });
    assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /@example-platform\/baseline#a/);
    const changed = git(root, "status", "--porcelain").split("\n").filter(Boolean).map((l) => l.slice(3));
    assert.ok(!changed.some((f) => f.startsWith("src/")), changed.join(", "));
    assert.ok(changed.includes("package.json"));
  });

  it("sets up a repo with pnpm", async () => {
    const keys = makeKeys();
    const tarball = await packTarball("@example-platform/baseline", keys, { rules: [{ id: "a", title: "Rule A", enforcement: "advisory", rationale: "x" }] });
    const root = makeRepo({ trust: { scopes: { "@example-platform": { keys: [keys.encoded] } } } });
    write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    const probe = spawnSync("pnpm", ["--version"]);
    if (probe.status !== 0) return;
    const { code, stdout, stderr } = await run(root, ["init", tarball, "--yes"]);
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /Running pnpm add --save-dev/);
    assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /@example-platform\/baseline#a/);
  });

  it("sets up a repo with Yarn", async () => {
    const probe = spawnSync("corepack", ["--version"]);
    if (probe.status !== 0) return;
    const keys = makeKeys();
    const tarball = await packTarball("@example-platform/baseline", keys, { rules: [{ id: "a", title: "Rule A", enforcement: "advisory", rationale: "x" }] });
    const root = makeRepo({ trust: { scopes: { "@example-platform": { keys: [keys.encoded] } } } });
    write(root, "yarn.lock", "# yarn lockfile v1\n\n");
    // Yarn 1 through corepack, as a shim on PATH.
    const shim = tmpDir("dws-shim-");
    write(shim, "yarn", "#!/bin/sh\nexec corepack yarn@1.22.22 \"$@\"\n");
    (await import("node:fs")).chmodSync(path.join(shim, "yarn"), 0o755);
    const { code, stdout, stderr } = await run(root, ["init", tarball, "--yes"], { PATH: `${shim}${path.delimiter}${process.env.PATH}`, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
    assert.equal(code, 0, stdout + stderr);
    assert.match(stdout, /Running yarn add --dev/);
    assert.ok(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).devDependencies["@example-platform/baseline"]);
    assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /@example-platform\/baseline#a/);
  });

  it("completes the template's setup without a terminal, recording facts and enforce mode", async () => {
    const root = makeRepo();
    const { code } = await run(root, ["init", "--yes", "--enforce", "--fact", "moduleFederation=2", "--fact", "role=remote", "--fact", "bundler=vite", "--trust-policy", "@example-platform/trust", "--no-install"], {});
    assert.equal(code, 3, "the trust policy package isn't installed, so sync fails closed");
    const config = JSON.parse(readFileSync(path.join(root, ".de-web-sdk/config.json"), "utf8"));
    assert.deepEqual(config, { mode: "enforce", facts: { moduleFederation: "2", role: "remote", bundler: "vite" } });
    assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".de-web-sdk/trust.json"), "utf8")), { extends: "@example-platform/trust", scopes: {} });
  });

  it("completes init for an agent that names no packs, and reports that none are installed", async () => {
    const root = makeRepo();
    const { code, stdout } = await run(root, ["init"]);
    assert.equal(code, 0);
    assert.match(stdout, /No packs are installed/);
  });

  it("checks only the files an agent names", async () => {
    const s = await scenario({ files: { "dist/mf-manifest.json": JSON.stringify({ exposes: [{}], shared: [{ name: "react", singleton: false }] }) } });
    const other = await run(s.root, ["check", "src/app.tsx"]);
    assert.equal(other.code, 0, other.stdout + other.stderr);
    const manifest = await run(s.root, ["check", "dist/mf-manifest.json"]);
    assert.equal(manifest.code, 1);
  });

  it("names the flag in a usage error", async () => {
    const root = makeRepo();
    const { code, stderr } = await run(root, ["check", "--strict-mode"]);
    assert.equal(code, 2);
    assert.match(stderr, /--strict-mode/);
  });

  it("switches every command to JSON with DE_WEB_SDK_FORMAT", async () => {
    const s = await scenario();
    const out = await run(s.root, ["check"], { DE_WEB_SDK_FORMAT: "json" });
    assert.equal(out.code, 1);
    const json = JSON.parse(out.stdout);
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.kind, "check");
    const resolve = JSON.parse((await run(s.root, ["resolve", "src/app.tsx"], { DE_WEB_SDK_FORMAT: "json" })).stdout);
    assert.equal(resolve.kind, "resolve");
  });

  it("writes JUnit and a resolution record to files", async () => {
    const s = await scenario();
    const out = await run(s.root, ["check", "--format", "junit", "--output", "reports/check.xml", "--record", "reports/record.json"]);
    assert.equal(out.code, 1);
    assert.match(readFileSync(path.join(s.root, "reports/check.xml"), "utf8"), /<testsuites name="de-web-sdk check"/);
    assert.equal(JSON.parse(readFileSync(path.join(s.root, "reports/record.json"), "utf8")).kind, "resolution-record");
    assert.match(out.stdout, /de-web-sdk check: enforce mode/);
  });

  it("prints a prefilled feedback link", async () => {
    const s = await scenario();
    const out = await run(s.root, ["feedback", `${RUNTIME_PACK}#react-singleton`, "--kind", "false-positive", "--message", "Our widget ships React."]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /https:\/\/git\.example\.com\/platform\/pack\/issues\/new\?title=/);
  });

  it("shows eval gate overrides to consumers during sync", async () => {
    const s = await scenario({ runtimeManifest: { evals: { overrides: [{ model: "copilot-gpt", reason: "Harness can't run MF builds yet.", approvedBy: "platform-web-runtime", expires: "2099-01-01" }] } } });
    const out = await run(s.root, ["sync"]);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /override in @example-platform\/runtime for model copilot-gpt: "Harness can't run MF builds yet\." Approved by platform-web-runtime/);
  });
});

describe("agent contract: no terminal, no network", () => {
  before(() => {
    execFileSync(process.execPath, [path.resolve(here, "../../../node_modules/typescript/bin/tsc"), "-b", path.resolve(here, "..")], { stdio: "inherit" });
  });

  it("runs sync, resolve, and check from the built binary without prompting", async () => {
    const s = await scenario({ files: { "dist/mf-manifest.json": JSON.stringify({ exposes: [{}], shared: [] }) } });
    for (const [args, expected] of [
      [["sync"], 0],
      [["resolve", "src/app.tsx"], 0],
      [["check"], 0],
      [["init"], 0],
      [["feedback", `${RUNTIME_PACK}#react-singleton`, "--kind", "false-positive"], 2],
    ] as const) {
      const r = spawnSync(process.execPath, [BIN, ...args, "--offline"], { cwd: s.root, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, encoding: "utf8", env: { ...process.env, npm_config_registry: "http://127.0.0.1:9" } });
      assert.equal(r.status, expected, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    }
    const missing = spawnSync(process.execPath, [BIN, "feedback", `${RUNTIME_PACK}#react-singleton`, "--kind", "false-positive"], { cwd: s.root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    assert.match(missing.stderr, /--message/);
  });
});

describe("npm provenance, fetched once and verified offline", () => {
  const attestation = readFileSync(path.resolve(here, "../../core/test/fixtures/provenance/@sigstore__core@4.0.1.json"));
  let server: Server;
  let port = 0;
  let hits = 0;
  before(async () => {
    server = createServer((req, res) => {
      hits += 1;
      if (req.url === "/-/npm/v1/attestations/@sigstore%2fcore@4.0.1") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(attestation);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.close());

  it("caches the attestation during an online sync, then verifies offline", async () => {
    const root = makeRepo({
      devDependencies: { "@sigstore/core": "4.0.1" },
      trust: { scopes: { "@sigstore": { provenance: [{ repository: "github.com/sigstore/sigstore-js" }] } } },
    });
    write(root, ".npmrc", `registry=http://127.0.0.1:${port}/\n`);
    write(root, "package-lock.json", { lockfileVersion: 3, packages: { "node_modules/@sigstore/core": { version: "4.0.1", integrity: "sha512-9v5hRjujn5NXq8o7XFEUgLyAtdr5Iisb4pzM05u3K61IS5q3hP3luWAndk0RkPPLTUFoTbg7Vb84UQ1ZQeajWQ==" } } });
    await installPack(root, { name: "@sigstore/core", version: "4.0.1", manifest: { rules: [{ id: "r", title: "R", enforcement: "advisory", rationale: "x" }] } });

    const online = await run(root, ["sync"], { DE_WEB_SDK_OFFLINE: "0" });
    assert.equal(online.code, 0, online.stderr);
    assert.equal(hits, 1);
    assert.ok(existsSync(path.join(root, ".de-web-sdk/cache/provenance/@sigstore__core@4.0.1.json")));

    const offline = await run(root, ["check", "--offline"]);
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(hits, 1);

    rmSync(path.join(root, ".de-web-sdk/cache"), { recursive: true });
    const cold = await run(root, ["check", "--offline"]);
    assert.equal(cold.code, 3);
    assert.match(cold.stderr, /Run `de-web-sdk sync` once with registry access/);
  });

  it("refuses provenance from a repository the policy doesn't list", async () => {
    const root = makeRepo({
      devDependencies: { "@sigstore/core": "4.0.1" },
      trust: { scopes: { "@sigstore": { provenance: [{ repository: "github.com/someone/fork" }] } } },
    });
    write(root, ".de-web-sdk/cache/provenance/@sigstore__core@4.0.1.json", attestation.toString());
    await installPack(root, { name: "@sigstore/core", version: "4.0.1" });
    const out = await run(root, ["sync", "--offline"]);
    assert.equal(out.code, 3);
    assert.match(out.stderr, /github\.com\/sigstore\/sigstore-js.*isn't listed/);
  });
});
