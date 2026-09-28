import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bundleToJSON } from "@sigstore/bundle";
import { MessageSignatureBundleBuilder } from "@sigstore/sign";
import { encodePublicKey, formatJson, keyId, SdkError, verifyKeySignature, writeFileAtomic } from "@de-web-sdk/core";

/** Loads a PEM private key from a file, or from an environment variable with `env:NAME`. */
export function loadPrivateKey(spec: string, env: NodeJS.ProcessEnv, cwd: string): KeyObject {
  let pem: string;
  if (spec.startsWith("env:")) {
    const name = spec.slice(4);
    pem = env[name] ?? "";
    if (!pem) throw new SdkError("usage", `The environment variable ${name} holds no key`);
  } else {
    try {
      pem = readFileSync(path.resolve(cwd, spec), "utf8");
    } catch {
      throw new SdkError("usage", `Can't read the key file ${spec}`);
    }
  }
  try {
    return createPrivateKey(pem);
  } catch {
    throw new SdkError("usage", "The signing key isn't a PEM private key");
  }
}

/**
 * Signs bytes with a producer key into a Sigstore bundle. Standard Sigstore
 * verifiers accept it with the producer's public key, and any byte change
 * makes it fail.
 */
export async function signBytes(data: Buffer, privateKey: KeyObject): Promise<unknown> {
  const publicKey = createPublicKey(privateKey);
  const builder = new MessageSignatureBundleBuilder({
    signer: {
      sign: async (payload: Buffer) => ({
        signature: cryptoSign("sha256", payload, privateKey),
        key: { $case: "publicKey" as const, publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(), hint: keyId(publicKey) },
      }),
    },
    witnesses: [],
  });
  const bundle = bundleToJSON(await builder.create({ data }));
  const check = verifyKeySignature(bundle, data, [publicKey]);
  if (!check.ok) throw new SdkError("trust", `The new signature doesn't verify: ${check.reason}`);
  return bundle;
}

export async function signFile(file: string, privateKey: KeyObject, out: string): Promise<{ keyId: string }> {
  const bundle = await signBytes(readFileSync(file), privateKey);
  await writeFileAtomic(out, formatJson(bundle));
  return { keyId: keyId(createPublicKey(privateKey)) };
}

/** Creates an ECDSA P-256 key pair for a producer scope. */
export function generateKeys(): { privatePem: string; publicPem: string; publicBase64: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privatePem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    publicBase64: encodePublicKey(publicKey),
    keyId: keyId(publicKey),
  };
}
