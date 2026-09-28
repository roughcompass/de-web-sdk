import path from "node:path";
import { GREP_ADAPTER, tmpDir, write } from "../../core/test/helpers.ts";
import { main } from "../src/main.ts";

export const PACK_ID = "@example-platform/runtime";

/**
 * A team's own driver module, as a profile route can name. It never calls a
 * model: with a pack installed it writes compliant code that uses the
 * expected API, and without one it writes a violation. FAKE_MODE flips it.
 */
export const FAKE_DRIVER = `
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const state = globalThis.__fakeDriver ??= { calls: [], outages: 0 };
export default {
  name: "fake",
  async available() { return { ok: true }; },
  async version() { return "fake 1.0"; },
  async run(trial) {
    const mode = trial.env.FAKE_MODE ?? "helpful";
    const withPack = existsSync(path.join(trial.worktree, "AGENTS.md")) && readFileSync(path.join(trial.worktree, "AGENTS.md"), "utf8").includes("no-console");
    state.calls.push({ withPack, mode });
    if (mode === "outage" && state.outages === 0) { state.outages++; return { status: "error", acted: false, error: "endpoint unreachable" }; }
    if (mode === "timeout") return { status: "timeout", acted: true, error: "the agent ran past its time budget" };
    const good = mode === "harmful" ? !withPack : withPack;
    mkdirSync(path.join(trial.worktree, "src"), { recursive: true });
    writeFileSync(path.join(trial.worktree, "src/confirm.tsx"), good
      ? 'import { Dialog } from "@example/ui";\\nexport const Confirm = () => Dialog;\\n'
      : 'export const Confirm = () => { console.log("custom modal"); return null; };\\n');
    writeFileSync(path.join(trial.cacheDir, "transcript.json"), "[]");
    return { status: "completed", acted: true, reportedModel: trial.modelId + "-reported" };
  },
};
`;

export interface ProducerOptions {
  minTrials?: number;
  runs?: number;
  extraTasks?: boolean;
}

/** A producer repo with a machine rule, its adapter and fixtures, an eval task, and an eval profile. */
export function producerRepo(options: ProducerOptions = {}): { dir: string; profile: string } {
  const dir = tmpDir("dws-producer-");
  write(dir, "package.json", { name: PACK_ID, version: "1.0.0", files: ["pack.json", "pack.sigstore.json", "guidance", "adapters"] });
  write(dir, "pack.json", {
    $schema: "https://schemas.example.com/agent-pack/v0.json",
    specVersion: "0",
    id: PACK_ID,
    version: "1.0.0",
    owner: { team: "Platform Web Runtime", contact: "#platform-web-runtime" },
    feedback: "https://git.example.com/platform/runtime/issues/new?title={title}&body={body}",
    adapters: [{ name: "grep", module: "adapters/grep.mjs" }],
    rules: [
      {
        id: "no-console",
        title: "Don't log to the console in UI code",
        enforcement: "machine",
        paths: ["src/**"],
        rationale: "Console output leaks data in production.",
        guidance: "guidance/no-console.md",
        fix: "Use the platform logger.",
        check: { adapter: "grep", options: { needle: "console.log" } },
      },
      { id: "use-dialog", title: "Use the design system's Dialog", enforcement: "advisory", rationale: "Accessibility.", guidance: "guidance/use-dialog.md" },
    ],
  });
  write(dir, "guidance/no-console.md", "Use `logger` from the platform instead of console.log.\n");
  write(dir, "guidance/use-dialog.md", "Import Dialog from @example/ui.\n");
  write(dir, "adapters/grep.mjs", GREP_ADAPTER);
  write(dir, "fixtures/no-console/positive/logs/src/a.ts", "console.log('x');\n");
  write(dir, "fixtures/no-console/negative/clean/src/a.ts", "export const a = 1;\n");
  write(dir, "evals/config.json", { models: [], runs: options.runs ?? 2, tasks: ["evals/tasks/confirm.json"] });
  write(dir, "evals/tasks/confirm.json", {
    id: "confirm-dialog",
    prompt: "Ask for confirmation before resetting preferences.",
    start: "evals/fixtures/app",
    exercises: ["no-console", "use-dialog"],
    expects: [{ package: "@example/ui", export: "Dialog" }],
    graders: [{ type: "check" }],
  });
  write(dir, "evals/fixtures/app/package.json", { name: "app", version: "0.0.0", private: true });
  write(dir, "evals/fixtures/app/src/index.ts", "export {};\n");
  write(dir, "drivers/fake.mjs", FAKE_DRIVER);
  const profile = write(dir, "profile.json", {
    required: ["fake-model"],
    gate: { confidence: 0.95, minTrials: options.minTrials ?? 2, resolveThreshold: 0.8 },
    models: { "fake-model": { model: "fake-1", routes: [{ driver: path.join(dir, "drivers/fake.mjs") }] } },
  });
  return { dir, profile };
}

const trialsDir = tmpDir("dws-trials-");

export async function toolkit(cwd: string, argv: string[], env: NodeJS.ProcessEnv = {}, extra: { interactive?: boolean; ask?: (q: string) => Promise<string>; now?: () => Date } = {}) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    cwd,
    env: { ...process.env, CI: "", DE_WEB_SDK_TRIALS_DIR: trialsDir, ...env },
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    interactive: extra.interactive ?? false,
    ask: extra.ask,
    now: extra.now,
  });
  return { code, stdout, stderr };
}

export function fakeState(): { calls: Array<{ withPack: boolean; mode: string }>; outages: number } {
  const g = globalThis as unknown as { __fakeDriver?: { calls: Array<{ withPack: boolean; mode: string }>; outages: number } };
  g.__fakeDriver ??= { calls: [], outages: 0 };
  return g.__fakeDriver;
}

export function resetFake(): void {
  const s = fakeState();
  s.calls.length = 0;
  s.outages = 0;
}
