import { readFileSync } from "node:fs";
import path from "node:path";
import { matchesPaths, type ResolvedRule } from "./compose.ts";
import { contest } from "./output.ts";
import { scrubPaths } from "./scrub.ts";
import { skillLoaders } from "./skills.ts";
import { toPosix } from "./util.ts";
import type { Workspace } from "./workspace.ts";

export const RESOLVE_SCHEMA_VERSION = 1;

export interface ResolveOptions {
  files?: string[];
  rule?: string;
  pack?: string;
  format: "markdown" | "json";
  budgetBytes?: number;
}

interface RuleEntry {
  ref: string;
  pack: string;
  id: string;
  title: string;
  enforcement: string;
  locked: boolean;
  owner: ResolvedRule["owner"];
  rationale: string;
  fix?: string;
  paths?: string[];
  appliesTo?: string[];
  check?: { pack: string; adapter: string; options: Record<string, unknown> };
  guidance?: { path: string; text?: string; omitted?: string };
  contest: { link: string; command: string };
}

function normalizeFile(root: string, file: string): string {
  const abs = path.resolve(root, file);
  return toPosix(path.relative(root, abs));
}

function readGuidance(rule: ResolvedRule): string | undefined {
  if (!rule.guidance) return undefined;
  try {
    return readFileSync(rule.guidance.abs, "utf8").trim();
  } catch {
    return undefined;
  }
}

/**
 * `resolve`: the rules, skills, docs, and commands that apply to the given
 * files, within a byte budget. Omitted rules are named with the command that
 * returns them.
 */
export function resolveRules(ws: Workspace, options: ResolveOptions): string {
  const budget = options.budgetBytes ?? ws.config.resolveBudgetBytes;
  const files = (options.files ?? []).map((f) => normalizeFile(ws.root, f));
  const forFiles = <T extends { paths?: string[] }>(item: T): string[] | undefined =>
    files.length ? files.filter((f) => matchesPaths(item.paths, f)) : undefined;
  const applies = (item: { paths?: string[] }) => !files.length || (forFiles(item)?.length ?? 0) > 0;

  let rules = ws.ruleSet.rules.filter(applies);
  if (options.rule) rules = rules.filter((r) => r.ref === options.rule);
  if (options.pack) rules = rules.filter((r) => r.pack === options.pack);
  const skills = ws.ruleSet.skills.filter(applies).filter((s) => !options.pack || s.pack === options.pack);
  const docs = ws.ruleSet.docs.filter(applies).filter((d) => !options.pack || d.pack === options.pack);
  const commands = ws.ruleSet.commands.filter(applies).filter((c) => !options.pack || c.pack === options.pack);

  const entries: RuleEntry[] = rules.map((r) => ({
    ref: r.ref,
    pack: r.pack,
    id: r.id,
    title: r.title,
    enforcement: r.enforcement,
    locked: r.locked,
    owner: r.owner,
    rationale: r.rationale,
    ...(r.fix ? { fix: r.fix } : {}),
    ...(r.paths ? { paths: r.paths } : {}),
    ...(files.length ? { appliesTo: forFiles(r) } : {}),
    ...(r.check ? { check: { pack: r.check.pack, adapter: r.check.adapter, options: r.check.options } } : {}),
    ...(r.guidance ? { guidance: { path: r.guidance.display, text: readGuidance(r) } } : {}),
    contest: contest(r),
  }));

  const extras = {
    skills: skills.map((s) => ({ name: s.installName, skill: s.name, pack: s.pack, description: s.description, path: `${toPosix(path.relative(ws.root, s.dir))}/SKILL.md`, load: skillLoaders(s.installName) })),
    docs: docs.map((d) => ({ title: d.title, pack: d.pack, ...(d.description ? { description: d.description } : {}), path: d.display })),
    commands: commands.map((c) => ({ name: c.name, pack: c.pack, run: c.run, use: c.use })),
  };

  const render = (included: RuleEntry[], omitted: RuleEntry[]): string => {
    const omittedList = omitted.map((r) => ({ ref: r.ref, command: `npx --no de-web-sdk resolve --rule ${r.ref}` }));
    if (options.format === "json") {
      const doc = {
        schemaVersion: RESOLVE_SCHEMA_VERSION,
        kind: "resolve",
        files,
        rules: included,
        ...extras,
        omitted: omittedList,
        budgetBytes: budget,
      };
      return `${JSON.stringify(scrubPaths(doc, ws.root), null, 2)}\n`;
    }
    return markdown(files, included, extras, omittedList, budget);
  };

  // Include rules in order while the output fits; drop guidance text before dropping a rule.
  const included: RuleEntry[] = [];
  const omitted: RuleEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const rest = entries.slice(i + 1);
    const attempt = render([...included, entry], [...omitted, ...rest]);
    if (Buffer.byteLength(attempt) <= budget) {
      included.push(entry);
      continue;
    }
    if (entry.guidance?.text) {
      const slim = { ...entry, guidance: { path: entry.guidance.path, omitted: `run npx --no de-web-sdk resolve --rule ${entry.ref}` } };
      if (Buffer.byteLength(render([...included, slim], [...omitted, ...rest])) <= budget) {
        included.push(slim);
        continue;
      }
    }
    omitted.push(entry);
  }
  return render(included, omitted);
}

function markdown(
  files: string[],
  rules: RuleEntry[],
  extras: { skills: Array<{ name: string; pack: string; description: string; path: string }>; docs: Array<{ title: string; pack: string; description?: string; path: string }>; commands: Array<{ run: string; use: string; pack: string }> },
  omitted: Array<{ ref: string; command: string }>,
  budget: number,
): string {
  const out: string[] = [];
  out.push(files.length ? `# Rules for ${files.map((f) => JSON.stringify(f)).join(", ")}` : "# Rules for this repo");
  if (!rules.length && !omitted.length) out.push("", "No rules apply.");
  for (const r of rules) {
    out.push("", `## \`${r.ref}\` [${r.enforcement}${r.locked ? ", locked" : ""}]`, "", r.title, "");
    out.push(`- Owner: ${r.owner.team}${r.owner.contact ? ` (${r.owner.contact})` : ""}`);
    if (r.paths) out.push(`- Applies to: ${r.paths.map((p) => `\`${p}\``).join(", ")}`);
    if (r.appliesTo) out.push(`- Matching files: ${r.appliesTo.map((f) => JSON.stringify(f)).join(", ")}`);
    out.push(`- Why: ${r.rationale}`);
    if (r.check) out.push(`- Checked by: \`${r.check.pack}#${r.check.adapter}\`. Run \`npx --no de-web-sdk check\`.`);
    if (r.fix) out.push(`- Fix: ${r.fix}`);
    out.push(`- Contest: ${r.contest.link}, or run \`${r.contest.command}\``);
    if (r.guidance?.text) out.push("", `Guidance (\`${r.guidance.path}\`):`, "", r.guidance.text);
    else if (r.guidance) out.push(`- Guidance: \`${r.guidance.path}\`${r.guidance.omitted ? ` (${r.guidance.omitted})` : ""}`);
  }
  if (extras.skills.length) {
    out.push("", "## Skills", "");
    for (const s of extras.skills) out.push(`- \`${s.name}\` (${s.pack}): ${s.description} Load it with \`get_skill\` or \`npx --no de-web-sdk skill ${s.name}\`.`);
  }
  if (extras.docs.length) {
    out.push("", "## Reference docs", "");
    for (const d of extras.docs) out.push(`- ${d.title} (${d.pack}): \`${d.path}\`${d.description ? `. ${d.description}` : ""}`);
  }
  if (extras.commands.length) {
    out.push("", "## Commands", "");
    for (const c of extras.commands) out.push(`- \`${c.run}\` (${c.pack}): ${c.use}`);
  }
  if (omitted.length) {
    out.push("", `## Omitted to stay within ${Math.round(budget / 1024)} KiB`, "");
    for (const o of omitted) out.push(`- \`${o.ref}\`: run \`${o.command}\``);
  }
  return `${out.join("\n")}\n`;
}
