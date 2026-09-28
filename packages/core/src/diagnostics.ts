export type Severity = "error" | "warning" | "info";

/** Where a problem was found. Paths are relative to the repo or pack root. */
export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  file?: string;
  field?: string;
  line?: number;
}

/** Exit codes shared by every command, as the consumer-cli spec defines. */
export const EXIT = {
  ok: 0,
  violations: 1,
  config: 2,
  trust: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * An error that stops a command. `kind` decides the exit code: usage and
 * configuration errors exit with 2, trust and integrity errors with 3.
 */
export class SdkError extends Error {
  readonly kind: "usage" | "config" | "trust";
  readonly diagnostics: Diagnostic[];

  constructor(kind: "usage" | "config" | "trust", message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = "SdkError";
    this.kind = kind;
    this.diagnostics = diagnostics;
  }

  get exitCode(): ExitCode {
    return this.kind === "trust" ? EXIT.trust : EXIT.config;
  }
}

export function error(code: string, message: string, where: Partial<Diagnostic> = {}): Diagnostic {
  return { severity: "error", code, message, ...where };
}

export function warning(code: string, message: string, where: Partial<Diagnostic> = {}): Diagnostic {
  return { severity: "warning", code, message, ...where };
}

export function info(code: string, message: string, where: Partial<Diagnostic> = {}): Diagnostic {
  return { severity: "info", code, message, ...where };
}

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = [d.file, d.line !== undefined ? `line ${d.line}` : undefined, d.field]
    .filter(Boolean)
    .join(", ");
  return `${d.severity}: ${d.message}${where ? ` (${where})` : ""}`;
}
