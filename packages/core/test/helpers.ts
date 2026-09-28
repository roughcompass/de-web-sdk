import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bundleToJSON } from "@sigstore/bundle";
import { MessageSignatureBundleBuilder } from "@sigstore/sign";
import { digestOf, encodePublicKey, keyId, type Manifest } from "../src/index.ts";

export const SCHEMA = "https://schemas.example.com/agent-pack/v0.json";

export function tmpDir(prefix = "dws-"): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(root: string, rel: string, content: string | object): string {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  return abs;
}

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  encoded: string;
  id: string;
}

export function makeKeys(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicKey, encoded: encodePublicKey(publicKey), id: keyId(publicKey) };
}

/** Signs bytes into a Sigstore bundle with a producer key, as the producer toolkit does. */
export async function signBundle(data: Buffer, keys: KeyPair): Promise<unknown> {
  const builder = new MessageSignatureBundleBuilder({
    signer: {
      sign: async (payload: Buffer) => ({
        signature: cryptoSign("sha256", payload, keys.privateKey),
        key: { $case: "publicKey" as const, publicKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(), hint: keys.id },
      }),
    },
    witnesses: [],
  });
  return bundleToJSON(await builder.create({ data }));
}

export function baseManifest(id: string, extra: Partial<Manifest> = {}): Manifest {
  return {
    $schema: SCHEMA,
    specVersion: "0",
    id,
    version: "1.0.0",
    owner: { team: "Platform Web Runtime", contact: "#platform-web-runtime" },
    feedback: "https://git.example.com/platform/pack/issues/new?title={title}&body={body}",
    ...extra,
  };
}

export interface PackSpec {
  name: string;
  version?: string;
  manifest?: Partial<Manifest>;
  files?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  bin?: Record<string, string>;
  /** Sign with this key. Omit to publish without provenance. */
  keys?: KeyPair;
  /** Install under this directory instead of `<repo>/node_modules`. */
  into?: string;
  /** Embed the pack in this subdirectory of a library package. */
  embedAt?: string;
  skipDigests?: boolean;
  /** Extra package.json fields. */
  packageJson?: Record<string, unknown>;
}

/** Installs a built pack into a repo's node_modules, with digests and an optional signature. */
export async function installPack(repo: string, spec: PackSpec): Promise<string> {
  const version = spec.version ?? "1.0.0";
  const pkgDir = path.join(spec.into ?? path.join(repo, "node_modules"), ...spec.name.split("/"));
  const packDir = spec.embedAt ? path.join(pkgDir, spec.embedAt) : pkgDir;
  // Package managers replace a package's directory on install.
  rmSync(pkgDir, { recursive: true, force: true });
  const pkg: Record<string, unknown> = { name: spec.name, version, ...spec.packageJson };
  if (spec.dependencies) pkg.dependencies = spec.dependencies;
  if (spec.peerDependencies) pkg.peerDependencies = spec.peerDependencies;
  if (spec.bin) pkg.bin = spec.bin;
  if (spec.embedAt) pkg.agentPack = `./${spec.embedAt}`;
  write(pkgDir, "package.json", pkg);
  for (const [rel, content] of Object.entries(spec.files ?? {})) write(packDir, rel, content);
  const manifest: Manifest = { ...baseManifest(spec.name), version, ...spec.manifest };
  if (!spec.skipDigests) {
    const files: Record<string, string> = {};
    const listed = { ...(spec.files ?? {}) };
    if (!spec.embedAt) listed["package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;
    for (const rel of Object.keys(listed).sort()) files[rel] = digestOf(listed[rel]!);
    manifest.files = files;
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  write(packDir, "pack.json", bytes.toString());
  if (spec.keys) write(packDir, "pack.sigstore.json", (await signBundle(bytes, spec.keys)) as object);
  return pkgDir;
}

export interface RepoSpec {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  config?: object;
  trust?: object;
  files?: Record<string, string>;
  git?: boolean;
}

export function makeRepo(spec: RepoSpec = {}): string {
  const root = tmpDir("dws-repo-");
  write(root, "package.json", { name: "fixture-app", version: "0.0.0", private: true, dependencies: spec.dependencies ?? {}, devDependencies: spec.devDependencies ?? {} });
  if (spec.config) write(root, ".de-web-sdk/config.json", spec.config);
  if (spec.trust) write(root, ".de-web-sdk/trust.json", spec.trust);
  for (const [rel, content] of Object.entries(spec.files ?? {})) write(root, rel, content);
  if (spec.git) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
  }
  return root;
}

export function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

export function trustFor(scope: string, keys: KeyPair): object {
  return { scopes: { [scope]: { keys: [keys.encoded] } } };
}

/** An adapter module that reports a violation for each listed file containing `needle`. */
export const GREP_ADAPTER = `
export default async function check(ctx) {
  const results = [];
  for (const file of ctx.files) {
    const text = await ctx.readText(file);
    if (text === undefined) continue;
    const lines = text.split("\\n");
    lines.forEach((line, i) => {
      if (line.includes(ctx.options.needle)) {
        results.push(ctx.result({ file, line: i + 1, message: "Found " + ctx.options.needle, fingerprint: ctx.options.needle + ":" + line.trim() }));
      }
    });
  }
  return { results };
}
`;

export const noop = () => undefined;
