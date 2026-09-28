import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolvePackageDir, SdkError } from "@de-web-sdk/core";

export interface Route {
  driver: string;
  /** An enterprise endpoint, for the pipeline. Credentials come from `credentialEnv`. */
  endpoint?: string;
  /** The developer's own local installation, such as their Claude Code sign-in. */
  local?: boolean;
  /** VS Code language model selectors. */
  vendor?: string;
  family?: string;
  /** The model id on this route, when it differs from the alias's model. */
  model?: string;
  /** Environment variable that holds the endpoint's credential. */
  credentialEnv?: string;
  requestsPerMinute?: number;
}

export interface ModelEntry {
  model: string;
  routes: Route[];
}

export interface EvalProfile {
  required: string[];
  gate: { confidence: number; minTrials: number; resolveThreshold: number };
  models: Record<string, ModelEntry>;
}

export const PROFILE_FILE = "eval-profile.json";
export const DEFAULT_GATE = { confidence: 0.95, minTrials: 20, resolveThreshold: 0.8 };

/**
 * Loads the platform's eval profile from a file, or from a package that holds
 * `eval-profile.json`. Packs never hold endpoints or credentials; only the
 * profile does.
 */
export function loadProfile(spec: string | undefined, cwd: string): EvalProfile {
  if (!spec) {
    throw new SdkError("usage", "Pass --profile <file or package>, or set DE_WEB_SDK_EVAL_PROFILE, to name the platform's eval profile");
  }
  let file = path.resolve(cwd, spec);
  if (!existsSync(file)) {
    const dir = resolvePackageDir(cwd, spec);
    if (dir && existsSync(path.join(dir, PROFILE_FILE))) file = path.join(dir, PROFILE_FILE);
    else throw new SdkError("usage", `Can't find the eval profile ${spec}`);
  }
  let raw: Partial<EvalProfile>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new SdkError("config", `The eval profile isn't valid JSON: ${(e as Error).message}`);
  }
  const profile: EvalProfile = {
    required: raw.required ?? [],
    gate: { ...DEFAULT_GATE, ...raw.gate },
    models: raw.models ?? {},
  };
  for (const alias of profile.required) {
    if (!profile.models[alias]) throw new SdkError("config", `The eval profile requires ${alias}, but doesn't define it under models`);
  }
  for (const [alias, entry] of Object.entries(profile.models)) {
    if (!entry.model || !Array.isArray(entry.routes) || entry.routes.length === 0) {
      throw new SdkError("config", `Eval profile model ${alias} needs a model and at least one route`);
    }
  }
  if (profile.gate.confidence <= 0 || profile.gate.confidence >= 1) throw new SdkError("config", "gate.confidence must be between 0 and 1");
  return profile;
}

/** The aliases a pack's evals cover: its own list plus every alias the profile requires. */
export function coveredAliases(profile: EvalProfile, packModels: string[] = []): string[] {
  return [...new Set([...packModels, ...profile.required])].filter((a) => profile.models[a]).sort();
}

export function routeKey(route: Route): string {
  if (route.endpoint) return `${route.driver}@${route.endpoint}`;
  if (route.vendor) return `${route.driver}:${route.vendor}/${route.family ?? ""}`;
  if (route.local) return `${route.driver}:local`;
  return route.driver;
}
