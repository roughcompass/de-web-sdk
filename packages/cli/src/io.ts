import type { KeyObject } from "node:crypto";
import { formatDiagnostic, SdkError, scrubPaths, type Diagnostic } from "@de-web-sdk/core";

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Whether a person can answer prompts. Commands never prompt without one. */
  interactive: boolean;
  rootKeys: KeyObject[];
  version: string;
  /** Asks a person a question. Only used with a terminal. */
  ask?: (question: string) => Promise<string>;
}

export type Format = "text" | "json";

export function jsonMode(io: Io, flag?: string): boolean {
  return flag === "json" || (flag === undefined && io.env.DE_WEB_SDK_FORMAT === "json");
}

export function printJson(io: Io, value: unknown): void {
  io.stdout(`${JSON.stringify(scrubPaths(value, io.cwd), null, 2)}\n`);
}

export function printDiagnostics(io: Io, diagnostics: Diagnostic[]): void {
  for (const d of diagnostics) io.stderr(`${formatDiagnostic(d)}\n`);
}

/** Reports a failure in the requested format and returns its exit code. */
export function fail(io: Io, kind: string, e: unknown, json: boolean): number {
  const err = e instanceof SdkError ? e : new SdkError("usage", (e as Error)?.message ?? String(e));
  const diagnostics = err.diagnostics.length ? err.diagnostics : [{ severity: "error" as const, code: err.kind, message: err.message }];
  if (json) printJson(io, { schemaVersion: 1, kind, exitCode: err.exitCode, error: err.message, diagnostics });
  else {
    io.stderr(`de-web-sdk ${kind}: ${err.message}\n`);
    printDiagnostics(io, diagnostics);
  }
  return err.exitCode;
}
