import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { EvalBridge, setNotifier } from "./bridge.ts";

const TRIAL_MARKER = ".de-web-sdk-trial.json";

interface TrialMarker {
  packageDir: string;
  task: string;
  model: string;
  prompt: string;
}

interface BlindTrial {
  trial: string;
  task: string;
  prompt: string;
  grader: "pass" | "fail";
  check?: string;
  files: Array<{ path: string; before?: string; after: string }>;
}

let bridge: EvalBridge | undefined;
let log: vscode.OutputChannel;

/** Writes to the output channel and to a log file that terminal tools can read. */
export function note(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  log?.appendLine(line);
  try {
    const dir = path.join(os.homedir(), ".de-web-sdk");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(path.join(dir, "vscode-extension.log"), `${line}\n`, { mode: 0o600 });
  } catch {
    // Logging must never break a command.
  }
}

function workspaceDir(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Runs the producer toolkit that the pack repo installs, and parses its JSON output. */
function toolkit(cwd: string, args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile("npx", ["--no-install", "de-web-sdk-pack", ...args], { cwd, shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (stderr) log.append(stderr);
      if (err && !stdout) return reject(new Error(stderr.trim().split("\n").pop() || err.message));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout);
      }
    });
  });
}

async function startBridge(version: string): Promise<void> {
  bridge ??= new EvalBridge(version, log);
  const port = await bridge.start();
  vscode.window.showInformationMessage(`The de-web-sdk eval bridge is running on port ${port}. Evals you run locally can now use Copilot's models.`);
}

async function runEvals(version: string): Promise<void> {
  const cwd = workspaceDir();
  if (!cwd || !existsSync(path.join(cwd, "evals", "config.json"))) {
    vscode.window.showErrorMessage("Open a pack repo that has evals/config.json.");
    return;
  }
  await startBridge(version);
  // The toolkit shows the trial count and asks before spending the developer's quota.
  const terminal = vscode.window.createTerminal({ name: "de-web-sdk evals", cwd });
  terminal.show();
  terminal.sendText("npx --no-install de-web-sdk-pack eval run --local");
}

async function startGuidedTrial(): Promise<void> {
  const cwd = workspaceDir();
  const configPath = cwd && path.join(cwd, "evals", "config.json");
  if (!cwd || !configPath || !existsSync(configPath)) {
    vscode.window.showErrorMessage("Open a pack repo that has evals/config.json.");
    return;
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { tasks: string[] };
  const tasks = config.tasks.map((f) => JSON.parse(readFileSync(path.join(cwd, f), "utf8")) as { id: string; prompt: string });
  const picked = await vscode.window.showQuickPick(tasks.map((t) => ({ label: t.id, detail: t.prompt })), { title: "Task for the guided Copilot trial" });
  if (!picked) return;
  const model = await vscode.window.showInputBox({ title: "Model alias from the eval profile", prompt: "Choose the same model in Copilot's model picker for this trial", value: "copilot-gpt" });
  if (!model) return;
  const prepared = (await toolkit(cwd, ["eval", "guided", "prepare", "--task", picked.label, "--model", model, "--format", "json"])) as { worktree: string };
  await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(prepared.worktree), { forceNewWindow: true });
}

let trialOpened = false;

/** In a trial window: give Copilot's agent mode the prompt, once, and offer to mark the trial finished. */
async function openTrial(folder: string, marker: TrialMarker): Promise<void> {
  if (trialOpened) return;
  trialOpened = true;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = "$(check) Mark trial finished";
  status.command = "deWebSdk.finishGuidedTrial";
  status.show();
  try {
    await vscode.commands.executeCommand("workbench.action.chat.open", { query: marker.prompt, mode: "agent" });
    note(`Guided trial ${marker.task}: opened Copilot's agent mode with the prompt in ${folder}.`);
    vscode.window.showInformationMessage(`Guided trial for ${marker.task}: Copilot's agent mode has the prompt. Select model ${marker.model}, send it, and mark the trial finished when the agent is done.`);
  } catch (e) {
    note(`Guided trial ${marker.task}: couldn't open agent mode with the prompt (${(e as Error).message}); copied it to the clipboard.`);
    await vscode.env.clipboard.writeText(marker.prompt);
    vscode.window.showInformationMessage(`Guided trial for ${marker.task}: the prompt is on the clipboard. Paste it into Copilot's agent mode, then mark the trial finished.`);
  }
}

async function finishGuidedTrial(): Promise<void> {
  const folder = workspaceDir();
  const markerPath = folder && path.join(folder, TRIAL_MARKER);
  if (!folder || !markerPath || !existsSync(markerPath)) {
    vscode.window.showErrorMessage("This window isn't a guided trial.");
    return;
  }
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as TrialMarker;
  const result = (await toolkit(marker.packageDir, ["eval", "guided", "finish", "--worktree", folder, "--format", "json"])) as { trial: { passed: boolean } };
  vscode.window.showInformationMessage(`The guided trial ${result.trial.passed ? "passed" : "failed"} its graders. It's recorded beside the harness results and doesn't count toward the gate.`);
}

async function openDiffs(t: BlindTrial): Promise<void> {
  for (const f of t.files) {
    const before = f.before ? vscode.Uri.file(f.before) : vscode.Uri.parse(`untitled:${f.path} (new file)`);
    // The title names only the trial and file, never the condition.
    await vscode.commands.executeCommand("vscode.diff", before, vscode.Uri.file(f.after), `Trial ${t.trial.slice(-6)}: ${f.path}`, { preview: false });
  }
}

async function reviewTrials(): Promise<void> {
  const cwd = workspaceDir();
  if (!cwd) return;
  const mode = await vscode.window.showQuickPick(["Review trials", "Compare two pack versions"], { title: "de-web-sdk review" });
  if (!mode) return;
  const reviewer = await vscode.window.showInputBox({ title: "Your reviewer id", value: process.env.USER ?? "" });
  if (!reviewer) return;
  if (mode === "Review trials") {
    const queue = ((await toolkit(cwd, ["eval", "review", "--list", "--format", "json"])) as { trials: BlindTrial[] }).trials;
    for (const t of queue) {
      await openDiffs(t);
      const verdict = await vscode.window.showQuickPick(["agree", "disagree", "skip", "stop"], { title: `Task ${t.task}: the grader says ${t.grader}. Do you agree?`, placeHolder: t.check });
      if (!verdict || verdict === "stop") break;
      if (verdict === "skip") continue;
      const reason = await vscode.window.showInputBox({ title: "Reason" });
      if (!reason) continue;
      const claims = await vscode.window.showInputBox({ title: "Claims the pack's content doesn't support (count)", value: "0" });
      await toolkit(cwd, ["eval", "review", "--record", t.trial, "--verdict", verdict, "--reason", reason, "--unsupported", claims ?? "0", "--reviewer", reviewer]);
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
    return;
  }
  const pairs = ((await toolkit(cwd, ["eval", "review", "--compare", "--list", "--format", "json"])) as { pairs: Array<{ pair: string; task: string; model: string; a: BlindTrial; b: BlindTrial }> }).pairs;
  for (const p of pairs) {
    await openDiffs({ ...p.a, trial: `A-${p.a.trial}` });
    await openDiffs({ ...p.b, trial: `B-${p.b.trial}` });
    const choice = await vscode.window.showQuickPick(["A", "B", "equal", "skip", "stop"], { title: `Task ${p.task} on ${p.model}: which result is better?` });
    if (!choice || choice === "stop") break;
    if (choice === "skip") continue;
    const reason = await vscode.window.showInputBox({ title: "Reason" });
    if (!reason) continue;
    await toolkit(cwd, ["eval", "review", "--compare", "--record", p.pair, "--choice", choice, "--reason", reason, "--reviewer", reviewer]);
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const version = (context.extension.packageJSON as { version: string }).version;
  log = vscode.window.createOutputChannel("de-web-sdk");
  setNotifier(note);
  const run = (fn: () => Promise<void>) => async () => {
    try {
      await fn();
    } catch (e) {
      vscode.window.showErrorMessage(`de-web-sdk: ${(e as Error).message}`);
    }
  };
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand("deWebSdk.startBridge", run(() => startBridge(version))),
    vscode.commands.registerCommand("deWebSdk.stopBridge", run(async () => bridge?.stop())),
    vscode.commands.registerCommand("deWebSdk.runEvals", run(() => runEvals(version))),
    vscode.commands.registerCommand("deWebSdk.startGuidedTrial", run(startGuidedTrial)),
    vscode.commands.registerCommand("deWebSdk.finishGuidedTrial", run(finishGuidedTrial)),
    vscode.commands.registerCommand("deWebSdk.reviewTrials", run(reviewTrials)),
    { dispose: () => bridge?.stop() },
    // vscode://de-web-sdk.de-web-sdk-vscode/start-bridge lets the toolkit, or a terminal, start the bridge.
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        note(`Handling ${uri.path}.`);
        if (uri.path === "/start-bridge") void run(() => startBridge(version))();
        else if (uri.path === "/stop-bridge") bridge?.stop();
      },
    }),
  );
  note(`Activated version ${version}.`);
  const folder = workspaceDir();
  const markerPath = folder && path.join(folder, TRIAL_MARKER);
  if (folder && markerPath && existsSync(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as TrialMarker;
    if (vscode.workspace.isTrusted) void openTrial(folder, marker);
    else {
      // Copilot's agent mode can't edit or run commands in Restricted Mode.
      note(`Guided trial ${marker.task}: waiting for the developer to trust ${folder}.`);
      vscode.window.showWarningMessage(
        `Trust this guided trial folder so Copilot's agent mode can work in it. Trust its parent, ${path.dirname(folder)}, to skip this for later trials.`,
        "Manage Workspace Trust",
      ).then((choice) => {
        if (choice) void vscode.commands.executeCommand("workbench.trust.manage");
      });
      context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void openTrial(folder, marker)));
    }
  }
}

export function deactivate(): void {
  bridge?.stop();
}
