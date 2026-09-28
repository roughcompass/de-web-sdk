import { readFileSync } from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import semver from "semver";
import type { CollectedPack } from "./collect.ts";
import type { FactReport } from "./facts.ts";
import type { Condition, Enforcement, EvalOverride, Owner } from "./manifest.ts";
import { resolvePackageDir } from "./resolve-package.ts";
import { resolveInside, sha256 } from "./util.ts";

export interface ResolvedCheck {
  /** The pack that ships the adapter. */
  pack: string;
  adapter: string;
  options: Record<string, unknown>;
  /** Absolute path of the adapter module, when the adapter's pack was collected. */
  module?: string;
  /** Why the adapter can't run, such as a missing pack. */
  unavailable?: string;
}

export interface ResolvedRule {
  ref: string;
  pack: string;
  packVersion?: string;
  id: string;
  title: string;
  enforcement: Enforcement;
  locked: boolean;
  owner: Owner;
  rationale: string;
  fix?: string;
  paths?: string[];
  guidance?: { abs: string; display: string };
  check?: ResolvedCheck;
  /** Where to contest the rule: the pack's feedback channel. */
  contest: string;
}

export interface ResolvedSkill {
  ref: string;
  pack: string;
  name: string;
  /** The name the skill is installed under: pack-prefixed, so packs can't collide. */
  installName: string;
  description: string;
  dir: string;
  display: string;
  paths?: string[];
  contentHash: string;
}

export interface ResolvedDoc {
  pack: string;
  title: string;
  description?: string;
  abs: string;
  display: string;
  paths?: string[];
}

export interface ResolvedCommand {
  pack: string;
  name: string;
  run: string;
  use: string;
  paths?: string[];
}

export interface Exclusion {
  kind: "pack" | "rule" | "skill" | "doc" | "command";
  ref: string;
  reason: string;
}

export interface ConsumerOverride extends EvalOverride {
  pack: string;
}

export interface RuleSet {
  rules: ResolvedRule[];
  skills: ResolvedSkill[];
  docs: ResolvedDoc[];
  commands: ResolvedCommand[];
  exclusions: Exclusion[];
  overrides: ConsumerOverride[];
}

type ConditionResult = { ok: true } | { ok: false; reason: string };

/** Tests a condition against the repo's facts. Every listed fact must match. */
export function evaluateCondition(condition: Condition | undefined, report: FactReport): ConditionResult {
  if (!condition) return { ok: true };
  const facts = report.facts;
  for (const [key, expected] of Object.entries(condition)) {
    if (key === "packages") {
      for (const [name, range] of Object.entries(expected as Record<string, string>)) {
        const version = report.versionOf(name);
        if (!version) {
          if (report.limitations.length && !(name in facts.packages)) {
            return { ok: false, reason: `the version of ${name} is unknown (${report.limitations[0]})` };
          }
          return { ok: false, reason: `requires ${name} ${range}, which isn't installed` };
        }
        if (range !== "*" && !semver.satisfies(version, range, { includePrerelease: true })) {
          return { ok: false, reason: `requires ${name} ${range}, and ${version} is installed` };
        }
      }
    } else if (key === "bundler" || key === "moduleFederation" || key === "role") {
      const actual = facts[key];
      if (actual === "unknown") {
        return { ok: false, reason: `the ${key} fact is unknown; declare it under "facts" in .de-web-sdk/config.json` };
      }
      if (!(expected as string[]).includes(actual)) {
        return { ok: false, reason: `requires ${key} ${(expected as string[]).join(" or ")}, and the repo has ${actual}` };
      }
    } else {
      return { ok: false, reason: `its condition uses the fact ${JSON.stringify(key)}, which this SDK version doesn't support` };
    }
  }
  return { ok: true };
}

function mergeCondition(pack: Condition | undefined, item: Condition | undefined): Condition | undefined {
  if (!pack) return item;
  if (!item) return pack;
  return { ...pack, ...item };
}

/** Skill names are limited to 64 characters by the Agent Skills format. */
export function installNameFor(packRef: string, skill: string): string {
  const prefix = packRef === "local" ? "local" : packRef.replace(/^@/, "").replace(/[^a-z0-9]+/g, "-");
  const full = `${prefix}-${skill}`.replace(/-+/g, "-");
  if (full.length <= 64) return full;
  return `${full.slice(0, 55).replace(/-$/, "")}-${sha256(full).slice(0, 8)}`;
}

function hashSkillFile(dir: string): string {
  try {
    return sha256(readFileSync(path.join(dir, "SKILL.md")));
  } catch {
    return "";
  }
}

function skillDescription(dir: string): string | undefined {
  try {
    const text = readFileSync(path.join(dir, "SKILL.md"), "utf8");
    const m = /^---\r?\n[\s\S]*?^description:\s*(.+?)\s*$/m.exec(text);
    return m?.[1]?.replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

/** Locates an item's files in the pack, or in the package it references. */
function locate(pack: CollectedPack, rel: string, from: string | undefined, root: string): { abs: string; display: string } | undefined {
  const base = from ? (pack.packageDir ? resolvePackageDir(pack.packageDir, from) : resolvePackageDir(root, from)) : pack.dir;
  if (!base) return undefined;
  const abs = resolveInside(base, rel);
  if (!abs) return undefined;
  const display = path.relative(root, abs).split(path.sep).join("/");
  return { abs, display };
}

/**
 * Assembles one rule set from collected packs and the repo's facts, listing
 * every excluded item with its reason.
 */
export function compose(packs: CollectedPack[], report: FactReport, root: string): RuleSet {
  const set: RuleSet = { rules: [], skills: [], docs: [], commands: [], exclusions: [], overrides: [] };
  const byRef = new Map(packs.map((p) => [p.ref, p]));

  for (const pack of packs) {
    const m = pack.manifest;
    for (const override of m.evals?.overrides ?? []) set.overrides.push({ pack: pack.ref, ...override });

    // A pack that governs packages applies only when each is installed inside its range.
    let governed: ConditionResult = { ok: true };
    for (const [name, range] of Object.entries(m.governs ?? {})) {
      const version = report.versionOf(name);
      if (!version) governed = { ok: false, reason: `it governs ${name} ${range}, which isn't installed` };
      else if (!semver.satisfies(version, range, { includePrerelease: true })) {
        governed = { ok: false, reason: `it governs ${name} ${range}, and ${version} is installed` };
      }
      if (!governed.ok) break;
    }
    if (!governed.ok) {
      set.exclusions.push({ kind: "pack", ref: pack.ref, reason: governed.reason });
      continue;
    }

    const packCondition = evaluateCondition(m.appliesWhen, report);
    const itemsBefore = set.exclusions.length;
    let applied = 0;
    const applies = (kind: Exclusion["kind"], ref: string, own: Condition | undefined): boolean => {
      const result = evaluateCondition(mergeCondition(m.appliesWhen, own), report);
      if (!result.ok) {
        set.exclusions.push({ kind, ref, reason: result.reason });
        return false;
      }
      applied += 1;
      return true;
    };

    for (const rule of m.rules ?? []) {
      const ref = `${pack.ref}#${rule.id}`;
      if (!applies("rule", ref, rule.appliesWhen)) continue;
      const resolved: ResolvedRule = {
        ref,
        pack: pack.ref,
        packVersion: pack.version,
        id: rule.id,
        title: rule.title,
        enforcement: rule.enforcement,
        locked: rule.locked === true,
        owner: rule.owner ?? m.owner,
        rationale: rule.rationale,
        fix: rule.fix,
        paths: rule.paths ?? m.paths,
        contest: m.feedback,
      };
      if (rule.guidance) resolved.guidance = locate(pack, rule.guidance, undefined, root);
      if (rule.enforcement === "machine" && rule.check) {
        const adapterPackRef = rule.check.pack ?? pack.ref;
        const check: ResolvedCheck = { pack: adapterPackRef, adapter: rule.check.adapter, options: rule.check.options ?? {} };
        const adapterPack = byRef.get(adapterPackRef);
        if (!adapterPack) {
          check.unavailable = `the adapter's pack ${adapterPackRef} isn't installed`;
        } else {
          const entry = adapterPack.manifest.adapters?.find((a) => a.name === rule.check!.adapter);
          if (!entry) check.unavailable = `${adapterPackRef} has no adapter named ${rule.check.adapter}`;
          else {
            const loc = locate(adapterPack, entry.module, entry.from, root);
            if (loc) check.module = loc.abs;
            else check.unavailable = `the module for adapter ${rule.check.adapter} can't be found`;
          }
        }
        resolved.check = check;
      }
      set.rules.push(resolved);
    }

    for (const skill of m.skills ?? []) {
      const ref = `${pack.ref}#${skill.name}`;
      if (!applies("skill", ref, skill.appliesWhen)) continue;
      const loc = locate(pack, skill.path, skill.from, root);
      if (!loc) {
        set.exclusions.push({ kind: "skill", ref, reason: `its files can't be found` });
        continue;
      }
      set.skills.push({
        ref,
        pack: pack.ref,
        name: skill.name,
        installName: installNameFor(pack.ref, skill.name),
        description: skill.description ?? skillDescription(loc.abs) ?? "",
        dir: loc.abs,
        display: loc.display,
        paths: skill.paths ?? m.paths,
        contentHash: hashSkillFile(loc.abs),
      });
    }

    for (const doc of m.docs ?? []) {
      const ref = `${pack.ref}#${doc.title}`;
      if (!applies("doc", ref, doc.appliesWhen)) continue;
      const loc = locate(pack, doc.path, doc.from, root);
      if (!loc) {
        set.exclusions.push({ kind: "doc", ref, reason: "its files can't be found" });
        continue;
      }
      set.docs.push({ pack: pack.ref, title: doc.title, description: doc.description, abs: loc.abs, display: loc.display, paths: doc.paths ?? m.paths });
    }

    for (const command of m.commands ?? []) {
      const ref = `${pack.ref}#${command.name}`;
      if (!applies("command", ref, command.appliesWhen)) continue;
      // A pack's binaries are in node_modules/.bin, which isn't on an agent's PATH.
      const run = pack.ref === "local" ? command.run : `npx --no ${command.run}`;
      set.commands.push({ pack: pack.ref, name: command.name, run, use: command.use, paths: command.paths ?? m.paths });
    }

    // Report a whole pack once when its own condition excluded everything.
    if (!packCondition.ok && applied === 0 && set.exclusions.length > itemsBefore) {
      set.exclusions.splice(itemsBefore);
      set.exclusions.push({ kind: "pack", ref: pack.ref, reason: packCondition.reason });
    }
  }
  return set;
}

/** Does `file` fall under a rule's path patterns? Items without patterns apply everywhere. */
export function matchesPaths(paths: string[] | undefined, file: string): boolean {
  if (!paths || paths.length === 0) return true;
  return picomatch(paths, { dot: true })(file);
}
