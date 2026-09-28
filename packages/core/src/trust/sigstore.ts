import { createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { bundleFromJSON, type SerializedBundle } from "@sigstore/bundle";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { toSignedEntity, toTrustMaterial, Verifier, type Signer } from "@sigstore/verify";
import { sha256 } from "../util.ts";

/**
 * The Sigstore public-good trusted root, copied from the seeds that
 * `@sigstore/tuf` 4.0.2 embeds. It lets `sync` and `check` verify npm
 * provenance offline. An enterprise trust policy can supply a newer one.
 */
export function defaultSigstoreTrustedRoot(): unknown {
  return JSON.parse(readFileSync(new URL("./sigstore-trusted-root.json", import.meta.url), "utf8"));
}

/** Parses a trust policy key: base64 of a DER SubjectPublicKeyInfo, or PEM. */
export function parsePublicKey(text: string): KeyObject {
  const trimmed = text.trim();
  if (trimmed.startsWith("-----BEGIN")) return createPublicKey(trimmed);
  return createPublicKey({ key: Buffer.from(trimmed, "base64"), format: "der", type: "spki" });
}

/** The key's identifier in signature bundles: the SHA-256 of its DER encoding. */
export function keyId(key: KeyObject): string {
  return sha256(key.export({ format: "der", type: "spki" }));
}

export function encodePublicKey(key: KeyObject): string {
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

export type SignatureCheck = { ok: true; keyId: string } | { ok: false; reason: string; keyId?: string };

/**
 * Verifies a Sigstore bundle that signs `data` with a producer key. The key
 * must be one of `trusted`. There is no transparency log for key signatures.
 */
export function verifyKeySignature(bundleJson: unknown, data: Buffer, trusted: KeyObject[]): SignatureCheck {
  let bundle;
  try {
    bundle = bundleFromJSON(bundleJson as SerializedBundle);
  } catch (e) {
    return { ok: false, reason: `the signature isn't a valid Sigstore bundle: ${(e as Error).message}` };
  }
  const material = bundle.verificationMaterial.content;
  if (material.$case !== "publicKey") {
    return { ok: false, reason: "the signature bundle doesn't name a public key" };
  }
  const hint = material.publicKey.hint;
  const byId = new Map(trusted.map((k) => [keyId(k), k]));
  const key = byId.get(hint);
  if (!key) return { ok: false, reason: `the signing key ${hint} isn't listed for this scope`, keyId: hint };
  const emptyRoot = TrustedRoot.fromJSON({
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    tlogs: [],
    certificateAuthorities: [],
    ctlogs: [],
    timestampAuthorities: [],
  });
  const trust = toTrustMaterial(emptyRoot, (h) => {
    if (h !== hint) throw new Error(`unknown key ${h}`);
    return { publicKey: key, validFor: () => true };
  });
  const verifier = new Verifier(trust, { tlogThreshold: 0, ctlogThreshold: 0, timestampThreshold: 0 });
  try {
    verifier.verify(toSignedEntity(bundle, data));
    return { ok: true, keyId: hint };
  } catch (e) {
    return { ok: false, reason: `the signature doesn't verify: ${(e as Error).message}`, keyId: hint };
  }
}

export interface ProvenanceIdentity {
  /** Source repository host and path, such as `github.com/jpmorganchase/salt-ds`. */
  repository: string;
  /** Workflow file in that repository, such as `.github/workflows/release.yml`. */
  workflow?: string;
}

export interface ProvenanceSubject {
  name: string;
  version: string;
  /** The tarball's `sha512-...` integrity from the lockfile, when known. */
  integrity?: string;
}

export type ProvenanceCheck =
  | { ok: true; identity: string; integrityChecked: boolean }
  | { ok: false; reason: string; identity?: string };

const OID_SOURCE_REPOSITORY_URI = "1.3.6.1.4.1.57264.1.12";

/**
 * Verifies an npm provenance attestation offline: the certificate chain and
 * transparency log entry against the trusted root, the signer's identity
 * against the trust policy, and the attested package against the lockfile.
 */
export function verifyNpmProvenance(
  attestations: unknown,
  subject: ProvenanceSubject,
  identities: ProvenanceIdentity[],
  trustedRoot: unknown,
): ProvenanceCheck {
  const list = (attestations as { attestations?: Array<{ predicateType?: string; bundle?: unknown }> })?.attestations ?? [];
  const provenance = list.find((a) => a.predicateType?.startsWith("https://slsa.dev/provenance/"));
  if (!provenance?.bundle) return { ok: false, reason: "the registry has no npm provenance attestation for this version" };
  let signer: Signer;
  let payload: { subject?: Array<{ name?: string; digest?: { sha512?: string } }> };
  try {
    const bundle = bundleFromJSON(provenance.bundle as SerializedBundle);
    const verifier = new Verifier(toTrustMaterial(TrustedRoot.fromJSON(trustedRoot)), {
      tlogThreshold: 1,
      ctlogThreshold: 1,
      timestampThreshold: 1,
    });
    signer = verifier.verify(toSignedEntity(bundle));
    if (bundle.content.$case !== "dsseEnvelope") return { ok: false, reason: "the provenance attestation isn't a DSSE envelope" };
    payload = JSON.parse(Buffer.from(bundle.content.dsseEnvelope.payload).toString("utf8"));
  } catch (e) {
    return { ok: false, reason: `the provenance attestation doesn't verify: ${(e as Error).message}` };
  }

  const san = signer.identity?.subjectAlternativeName ?? "";
  const rawRepo = signer.identity?.oids?.find((o) => o.oid?.id?.join(".") === OID_SOURCE_REPOSITORY_URI)?.value;
  const sourceRepo = rawRepo ? derUtf8String(Buffer.from(rawRepo)) : undefined;
  const matches = identities.some((id) => {
    const repoUrl = `https://${id.repository.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    if (!san.startsWith(`${repoUrl}/`)) return false;
    if (id.workflow && !san.startsWith(`${repoUrl}/${id.workflow.replace(/^\//, "")}@`)) return false;
    if (sourceRepo && sourceRepo !== repoUrl) return false;
    return true;
  });
  if (!matches) return { ok: false, reason: `the provenance identity ${san} isn't listed for this scope`, identity: san };

  const expectedName = `pkg:npm/${subject.name.replace(/^@/, "%40")}@${subject.version}`;
  const entry = payload.subject?.find((s) => decodeURIComponent(s.name ?? "") === decodeURIComponent(expectedName));
  if (!entry) return { ok: false, reason: `the attestation covers a different package than ${subject.name}@${subject.version}`, identity: san };
  let integrityChecked = false;
  if (subject.integrity?.startsWith("sha512-")) {
    const hex = Buffer.from(subject.integrity.slice(7), "base64").toString("hex");
    if (entry.digest?.sha512 !== hex) {
      return { ok: false, reason: "the attested tarball digest doesn't match the lockfile's integrity", identity: san };
    }
    integrityChecked = true;
  }
  return { ok: true, identity: san, integrityChecked };
}

/** Fulcio's newer extensions hold a DER UTF8String; older ones hold raw text. */
function derUtf8String(value: Buffer): string {
  if (value[0] === 0x0c && value.length > 2) {
    const len = value[1]!;
    if (len < 0x80) return value.subarray(2, 2 + len).toString("utf8");
    const bytes = len & 0x7f;
    const size = value.subarray(2, 2 + bytes).reduce((acc, b) => acc * 256 + b, 0);
    return value.subarray(2 + bytes, 2 + bytes + size).toString("utf8");
  }
  return value.toString("utf8");
}
