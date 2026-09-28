import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_FILE,
  TARGET_TOOLS,
  TRUST_FILE,
  checkJson,
  checkJunit,
  checkSarif,
  checkText,
  draftFeedback,
  getSkill,
  MCP_CONFIG,
  MCP_SERVER_NAME,
  readPackFile,
  submitFeedback,
  detectPackageManager,
  EXIT,
  formatJson,
  loadWorkspace,
  pluralize,
  quote,
  readPackageJson,
  resolutionRecord,
  resolveRules,
  runCheck,
  SdkError,
  sync,
  writeFileAtomic,
  type FeedbackKind,
  type SubmissionResult,
  type SyncResult,
  type Workspace,
} from "@de-web-sdk/core";
import { fail, jsonMode, printDiagnostics, printJson, type Io } from "./io.ts";
import { mcpToolCaller, vscodeToolCaller } from "./mcp/client.ts";

function network(io: Io, offline?: boolean): boolean {
  return !offline && io.env.DE_WEB_SDK_OFFLINE !== "1";
}

function syncSummary(result: SyncResult) {
  const ws = result.workspace;
  return {
    packs: ws.collection.packs.map((p) => ({
      id: p.ref,
      ...(p.version ? { version: p.version } : {}),
      kind: p.kind,
      via: p.via,
      ...(p.provenance ? { provenance: p.provenance.method } : {}),
    })),
    rules: ws.ruleSet.rules.map((r) => ({ rule: r.ref, enforcement: r.enforcement, locked: r.locked })),
    skills: ws.ruleSet.skills.map((s) => ({ name: s.installName, pack: s.pack })),
    docs: ws.ruleSet.docs.map((d) => ({ title: d.title, pack: d.pack, path: d.display })),
    commands: ws.ruleSet.commands.map((c) => ({ name: c.name, pack: c.pack, run: c.run })),
    facts: ws.facts.facts,
    disagreements: ws.facts.disagreements,
    limitations: ws.facts.limitations,
    notEvaluated: ws.facts.notEvaluated,
    exclusions: ws.ruleSet.exclusions,
    skipped: ws.collection.skipped,
    mcpServer: result.workspace.config.mcpServer ? MCP_SERVER_NAME : null,
    overrides: ws.ruleSet.overrides,
    written: result.applied.written,
    deleted: result.applied.deleted,
  };
}

function printSyncText(io: Io, result: SyncResult): void {
  const ws = result.workspace;
  const set = ws.ruleSet;
  const published = ws.collection.packs.filter((p) => p.ref !== "local");
  if (!ws.collection.packs.length) {
    io.stdout("de-web-sdk sync: No packs are installed. Add one with `npx --no de-web-sdk init <pack>`.\n");
  } else {
    const machine = set.rules.filter((r) => r.enforcement === "machine").length;
    io.stdout(
      `de-web-sdk sync: ${pluralize(published.length, "pack")}${ws.collection.packs.some((p) => p.ref === "local") ? " and the local pack" : ""}. ${pluralize(set.rules.length, "rule")} apply (${machine} machine), with ${pluralize(set.skills.length, "skill")}, ${pluralize(set.docs.length, "doc")}, and ${pluralize(set.commands.length, "command")}.\n`,
    );
  }
  const f = ws.facts.facts;
  io.stdout(`Facts: bundler ${f.bundler}${f.bundlerVersion ? ` ${f.bundlerVersion}` : ""}, Module Federation ${f.moduleFederation}, role ${f.role}${f.react ? `, React ${f.react}` : ""}.\n`);
  for (const d of ws.facts.disagreements) io.stdout(`Declared ${d.fact} is ${quote(d.declared)}, but detection found ${quote(d.detected)}. The declared value applies.\n`);
  if (ws.facts.notEvaluated.length) io.stdout(`Not evaluated: ${ws.facts.notEvaluated.join(", ")}. The SDK evaluates the root package only.\n`);
  if (set.exclusions.length) {
    io.stdout("Excluded:\n");
    for (const e of set.exclusions) io.stdout(`  ${e.kind} ${e.ref}: ${e.reason}\n`);
  }
  if (result.workspace.config.mcpServer) io.stdout(`Agents reach the SDK through the ${MCP_SERVER_NAME} MCP server in ${MCP_CONFIG}. Claude Code asks once to approve it, and VS Code starts it in a trusted folder.\n`);
  for (const o of set.overrides) io.stdout(`Eval gate override in ${o.pack} for model ${o.model}: ${quote(o.reason)} Approved by ${o.approvedBy}, expires ${o.expires}.\n`);
  const changed = [...result.applied.written, ...result.applied.deleted.map((d) => `${d} (deleted)`)];
  io.stdout(changed.length ? `Updated ${changed.join(", ")}.\n` : "No files changed.\n");
  printDiagnostics(io, [...ws.warnings, ...result.plan.warnings]);
}

export async function cmdSync(io: Io, flags: { format?: string; offline?: boolean }): Promise<number> {
  const json = jsonMode(io, flags.format);
  try {
    const result = await sync({ root: io.cwd, rootKeys: io.rootKeys, network: network(io, flags.offline) });
    if (json) printJson(io, { schemaVersion: 1, kind: "sync", exitCode: 0, ...syncSummary(result), diagnostics: [...result.workspace.warnings, ...result.plan.warnings] });
    else printSyncText(io, result);
    return EXIT.ok;
  } catch (e) {
    return fail(io, "sync", e, json);
  }
}

export async function cmdResolve(io: Io, files: string[], flags: { format?: string; rule?: string; pack?: string; budget?: string; offline?: boolean }): Promise<number> {
  const json = jsonMode(io, flags.format);
  try {
    if (flags.format && !["json", "markdown"].includes(flags.format)) throw new SdkError("usage", "--format must be markdown or json");
    const budget = flags.budget ? Number(flags.budget) : undefined;
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1024)) throw new SdkError("usage", "--budget takes a number of bytes, at least 1024");
    const ws = await loadWorkspace({ root: io.cwd, rootKeys: io.rootKeys, network: network(io, flags.offline) });
    io.stdout(resolveRules(ws, { files, rule: flags.rule, pack: flags.pack, format: json ? "json" : "markdown", budgetBytes: budget }));
    return EXIT.ok;
  } catch (e) {
    return fail(io, "resolve", e, json);
  }
}

export interface CheckFlags {
  format?: string;
  output?: string;
  record?: string;
  baseline?: boolean;
  enforce?: boolean;
  "prune-baseline"?: boolean;
  "baseline-ref"?: string;
  offline?: boolean;
}

export async function cmdCheck(io: Io, flags: CheckFlags, files: string[] = []): Promise<number> {
  const format = flags.format ?? (io.env.DE_WEB_SDK_FORMAT === "json" ? "json" : "text");
  const json = format === "json";
  try {
    if (!["text", "json", "sarif", "junit"].includes(format)) throw new SdkError("usage", "--format must be text, json, sarif, or junit");
    if (flags.enforce && !flags.baseline) throw new SdkError("usage", "--enforce works with --baseline. To enforce without a baseline, set \"mode\": \"enforce\" in .de-web-sdk/config.json");
    const ws: Workspace = await loadWorkspace({ root: io.cwd, rootKeys: io.rootKeys, network: network(io, flags.offline) });
    const result = await runCheck(ws, {
      baseline: flags.baseline,
      enforce: flags.enforce,
      pruneBaseline: flags["prune-baseline"],
      baselineRef: flags["baseline-ref"],
      files: files.map((f) => path.relative(io.cwd, path.resolve(io.cwd, f)).split(path.sep).join("/")),
    });
    const ctx = { workspace: ws, result, sdkVersion: io.version };
    const body =
      format === "json" ? formatJson(checkJson(ctx)) : format === "sarif" ? formatJson(checkSarif(ctx)) : format === "junit" ? checkJunit(ctx) : checkText(ctx);
    if (flags.output) {
      await writeFileAtomic(path.resolve(io.cwd, flags.output), body);
      if (format !== "text") io.stdout(checkText(ctx));
    } else {
      io.stdout(body);
    }
    if (flags.record) await writeFileAtomic(path.resolve(io.cwd, flags.record), formatJson(resolutionRecord(ws, result, io.version)));
    return result.exitCode;
  } catch (e) {
    return fail(io, "check", e, json);
  }
}

export interface FeedbackFlags {
  kind?: string;
  message?: string;
  lines?: string[];
  format?: string;
  offline?: boolean;
  submit?: boolean;
  yes?: boolean;
}

/**
 * `feedback`: drafts a report and names where the pack's adapter sends it.
 * With `--submit`, it sends the report after the developer approves it, and
 * falls back to the pack's feedback link when it can't.
 */
export async function cmdFeedback(io: Io, rule: string | undefined, flags: FeedbackFlags): Promise<number> {
  const json = jsonMode(io, flags.format);
  try {
    if (!rule) throw new SdkError("usage", "Name the rule: de-web-sdk feedback <pack>#<rule> --kind <kind> --message <text>");
    if (!flags.kind) throw new SdkError("usage", "Pass --kind: false-positive, missed-violation, unclear-guidance, or agent-ignored-rule");
    if (!flags.message) throw new SdkError("usage", "Pass --message with the reason for the report");
    const ws = await loadWorkspace({ root: io.cwd, rootKeys: io.rootKeys, network: network(io, flags.offline) });
    const draft = draftFeedback(ws, { rule, kind: flags.kind as FeedbackKind, message: flags.message, lines: flags.lines, sdkVersion: io.version });
    let submission: SubmissionResult | undefined;
    if (flags.submit) {
      if (!flags.yes) {
        if (!io.interactive || !io.ask) throw new SdkError("usage", "Sending a report needs approval, from the developer or an agent acting for them. Review it, then pass --yes");
        io.stdout(`This report goes to ${draft.adapter.destination}:\n\n${JSON.stringify(draft.report, null, 2)}\n\n`);
        const answer = (await io.ask("Send it? [y/N] ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") submission = { status: "declined", link: draft.link, prefilled: draft.prefilled };
      }
      submission ??= await submitFeedback(draft, mcpToolCaller({ root: ws.root, env: io.env, viaVsCode: vscodeToolCaller(io.env) }));
    }
    if (json) {
      printJson(io, {
        schemaVersion: 1,
        kind: "feedback",
        exitCode: 0,
        draftId: draft.id,
        adapter: { type: draft.adapter.type, destination: draft.adapter.destination },
        link: draft.link,
        prefilled: draft.prefilled,
        report: draft.report,
        ...(submission ? { submission } : {}),
      });
      return EXIT.ok;
    }
    if (submission?.status === "submitted") {
      io.stdout(`Sent the report through ${submission.via}.${submission.reference ? ` Reference: ${submission.reference}.` : ""}${submission.url ? ` ${submission.url}` : ""}\n`);
      return EXIT.ok;
    }
    if (submission?.status === "declined") io.stdout("Not sent.\n");
    else if (submission?.status === "link") io.stdout(`Couldn't send it automatically: ${submission.reason}.\n`);
    else if (draft.adapter.submits) io.stdout(`The pack sends reports to ${draft.adapter.destination}. Run again with --submit to send this one.\n`);
    if (draft.prefilled) io.stdout(`Open this link to file the report with the report filled in:\n${draft.link}\n`);
    else io.stdout(`Open ${draft.link} and paste this report:\n\n${JSON.stringify(draft.report, null, 2)}\n`);
    return EXIT.ok;
  } catch (e) {
    return fail(io, "feedback", e, json);
  }
}

/** `skill`: prints a skill, or one of its files, from its verified pack. */
export async function cmdSkill(io: Io, name: string | undefined, flags: { file?: string; format?: string; offline?: boolean }): Promise<number> {
  const json = jsonMode(io, flags.format);
  try {
    const ws = await loadWorkspace({ root: io.cwd, rootKeys: io.rootKeys, network: network(io, flags.offline) });
    if (!name) {
      const skills = ws.ruleSet.skills.map((s) => ({ name: s.installName, pack: s.pack, description: s.description }));
      if (json) printJson(io, { schemaVersion: 1, kind: "skills", skills });
      else io.stdout(skills.length ? skills.map((s) => `${s.name} (${s.pack}): ${s.description}\n`).join("") : "No skills apply to this repo.\n");
      return EXIT.ok;
    }
    const skill = getSkill(ws, name);
    if (flags.file) {
      const page = readPackFile(ws, flags.file.startsWith(skill.dir) ? flags.file : `${skill.dir}/${flags.file}`);
      if (json) printJson(io, { schemaVersion: 1, kind: "skill-file", skill: skill.name, ...page });
      else io.stdout(page.text + (page.nextOffset !== undefined ? `\n[truncated at ${page.nextOffset} characters]\n` : ""));
      return EXIT.ok;
    }
    if (json) printJson(io, { schemaVersion: 1, kind: "skill", ...skill });
    else io.stdout(`${skill.content}\n\nFiles in this skill (read one with --file <path>):\n${skill.files.map((f) => `- ${f.path}`).join("\n")}\n`);
    return EXIT.ok;
  } catch (e) {
    return fail(io, "skill", e, json);
  }
}

export interface InitFlags {
  enforce?: boolean;
  fact?: string[];
  target?: string[];
  "trust-policy"?: string;
  install?: boolean;
  yes?: boolean;
  format?: string;
  offline?: boolean;
}

const FACT_KEYS = new Set(["bundler", "moduleFederation", "role"]);

function parseFacts(specs: string[] = []): Record<string, unknown> {
  const facts: Record<string, unknown> = {};
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0) throw new SdkError("usage", `--fact takes key=value, such as moduleFederation=2, not ${quote(spec)}`);
    const key = spec.slice(0, eq);
    const value = spec.slice(eq + 1);
    if (key.startsWith("packages.")) {
      facts.packages = { ...(facts.packages as object), [key.slice("packages.".length)]: value };
    } else if (FACT_KEYS.has(key)) {
      facts[key] = value;
    } else {
      throw new SdkError("usage", `Unknown fact ${quote(key)}. Facts are bundler, moduleFederation, role, and packages.<name>`);
    }
  }
  return facts;
}

function readJsonFile(abs: string): Record<string, unknown> | undefined {
  if (!existsSync(abs)) return undefined;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    throw new SdkError("config", `${path.basename(abs)} isn't valid JSON`);
  }
}

function installCommand(manager: string, packages: string[]): [string, string[]] {
  if (manager === "pnpm") return ["pnpm", ["add", "--save-dev", ...packages]];
  if (manager === "yarn") return ["yarn", ["add", "--dev", ...packages]];
  if (manager === "bun") return ["bun", ["add", "--dev", ...packages]];
  return ["npm", ["install", "--save-dev", ...packages]];
}

/** `init`: creates configuration and the trust policy, adds named packs, records facts, then runs `sync`. */
export async function cmdInit(io: Io, packs: string[], flags: InitFlags): Promise<number> {
  const json = jsonMode(io, flags.format);
  try {
    const pkg = readPackageJson(io.cwd);
    if (!pkg) throw new SdkError("usage", "Run init at the root of a repo that has a package.json");
    const targets = flags.target ?? [];
    for (const t of targets) {
      if (!(TARGET_TOOLS as readonly string[]).includes(t)) throw new SdkError("usage", `Unknown --target ${quote(t)}. Supported tools are ${TARGET_TOOLS.join(", ")}`);
    }
    const facts = parseFacts(flags.fact);
    const created: string[] = [];

    const configPath = path.join(io.cwd, CONFIG_FILE);
    const existing = readJsonFile(configPath);
    const config: Record<string, unknown> = existing ? { ...existing } : { mode: flags.enforce ? "enforce" : "report" };
    if (existing && flags.enforce) config.mode = "enforce";
    if (targets.length) config.targets = targets;
    if (Object.keys(facts).length) {
      const merged = { ...(config.facts as object), ...facts } as Record<string, unknown>;
      if (facts.packages) merged.packages = { ...((config.facts as Record<string, object>)?.packages ?? {}), ...(facts.packages as object) };
      config.facts = merged;
    }
    const ordered: Record<string, unknown> = { mode: config.mode };
    for (const [k, v] of Object.entries(config)) if (k !== "mode") ordered[k] = v;
    const configText = formatJson(ordered);
    if (!existing || readFileSync(configPath, "utf8") !== configText) {
      await writeFileAtomic(configPath, configText);
      created.push(CONFIG_FILE);
    }

    const trustPath = path.join(io.cwd, TRUST_FILE);
    const trustPolicy = flags["trust-policy"] ?? io.env.DE_WEB_SDK_TRUST_POLICY;
    if (!existsSync(trustPath)) {
      await writeFileAtomic(trustPath, formatJson({ ...(trustPolicy ? { extends: trustPolicy } : {}), scopes: {} }));
      created.push(TRUST_FILE);
    }

    const toInstall = [...packs, ...(trustPolicy && !existsSync(path.join(io.cwd, "node_modules", ...trustPolicy.split("/"))) ? [trustPolicy] : [])];
    let installedWith: string | undefined;
    if (toInstall.length && flags.install !== false) {
      const manager = detectPackageManager(io.cwd, pkg.packageManager);
      const [cmd, args] = installCommand(manager, toInstall);
      installedWith = `${cmd} ${args.join(" ")}`;
      if (!json) io.stdout(`Running ${installedWith}\n`);
      const run = spawnSync(cmd, args, { cwd: io.cwd, stdio: ["ignore", json ? "pipe" : "inherit", json ? "pipe" : "inherit"], env: io.env, shell: process.platform === "win32" });
      if (run.status !== 0) {
        throw new SdkError("usage", `${installedWith} failed${run.error ? `: ${run.error.message}` : ""}. Fix the install, then rerun init`);
      }
    }

    const result = await sync({ root: io.cwd, rootKeys: io.rootKeys, network: network(io, flags.offline) });
    if (json) {
      printJson(io, { schemaVersion: 1, kind: "init", exitCode: 0, created, installed: toInstall, ...(installedWith ? { installedWith } : {}), mode: ordered.mode, ...syncSummary(result), diagnostics: [...result.workspace.warnings, ...result.plan.warnings] });
    } else {
      if (created.length) io.stdout(`Wrote ${created.join(", ")}.\n`);
      io.stdout(`Mode: ${ordered.mode}.${ordered.mode === "report" ? " The pipeline lists violations without failing. Run `npx --no de-web-sdk check --baseline --enforce` after a build to start enforcing." : ""}\n`);
      printSyncText(io, result);
    }
    return EXIT.ok;
  } catch (e) {
    return fail(io, "init", e, json);
  }
}
