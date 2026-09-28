import { readFileSync } from "node:fs";
import path from "node:path";
import { LOCAL_PACK_DIR } from "./config.ts";
import { error, warning, type Diagnostic } from "./diagnostics.ts";
import {
  EMBED_FIELD,
  hasContent,
  MANIFEST_FILE,
  readManifestFile,
  scopeOf,
  type Manifest,
} from "./manifest.ts";
import { declaredDependencies, readPackageJson, resolvePackageDir, type PackageJson } from "./resolve-package.ts";
import { scopeIsListed, verifyProvenance, type TrustPolicy } from "./trust/policy.ts";
import { digestOf, isDir, isFile, relativeTo } from "./util.ts";
import { scanHidden, validatePackDir, type DeliveredFile } from "./validate.ts";

export type PackKind = "standalone" | "embedded" | "bundle" | "adapter" | "local";

export interface CollectedPack {
  /** The pack's identifier in rule references: its npm name, or `local`. */
  ref: string;
  kind: PackKind;
  manifest: Manifest;
  manifestDigest: string;
  /** Absolute pack directory. */
  dir: string;
  /** Repo-relative pack directory, for output. */
  displayDir: string;
  packageName?: string;
  packageDir?: string;
  packageJson?: PackageJson;
  version?: string;
  via: "direct" | "embedded" | "dependency" | "local";
  requiredBy?: string;
  provenance?: { method: "signature" | "npm-provenance" | "pinned-integrity"; identity?: string };
  delivered: DeliveredFile[];
}

export interface SkippedPack {
  package: string;
  reason: string;
}

export interface Collection {
  packs: CollectedPack[];
  skipped: SkippedPack[];
  /** Trust and integrity errors, which stop every command. */
  trustErrors: Diagnostic[];
  /** Local pack errors, which are configuration errors. */
  configErrors: Diagnostic[];
  warnings: Diagnostic[];
}

export interface CollectOptions {
  root: string;
  policy: TrustPolicy;
  network: boolean;
}

interface Candidate {
  packageName: string;
  packageDir: string;
  packageJson: PackageJson;
  packDir: string;
  embedded: boolean;
  via: CollectedPack["via"];
  requiredBy?: string;
}

/** Returns the pack a package holds, if any: an `agentPack` directory, or a root manifest. */
function packIn(packageDir: string, pkg: PackageJson): { packDir: string; embedded: boolean } | { missing: string } | undefined {
  const field = pkg[EMBED_FIELD];
  if (typeof field === "string") {
    const packDir = path.resolve(packageDir, field);
    if (!isFile(path.join(packDir, MANIFEST_FILE))) return { missing: field };
    return { packDir, embedded: path.relative(packageDir, packDir) !== "" };
  }
  if (isFile(path.join(packageDir, MANIFEST_FILE))) return { packDir: packageDir, embedded: false };
  return undefined;
}

function kindOf(manifest: Manifest, embedded: boolean): PackKind {
  if (embedded) return "embedded";
  if (!hasContent(manifest)) return "bundle";
  const onlyAdapters = manifest.adapters?.length && !manifest.rules?.length && !manifest.skills?.length && !manifest.docs?.length && !manifest.commands?.length;
  return onlyAdapters ? "adapter" : "standalone";
}

/**
 * Collects the repo's packs, as the composition spec defines: direct
 * dependencies that are packs or embed one, every pack a collected pack
 * depends on, and the local pack. Verifies trust, provenance, digests, and
 * hidden characters before returning any pack.
 */
export async function collectPacks(options: CollectOptions): Promise<Collection> {
  const { root, policy } = options;
  const result: Collection = { packs: [], skipped: [], trustErrors: [], configErrors: [], warnings: [] };
  const rootPkg = readPackageJson(root) ?? {};
  const direct = [
    ...Object.keys(rootPkg.dependencies ?? {}),
    ...Object.keys(rootPkg.devDependencies ?? {}),
    ...Object.keys(rootPkg.optionalDependencies ?? {}),
  ]
    .filter((n, i, all) => all.indexOf(n) === i)
    .sort();

  const queue: Candidate[] = [];
  for (const name of direct) {
    const packageDir = resolvePackageDir(root, name);
    if (!packageDir) continue;
    const pkg = readPackageJson(packageDir);
    if (!pkg) continue;
    const found = packIn(packageDir, pkg);
    if (!found) continue;
    if ("missing" in found) {
      result.warnings.push(warning("collect.embedMissing", `${name} names ${JSON.stringify(found.missing)} as its pack directory, but it holds no ${MANIFEST_FILE}`));
      continue;
    }
    queue.push({ packageName: name, packageDir, packageJson: pkg, packDir: found.packDir, embedded: found.embedded, via: found.embedded ? "embedded" : "direct" });
  }

  const seen = new Set<string>();
  const verifiedPackages = new Map<string, boolean>();

  while (queue.length) {
    const c = queue.shift()!;
    if (seen.has(c.packDir)) continue;
    seen.add(c.packDir);
    const label = `Pack ${c.packageName}`;

    if (!scopeIsListed(policy, c.packageName)) {
      const scope = scopeOf(c.packageName) || "(none)";
      if (c.embedded) {
        result.skipped.push({ package: c.packageName, reason: `its scope ${scope} isn't in the trust policy` });
        continue;
      }
      result.trustErrors.push(error("trust.scope", `${label}: its scope ${scope} isn't in the trust policy`, { file: ".de-web-sdk/trust.json" }));
      continue;
    }

    const version = c.packageJson.version ?? "0.0.0";
    const provenance = await verifyProvenance({
      root,
      policy,
      packageName: c.packageName,
      version,
      packDir: c.packDir,
      network: options.network,
      label,
    });
    verifiedPackages.set(c.packageName, provenance.ok);
    if (!provenance.ok) {
      result.trustErrors.push(...provenance.diagnostics);
      continue;
    }
    result.warnings.push(...provenance.diagnostics);

    const read = readManifestFile(path.join(c.packDir, MANIFEST_FILE));
    const displayDir = relativeTo(root, c.packDir) ?? c.packageName;
    if (!read.manifest || !read.bytes) {
      result.trustErrors.push(...read.diagnostics.map((d) => ({ ...d, message: `${label}: ${d.message}`, file: `${displayDir}/${MANIFEST_FILE}` })));
      continue;
    }
    const validation = validatePackDir(c.packDir, read.manifest, {
      packageJson: c.packageJson,
      packageDir: c.packageDir,
      label: c.packageName,
      filePrefix: `${displayDir}/`,
      checkDigests: true,
    });
    result.warnings.push(...validation.diagnostics.filter((d) => d.code === "feedback.adapterUnknown").map((d) => ({ ...d, message: `${label}: ${d.message}` })));
    // Unknown facts in conditions exclude the item instead of refusing the pack, for forward compatibility.
    const blocking = validation.diagnostics.filter((d) => d.severity === "error" && d.code !== "schema.undefinedFact");
    if (!read.manifest.files) {
      blocking.push(error("digest.none", `${label} lists no file digests, so its files can't be verified`, { file: `${displayDir}/${MANIFEST_FILE}`, field: "files" }));
    }
    if (blocking.length) {
      result.trustErrors.push(...blocking.map((d) => (d.message.startsWith(label) ? d : { ...d, message: `${label}: ${d.message}` })));
      continue;
    }

    // Content referenced in other packages must pass the same checks.
    const referenced = new Set<string>();
    for (const list of [read.manifest.skills, read.manifest.docs, read.manifest.adapters, read.manifest.commands]) {
      for (const item of list ?? []) if (item?.from) referenced.add(item.from);
    }
    let referencesOk = true;
    for (const dep of [...referenced].sort()) {
      const depDir = resolvePackageDir(c.packageDir, dep);
      if (!depDir) {
        result.trustErrors.push(error("trust.referenceMissing", `${label} references ${dep}, which isn't installed`));
        referencesOk = false;
        continue;
      }
      if (verifiedPackages.get(dep) === true) continue;
      const depPkg = readPackageJson(depDir) ?? {};
      const depPack = packIn(depDir, depPkg);
      const check = await verifyProvenance({
        root,
        policy,
        packageName: dep,
        version: depPkg.version ?? "0.0.0",
        packDir: depPack && "packDir" in depPack ? depPack.packDir : undefined,
        network: options.network,
        label: `Package ${dep}, referenced by ${c.packageName}`,
      });
      verifiedPackages.set(dep, check.ok);
      if (!check.ok) {
        result.trustErrors.push(...check.diagnostics);
        referencesOk = false;
      }
    }
    if (!referencesOk) continue;

    const manifestDigest = digestOf(read.bytes);
    result.packs.push({
      ref: c.packageName,
      kind: kindOf(read.manifest, c.embedded),
      manifest: read.manifest,
      manifestDigest,
      dir: c.packDir,
      displayDir,
      packageName: c.packageName,
      packageDir: c.packageDir,
      packageJson: c.packageJson,
      version,
      via: c.via,
      requiredBy: c.requiredBy,
      provenance: { method: provenance.method!, identity: provenance.identity },
      delivered: validation.delivered,
    });

    // Packs this pack depends on join the collection.
    for (const dep of [...declaredDependencies(c.packageJson)].sort()) {
      const depDir = resolvePackageDir(c.packageDir, dep);
      if (!depDir) continue;
      const depPkg = readPackageJson(depDir);
      if (!depPkg) continue;
      const found = packIn(depDir, depPkg);
      if (!found || "missing" in found) continue;
      queue.push({ packageName: dep, packageDir: depDir, packageJson: depPkg, packDir: found.packDir, embedded: found.embedded, via: "dependency", requiredBy: c.packageName });
    }
  }

  const local = collectLocalPack(root);
  if (local.pack) result.packs.push(local.pack);
  result.configErrors.push(...local.errors.filter((d) => d.code !== "hidden.character"));
  result.trustErrors.push(...local.errors.filter((d) => d.code === "hidden.character"));

  result.packs.sort((a, b) => (a.ref === "local" ? 1 : b.ref === "local" ? -1 : a.ref.localeCompare(b.ref)));
  return result;
}

/** Validates and loads `.de-web-sdk/local/`. Errors name the file and the field. */
export function collectLocalPack(root: string): { pack?: CollectedPack; errors: Diagnostic[] } {
  const dir = path.join(root, LOCAL_PACK_DIR);
  if (!isDir(dir)) return { errors: [] };
  const prefix = `${LOCAL_PACK_DIR}/`;
  const read = readManifestFile(path.join(dir, MANIFEST_FILE));
  if (!read.manifest || !read.bytes) {
    return { errors: read.diagnostics.map((d) => ({ ...d, file: `${prefix}${MANIFEST_FILE}` })) };
  }
  const validation = validatePackDir(dir, read.manifest, { local: true, label: "local", filePrefix: prefix });
  const errors = validation.diagnostics.filter((d) => d.severity === "error" && d.code !== "schema.undefinedFact");
  if (errors.length) return { errors };
  return {
    errors: [],
    pack: {
      ref: "local",
      kind: "local",
      manifest: read.manifest,
      manifestDigest: digestOf(read.bytes),
      dir,
      displayDir: LOCAL_PACK_DIR,
      via: "local",
      delivered: validation.delivered,
    },
  };
}

export { scanHidden };

export function readText(abs: string): string | undefined {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
}
