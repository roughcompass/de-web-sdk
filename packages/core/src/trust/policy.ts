import type { KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { TRUST_FILE } from "../config.ts";
import { error, SdkError, warning, type Diagnostic } from "../diagnostics.ts";
import { readLockfile } from "../lockfile.ts";
import { MANIFEST_FILE, scopeOf, SIGNATURE_FILE } from "../manifest.ts";
import { resolvePackageDir } from "../resolve-package.ts";
import { loadAttestations } from "./registry.ts";
import {
  defaultSigstoreTrustedRoot,
  parsePublicKey,
  verifyKeySignature,
  verifyNpmProvenance,
  type ProvenanceIdentity,
} from "./sigstore.ts";

export const POLICY_FILE = "trust-policy.json";
export const POLICY_SIGNATURE_FILE = "trust-policy.sigstore.json";

export interface ScopeTrust {
  keys: KeyObject[];
  provenance: ProvenanceIdentity[];
}

export interface TrustPolicy {
  scopes: Map<string, ScopeTrust>;
  sigstoreTrustedRoot: unknown;
  /** The enterprise trust policy package this repo extends, with its version. */
  enterprise?: { name: string; version?: string };
  exists: boolean;
}

interface RawScope {
  keys?: unknown;
  provenance?: unknown;
}

function parseScopes(raw: unknown, file: string, diagnostics: Diagnostic[]): Map<string, ScopeTrust> {
  const scopes = new Map<string, ScopeTrust>();
  if (raw === undefined) return scopes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    diagnostics.push(error("trust.scopes", "scopes must map npm scopes to keys or provenance identities", { file, field: "scopes" }));
    return scopes;
  }
  for (const [scope, value] of Object.entries(raw as Record<string, RawScope>)) {
    const entry: ScopeTrust = { keys: [], provenance: [] };
    if (!/^@[a-z0-9][a-z0-9._~-]*$/.test(scope)) {
      diagnostics.push(error("trust.scope", `${JSON.stringify(scope)} isn't an npm scope`, { file, field: `scopes.${scope}` }));
      continue;
    }
    if (value?.keys !== undefined) {
      if (!Array.isArray(value.keys)) {
        diagnostics.push(error("trust.keys", `scopes.${scope}.keys must be a list`, { file, field: `scopes.${scope}.keys` }));
      } else {
        value.keys.forEach((k, i) => {
          try {
            entry.keys.push(parsePublicKey(String(k)));
          } catch {
            diagnostics.push(error("trust.key", `Key ${i} for ${scope} isn't a valid public key`, { file, field: `scopes.${scope}.keys[${i}]` }));
          }
        });
      }
    }
    if (value?.provenance !== undefined) {
      if (!Array.isArray(value.provenance)) {
        diagnostics.push(error("trust.provenance", `scopes.${scope}.provenance must be a list`, { file, field: `scopes.${scope}.provenance` }));
      } else {
        value.provenance.forEach((p: Partial<ProvenanceIdentity>, i) => {
          if (typeof p?.repository !== "string" || !p.repository) {
            diagnostics.push(error("trust.provenance", `Provenance identity ${i} for ${scope} has no repository`, { file, field: `scopes.${scope}.provenance[${i}].repository` }));
          } else {
            entry.provenance.push({ repository: p.repository, workflow: typeof p.workflow === "string" ? p.workflow : undefined });
          }
        });
      }
    }
    scopes.set(scope, entry);
  }
  return scopes;
}

function merge(into: Map<string, ScopeTrust>, from: Map<string, ScopeTrust>) {
  for (const [scope, entry] of from) {
    const existing = into.get(scope);
    if (!existing) into.set(scope, { keys: [...entry.keys], provenance: [...entry.provenance] });
    else {
      existing.keys.push(...entry.keys);
      existing.provenance.push(...entry.provenance);
    }
  }
}

/**
 * Loads the repo's trust policy and the enterprise trust policy it extends.
 * The enterprise policy must verify against `rootKeys`, which the CLI builds in.
 */
export function loadTrustPolicy(root: string, rootKeys: KeyObject[]): TrustPolicy {
  const file = TRUST_FILE;
  const abs = path.join(root, file);
  const policy: TrustPolicy = { scopes: new Map(), sigstoreTrustedRoot: defaultSigstoreTrustedRoot(), exists: existsSync(abs) };
  if (!policy.exists) return policy;
  let raw: { extends?: unknown; scopes?: unknown };
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new SdkError("config", `${file} isn't valid JSON`, [error("trust.json", `${file} isn't valid JSON: ${(e as Error).message}`, { file })]);
  }
  const diagnostics: Diagnostic[] = [];
  if (raw.extends !== undefined) {
    if (typeof raw.extends !== "string") {
      diagnostics.push(error("trust.extends", "extends must name the enterprise trust policy package", { file, field: "extends" }));
    } else {
      const enterprise = loadEnterprisePolicy(root, raw.extends, rootKeys);
      policy.enterprise = { name: raw.extends, version: enterprise.version };
      merge(policy.scopes, enterprise.scopes);
      if (enterprise.sigstoreTrustedRoot) policy.sigstoreTrustedRoot = enterprise.sigstoreTrustedRoot;
    }
  }
  merge(policy.scopes, parseScopes(raw.scopes, file, diagnostics));
  if (diagnostics.length) throw new SdkError("config", `${file} has errors`, diagnostics);
  return policy;
}

function loadEnterprisePolicy(root: string, name: string, rootKeys: KeyObject[]) {
  const dir = resolvePackageDir(root, name);
  if (!dir) {
    throw new SdkError("trust", `The enterprise trust policy ${name} isn't installed`, [
      error("trust.enterpriseMissing", `The enterprise trust policy package ${name} isn't installed. Install it as a dev dependency`, { file: TRUST_FILE, field: "extends" }),
    ]);
  }
  const policyPath = path.join(dir, POLICY_FILE);
  const sigPath = path.join(dir, POLICY_SIGNATURE_FILE);
  const fail = (reason: string) =>
    new SdkError("trust", `The enterprise trust policy ${name} failed verification`, [
      error("trust.enterprise", `The enterprise trust policy package ${name} failed verification: ${reason}`, { file: TRUST_FILE, field: "extends" }),
    ]);
  if (!existsSync(policyPath) || !existsSync(sigPath)) throw fail(`it needs ${POLICY_FILE} and ${POLICY_SIGNATURE_FILE}`);
  if (rootKeys.length === 0) throw fail("this SDK build has no root keys");
  const bytes = readFileSync(policyPath);
  let bundle: unknown;
  try {
    bundle = JSON.parse(readFileSync(sigPath, "utf8"));
  } catch {
    throw fail(`${POLICY_SIGNATURE_FILE} isn't valid JSON`);
  }
  const check = verifyKeySignature(bundle, bytes, rootKeys);
  if (!check.ok) throw fail(check.reason);
  const data = JSON.parse(bytes.toString("utf8")) as { scopes?: unknown; sigstoreTrustedRoot?: unknown };
  const diagnostics: Diagnostic[] = [];
  const scopes = parseScopes(data.scopes, `${name}/${POLICY_FILE}`, diagnostics);
  if (diagnostics.length) throw new SdkError("trust", `The enterprise trust policy ${name} has errors`, diagnostics);
  const version = (JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: string }).version;
  return { scopes, sigstoreTrustedRoot: data.sigstoreTrustedRoot, version };
}

export interface ProvenanceResult {
  ok: boolean;
  method?: "signature" | "npm-provenance";
  identity?: string;
  diagnostics: Diagnostic[];
}

export interface ProvenanceRequest {
  root: string;
  policy: TrustPolicy;
  packageName: string;
  version: string;
  /** The pack directory, when the package holds a pack. Its signature covers its manifest. */
  packDir?: string;
  /** Whether the registry may be contacted for npm attestations. */
  network: boolean;
  /** How to name the package in messages, such as "Pack @x/y" or "Package @salt-ds/knowledge, referenced by @x/y". */
  label: string;
}

export function scopeIsListed(policy: TrustPolicy, packageName: string): boolean {
  return policy.scopes.has(scopeOf(packageName));
}

/** Verifies a package's provenance: a Sigstore-format key signature, or npm provenance. */
export async function verifyProvenance(req: ProvenanceRequest): Promise<ProvenanceResult> {
  const scope = scopeOf(req.packageName);
  const entry = req.policy.scopes.get(scope);
  if (!entry) {
    return {
      ok: false,
      diagnostics: [error("trust.scope", `${req.label}: its scope ${JSON.stringify(scope || "(none)")} isn't in the trust policy`, { file: TRUST_FILE })],
    };
  }
  const sigPath = req.packDir ? path.join(req.packDir, SIGNATURE_FILE) : undefined;
  if (sigPath && existsSync(sigPath) && entry.keys.length) {
    let bundle: unknown;
    try {
      bundle = JSON.parse(readFileSync(sigPath, "utf8"));
    } catch {
      return { ok: false, diagnostics: [error("trust.signature", `${req.label}: ${SIGNATURE_FILE} isn't valid JSON`)] };
    }
    const check = verifyKeySignature(bundle, readFileSync(path.join(req.packDir!, MANIFEST_FILE)), entry.keys);
    if (check.ok) return { ok: true, method: "signature", identity: `key ${check.keyId}`, diagnostics: [] };
    return {
      ok: false,
      identity: check.keyId ? `key ${check.keyId}` : undefined,
      diagnostics: [error("trust.signature", `${req.label}: ${check.reason}`)],
    };
  }
  if (entry.provenance.length) {
    const lookup = await loadAttestations(req.root, req.packageName, req.version, { network: req.network });
    if (lookup.status === "missing") {
      return {
        ok: false,
        diagnostics: [
          error(
            "trust.provenanceMissing",
            `${req.label} has no verifiable npm provenance: ${lookup.reason}. Run \`de-web-sdk sync\` once with registry access to cache it`,
          ),
        ],
      };
    }
    const lock = readLockfile(req.root).lookup(req.packageName);
    const integrity = lock && lock.version === req.version ? lock.integrity : undefined;
    const check = verifyNpmProvenance(lookup.attestations, { name: req.packageName, version: req.version, integrity }, entry.provenance, req.policy.sigstoreTrustedRoot);
    if (!check.ok) {
      return { ok: false, identity: check.identity, diagnostics: [error("trust.provenance", `${req.label}: ${check.reason}`)] };
    }
    const diagnostics = check.integrityChecked
      ? []
      : [warning("trust.integrityUnchecked", `${req.label}: the lockfile records no sha512 integrity, so provenance was matched by name and version only`)];
    return { ok: true, method: "npm-provenance", identity: check.identity, diagnostics };
  }
  return {
    ok: false,
    diagnostics: [error("trust.none", `${req.label} has neither npm provenance nor a signature that the trust policy accepts for ${scope}`)],
  };
}
