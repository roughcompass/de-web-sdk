import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterFacts, SarifResult } from "./adapter.ts";
import { isFile, relativeTo, sha256 } from "./util.ts";

export interface AdapterJob {
  module: string;
  root: string;
  rule: string;
  facts: AdapterFacts;
  options: Record<string, unknown>;
  files: string[];
  timeoutMs: number;
}

/** A normalized adapter result: a violation located by repo-relative path. */
export interface Finding {
  file: string;
  line?: number;
  column?: number;
  message: string;
  /** Stable key built from the file and the result's partial fingerprints. */
  fingerprint: string;
  /** The adapter's own SARIF result, passed through unchanged. */
  sarif: SarifResult;
}

export type AdapterRun =
  | { ok: true; findings: Finding[]; warnings: string[]; durationMs: number }
  | { ok: false; error: string; durationMs: number };

const MAX_OUTPUT = 16 * 1024 * 1024;

const ENV_ALLOW = new Set(["PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "SYSTEMROOT", "LANG", "TZ", "CI"]);

/**
 * The environment adapters run with: only what Node.js and a locale need.
 * Developers' tokens, such as ones for feedback destinations, never reach
 * pack code.
 */
export function adapterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (ENV_ALLOW.has(k) || k.startsWith("LC_")) out[k] = v;
  return out;
}

function hostPath(): string {
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), `adapter-host${path.extname(here)}`);
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The nearest directory above `file` that holds a package.json. */
function packageRootOf(file: string): string {
  let dir = path.dirname(file);
  for (;;) {
    if (isFile(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(file);
    dir = parent;
  }
}

/** Every node_modules directory that Node.js searches from `dir`, so an adapter can import its own dependencies. */
function moduleDirs(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; d = path.dirname(d)) {
    const candidate = path.join(d, "node_modules");
    if (existsSync(candidate)) out.push(candidate);
    if (path.dirname(d) === d) return out;
  }
}

/** Node.js flags for the adapter process: read access only. */
export function permissionFlags(job: Pick<AdapterJob, "root" | "module">): string[] {
  const host = hostPath();
  const adapterPackage = packageRootOf(job.module);
  // The permission model compares path strings, so allow each path and its real path.
  const reads = new Set(
    [job.root, path.resolve(path.dirname(host), ".."), adapterPackage, ...moduleDirs(adapterPackage), ...moduleDirs(real(adapterPackage))].flatMap((p) => [p, real(p)]),
  );
  const inherited = process.execArgv.filter((a) => a.startsWith("--conditions") || a.startsWith("-C") || a === "--experimental-strip-types");
  return ["--permission", ...[...reads].map((p) => `--allow-fs-read=${p}`), ...inherited];
}

/**
 * Runs one adapter in a child process with Node.js's permission model and a
 * time limit. The permission model guards against mistakes, not malice; see
 * design D4.
 */
export function runAdapter(job: AdapterJob): Promise<AdapterRun> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...permissionFlags(job), hostPath()], {
      cwd: job.root,
      stdio: ["pipe", "pipe", "pipe"],
      env: adapterEnv(process.env),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (run: AdapterRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(run);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `the adapter ran longer than its time limit of ${Math.round(job.timeoutMs / 1000)} seconds and was stopped`, durationMs: Date.now() - started });
    }, job.timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
      if (stdout.length > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish({ ok: false, error: "the adapter wrote more than 16 MiB of output", durationMs: Date.now() - started });
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += d.toString("utf8");
    });
    child.on("error", (e) => finish({ ok: false, error: `the adapter process couldn't start: ${e.message}`, durationMs: Date.now() - started }));
    child.on("close", (code) => {
      const durationMs = Date.now() - started;
      const line = stdout.trim().split("\n").pop();
      let reply: { ok?: boolean; output?: unknown; error?: string; code?: string } | undefined;
      try {
        reply = line ? JSON.parse(line) : undefined;
      } catch {
        reply = undefined;
      }
      if (!reply) {
        const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
        finish({ ok: false, error: `the adapter exited with code ${code} without a result${detail ? `: ${detail}` : ""}`, durationMs });
        return;
      }
      if (!reply.ok) {
        const access = reply.code === "ERR_ACCESS_DENIED" ? " (access denied: adapters can read the repo and installed packages, but can't write files, start processes, or create workers)" : "";
        finish({ ok: false, error: `the adapter crashed: ${reply.error}${access}`, durationMs });
        return;
      }
      finish(normalizeOutput(reply.output, job.root, durationMs));
    });
    child.stdin.end(
      JSON.stringify({ module: real(job.module), root: real(job.root), rule: job.rule, facts: job.facts, options: job.options, files: job.files }),
    );
  });
}

/** Accepts `{ results }`, `{ error }`, or a SARIF log, and locates each result by repo-relative path. */
export function normalizeOutput(output: unknown, root: string, durationMs = 0): AdapterRun {
  if (!output || typeof output !== "object") {
    return { ok: false, error: "the adapter returned no results object", durationMs };
  }
  const o = output as { error?: unknown; results?: unknown; runs?: Array<{ results?: unknown }> };
  if (typeof o.error === "string") return { ok: false, error: o.error, durationMs };
  let results: unknown[];
  if (Array.isArray(o.results)) results = o.results;
  else if (Array.isArray(o.runs)) results = o.runs.flatMap((r) => (Array.isArray(r.results) ? r.results : []));
  else return { ok: false, error: "the adapter returned neither results nor a SARIF log", durationMs };

  const findings: Finding[] = [];
  const warnings: string[] = [];
  for (const raw of results) {
    const r = raw as SarifResult;
    if (!r || typeof r.message?.text !== "string") {
      warnings.push("the adapter returned a result without a message, which was skipped");
      continue;
    }
    if (r.level === "none" || r.level === "note") continue;
    const loc = r.locations?.[0]?.physicalLocation;
    let uri = loc?.artifactLocation?.uri ?? ".";
    if (uri.startsWith("file://")) uri = fileURLToPath(uri);
    let file: string | undefined = uri;
    if (path.isAbsolute(uri)) file = relativeTo(root, uri) ?? relativeTo(real(root), uri);
    else file = path.posix.normalize(uri.replace(/\\/g, "/"));
    if (!file || file.startsWith("..")) {
      warnings.push("the adapter returned a result outside the repo, which was skipped");
      continue;
    }
    const keys = Object.entries(r.partialFingerprints ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const basis = keys.length ? keys.map(([k, v]) => `${k}=${v}`).join("\n") : `${r.ruleId ?? ""}\n${r.message.text}`;
    findings.push({
      file,
      line: loc?.region?.startLine,
      column: loc?.region?.startColumn,
      message: r.message.text,
      fingerprint: sha256(`${file}\n${basis}`).slice(0, 20),
      sarif: r,
    });
  }
  return { ok: true, findings, warnings, durationMs };
}
