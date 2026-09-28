const CODE_FILE = /\.(m|c)?(j|t)sx?$|\.vue$|\.svelte$/;

interface ImportRecord {
  source: string;
  names: string[];
  defaultName?: string;
  namespace?: string;
}

/** Reads the static imports and requires in a source file, without running it. */
export function importsIn(text: string): ImportRecord[] {
  const out: ImportRecord[] = [];
  const parseClause = (clause: string, source: string) => {
    const rec: ImportRecord = { source, names: [] };
    const trimmed = clause.replace(/^type\s+/, "").trim();
    const braces = /\{([\s\S]*?)\}/.exec(trimmed);
    if (braces) {
      for (const part of braces[1]!.split(",")) {
        const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim();
        if (name) rec.names.push(name);
      }
    }
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (ns) rec.namespace = ns[1];
    const def = /^([A-Za-z_$][\w$]*)\s*(,|$)/.exec(trimmed);
    if (def) rec.defaultName = def[1];
    out.push(rec);
  };
  for (const m of text.matchAll(/import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g)) parseClause(m[1]!, m[2]!);
  for (const m of text.matchAll(/export\s+(\{[\s\S]*?\}|\*\s+as\s+\w+)\s+from\s+["']([^"']+)["']/g)) parseClause(m[1]!, m[2]!);
  for (const m of text.matchAll(/(?:const|let|var)\s+(\{[\s\S]*?\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g)) {
    const binding = m[1]!;
    if (binding.startsWith("{")) parseClause(binding.replace(/:\s*\w+/g, ""), m[2]!);
    else out.push({ source: m[2]!, names: [], namespace: binding });
  }
  return out;
}

function fromPackage(source: string, pkg: string): boolean {
  return source === pkg || source.startsWith(`${pkg}/`);
}

/**
 * Whether the agent's changed files use every expected API: each expected
 * export is imported from its package, or used through a namespace import.
 * Returns null when the task declares no expected APIs.
 */
export function usesExpectedApis(expects: Array<{ package: string; export: string }> | undefined, changed: Array<{ path: string; text: string }>): boolean | null {
  if (!expects?.length) return null;
  const files = changed.filter((f) => CODE_FILE.test(f.path));
  return expects.every((e) =>
    files.some((f) =>
      importsIn(f.text).some((imp) => {
        if (!fromPackage(imp.source, e.package)) return false;
        if (e.export === "default") return Boolean(imp.defaultName);
        if (imp.names.includes(e.export)) return true;
        // A subpath import that names the export, such as "@scope/core/Dialog".
        if (imp.defaultName && imp.source.endsWith(`/${e.export}`)) return true;
        const ns = imp.namespace;
        return Boolean(ns && new RegExp(`\\b${ns}\\.${e.export}\\b`).test(f.text));
      }),
    ),
  );
}
