import path from "node:path";
import { pathToFileURL } from "node:url";
import { SdkError } from "@de-web-sdk/core";
import type { Route } from "../profile.ts";
import { claudeCodeDriver } from "./claude-code.ts";
import { bridgeClient, checkBridge, openAiClient } from "./clients.ts";
import { HARNESS_PROMPT_REVISION, runHarness } from "./harness.ts";
import type { Driver } from "./types.ts";

export const TOOLKIT_VERSION_ENV = "DE_WEB_SDK_TOOLKIT_VERSION";

/** The reference harness against an OpenAI-compatible endpoint. */
export const referenceHarnessDriver: Driver = {
  name: "reference-harness",
  async available(route, env) {
    if (!route.endpoint) return { ok: false, reason: "the route names no endpoint" };
    const name = route.credentialEnv ?? "DE_WEB_SDK_EVAL_TOKEN";
    if (!env[name]) return { ok: false, reason: `the endpoint's credential ${name} isn't set` };
    return { ok: true };
  },
  async version(_route, env) {
    return `reference-harness ${env[TOOLKIT_VERSION_ENV] ?? "dev"}, prompt ${HARNESS_PROMPT_REVISION}`;
  },
  run(trial) {
    const token = trial.env[trial.route.credentialEnv ?? "DE_WEB_SDK_EVAL_TOKEN"];
    return runHarness(trial, openAiClient(trial.route.endpoint!, trial.route.model ?? trial.modelId, token));
  },
};

/** The reference harness with Copilot's models, through the VS Code extension. */
export function vscodeDriver(expectedVersion: string): Driver {
  return {
    name: "vscode",
    async available(_route, env) {
      const check = await checkBridge(env, expectedVersion);
      return check.ok ? { ok: true } : { ok: false, reason: check.reason };
    },
    async version(route, env) {
      const check = await checkBridge(env, expectedVersion);
      return check.ok ? `vscode-bridge ${check.info.version} (${route.vendor ?? "copilot"}/${route.family ?? "any"}), prompt ${HARNESS_PROMPT_REVISION}` : "unknown";
    },
    async run(trial) {
      const check = await checkBridge(trial.env, expectedVersion);
      if (!check.ok) return { status: "error", acted: false, error: check.reason };
      return runHarness(trial, bridgeClient(check.info, { vendor: trial.route.vendor ?? "copilot", family: trial.route.family, id: trial.route.model }));
    },
  };
}

/**
 * Finds a route's driver. Built-in names select the SDK's drivers; a path
 * such as `./drivers/our-agent.mjs` loads a team's own driver module.
 */
export async function getDriver(route: Route, baseDir: string, toolkitVersion: string): Promise<Driver> {
  if (route.driver === "claude-code") return claudeCodeDriver;
  if (route.driver === "reference-harness") return referenceHarnessDriver;
  if (route.driver === "vscode") return vscodeDriver(toolkitVersion);
  if (route.driver.startsWith(".") || path.isAbsolute(route.driver)) {
    const mod = await import(pathToFileURL(path.resolve(baseDir, route.driver)).href);
    const driver = (mod.default ?? mod.driver) as Driver | undefined;
    if (!driver?.run) throw new SdkError("config", `The driver module ${route.driver} doesn't export a driver`);
    return driver;
  }
  throw new SdkError("config", `Unknown driver ${JSON.stringify(route.driver)}. Use claude-code, reference-harness, vscode, or a path to a driver module`);
}
