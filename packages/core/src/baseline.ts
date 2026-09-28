import { readFileSync } from "node:fs";
import path from "node:path";
import { BASELINE_FILE } from "./config.ts";
import { error, SdkError } from "./diagnostics.ts";
import { showAtRef } from "./git.ts";
import { writeFileAtomic } from "./util.ts";

export interface BaselineEntry {
  rule: string;
  file: string;
  fingerprint: string;
}

export function entryKey(e: BaselineEntry): string {
  return `${e.rule}\u0000${e.file}\u0000${e.fingerprint}`;
}

export function sortEntries(entries: BaselineEntry[]): BaselineEntry[] {
  const unique = new Map(entries.map((e) => [entryKey(e), { rule: e.rule, file: e.file, fingerprint: e.fingerprint }]));
  return [...unique.values()].sort(
    (a, b) => a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.fingerprint.localeCompare(b.fingerprint),
  );
}

/** One sorted entry per line, so parallel pull requests conflict on single lines. */
export function formatBaseline(entries: BaselineEntry[]): string {
  const sorted = sortEntries(entries);
  const lines = sorted.map((e, i) => `    ${JSON.stringify(e)}${i < sorted.length - 1 ? "," : ""}`);
  return `{\n  "baselineVersion": 1,\n  "entries": [\n${lines.join("\n")}${lines.length ? "\n" : ""}  ]\n}\n`;
}

export function parseBaseline(text: string, source: string): BaselineEntry[] {
  let data: { baselineVersion?: number; entries?: BaselineEntry[] };
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new SdkError("config", `${source} isn't valid JSON`, [error("baseline.json", `${source} isn't valid JSON: ${(e as Error).message}`, { file: BASELINE_FILE })]);
  }
  if (data.baselineVersion !== 1 || !Array.isArray(data.entries)) {
    throw new SdkError("config", `${source} isn't a version 1 baseline`, [error("baseline.format", `${source} isn't a version 1 baseline`, { file: BASELINE_FILE })]);
  }
  return data.entries.filter((e) => typeof e?.rule === "string" && typeof e.file === "string" && typeof e.fingerprint === "string");
}

export function readBaseline(root: string): BaselineEntry[] | undefined {
  let text: string;
  try {
    text = readFileSync(path.join(root, BASELINE_FILE), "utf8");
  } catch {
    return undefined;
  }
  return parseBaseline(text, BASELINE_FILE);
}

export async function writeBaseline(root: string, entries: BaselineEntry[]): Promise<void> {
  await writeFileAtomic(path.join(root, BASELINE_FILE), formatBaseline(entries));
}

export type BaseComparison =
  | { status: "introduced" }
  | { status: "compared"; added: BaselineEntry[] }
  | { status: "refMissing" };

/** Compares the working baseline with the one at `ref`, for the shrink-only rule. */
export function compareWithRef(root: string, ref: string, current: BaselineEntry[]): BaseComparison {
  const shown = showAtRef(root, ref, BASELINE_FILE);
  if (!shown.found) return shown.refExists ? { status: "introduced" } : { status: "refMissing" };
  const base = new Set(parseBaseline(shown.text, `${BASELINE_FILE} at ${ref}`).map(entryKey));
  return { status: "compared", added: sortEntries(current).filter((e) => !base.has(entryKey(e))) };
}
