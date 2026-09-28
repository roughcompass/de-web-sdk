import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { formatJson, hasErrors, MANIFEST_FILE, SdkError, todayUtc, writeFileAtomic, type Diagnostic, type Manifest } from "@de-web-sdk/core";
import { evaluateGate, type GateResult } from "./evals/gate.ts";
import type { EvalProfile } from "./evals/profile.ts";
import { readRuns } from "./evals/records.ts";
import { computeDigests, contentDigest, type PackSource } from "./source.ts";
import { validateSource } from "./validate.ts";

export interface BuildOptions {
  source: PackSource;
  profile?: EvalProfile;
  /** Directory for the npm tarball. Omit to skip the tarball. */
  out?: string;
  now?: Date;
}

export interface BuildResult {
  ok: boolean;
  manifestPath: string;
  digest: string;
  tarball?: string;
  gate?: GateResult;
  diagnostics: Diagnostic[];
}

/** Keeps the source manifest's field order and puts generated fields last. */
function builtManifest(manifest: Manifest, files: Record<string, string>, gate: GateResult | undefined): Manifest {
  const { files: _f, evals: _e, ...rest } = manifest;
  const out: Manifest = { ...rest } as Manifest;
  if (gate) out.evals = { summary: gate.summary, overrides: gate.overrides };
  out.files = files;
  return out;
}

export function packTarball(source: PackSource, out: string): string {
  mkdirSync(out, { recursive: true });
  const json = execFileSync("npm", ["pack", "--pack-destination", out, "--json", "--ignore-scripts"], { cwd: source.packageDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const name = (JSON.parse(json) as Array<{ filename: string }>)[0]!.filename;
  return path.join(out, name);
}

/**
 * `build`: validates, rejects hidden characters, computes every published
 * file's digest, applies the eval gate to packs with rules, and writes a
 * deterministic manifest and an npm tarball.
 */
export async function buildPack(options: BuildOptions): Promise<BuildResult> {
  const { source } = options;
  const validation = await validateSource(source, { checkDigests: false });
  if (hasErrors(validation.diagnostics)) {
    throw new SdkError("config", "The pack has errors", validation.diagnostics.filter((d) => d.severity === "error"));
  }
  const files = computeDigests(source, validation.published);
  const digest = contentDigest(source.manifest, files);
  let gate: GateResult | undefined;
  if (source.manifest.rules?.length) {
    if (!options.profile) throw new SdkError("usage", "A pack with rules needs the eval profile to build. Pass --profile or set DE_WEB_SDK_EVAL_PROFILE");
    gate = evaluateGate(readRuns(source.dir), digest, options.profile, source.evalConfig, todayUtc(options.now));
  }
  const manifestPath = path.join(source.dir, MANIFEST_FILE);
  const result: BuildResult = { ok: !gate || gate.ok, manifestPath, digest, gate, diagnostics: validation.diagnostics };
  if (!result.ok) return result;
  await writeFileAtomic(manifestPath, formatJson(builtManifest(source.manifest, files, gate)));
  if (options.out) result.tarball = packTarball(source, options.out);
  return result;
}
