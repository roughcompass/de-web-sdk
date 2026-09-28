import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { formatDiagnostic, hasErrors, SdkError, SIGNATURE_FILE, MANIFEST_FILE, verifyDigests, type Diagnostic } from "@de-web-sdk/core";
import { buildPack, packTarball } from "./build.ts";
import { draftTaskFromFeedback, importFeedback, listOpenByRule } from "./evals/feedback.ts";
import { evaluateGate } from "./evals/gate.ts";
import { finishGuided, prepareGuided } from "./evals/guided.ts";
import { coveredAliases, loadProfile, routeKey } from "./evals/profile.ts";
import { readRuns } from "./evals/records.ts";
import { buildReport, reportText } from "./evals/report.ts";
import { comparisonQueue, recordComparison, recordReview, reviewQueue } from "./evals/review.ts";
import { chooseRoute, runEvals } from "./evals/runner.ts";
import { TOOLKIT_VERSION_ENV } from "./evals/drivers/index.ts";
import { scaffoldPack } from "./new.ts";
import { generateKeys, loadPrivateKey, signFile } from "./sign.ts";
import { computeDigests, contentDigest, loadSource, publishedFiles } from "./source.ts";
import { validateSource } from "./validate.ts";

/** True when `file` is in a git work tree and not ignored, so `git add -A` would commit it. */
function gitWouldAdd(file: string): boolean {
  return spawnSync("git", ["check-ignore", "-q", path.basename(file)], { cwd: path.dirname(file), stdio: "ignore" }).status === 1;
}

export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

export interface ToolkitIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (t: string) => void;
  stderr: (t: string) => void;
  interactive: boolean;
  /** Answers prompts in tests; defaults to reading the terminal. */
  ask?: (question: string) => Promise<string>;
  now?: () => Date;
  version: string;
}

const HELP = `Usage: de-web-sdk-pack <command> [options]

Commands:
  new <id> --owner <team> --feedback <url>   Scaffold a pack that passes validate
  validate                                    Check the pack, its fixtures, and its eval tasks
  build [--out <dir>]                         Digest files, apply the eval gate, write the manifest and tarball
  sign --key <file|env:NAME>                  Sign the built manifest in the Sigstore bundle format
  keygen --out <dir>                          Create a producer key pair
  eval run [--local] [--yes]                  Run eval trials on every covered model
  eval report                                 Print the latest eval report and gate decision
  eval review [--compare]                     Review trials without seeing their condition
  eval add --from-feedback <id>               Draft an eval task from a feedback report
  eval doctor                                 Show which route reaches each model here
  eval guided prepare --task <id> --model <alias> | finish --worktree <dir>
  feedback import <file|->                    Store a consumer's feedback report
  feedback list                               List open reports by rule

Common options: --dir <pack dir>, --profile <file or package>, --format json
Exit codes: 0 done, 1 validation or gate failure, 2 usage or configuration error, 3 trust error.
`;

const S = { type: "string" } as const;
const B = { type: "boolean" } as const;
const OPTIONS: ParseArgsConfig["options"] = {
  dir: S, profile: S, format: S, out: S, key: S, file: S, owner: S, contact: S, feedback: S,
  local: B, yes: { type: "boolean", short: "y" }, models: S, tasks: S, runs: S, published: S, keep: B,
  run: S, list: B, compare: B, record: S, verdict: S, choice: S, reason: S, unsupported: S, reviewer: S,
  "from-feedback": S, task: S, model: S, worktree: S, "no-tarball": B, help: { type: "boolean", short: "h" },
};

function print(io: ToolkitIo, diagnostics: Diagnostic[]): void {
  for (const d of diagnostics) io.stderr(`${formatDiagnostic(d)}\n`);
}

function json(io: ToolkitIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

async function ask(io: ToolkitIo, question: string): Promise<string> {
  if (io.ask) return io.ask(question);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function profileSpec(io: ToolkitIo, v: Record<string, unknown>): string | undefined {
  return (v.profile as string | undefined) ?? io.env.DE_WEB_SDK_EVAL_PROFILE;
}

export async function main(argv: string[], options: Partial<ToolkitIo> = {}): Promise<number> {
  const io: ToolkitIo = {
    cwd: options.cwd ?? process.cwd(),
    env: { ...(options.env ?? process.env), [TOOLKIT_VERSION_ENV]: options.version ?? VERSION },
    stdout: options.stdout ?? ((t) => process.stdout.write(t)),
    stderr: options.stderr ?? ((t) => process.stderr.write(t)),
    interactive: options.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask: options.ask,
    now: options.now,
    version: options.version ?? VERSION,
  };
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true }) as typeof parsed;
  } catch (e) {
    io.stderr(`${(e as Error).message}\n`);
    return 2;
  }
  const v = parsed.values;
  const [command, sub, ...rest] = parsed.positionals;
  if (!command || v.help) {
    io.stdout(HELP);
    return command || v.help ? 0 : 2;
  }
  const dir = path.resolve(io.cwd, (v.dir as string | undefined) ?? ".");
  const asJson = v.format === "json";
  const now = io.now ?? (() => new Date());
  try {
    switch (command) {
      case "new": {
        if (!sub) throw new SdkError("usage", "Name the pack: de-web-sdk-pack new <npm package name> --owner <team> --feedback <url>");
        if (!v.owner || !v.feedback) throw new SdkError("usage", "Pass --owner <team> and --feedback <url>");
        const target = path.resolve(io.cwd, (v.dir as string | undefined) ?? sub.split("/").pop()!);
        const files = await scaffoldPack({ id: sub, team: v.owner as string, contact: v.contact as string | undefined, feedback: v.feedback as string, dir: target, sdkVersion: io.version });
        io.stdout(`Created ${files.length} files in ${path.relative(io.cwd, target) || "."}. Run \`npm install\` there, then \`npx --no de-web-sdk-pack validate\`.\n`);
        return 0;
      }
      case "validate": {
        const source = loadSource(dir);
        const result = await validateSource(source);
        if (asJson) json(io, { schemaVersion: 1, kind: "validate", ok: !hasErrors(result.diagnostics), diagnostics: result.diagnostics });
        else {
          print(io, result.diagnostics);
          const errors = result.diagnostics.filter((d) => d.severity === "error").length;
          const warnings = result.diagnostics.filter((d) => d.severity === "warning").length;
          const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
          io.stdout(errors ? `${count(errors, "error")}, ${count(warnings, "warning")}.\n` : `${source.manifest.id} is valid${warnings ? `, with ${count(warnings, "warning")}` : ""}.\n`);
        }
        return hasErrors(result.diagnostics) ? 1 : 0;
      }
      case "build": {
        const source = loadSource(dir);
        const profile = source.manifest.rules?.length ? loadProfile(profileSpec(io, v), io.cwd) : undefined;
        const out = v["no-tarball"] ? undefined : path.resolve(io.cwd, (v.out as string | undefined) ?? path.join(source.packageDir, "dist-pack"));
        const result = await buildPack({ source, profile, out, now: now() });
        print(io, result.diagnostics.filter((d) => d.severity !== "info"));
        if (asJson) json(io, { schemaVersion: 1, kind: "build", ok: result.ok, digest: result.digest, tarball: result.tarball, gate: result.gate });
        else {
          for (const d of result.gate?.decisions ?? []) io.stdout(`Gate for ${d.alias}: ${d.status}${d.reasons.length ? `. ${d.reasons.join(". ")}` : ""}${d.ranIn ? ` (ran in ${d.ranIn})` : ""}\n`);
          io.stdout(result.ok ? `Built ${source.manifest.id} (${result.digest}).${result.tarball ? ` Tarball: ${path.relative(io.cwd, result.tarball)}` : ""}\n` : "The build failed the eval gate, so the manifest wasn't written.\n");
        }
        return result.ok ? 0 : 1;
      }
      case "sign": {
        if (!v.key) throw new SdkError("usage", "Pass --key <PEM file> or --key env:<VARIABLE>");
        const source = loadSource(dir);
        const file = v.file ? path.resolve(io.cwd, v.file as string) : path.join(source.dir, MANIFEST_FILE);
        const target = v.file ? `${file.replace(/\.json$/, "")}.sigstore.json` : path.join(source.dir, SIGNATURE_FILE);
        if (!v.file && !source.manifest.files) throw new SdkError("usage", "Run build before sign, so the manifest lists every file's digest");
        if (!v.file) {
          // Consumers would reject a signed manifest whose digests don't match the published files.
          const stale = verifyDigests(source.dir, source.manifest.files!, { publishedFiles: publishedFiles(source) });
          if (stale.length) throw new SdkError("usage", `Files changed since the last build: ${stale.map((d) => d.file).join(", ")}. Run build again, then sign`);
        }
        const signed = await signFile(file, loadPrivateKey(v.key as string, io.env, io.cwd), target);
        io.stdout(`Signed ${path.relative(io.cwd, file)} with key ${signed.keyId}. Wrote ${path.relative(io.cwd, target)}.\n`);
        if (!v.file && v.out) io.stdout(`Tarball: ${path.relative(io.cwd, packTarball(source, path.resolve(io.cwd, v.out as string)))}\n`);
        return 0;
      }
      case "keygen": {
        if (!v.out) throw new SdkError("usage", "Pass --out <dir> for the key files");
        const { writeFileAtomic } = await import("@de-web-sdk/core");
        const outDir = path.resolve(io.cwd, v.out as string);
        const privatePath = path.join(outDir, "private.pem");
        if (existsSync(privatePath)) throw new SdkError("usage", `${path.relative(io.cwd, privatePath)} already exists. Move it first, so keygen doesn't replace a key in use`);
        const keys = generateKeys();
        await writeFileAtomic(privatePath, keys.privatePem, 0o600);
        await writeFileAtomic(path.join(outDir, "public.pem"), keys.publicPem);
        io.stdout(`Wrote private.pem and public.pem. Keep private.pem in the pipeline's secret store.\nKey ${keys.keyId}. Trust policy entry: "keys": ["${keys.publicBase64}"]\n`);
        if (gitWouldAdd(privatePath)) io.stderr(`warning: ${path.relative(io.cwd, privatePath)} is in a git repository and isn't ignored. Add it to .gitignore, or move the keys out of the repo.\n`);
        return 0;
      }
      case "eval":
        return await evalCommand(io, sub, rest, v, dir, now);
      case "feedback": {
        const source = loadSource(dir);
        if (sub === "import") {
          const file = rest[0];
          if (!file) throw new SdkError("usage", "Pass the report file, or - to read standard input");
          const raw = file === "-" ? readFileSync(0, "utf8") : readFileSync(path.resolve(io.cwd, file), "utf8");
          const item = await importFeedback(source, raw, now());
          io.stdout(`Imported report ${item.id} on rule ${item.report.rule} (${item.report.kind}). Draft an eval task with \`de-web-sdk-pack eval add --from-feedback ${item.id}\`.\n`);
          return 0;
        }
        if (sub === "list") {
          const open = listOpenByRule(source);
          if (asJson) json(io, { schemaVersion: 1, kind: "feedback-list", open });
          else if (!Object.keys(open).length) io.stdout("No open feedback reports.\n");
          else for (const [rule, items] of Object.entries(open)) io.stdout(`${rule}: ${items.map((i) => `${i.id} (${i.report.kind}${i.task ? `, task ${i.task}` : ""}): ${JSON.stringify(i.report.message)}`).join("; ")}\n`);
          return 0;
        }
        throw new SdkError("usage", "Use feedback import <file> or feedback list");
      }
      default:
        io.stderr(`Unknown command ${JSON.stringify(command)}.\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    const err = e instanceof SdkError ? e : new SdkError("usage", (e as Error)?.message ?? String(e));
    if (asJson) json(io, { schemaVersion: 1, kind: command, error: err.message, diagnostics: err.diagnostics });
    else {
      io.stderr(`de-web-sdk-pack ${command}: ${err.message}\n`);
      print(io, err.diagnostics);
    }
    return err.exitCode;
  }
}

async function evalCommand(io: ToolkitIo, sub: string | undefined, rest: string[], v: Record<string, unknown>, dir: string, now: () => Date): Promise<number> {
  const source = loadSource(dir);
  const asJson = v.format === "json";
  switch (sub) {
    case "run": {
      const profile = loadProfile(profileSpec(io, v), io.cwd);
      const published = v.published === "none" ? false : (v.published as string | undefined);
      const run = await runEvals({
        source,
        profile,
        env: io.env,
        local: Boolean(v.local),
        yes: Boolean(v.yes),
        interactive: io.interactive,
        models: v.models ? String(v.models).split(",") : undefined,
        tasks: v.tasks ? String(v.tasks).split(",") : undefined,
        runs: v.runs ? Number(v.runs) : undefined,
        published: published === undefined ? undefined : published,
        keep: Boolean(v.keep),
        toolkitVersion: io.version,
        log: (line) => io.stderr(`${line}\n`),
        confirm: async (q) => /^y(es)?$/i.test((await ask(io, `${q} [y/N] `)).trim()),
        now,
      });
      const gate = evaluateGate(readRuns(source.dir), run.pack.candidateDigest, profile, source.evalConfig, now().toISOString().slice(0, 10));
      const report = buildReport(source, run, readRuns(source.dir), gate);
      if (asJson) json(io, report);
      else io.stdout(reportText(report, profile));
      return 0;
    }
    case "report": {
      const profile = loadProfile(profileSpec(io, v), io.cwd);
      const runs = readRuns(source.dir);
      const run = v.run ? runs.find((r) => r.id === v.run) : runs.filter((r) => r.trials.some((t) => !t.guided)).at(-1);
      if (!run) throw new SdkError("usage", "No eval runs are recorded. Run `de-web-sdk-pack eval run`");
      const digest = contentDigest(source.manifest, computeDigests(source, publishedFiles(source)));
      const gate = evaluateGate(runs, digest, profile, source.evalConfig, now().toISOString().slice(0, 10));
      const report = buildReport(source, run, runs, gate);
      if (asJson) json(io, report);
      else io.stdout(reportText(report, profile));
      return 0;
    }
    case "doctor": {
      const profile = loadProfile(profileSpec(io, v), io.cwd);
      for (const alias of coveredAliases(profile, source.evalConfig?.models)) {
        const plan = await chooseRoute({ profile, local: Boolean(v.local), source, toolkitVersion: io.version, env: io.env }, alias, v.local || !io.env.CI ? "local" : "pipeline");
        io.stdout("reasons" in plan ? `${alias}: unreachable. ${plan.reasons.join("; ")}\n` : `${alias}: ${plan.modelId} via ${routeKey(plan.route)} (${plan.toolVersion})\n`);
      }
      return 0;
    }
    case "add": {
      if (!v["from-feedback"]) throw new SdkError("usage", "Use eval add --from-feedback <report id>");
      const { file, task } = await draftTaskFromFeedback(source, v["from-feedback"] as string);
      io.stdout(`Drafted ${file} for rule ${task.exercises[0]}. Edit its prompt and starting state, then run the evals.\n`);
      return 0;
    }
    case "guided": {
      const action = rest[0];
      if (action === "prepare") {
        if (!v.task || !v.model) throw new SdkError("usage", "Pass --task <id> and --model <alias>");
        const prepared = await prepareGuided(source, v.task as string, v.model as string, io.env, now());
        json(io, { schemaVersion: 1, kind: "guided-trial", ...prepared });
        return 0;
      }
      if (action === "finish") {
        if (!v.worktree) throw new SdkError("usage", "Pass --worktree <dir>");
        const trial = await finishGuided(path.resolve(io.cwd, v.worktree as string), io.env, now());
        if (asJson) json(io, { schemaVersion: 1, kind: "guided-result", trial });
        else io.stdout(`Guided trial ${trial.id} on ${trial.task}: ${trial.passed ? "passed" : "failed"}. It appears beside harness results and doesn't count toward the gate.\n`);
        return 0;
      }
      throw new SdkError("usage", "Use eval guided prepare or eval guided finish");
    }
    case "review":
      return await reviewCommand(io, source, v, now);
    default:
      throw new SdkError("usage", "Use eval run, report, review, add, doctor, or guided");
  }
}

async function reviewCommand(io: ToolkitIo, source: ReturnType<typeof loadSource>, v: Record<string, unknown>, now: () => Date): Promise<number> {
  const reviewer = (v.reviewer as string | undefined) ?? io.env.USER ?? "reviewer";
  if (v.compare) {
    if (v.record) {
      const rec = await recordComparison(source, { pair: v.record as string, choice: v.choice as "A" | "B" | "equal", reason: v.reason as string, reviewer }, now());
      io.stdout(`Recorded: ${rec.choice} for ${rec.task} on ${rec.model}.\n`);
      return 0;
    }
    const pairs = comparisonQueue(source);
    if (v.list || v.format === "json") {
      json(io, { schemaVersion: 1, kind: "comparison-queue", pairs });
      return 0;
    }
    if (!io.interactive) throw new SdkError("usage", "Interactive comparison needs a terminal. Use --list --format json and --record instead");
    for (const p of pairs) {
      io.stdout(`\nTask ${p.task} on ${p.model}\nPrompt: ${p.prompt}\n\n--- Result A (${p.a.grader}) ---\n${p.a.diff ?? "(no changes)"}\n--- Result B (${p.b.grader}) ---\n${p.b.diff ?? "(no changes)"}\n`);
      const choice = (await ask(io, "Better result? [A/B/e(qual)/s(kip)] ")).trim().toLowerCase();
      if (choice.startsWith("s") || !choice) continue;
      const reason = await ask(io, "Reason: ");
      await recordComparison(source, { pair: p.pair, choice: choice.startsWith("a") ? "A" : choice.startsWith("b") ? "B" : "equal", reason, reviewer }, now());
    }
    return 0;
  }
  if (v.record) {
    await recordReview(source, { trial: v.record as string, verdict: v.verdict as "agree" | "disagree", reason: v.reason as string, unsupportedClaims: v.unsupported ? Number(v.unsupported) : 0, reviewer }, now());
    io.stdout(`Recorded the review of ${v.record}.\n`);
    return 0;
  }
  const queue = reviewQueue(source, v.run as string | undefined);
  if (v.list || v.format === "json") {
    json(io, { schemaVersion: 1, kind: "review-queue", trials: queue });
    return 0;
  }
  if (!io.interactive) throw new SdkError("usage", "Interactive review needs a terminal. Use --list --format json and --record instead");
  for (const t of queue) {
    io.stdout(`\nTrial ${t.trial}, task ${t.task}\nPrompt: ${t.prompt}\nGraders: ${t.graders.map((g) => `${g.type} ${g.passed ? "passed" : "failed"}`).join(", ")}\n${t.check ? `Check: ${t.check}\n` : ""}\n${t.diff ?? "(no changes)"}\n`);
    const verdict = (await ask(io, `The grader says ${t.grader}. Agree? [a(gree)/d(isagree)/s(kip)] `)).trim().toLowerCase();
    if (verdict.startsWith("s") || !verdict) continue;
    const reason = await ask(io, "Reason: ");
    const claims = await ask(io, "Claims the pack's content doesn't support (count, default 0): ");
    await recordReview(source, { trial: t.trial, verdict: verdict.startsWith("d") ? "disagree" : "agree", reason, unsupportedClaims: Number(claims) || 0, reviewer }, now());
  }
  return 0;
}
