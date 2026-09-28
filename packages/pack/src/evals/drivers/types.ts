import type { Route } from "../profile.ts";

export interface TrialContext {
  /** The trial's worktree. Drivers keep the agent inside it. */
  worktree: string;
  prompt: string;
  /** The model id to request on this route. */
  modelId: string;
  route: Route;
  /** Commands the agent may run: the task's build and check commands. Everything else is refused. */
  allowedCommands: string[];
  timeoutMs: number;
  /** Where the driver writes the transcript. The pack repo ignores it. */
  cacheDir: string;
  env: NodeJS.ProcessEnv;
  pacer: Pacer;
}

export interface TrialOutcome {
  status: "completed" | "timeout" | "error";
  /** Whether the agent took any action. A failure before it acts can be retried once. */
  acted: boolean;
  reportedModel?: string;
  error?: string;
  /** How often the agent called each SDK tool or command, such as `mcp:check` or `cli:resolve`. */
  sdkUse?: Record<string, number>;
}

export type Availability = { ok: true } | { ok: false; reason: string };

/**
 * An agent driver. The SDK ships Claude Code, reference harness, and VS Code
 * drivers. Teams add their own by pointing a profile route at a module that
 * default-exports this interface.
 */
export interface Driver {
  name: string;
  available(route: Route, env: NodeJS.ProcessEnv): Promise<Availability>;
  version(route: Route, env: NodeJS.ProcessEnv): Promise<string>;
  run(trial: TrialContext): Promise<TrialOutcome>;
}

/** Spaces requests to stay within a tool's rate limit. */
export class Pacer {
  private readonly intervalMs: number;
  private next = 0;

  constructor(requestsPerMinute?: number) {
    this.intervalMs = requestsPerMinute && requestsPerMinute > 0 ? 60_000 / requestsPerMinute : 0;
  }

  async wait(): Promise<void> {
    if (!this.intervalMs) return;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

const SHELL_META = /[;&|<>`$\n\r]/;

/**
 * Decides whether a trial may run `command`. The SDK's own commands accept
 * arguments; the task's commands must match exactly. Shell operators are
 * refused, so an allowed command can't chain another.
 */
export function commandAllowed(command: string, allowed: string[]): boolean {
  const c = command.trim().replace(/\s+/g, " ");
  if (!c || SHELL_META.test(c)) return false;
  for (const a of allowed) {
    const norm = a.trim().replace(/\s+/g, " ");
    if (c === norm) return true;
    if (norm.endsWith(" *") && (c === norm.slice(0, -2) || c.startsWith(norm.slice(0, -1)))) return true;
  }
  return false;
}
