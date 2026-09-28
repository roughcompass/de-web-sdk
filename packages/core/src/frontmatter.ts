import { parse } from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

/** Parses leading YAML frontmatter delimited by `---` lines. */
export function parseFrontmatter(text: string): Frontmatter | undefined {
  const normalized = text.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return undefined;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return undefined;
  try {
    const data = parse(match[1]!) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    return { data: data as Record<string, unknown>, body: match[2]! };
  } catch {
    return undefined;
  }
}
