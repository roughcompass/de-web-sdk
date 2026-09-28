/**
 * Entry point of the child process that runs one adapter. The parent starts
 * it with Node.js's permission model: it can read the repo and the installed
 * packages, and it can't write files, start processes, or create workers.
 * It reads one job from standard input and writes one JSON line.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { result, type AdapterContext } from "./adapter.ts";

interface Job {
  module: string;
  root: string;
  rule: string;
  facts: AdapterContext["facts"];
  options: Record<string, unknown>;
  files: string[];
}

function reply(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function inside(root: string, file: string): string {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${file} is outside the repo`);
  return abs;
}

async function main(): Promise<void> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const job = JSON.parse(input) as Job;
  const mod = await import(pathToFileURL(job.module).href);
  const fn = typeof mod.default === "function" ? mod.default : mod.check;
  if (typeof fn !== "function") {
    reply({ ok: false, error: "the adapter module exports no default function" });
    return;
  }
  const context: AdapterContext = {
    root: job.root,
    facts: job.facts,
    options: job.options,
    files: job.files,
    rule: job.rule,
    async readText(file) {
      const abs = inside(job.root, file);
      if (!existsSync(abs)) return undefined;
      return readFile(abs, "utf8");
    },
    async readJson(file) {
      const abs = inside(job.root, file);
      if (!existsSync(abs)) return undefined;
      return JSON.parse(await readFile(abs, "utf8"));
    },
    exists(file) {
      return existsSync(inside(job.root, file));
    },
    result,
  };
  const output = await fn(context);
  reply({ ok: true, output });
}

main().catch((e: unknown) => {
  const err = e as { code?: string; message?: string };
  reply({ ok: false, error: err?.message ?? String(e), code: err?.code });
  process.exitCode = 1;
});
