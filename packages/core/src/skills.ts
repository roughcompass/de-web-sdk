import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { CollectedPack } from "./collect.ts";
import type { ResolvedSkill } from "./compose.ts";
import { error, SdkError } from "./diagnostics.ts";
import { findHiddenCharacter } from "./hidden.ts";
import { digestOf, isFile, toPosix, walkFiles } from "./util.ts";
import type { Workspace } from "./workspace.ts";

/** How agents load skills when no files are installed for them: the MCP tool and the CLI command. */
export function skillLoaders(installName: string): { tool: string; command: string } {
  return { tool: "get_skill", command: `npx --no de-web-sdk skill ${installName}` };
}

export interface PackFile {
  /** Repo-relative path. */
  path: string;
  size: number;
  /** The digest the pack's manifest lists, when the file is the pack's own. */
  digest?: string;
}

export interface SkillView {
  name: string;
  skill: string;
  pack: string;
  description: string;
  uri: string;
  /** Repo-relative folder, for commands the skill runs. */
  dir: string;
  files: PackFile[];
  content: string;
}

const PAGE = 64 * 1024;

/** Finds a skill by its install name, `<pack>#<skill>`, or a skill name that only one pack uses. */
export function findSkill(ws: Workspace, name: string): ResolvedSkill | undefined {
  const skills = ws.ruleSet.skills;
  const exact = skills.find((s) => s.installName === name || s.ref === name);
  if (exact) return exact;
  const byName = skills.filter((s) => s.name === name);
  return byName.length === 1 ? byName[0] : undefined;
}

function owningPack(ws: Workspace, abs: string): CollectedPack | undefined {
  return ws.collection.packs
    .filter((p) => abs === p.dir || abs.startsWith(p.dir + path.sep))
    .sort((a, b) => b.dir.length - a.dir.length)[0];
}

/**
 * Reads a file a pack delivers, checking it against the pack's manifest
 * digest at the moment it's served. Files referenced in other packages were
 * verified through their package's provenance when the workspace loaded.
 */
export function readVerified(ws: Workspace, abs: string): { text: string; digest?: string } {
  const bytes = readFileSync(abs);
  const pack = owningPack(ws, abs);
  const rel = pack ? toPosix(path.relative(pack.dir, abs)) : undefined;
  const expected = pack && pack.ref !== "local" && rel ? pack.manifest.files?.[rel] : undefined;
  const display = toPosix(path.relative(ws.root, abs));
  if (pack && pack.ref !== "local" && rel && pack.manifest.files && expected === undefined) {
    throw new SdkError("trust", `${display} isn't part of ${pack.ref}`, [error("digest.unlisted", `${display} isn't listed in ${pack.ref}'s manifest`, { file: display })]);
  }
  if (expected && digestOf(bytes) !== expected) {
    throw new SdkError("trust", `${display} changed after install`, [error("digest.mismatch", `${display} doesn't match its digest in ${pack!.ref}. Reinstall the pack`, { file: display })]);
  }
  const text = bytes.toString("utf8");
  const hidden = findHiddenCharacter(text);
  if (hidden) throw new SdkError("trust", `${display} contains a hidden character`, [error("hidden.character", `${display} contains ${hidden.codePoint} at line ${hidden.line}`, { file: display, line: hidden.line })]);
  return { text, digest: expected };
}

function filesOf(ws: Workspace, dir: string): PackFile[] {
  const pack = owningPack(ws, dir);
  return walkFiles(dir, { skipDirs: ["node_modules"] }).map((rel) => {
    const abs = path.join(dir, rel);
    const packRel = pack ? toPosix(path.relative(pack.dir, abs)) : undefined;
    const digest = pack && packRel ? pack.manifest.files?.[packRel] : undefined;
    return { path: toPosix(path.relative(ws.root, abs)), size: statSync(abs).size, ...(digest ? { digest } : {}) };
  });
}

/** Loads a skill from its verified pack: SKILL.md and the list of its supporting files. */
export function getSkill(ws: Workspace, name: string): SkillView {
  const skill = findSkill(ws, name);
  if (!skill) {
    const names = ws.ruleSet.skills.map((s) => s.installName);
    throw new SdkError("usage", `No applicable skill is named ${JSON.stringify(name)}${names.length ? `. Skills: ${names.join(", ")}` : ""}`);
  }
  const { text } = readVerified(ws, path.join(skill.dir, "SKILL.md"));
  return {
    name: skill.installName,
    skill: skill.name,
    pack: skill.pack,
    description: skill.description,
    uri: `skill://${skill.installName}/SKILL.md`,
    dir: toPosix(path.relative(ws.root, skill.dir)),
    files: filesOf(ws, skill.dir),
    content: text,
  };
}

/** Folders and files that agents may read through the SDK: packs, and skills and docs they reference. */
function readableRoots(ws: Workspace): string[] {
  return [...ws.collection.packs.map((p) => p.dir), ...ws.ruleSet.skills.map((s) => s.dir), ...ws.ruleSet.docs.map((d) => d.abs)];
}

/** Reads one page of a file that a collected pack delivers, verified as it's served. */
export function readPackFile(ws: Workspace, file: string, offset = 0): { path: string; text: string; offset: number; nextOffset?: number; size: number; digest?: string } {
  const abs = path.resolve(ws.root, file);
  const allowed = readableRoots(ws).some((r) => abs === r || abs.startsWith(r + path.sep));
  if (!allowed || !isFile(abs)) {
    throw new SdkError("usage", `${file} isn't a file that a collected pack delivers. Use the paths that resolve and get_skill return`);
  }
  const { text, digest } = readVerified(ws, abs);
  const page = text.slice(offset, offset + PAGE);
  const next = offset + PAGE < text.length ? offset + PAGE : undefined;
  return { path: toPosix(path.relative(ws.root, abs)), text: page, offset, ...(next !== undefined ? { nextOffset: next } : {}), size: text.length, ...(digest ? { digest } : {}) };
}

/** Resolves a `skill://<name>/<path>` URI to a repo-relative file path. */
export function skillUriPath(ws: Workspace, uri: string): string {
  const m = /^skill:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!m) throw new SdkError("usage", `${uri} isn't a skill URI`);
  const skill = findSkill(ws, m[1]!);
  if (!skill) throw new SdkError("usage", `No applicable skill is named ${m[1]}`);
  const abs = path.resolve(skill.dir, m[2]!);
  if (!abs.startsWith(skill.dir + path.sep)) throw new SdkError("usage", `${uri} is outside the skill`);
  return toPosix(path.relative(ws.root, abs));
}
