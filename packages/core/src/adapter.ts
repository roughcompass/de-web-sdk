/**
 * The check adapter contract. Adapter modules import only this file, so they
 * stay independent of the rest of the SDK. An adapter's default export
 * receives an `AdapterContext` and returns SARIF 2.1.0 results.
 */

/** The partial fingerprint key that `result()` writes. Any partial fingerprints work as stable keys. */
export const FINGERPRINT_KEY = "stableKey/v1";

export interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string; uriBaseId?: string };
    region?: { startLine?: number; startColumn?: number; endLine?: number; endColumn?: number };
  };
}

export interface SarifResult {
  ruleId?: string;
  level?: "error" | "warning" | "note" | "none";
  message: { text: string };
  locations?: SarifLocation[];
  partialFingerprints?: Record<string, string>;
  properties?: Record<string, unknown>;
}

export interface SarifLog {
  version: "2.1.0";
  $schema?: string;
  runs: Array<{ tool?: unknown; results?: SarifResult[] }>;
}

export interface AdapterFacts {
  bundler: string;
  bundlerVersion?: string;
  moduleFederation: string;
  role: string;
  react?: string;
  packages: Record<string, string>;
}

export interface AdapterContext {
  /** The repo root. Adapters can read under it but can't write anywhere. */
  root: string;
  facts: AdapterFacts;
  /** The rule's options from its pack. */
  options: Record<string, any>;
  /** Repo-relative files the rule covers, after its path patterns and the repo's ignored paths. */
  files: string[];
  /** The rule reference, such as `@scope/pack#rule`. */
  rule: string;
  /** Reads a repo-relative file, or returns undefined when it doesn't exist. */
  readText(file: string): Promise<string | undefined>;
  /** Reads and parses a repo-relative JSON file, or returns undefined when it doesn't exist. */
  readJson<T = any>(file: string): Promise<T | undefined>;
  exists(file: string): boolean;
  result: typeof result;
}

/** What an adapter returns: results, a SARIF log, or an error when it can't evaluate the rule. */
export type AdapterOutput = { results: SarifResult[] } | { error: string } | SarifLog;

export type Adapter = (context: AdapterContext) => AdapterOutput | Promise<AdapterOutput>;

export interface ResultInput {
  /** Repo-relative file the violation is in. */
  file: string;
  message: string;
  /**
   * A stable key for the violation within its file, such as a shared
   * dependency's name. Leave line numbers out, so unrelated edits don't
   * change it.
   */
  fingerprint: string;
  line?: number;
  column?: number;
  level?: SarifResult["level"];
}

/** Builds a SARIF 2.1.0 result with the fingerprint as its partial fingerprint. */
export function result(input: ResultInput): SarifResult {
  const region: Record<string, number> = {};
  if (input.line !== undefined) region.startLine = input.line;
  if (input.column !== undefined) region.startColumn = input.column;
  return {
    level: input.level ?? "error",
    message: { text: input.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: input.file },
          ...(Object.keys(region).length ? { region } : {}),
        },
      },
    ],
    partialFingerprints: { [FINGERPRINT_KEY]: input.fingerprint },
  };
}
