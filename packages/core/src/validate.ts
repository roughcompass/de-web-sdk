import { readFileSync } from "node:fs";
import path from "node:path";
import { error, warning, type Diagnostic } from "./diagnostics.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { isKnownAdapter } from "./feedback-adapters.ts";
import { findHiddenCharacter } from "./hidden.ts";
import {
  checkSpecVersion,
  MANIFEST_FILE,
  SIGNATURE_FILE,
  validateSchema,
  type Manifest,
} from "./manifest.ts";
import { binNames, declaredDependencies, readPackageJson, resolvePackageDir, type PackageJson } from "./resolve-package.ts";
import { fileDigest, isDir, isFile, isTextFile, relativeTo, resolveInside, walkFiles } from "./util.ts";

export interface ValidateOptions {
  /** The repo's local pack: no identifier, version, digests, or provenance. */
  local?: boolean;
  /** The package.json of the package that contains the pack. */
  packageJson?: PackageJson;
  /** The npm package root, when it differs from the pack directory (embedded packs). */
  packageDir?: string;
  /** Check `files` digests. Defaults to true when the manifest lists files. */
  checkDigests?: boolean;
  /** Files that belong to the published pack, relative to the pack directory. Defaults to every file in it. */
  publishedFiles?: string[];
  /** Label used in messages, such as the pack identifier or `local`. */
  label?: string;
  /** Prefix for file names in diagnostics, such as `.de-web-sdk/local/`. */
  filePrefix?: string;
}

/** A text file that the pack delivers to agents, for hidden-character scanning. */
export interface DeliveredFile {
  abs: string;
  /** How to name the file in messages. */
  display: string;
}

export interface ValidationResult {
  diagnostics: Diagnostic[];
  delivered: DeliveredFile[];
}

/** Files that never count as pack content. */
export function isPackMetaFile(rel: string): boolean {
  return rel === MANIFEST_FILE || rel === SIGNATURE_FILE || rel.startsWith("node_modules/");
}

/**
 * Validates a pack directory against the specification: the schema, then the
 * rules that a schema can't express. Returns every problem in one pass.
 */
export function validatePackDir(dir: string, manifest: unknown, options: ValidateOptions = {}): ValidationResult {
  const prefix = options.filePrefix ?? "";
  const manifestFile = `${prefix}${MANIFEST_FILE}`;
  const label = options.label ?? (manifest as Manifest)?.id ?? "pack";
  const diagnostics: Diagnostic[] = [];
  const delivered: DeliveredFile[] = [];

  const spec = checkSpecVersion(manifest as Manifest, manifestFile, label);
  if (spec) return { diagnostics: [spec], delivered };

  diagnostics.push(...validateSchema(manifest, { local: options.local, file: manifestFile }));
  if (!manifest || typeof manifest !== "object") return { diagnostics, delivered };
  const m = manifest as Manifest;
  delivered.push({ abs: path.join(dir, MANIFEST_FILE), display: manifestFile });

  const pkg = options.packageJson;
  const packageDir = options.packageDir ?? dir;
  const deps = declaredDependencies(pkg);

  if (!options.local && pkg && m.id && pkg.name && m.id !== pkg.name) {
    diagnostics.push(
      error("manifest.id", `Pack identifier ${JSON.stringify(m.id)} must be the npm package name ${JSON.stringify(pkg.name)}`, {
        file: manifestFile,
        field: "id",
      }),
    );
  }
  if (!options.local && pkg && m.version && pkg.version && m.version !== pkg.version) {
    diagnostics.push(
      error("manifest.version", `Pack version ${m.version} must match the package version ${pkg.version}`, {
        file: manifestFile,
        field: "version",
      }),
    );
  }

  const unique = (items: Array<{ key: string; index: number }>, list: string, noun: string) => {
    const seen = new Map<string, number>();
    for (const { key, index } of items) {
      if (seen.has(key)) {
        diagnostics.push(
          error("manifest.duplicate", `${noun} ${JSON.stringify(key)} is declared more than once`, {
            file: manifestFile,
            field: `${list}[${index}]`,
          }),
        );
      } else {
        seen.set(key, index);
      }
    }
  };
  const keyed = (list: unknown[] | undefined, key: "id" | "name") =>
    (list ?? [])
      .map((item, index) => ({ key: (item as Record<string, unknown>)?.[key], index }))
      .filter((x): x is { key: string; index: number } => typeof x.key === "string");
  unique(keyed(m.rules, "id"), "rules", "Rule");
  unique(keyed(m.skills, "name"), "skills", "Skill");
  unique(keyed(m.adapters, "name"), "adapters", "Adapter");
  unique(keyed(m.commands, "name"), "commands", "Command");

  // Resolves a path in the pack, or in a referenced dependency.
  const locate = (rel: string, from: string | undefined, field: string, noun: string): { abs?: string; display?: string } => {
    if (typeof rel !== "string") return {};
    if (from) {
      if (!deps.has(from)) {
        diagnostics.push(
          error("manifest.fromUndeclared", `${noun} references package ${JSON.stringify(from)}, which the pack doesn't list as a dependency or peer dependency`, {
            file: manifestFile,
            field,
          }),
        );
        return {};
      }
      const depDir = resolvePackageDir(packageDir, from);
      if (!depDir) {
        diagnostics.push(
          warning("manifest.fromNotInstalled", `${noun} references ${JSON.stringify(from)}, which isn't installed, so its files weren't checked`, {
            file: manifestFile,
            field,
          }),
        );
        return {};
      }
      const abs = resolveInside(depDir, rel);
      if (!abs) return {};
      return { abs, display: `${from}/${rel}` };
    }
    const abs = resolveInside(dir, rel);
    if (!abs) return {};
    return { abs, display: `${prefix}${rel}` };
  };

  const deliverTree = (abs: string, display: string) => {
    if (isFile(abs)) {
      if (isTextFile(abs)) delivered.push({ abs, display });
      return;
    }
    for (const rel of walkFiles(abs, { skipDirs: ["node_modules"] })) {
      if (isTextFile(rel)) delivered.push({ abs: path.join(abs, rel), display: `${display}/${rel}` });
    }
  };

  const ownAdapters = new Set((m.adapters ?? []).map((a) => a?.name));

  (m.rules ?? []).forEach((rule, i) => {
    if (!rule || typeof rule !== "object") return;
    const name = JSON.stringify(rule.id);
    if (typeof rule.guidance === "string") {
      const { abs, display } = locate(rule.guidance, undefined, `rules[${i}].guidance`, `Rule ${name}`);
      if (abs && !isFile(abs)) {
        diagnostics.push(error("manifest.guidanceMissing", `Rule ${name}: guidance file ${JSON.stringify(rule.guidance)} doesn't exist`, { file: manifestFile, field: `rules[${i}].guidance` }));
      } else if (abs && display) {
        delivered.push({ abs, display });
      }
    }
    if (rule.enforcement === "advisory" && rule.check) {
      diagnostics.push(warning("manifest.advisoryCheck", `Rule ${name} is advisory, so its check never runs`, { file: manifestFile, field: `rules[${i}].check` }));
    }
    if (rule.enforcement === "machine" && rule.check && typeof rule.check.adapter === "string") {
      const fromPack = rule.check.pack;
      if (!fromPack || fromPack === m.id) {
        if (!ownAdapters.has(rule.check.adapter)) {
          diagnostics.push(
            error("manifest.adapterUnknown", `Rule ${name} uses adapter ${JSON.stringify(rule.check.adapter)}, which the pack doesn't declare`, {
              file: manifestFile,
              field: `rules[${i}].check.adapter`,
            }),
          );
        }
      } else if (!deps.has(fromPack)) {
        diagnostics.push(
          error(
            "manifest.adapterPackUndeclared",
            `Rule ${name} uses an adapter from ${JSON.stringify(fromPack)}, which the pack doesn't declare as a dependency`,
            { file: manifestFile, field: `rules[${i}].check.pack` },
          ),
        );
      } else {
        const depDir = resolvePackageDir(packageDir, fromPack);
        const depManifest = depDir ? readJsonQuiet(path.join(depDir, MANIFEST_FILE)) : undefined;
        if (depManifest && !(depManifest.adapters ?? []).some((a: { name?: string }) => a?.name === rule.check!.adapter)) {
          diagnostics.push(
            error("manifest.adapterUnknown", `Rule ${name} uses adapter ${JSON.stringify(rule.check.adapter)}, which ${fromPack} doesn't declare`, {
              file: manifestFile,
              field: `rules[${i}].check.adapter`,
            }),
          );
        }
      }
    }
  });

  (m.adapters ?? []).forEach((adapter, i) => {
    if (!adapter || typeof adapter.module !== "string") return;
    const { abs } = locate(adapter.module, adapter.from, `adapters[${i}].module`, `Adapter ${JSON.stringify(adapter.name)}`);
    if (abs && !isFile(abs)) {
      diagnostics.push(
        error("manifest.adapterMissing", `Adapter ${JSON.stringify(adapter.name)}: code file ${JSON.stringify(adapter.module)} doesn't exist`, {
          file: manifestFile,
          field: `adapters[${i}].module`,
        }),
      );
    }
  });

  (m.skills ?? []).forEach((skill, i) => {
    if (!skill || typeof skill.path !== "string") return;
    const noun = `Skill ${JSON.stringify(skill.name)}`;
    const { abs, display } = locate(skill.path, skill.from, `skills[${i}].path`, noun);
    if (!abs) {
      if (!skill.from && !skill.description) {
        diagnostics.push(error("manifest.skillDescription", `${noun} has no description`, { file: manifestFile, field: `skills[${i}].description` }));
      }
      return;
    }
    const skillFile = path.join(abs, "SKILL.md");
    if (!isFile(skillFile)) {
      diagnostics.push(error("manifest.skillMissing", `${noun}: ${JSON.stringify(skill.path)} has no SKILL.md`, { file: manifestFile, field: `skills[${i}].path` }));
      return;
    }
    const fm = parseFrontmatter(readFileSync(skillFile, "utf8"));
    const description = skill.description ?? (typeof fm?.data.description === "string" ? fm.data.description : undefined);
    if (!description || !description.trim()) {
      diagnostics.push(
        error("manifest.skillDescription", `${noun} has no description in the manifest or in its SKILL.md frontmatter`, {
          file: manifestFile,
          field: `skills[${i}].description`,
        }),
      );
    }
    if (display) deliverTree(abs, display);
  });

  (m.docs ?? []).forEach((doc, i) => {
    if (!doc || typeof doc.path !== "string") return;
    const { abs, display } = locate(doc.path, doc.from, `docs[${i}].path`, `Doc entry ${JSON.stringify(doc.title ?? i)}`);
    if (!abs) return;
    if (!isFile(abs) && !isDir(abs)) {
      diagnostics.push(error("manifest.docMissing", `Doc entry ${JSON.stringify(doc.title ?? i)}: ${JSON.stringify(doc.path)} doesn't exist`, { file: manifestFile, field: `docs[${i}].path` }));
      return;
    }
    if (display) deliverTree(abs, display);
  });

  (m.commands ?? []).forEach((command, i) => {
    if (!command || typeof command.run !== "string") return;
    const bin = command.run.trim().split(/\s+/)[0] ?? "";
    const noun = `Command ${JSON.stringify(command.name)}`;
    if (command.from) {
      if (!deps.has(command.from)) {
        diagnostics.push(
          error("manifest.commandUndeclared", `${noun} runs ${JSON.stringify(bin)} from ${JSON.stringify(command.from)}, which the pack doesn't depend on`, {
            file: manifestFile,
            field: `commands[${i}].from`,
          }),
        );
        return;
      }
      const depDir = resolvePackageDir(packageDir, command.from);
      if (depDir && !binNames(readPackageJson(depDir)).includes(bin)) {
        diagnostics.push(
          error("manifest.commandBin", `${noun}: ${command.from} has no binary named ${JSON.stringify(bin)}`, { file: manifestFile, field: `commands[${i}].run` }),
        );
      }
    } else if (!options.local && !binNames(pkg).includes(bin)) {
      diagnostics.push(
        error("manifest.commandUndeclared", `${noun} runs ${JSON.stringify(bin)}, which neither the pack's package nor a declared dependency provides; set "from"`, {
          file: manifestFile,
          field: `commands[${i}].from`,
        }),
      );
    }
  });

  if (m.feedbackAdapter && typeof m.feedbackAdapter.type === "string" && !isKnownAdapter(m.feedbackAdapter.type)) {
    diagnostics.push(
      warning("feedback.adapterUnknown", `Feedback adapter type ${JSON.stringify(m.feedbackAdapter.type)} isn't one this SDK knows, so reports use the feedback link`, {
        file: manifestFile,
        field: "feedbackAdapter.type",
      }),
    );
  }

  if (!options.local && m.files && options.checkDigests !== false) {
    diagnostics.push(...verifyDigests(dir, m.files, { prefix, publishedFiles: options.publishedFiles }));
  }

  diagnostics.push(...scanHidden(delivered));
  return { diagnostics, delivered };
}

/** Checks that every published file is listed with a matching digest. */
export function verifyDigests(
  dir: string,
  files: Record<string, string>,
  options: { prefix?: string; publishedFiles?: string[] } = {},
): Diagnostic[] {
  const prefix = options.prefix ?? "";
  const out: Diagnostic[] = [];
  const present = (options.publishedFiles ?? walkFiles(dir, { skipDirs: ["node_modules"] })).filter((f) => !isPackMetaFile(f));
  const presentSet = new Set(present);
  for (const rel of present) {
    if (!(rel in files)) {
      out.push(error("digest.unlisted", `File ${prefix}${rel} isn't listed in the manifest's files`, { file: `${prefix}${rel}`, field: "files" }));
    }
  }
  for (const [rel, expected] of Object.entries(files)) {
    const abs = resolveInside(dir, rel);
    if (!abs || !presentSet.has(rel) || !isFile(abs)) {
      out.push(error("digest.missing", `Listed file ${prefix}${rel} is missing`, { file: `${prefix}${rel}`, field: `files.${rel}` }));
      continue;
    }
    if (fileDigest(abs) !== expected) {
      out.push(error("digest.mismatch", `File ${prefix}${rel} doesn't match its digest`, { file: `${prefix}${rel}`, field: `files.${rel}` }));
    }
  }
  return out;
}

/** Rejects delivered text files that contain hidden characters. */
export function scanHidden(files: DeliveredFile[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.abs)) continue;
    seen.add(f.abs);
    let text: string;
    try {
      text = readFileSync(f.abs, "utf8");
    } catch {
      continue;
    }
    const hit = findHiddenCharacter(text);
    if (hit) {
      out.push(
        error("hidden.character", `${f.display} contains a hidden character, ${hit.codePoint} (${hit.kind}), at line ${hit.line}`, {
          file: f.display,
          line: hit.line,
        }),
      );
    }
  }
  return out;
}

function readJsonQuiet(abs: string): Manifest | undefined {
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as Manifest;
  } catch {
    return undefined;
  }
}

/** Display path for a file inside a pack, relative to the repo root when possible. */
export function displayPath(root: string, abs: string): string {
  return relativeTo(root, abs) ?? path.basename(abs);
}
