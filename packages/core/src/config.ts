import path from "node:path";
import { error, SdkError, type Diagnostic } from "./diagnostics.ts";
import type { DeclaredFacts } from "./facts.ts";
import { readJsonSync } from "./util.ts";

export const SDK_DIR = ".de-web-sdk";
export const CONFIG_FILE = `${SDK_DIR}/config.json`;
export const TRUST_FILE = `${SDK_DIR}/trust.json`;
export const BASELINE_FILE = `${SDK_DIR}/baseline.json`;
export const LOCAL_PACK_DIR = `${SDK_DIR}/local`;
export const CONTEXT_DIR = `${SDK_DIR}/context`;
export const CACHE_DIR = `${SDK_DIR}/cache`;

export const TARGET_TOOLS = ["claude-code", "github-copilot"] as const;
export type TargetTool = (typeof TARGET_TOOLS)[number];

export interface IgnoredPath {
  path: string;
  reason: string;
}

export interface RecordedException {
  rule: string;
  owner: string;
  reason: string;
  expires: string;
  paths?: string[];
  approvedBy?: string;
  approval?: string;
}

export interface RepoConfig {
  mode: "report" | "enforce";
  targets: TargetTool[];
  facts: DeclaredFacts;
  ignore: IgnoredPath[];
  exceptions: RecordedException[];
  /** Byte budget for `resolve`. */
  resolveBudgetBytes: number;
  /** Line budget for the AGENTS.md block. */
  agentsBlockLines: number;
  adapterTimeoutSeconds: number;
  /** Whether `sync` writes the SDK's MCP server into `.mcp.json`. */
  mcpServer: boolean;
}

export const DEFAULTS = {
  resolveBudgetBytes: 16 * 1024,
  agentsBlockLines: 40,
  adapterTimeoutSeconds: 60,
};

const KNOWN_KEYS = new Set(["$schema", "mode", "targets", "facts", "ignore", "exceptions", "budgets", "adapterTimeoutSeconds", "mcpServer"]);
/** Keys that other tools use to turn rules off. The SDK refuses them. */
const OPT_OUT_KEYS = new Set(["rules", "disable", "disabled", "disabledRules", "off", "overrides", "severity", "enabled"]);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FACT_VALUES: Record<string, string[]> = {
  bundler: ["vite", "webpack", "rspack", "none"],
  moduleFederation: ["none", "1", "2"],
  role: ["host", "remote", "both", "none"],
};

export interface LoadedConfig {
  config: RepoConfig;
  exists: boolean;
  diagnostics: Diagnostic[];
}

/** Loads `.de-web-sdk/config.json`, reporting every problem with its field. */
export function loadConfig(root: string): LoadedConfig {
  const file = CONFIG_FILE;
  let raw: Record<string, unknown> | undefined;
  try {
    raw = readJsonSync<Record<string, unknown>>(path.join(root, file));
  } catch (e) {
    throw new SdkError("config", `${file} isn't valid JSON: ${(e as Error).message}`, [
      error("config.json", `${file} isn't valid JSON`, { file }),
    ]);
  }
  const diagnostics: Diagnostic[] = [];
  const config: RepoConfig = {
    mode: "report",
    targets: [...TARGET_TOOLS],
    facts: {},
    ignore: [],
    exceptions: [],
    ...DEFAULTS,
    mcpServer: true,
  };
  if (!raw) return { config, exists: false, diagnostics };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { config, exists: true, diagnostics: [error("config.type", `${file} must hold a JSON object`, { file })] };
  }

  for (const key of Object.keys(raw)) {
    if (OPT_OUT_KEYS.has(key)) {
      diagnostics.push(
        error(
          "config.optOut",
          `The configuration can't turn off a pack's rule (${JSON.stringify(key)}). Record an exception with an owner, reason, and expiry date under "exceptions", or ignore generated paths with a reason under "ignore"`,
          { file, field: key },
        ),
      );
    } else if (!KNOWN_KEYS.has(key)) {
      diagnostics.push(error("config.unknown", `Unknown configuration field ${JSON.stringify(key)}`, { file, field: key }));
    }
  }

  if (raw.mode !== undefined) {
    if (raw.mode === "report" || raw.mode === "enforce") config.mode = raw.mode;
    else diagnostics.push(error("config.mode", `mode must be "report" or "enforce"`, { file, field: "mode" }));
  }

  if (raw.targets !== undefined) {
    if (!Array.isArray(raw.targets)) {
      diagnostics.push(error("config.targets", "targets must be a list of tool names", { file, field: "targets" }));
    } else {
      const targets: TargetTool[] = [];
      raw.targets.forEach((t, i) => {
        if ((TARGET_TOOLS as readonly string[]).includes(t as string)) targets.push(t as TargetTool);
        else diagnostics.push(error("config.targets", `Unknown target tool ${JSON.stringify(t)}; supported tools are ${TARGET_TOOLS.join(", ")}`, { file, field: `targets[${i}]` }));
      });
      config.targets = targets;
    }
  }

  if (raw.facts !== undefined) {
    const facts = raw.facts as Record<string, unknown>;
    if (!facts || typeof facts !== "object" || Array.isArray(facts)) {
      diagnostics.push(error("config.facts", "facts must be an object", { file, field: "facts" }));
    } else {
      for (const [key, value] of Object.entries(facts)) {
        if (key === "packages") {
          if (!value || typeof value !== "object" || Object.values(value).some((v) => typeof v !== "string")) {
            diagnostics.push(error("config.facts", "facts.packages must map package names to exact versions", { file, field: "facts.packages" }));
          } else {
            config.facts.packages = value as Record<string, string>;
          }
        } else if (FACT_VALUES[key]) {
          if (FACT_VALUES[key]!.includes(value as string)) (config.facts as Record<string, unknown>)[key] = value;
          else diagnostics.push(error("config.facts", `facts.${key} must be one of ${FACT_VALUES[key]!.map((v) => JSON.stringify(v)).join(", ")}`, { file, field: `facts.${key}` }));
        } else {
          diagnostics.push(error("config.facts", `Unknown fact ${JSON.stringify(key)}; facts are packages, bundler, moduleFederation, and role`, { file, field: `facts.${key}` }));
        }
      }
    }
  }

  if (raw.ignore !== undefined) {
    if (!Array.isArray(raw.ignore)) {
      diagnostics.push(error("config.ignore", "ignore must be a list", { file, field: "ignore" }));
    } else {
      raw.ignore.forEach((entry, i) => {
        const e = entry as Partial<IgnoredPath>;
        if (!e || typeof e.path !== "string" || !e.path) {
          diagnostics.push(error("config.ignore", `Ignored path ${i} has no path`, { file, field: `ignore[${i}].path` }));
        } else if (typeof e.reason !== "string" || !e.reason.trim()) {
          diagnostics.push(error("config.ignore", `Ignored path ${JSON.stringify(e.path)} has no reason`, { file, field: `ignore[${i}].reason` }));
        } else {
          config.ignore.push({ path: e.path, reason: e.reason });
        }
      });
    }
  }

  if (raw.exceptions !== undefined) {
    if (!Array.isArray(raw.exceptions)) {
      diagnostics.push(error("config.exceptions", "exceptions must be a list", { file, field: "exceptions" }));
    } else {
      raw.exceptions.forEach((entry, i) => {
        const e = entry as Partial<RecordedException>;
        const field = (name: string) => `exceptions[${i}].${name}`;
        const label = typeof e?.rule === "string" ? `Exception for ${e.rule}` : `Exception ${i}`;
        let ok = true;
        if (typeof e?.rule !== "string" || !/^.+#[a-z0-9][a-z0-9-]*$/.test(e.rule)) {
          diagnostics.push(error("config.exception", `${label} must name a rule as <pack>#<rule>`, { file, field: field("rule") }));
          ok = false;
        }
        for (const name of ["owner", "reason"] as const) {
          if (typeof e?.[name] !== "string" || !e[name]!.trim()) {
            diagnostics.push(error("config.exception", `${label} has no ${name}`, { file, field: field(name) }));
            ok = false;
          }
        }
        if (typeof e?.expires !== "string" || !DATE.test(e.expires) || Number.isNaN(Date.parse(e.expires))) {
          diagnostics.push(error("config.exception", `${label} needs an expiry date as YYYY-MM-DD`, { file, field: field("expires") }));
          ok = false;
        }
        if (e?.paths !== undefined && (!Array.isArray(e.paths) || e.paths.some((p) => typeof p !== "string"))) {
          diagnostics.push(error("config.exception", `${label}: paths must be a list of patterns`, { file, field: field("paths") }));
          ok = false;
        }
        if (ok) config.exceptions.push(e as RecordedException);
      });
    }
  }

  const budgets = raw.budgets as Record<string, unknown> | undefined;
  if (budgets !== undefined) {
    if (typeof budgets.resolveBytes === "number" && budgets.resolveBytes >= 1024) config.resolveBudgetBytes = budgets.resolveBytes;
    else if (budgets.resolveBytes !== undefined) diagnostics.push(error("config.budgets", "budgets.resolveBytes must be a number of at least 1024", { file, field: "budgets.resolveBytes" }));
    if (typeof budgets.agentsLines === "number" && budgets.agentsLines >= 10) config.agentsBlockLines = budgets.agentsLines;
    else if (budgets.agentsLines !== undefined) diagnostics.push(error("config.budgets", "budgets.agentsLines must be a number of at least 10", { file, field: "budgets.agentsLines" }));
  }
  if (raw.adapterTimeoutSeconds !== undefined) {
    if (typeof raw.adapterTimeoutSeconds === "number" && raw.adapterTimeoutSeconds > 0) config.adapterTimeoutSeconds = raw.adapterTimeoutSeconds;
    else diagnostics.push(error("config.timeout", "adapterTimeoutSeconds must be a positive number", { file, field: "adapterTimeoutSeconds" }));
  }

  if (raw.mcpServer !== undefined) {
    if (typeof raw.mcpServer === "boolean") config.mcpServer = raw.mcpServer;
    else diagnostics.push(error("config.mcpServer", "mcpServer must be true or false", { file, field: "mcpServer" }));
  }

  return { config, exists: true, diagnostics };
}

export function exceptionIsActive(exception: RecordedException, today: string): boolean {
  return exception.expires >= today;
}
