import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorObject, ValidateFunction } from "ajv";
import { error, type Diagnostic } from "./diagnostics.ts";

export const SUPPORTED_SPEC_MAJOR = 0;
export const MANIFEST_FILE = "pack.json";
export const SIGNATURE_FILE = "pack.sigstore.json";
export const SCHEMA_URL = "https://schemas.example.com/agent-pack/v0.json";
export const LOCAL_SCHEMA_URL = "https://schemas.example.com/agent-pack/v0-local.json";
/** The package.json field that names an embedded pack's directory. Pending open question 10. */
export const EMBED_FIELD = "agentPack";

export type Enforcement = "machine" | "advisory";

export interface Owner {
  team: string;
  contact?: string;
}

export interface Condition {
  packages?: Record<string, string>;
  bundler?: string[];
  moduleFederation?: string[];
  role?: string[];
}

export interface RuleCheck {
  pack?: string;
  adapter: string;
  options?: Record<string, unknown>;
}

export interface Rule {
  id: string;
  title: string;
  enforcement: Enforcement;
  locked?: boolean;
  owner?: Owner;
  appliesWhen?: Condition;
  paths?: string[];
  rationale: string;
  guidance?: string;
  fix?: string;
  check?: RuleCheck;
}

export interface SkillEntry {
  name: string;
  path: string;
  from?: string;
  description?: string;
  appliesWhen?: Condition;
  paths?: string[];
}

export interface DocEntry {
  title: string;
  path: string;
  from?: string;
  description?: string;
  appliesWhen?: Condition;
  paths?: string[];
}

export interface CommandEntry {
  name: string;
  run: string;
  use: string;
  from?: string;
  appliesWhen?: Condition;
  paths?: string[];
}

export interface AdapterEntry {
  name: string;
  module: string;
  from?: string;
}

export interface Rates {
  without: number;
  with: number;
  published?: number;
}

export interface EvalSummaryEntry {
  trials: number;
  pass: Rates;
  api?: Rates;
  ranIn?: string;
}

export interface EvalOverride {
  model: string;
  reason: string;
  approvedBy: string;
  expires: string;
}

export interface McpFeedbackTarget {
  /** The server's name in the developer's MCP configuration. */
  server: string;
  url?: string;
  tool: string;
  arguments?: Record<string, string | number | boolean>;
}

export interface FeedbackAdapterConfig {
  type: string;
  mcp?: McpFeedbackTarget;
}

export interface Manifest {
  $schema: string;
  specVersion: string;
  id?: string;
  version?: string;
  owner: Owner;
  feedback: string;
  feedbackAdapter?: FeedbackAdapterConfig;
  governs?: Record<string, string>;
  appliesWhen?: Condition;
  paths?: string[];
  rules?: Rule[];
  skills?: SkillEntry[];
  docs?: DocEntry[];
  commands?: CommandEntry[];
  adapters?: AdapterEntry[];
  evals?: { summary?: Record<string, EvalSummaryEntry>; overrides?: EvalOverride[] };
  files?: Record<string, string>;
}

const require = createRequire(import.meta.url);

let validators: { published: ValidateFunction; local: ValidateFunction } | undefined;

/** The schema files ship in the package's `schema/` directory, beside `src/` and `dist/`. */
export function schemaPath(name: "pack.v0.json" | "pack.v0-local.json"): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema", name);
}

export function loadSchemas(): { published: object; local: object } {
  return {
    published: JSON.parse(readFileSync(schemaPath("pack.v0.json"), "utf8")),
    local: JSON.parse(readFileSync(schemaPath("pack.v0-local.json"), "utf8")),
  };
}

function getValidators() {
  if (!validators) {
    const mod = require("ajv/dist/2020.js");
    const Ajv2020 = mod.default ?? mod;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schemas = loadSchemas();
    ajv.addSchema(schemas.published);
    ajv.addSchema(schemas.local);
    validators = {
      published: ajv.getSchema(SCHEMA_URL)!,
      local: ajv.getSchema(LOCAL_SCHEMA_URL)!,
    };
  }
  return validators;
}

/** Converts `/rules/2/check` to `rules[2].check`. */
export function pointerToField(pointer: string): string {
  if (!pointer) return "";
  return pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((acc, part) => (/^\d+$/.test(part) ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part), "");
}

function describeItem(manifest: unknown, pointer: string): string | undefined {
  const match = /^\/(rules|skills|docs|commands|adapters)\/(\d+)/.exec(pointer);
  if (!match) return undefined;
  const list = (manifest as Record<string, unknown[]>)[match[1]!];
  const item = list?.[Number(match[2])] as Record<string, unknown> | undefined;
  const label = item?.id ?? item?.name ?? item?.title;
  const noun = { rules: "Rule", skills: "Skill", docs: "Doc entry", commands: "Command", adapters: "Adapter" }[match[1]!];
  return label ? `${noun} ${JSON.stringify(label)}` : `${noun} ${match[2]}`;
}

function toDiagnostic(e: ErrorObject, manifest: unknown, file: string): Diagnostic | undefined {
  if (e.keyword === "if") return undefined;
  const base = e.instancePath;
  const subject = describeItem(manifest, base);
  const prefix = subject ? `${subject}: ` : "";
  switch (e.keyword) {
    case "required": {
      const missing = (e.params as { missingProperty: string }).missingProperty;
      const field = pointerToField(`${base}/${missing}`);
      return error("schema.required", `${prefix}missing required field ${JSON.stringify(field)}`, { file, field });
    }
    case "enum": {
      const allowed = (e.params as { allowedValues: unknown[] }).allowedValues;
      return error("schema.enum", `${prefix}${pointerToField(base)} must be one of ${allowed.map((v) => JSON.stringify(v)).join(", ")}`, {
        file,
        field: pointerToField(base),
      });
    }
    case "additionalProperties": {
      const extra = (e.params as { additionalProperty: string }).additionalProperty;
      const field = pointerToField(`${base}/${extra}`);
      if (/appliesWhen$/.test(base)) {
        return error(
          "schema.undefinedFact",
          `${prefix}condition on undefined fact ${JSON.stringify(extra)}; facts are packages, bundler, moduleFederation, and role`,
          { file, field },
        );
      }
      return error("schema.additional", `${prefix}unknown field ${JSON.stringify(field)}`, { file, field });
    }
    default:
      return error("schema." + e.keyword, `${prefix}${pointerToField(base) || "manifest"} ${e.message ?? "is invalid"}`, {
        file,
        field: pointerToField(base),
      });
  }
}

/** Validates a manifest against the published JSON Schema. Returns every error. */
export function validateSchema(manifest: unknown, options: { local?: boolean; file?: string } = {}): Diagnostic[] {
  const v = options.local ? getValidators().local : getValidators().published;
  const file = options.file ?? MANIFEST_FILE;
  if (v(manifest)) return [];
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const e of v.errors ?? []) {
    const d = toDiagnostic(e, manifest, file);
    if (!d) continue;
    const key = `${d.code}|${d.field}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/** Raw schema errors, for comparing with a generic validator. */
export function schemaErrorFields(manifest: unknown, options: { local?: boolean } = {}): string[] {
  const v = options.local ? getValidators().local : getValidators().published;
  v(manifest);
  return (v.errors ?? [])
    .filter((e) => e.keyword !== "if")
    .map((e) =>
      e.keyword === "required"
        ? `${e.instancePath}/${(e.params as { missingProperty: string }).missingProperty}`
        : e.keyword === "additionalProperties"
          ? `${e.instancePath}/${(e.params as { additionalProperty: string }).additionalProperty}`
          : e.instancePath,
    )
    .sort();
}

export function specMajor(specVersion: string): number {
  return Number.parseInt(specVersion.split(".")[0] ?? "", 10);
}

/** Refuses a manifest whose major specification version this SDK doesn't support. */
export function checkSpecVersion(manifest: { specVersion?: unknown }, file: string, label: string): Diagnostic | undefined {
  if (typeof manifest.specVersion !== "string") return undefined;
  const major = specMajor(manifest.specVersion);
  if (major !== SUPPORTED_SPEC_MAJOR) {
    return error(
      "spec.unsupported",
      `${label} declares specification version ${manifest.specVersion}, but this SDK supports version ${SUPPORTED_SPEC_MAJOR}`,
      { file, field: "specVersion" },
    );
  }
  return undefined;
}

export function readManifestFile(abs: string): { manifest?: Manifest; bytes?: Buffer; diagnostics: Diagnostic[] } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch {
    return { diagnostics: [error("manifest.missing", `No ${MANIFEST_FILE} found`, { file: MANIFEST_FILE })] };
  }
  try {
    return { manifest: JSON.parse(bytes.toString("utf8")) as Manifest, bytes, diagnostics: [] };
  } catch (e) {
    return {
      bytes,
      diagnostics: [error("manifest.json", `${MANIFEST_FILE} isn't valid JSON: ${(e as Error).message}`, { file: MANIFEST_FILE })],
    };
  }
}

export function ruleOwner(rule: Rule, manifest: Manifest): Owner {
  return rule.owner ?? manifest.owner;
}

export function hasContent(manifest: Manifest): boolean {
  return Boolean(
    manifest.rules?.length || manifest.skills?.length || manifest.docs?.length || manifest.commands?.length || manifest.adapters?.length,
  );
}

export function scopeOf(packageName: string): string {
  return packageName.startsWith("@") ? packageName.split("/")[0]! : "";
}
