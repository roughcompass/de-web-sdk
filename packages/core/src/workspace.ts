import type { KeyObject } from "node:crypto";
import { writeFile, unlink, mkdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planAgentFiles, type AgentPlan } from "./agents.ts";
import { collectPacks, type Collection } from "./collect.ts";
import { compose, type RuleSet } from "./compose.ts";
import { loadConfig, type RepoConfig } from "./config.ts";
import { hasErrors, SdkError, warning, type Diagnostic } from "./diagnostics.ts";
import { detectFacts, type FactReport } from "./facts.ts";
import { loadTrustPolicy, type TrustPolicy } from "./trust/policy.ts";

export interface WorkspaceOptions {
  root: string;
  /** Root public keys that verify the enterprise trust policy. The CLI builds them in. */
  rootKeys: KeyObject[];
  /** Whether the registry may be contacted to cache npm provenance attestations. */
  network: boolean;
}

export interface Workspace {
  root: string;
  config: RepoConfig;
  configExists: boolean;
  trust: TrustPolicy;
  facts: FactReport;
  collection: Collection;
  ruleSet: RuleSet;
  warnings: Diagnostic[];
}

/**
 * Loads configuration, trust, facts, and packs, then composes the rule set.
 * Throws an `SdkError` for configuration errors (exit 2) and trust or
 * integrity errors (exit 3). Trust errors win, so nothing runs on an
 * unverified pack.
 */
export async function loadWorkspace(options: WorkspaceOptions): Promise<Workspace> {
  const { root } = options;
  const loaded = loadConfig(root);
  if (hasErrors(loaded.diagnostics)) {
    throw new SdkError("config", "The SDK configuration has errors", loaded.diagnostics.filter((d) => d.severity === "error"));
  }
  const trust = loadTrustPolicy(root, options.rootKeys);
  const facts = detectFacts(root, loaded.config.facts);
  const collection = await collectPacks({ root, policy: trust, network: options.network });
  if (collection.trustErrors.length) {
    throw new SdkError("trust", "Pack verification failed", collection.trustErrors);
  }
  if (collection.configErrors.length) {
    throw new SdkError("config", "The local pack has errors", collection.configErrors);
  }
  const ruleSet = compose(collection.packs, facts, root);
  const warnings: Diagnostic[] = [...loaded.diagnostics, ...collection.warnings];
  if (!trust.exists && collection.packs.some((p) => p.ref !== "local")) {
    warnings.push(warning("trust.none", "The repo has no .de-web-sdk/trust.json"));
  }
  for (const d of facts.disagreements) {
    warnings.push(warning("facts.disagree", `Declared fact ${d.fact} is ${JSON.stringify(d.declared)}, but detection found ${JSON.stringify(d.detected)}`, { file: ".de-web-sdk/config.json", field: `facts.${d.fact}` }));
  }
  for (const limitation of facts.limitations) warnings.push(warning("facts.limitation", limitation));
  for (const s of collection.skipped) warnings.push(warning("collect.skipped", `Skipped the pack embedded in ${s.package}: ${s.reason}`));
  return { root, config: loaded.config, configExists: loaded.exists, trust, facts, collection, ruleSet, warnings };
}

export interface ApplyResult {
  written: string[];
  deleted: string[];
  unchanged: string[];
}

/** Writes planned files that changed and deletes stale generated ones. */
export async function applyAgentPlan(root: string, plan: AgentPlan): Promise<ApplyResult> {
  const result: ApplyResult = { written: [], deleted: [], unchanged: [] };
  for (const f of plan.files) {
    const abs = path.join(root, f.path);
    let current: string | undefined;
    try {
      current = readFileSync(abs, "utf8");
    } catch {
      current = undefined;
    }
    if (current === f.content) {
      result.unchanged.push(f.path);
      continue;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, f.content);
    result.written.push(f.path);
  }
  for (const d of plan.deletes) {
    const abs = path.join(root, d);
    await unlink(abs).catch(() => undefined);
    // Skill folders hold only the generated SKILL.md.
    if (d.endsWith("/SKILL.md")) await rm(path.dirname(abs), { recursive: true, force: true });
    result.deleted.push(d);
  }
  return result;
}

export interface SyncResult {
  workspace: Workspace;
  plan: AgentPlan;
  applied: ApplyResult;
}

/** `sync`: verify, compose, and regenerate agent files. It never changes configuration or source files. */
export async function sync(options: WorkspaceOptions): Promise<SyncResult> {
  const workspace = await loadWorkspace(options);
  const plan = planAgentFiles(options.root, workspace.ruleSet, workspace.config, workspace.facts);
  const applied = await applyAgentPlan(options.root, plan);
  return { workspace, plan, applied };
}

export function planFor(workspace: Workspace): AgentPlan {
  return planAgentFiles(workspace.root, workspace.ruleSet, workspace.config, workspace.facts);
}
