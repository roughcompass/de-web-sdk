import { readdirSync } from "node:fs";
import path from "node:path";
import {
  detectFacts,
  error,
  loadConfig,
  matchesPaths,
  MANIFEST_FILE,
  readManifestFile,
  resolveInside,
  resolvePackageDir,
  runAdapter,
  scanHidden,
  isTextFile,
  validatePackDir,
  walkFiles,
  warning,
  type Diagnostic,
  type Rule,
} from "@de-web-sdk/core";
import { publishedFiles, validateEvals, type PackSource } from "./source.ts";

export const FIXTURES_DIR = "fixtures";

function listDirs(abs: string): string[] {
  try {
    return readdirSync(abs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Finds the module for a rule's adapter: in the pack itself, or in a dependency pack. */
function adapterModule(source: PackSource, rule: Rule): { module?: string; reason?: string } {
  const check = rule.check!;
  const own = !check.pack || check.pack === source.manifest.id;
  let dir = source.dir;
  let manifest = source.manifest;
  if (!own) {
    const depDir = resolvePackageDir(source.packageDir, check.pack!);
    if (!depDir) return { reason: `the adapter pack ${check.pack} isn't installed; run npm install` };
    const read = readManifestFile(path.join(depDir, MANIFEST_FILE));
    if (!read.manifest) return { reason: `${check.pack} has no readable ${MANIFEST_FILE}` };
    dir = depDir;
    manifest = read.manifest;
  }
  const entry = manifest.adapters?.find((a) => a.name === check.adapter);
  if (!entry) return { reason: `no adapter named ${check.adapter}` };
  const base = entry.from ? resolvePackageDir(dir, entry.from) : dir;
  if (!base) return { reason: `${entry.from} isn't installed` };
  const module = resolveInside(base, entry.module);
  return module ? { module } : { reason: "the adapter module path is invalid" };
}

/** Runs each machine rule's check on its positive and negative fixtures. */
export async function checkFixtures(source: PackSource, timeoutMs = 60_000): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  for (const rule of source.manifest.rules ?? []) {
    if (rule.enforcement !== "machine" || !rule.check) continue;
    const name = JSON.stringify(rule.id);
    const base = path.join(source.dir, FIXTURES_DIR, rule.id);
    const positive = listDirs(path.join(base, "positive"));
    const negative = listDirs(path.join(base, "negative"));
    if (!positive.length || !negative.length) {
      out.push(
        error("fixtures.missing", `Machine rule ${name} needs at least one positive fixture in ${FIXTURES_DIR}/${rule.id}/positive/ and one negative fixture in ${FIXTURES_DIR}/${rule.id}/negative/`, {
          file: `${FIXTURES_DIR}/${rule.id}`,
        }),
      );
      continue;
    }
    const found = adapterModule(source, rule);
    if (!found.module) {
      out.push(error("fixtures.adapter", `Machine rule ${name}: can't run its check: ${found.reason}`, { file: MANIFEST_FILE, field: "check" }));
      continue;
    }
    for (const [kind, cases] of [["positive", positive], ["negative", negative]] as const) {
      for (const c of cases) {
        const root = path.join(base, kind, c);
        const fixture = `${FIXTURES_DIR}/${rule.id}/${kind}/${c}`;
        const declared = loadConfig(root).config.facts;
        const facts = detectFacts(root, declared).facts;
        const files = walkFiles(root, { skipDirs: ["node_modules", ".git"] }).filter((f) => matchesPaths(rule.paths ?? source.manifest.paths, f));
        const run = await runAdapter({
          module: found.module,
          root,
          rule: `${source.manifest.id}#${rule.id}`,
          facts: { ...facts, packages: { ...facts.packages } },
          options: rule.check.options ?? {},
          files,
          timeoutMs,
        });
        if (!run.ok) {
          out.push(error("fixtures.adapterError", `Machine rule ${name}: its check failed on fixture ${fixture}: ${run.error}`, { file: fixture }));
          continue;
        }
        const hits = run.findings.filter((f) => f.file === "." || matchesPaths(rule.paths ?? source.manifest.paths, f.file));
        if (kind === "positive" && hits.length === 0) {
          out.push(error("fixtures.missed", `Machine rule ${name}: its check doesn't flag positive fixture ${fixture}`, { file: fixture }));
        }
        if (kind === "negative" && hits.length > 0) {
          out.push(error("fixtures.falsePositive", `Machine rule ${name}: its check flags negative fixture ${fixture}: ${hits[0]!.message}`, { file: fixture }));
        }
      }
    }
  }
  return out;
}

export interface ProducerValidation {
  diagnostics: Diagnostic[];
  published: string[];
}

/**
 * The producer toolkit's `validate`: the pack format, eval tasks, fixtures,
 * and hidden characters in every published text file, in one run.
 */
export async function validateSource(source: PackSource, options: { checkDigests?: boolean; runFixtures?: boolean } = {}): Promise<ProducerValidation> {
  const published = publishedFiles(source);
  const result = validatePackDir(source.dir, source.manifest, {
    packageJson: source.packageJson,
    packageDir: source.packageDir,
    checkDigests: options.checkDigests ?? source.manifest.files !== undefined,
    publishedFiles: published,
  });
  // In the source repo, digests come from the last build, so edits since then only mean it's time to build again.
  const stale = result.diagnostics.filter((d) => d.code.startsWith("digest."));
  const diagnostics = result.diagnostics.filter((d) => !d.code.startsWith("digest."));
  if (stale.length) {
    const names = stale.map((d) => d.file).filter(Boolean);
    diagnostics.push(warning("digest.stale", `pack.json lists digests from an earlier build, and ${names.length === 1 ? `${names[0]} has` : `${names.length} files have`} changed since. Run build again before sign`, { file: MANIFEST_FILE, field: "files" }));
  }
  if (!source.packageJson.files && !source.embedded) {
    diagnostics.push(warning("package.files", 'package.json has no "files" list, so npm publishes everything in the directory, including evals and fixtures', { file: "package.json", field: "files" }));
  }
  // Every published text file reaches agents' machines, so scan them all.
  const already = new Set(result.delivered.map((d) => d.abs));
  diagnostics.push(
    ...scanHidden(published.filter(isTextFile).map((f) => ({ abs: path.join(source.dir, f), display: f })).filter((f) => !already.has(f.abs))),
  );
  diagnostics.push(...validateEvals(source));
  if (options.runFixtures !== false) diagnostics.push(...(await checkFixtures(source)));
  return { diagnostics, published };
}
