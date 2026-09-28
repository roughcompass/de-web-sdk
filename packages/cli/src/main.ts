import { readFileSync } from "node:fs";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { parsePublicKey } from "@de-web-sdk/core";
import { createInterface } from "node:readline/promises";
import { cmdCheck, cmdFeedback, cmdInit, cmdResolve, cmdSkill, cmdSync } from "./commands.ts";
import { fail, type Io } from "./io.ts";
import { ROOT_KEYS } from "./root-keys.ts";

export const VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

const HELP = `Usage: de-web-sdk <command> [options]

Commands:
  init [packs...]      Set up the repo: configuration, trust policy, packs, then sync
  sync                 Verify packs, assemble the rule set, and regenerate agent files
  resolve [files...]   Print the rules, skills, docs, and commands for files
  check [files...]     Run machine rules and report violations, in the named files if given
  feedback <rule>      Create a feedback report for a rule's owner, and send it with --submit
  skill [name]         Print a skill from its verified pack, or list the skills that apply
  mcp                  Run the SDK's MCP server over standard input and output, for agents

Options for every command:
  --format <format>    json for machine-readable output (or set DE_WEB_SDK_FORMAT=json)
  --offline            Don't contact the registry, even to cache npm provenance
  --yes                Never prompt (commands never prompt without a terminal)

init:      --enforce, --fact <key=value>, --target <tool>, --trust-policy <package>, --no-install
resolve:   --rule <pack#rule>, --pack <id>, --budget <bytes>
check:     --format text|json|sarif|junit, --output <file>, --record <file>,
           --baseline [--enforce], --prune-baseline, --baseline-ref <ref>
feedback:  --kind false-positive|missed-violation|unclear-guidance|agent-ignored-rule,
           --message <text>, --lines <file>:<start>[-<end>], --submit [--yes]
skill:     --file <path>
mcp:       --root <dir>

Exit codes: 0 done, 1 new violations, 2 usage or configuration error,
3 trust, integrity, or adapter error.
`;

const COMMON = {
  format: { type: "string" },
  offline: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
} as const;

const OPTIONS: Record<string, ParseArgsConfig["options"]> = {
  init: { ...COMMON, enforce: { type: "boolean" }, fact: { type: "string", multiple: true }, target: { type: "string", multiple: true }, "trust-policy": { type: "string" }, "no-install": { type: "boolean" } },
  sync: { ...COMMON },
  resolve: { ...COMMON, rule: { type: "string" }, pack: { type: "string" }, budget: { type: "string" } },
  check: { ...COMMON, output: { type: "string" }, record: { type: "string" }, baseline: { type: "boolean" }, enforce: { type: "boolean" }, "prune-baseline": { type: "boolean" }, "baseline-ref": { type: "string" } },
  feedback: { ...COMMON, kind: { type: "string" }, message: { type: "string" }, lines: { type: "string", multiple: true }, submit: { type: "boolean" } },
  skill: { ...COMMON, file: { type: "string" } },
  mcp: { root: { type: "string" }, help: { type: "boolean", short: "h" } },
};

export interface MainOptions extends Partial<Omit<Io, "rootKeys">> {
  rootKeys?: Io["rootKeys"];
}

/** Runs one CLI invocation and returns its exit code. */
export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const io: Io = {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdout: options.stdout ?? ((t) => process.stdout.write(t)),
    stderr: options.stderr ?? ((t) => process.stderr.write(t)),
    interactive: options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    rootKeys: options.rootKeys ?? ROOT_KEYS.map(parsePublicKey),
    version: options.version ?? VERSION,
    ask:
      options.ask ??
      (async (question: string) => {
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          return await rl.question(question);
        } finally {
          rl.close();
        }
      }),
  };
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(HELP);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(`${io.version}\n`);
    return 0;
  }
  const spec = OPTIONS[command];
  if (!spec) {
    io.stderr(`Unknown command ${JSON.stringify(command)}.\n\n${HELP}`);
    return 2;
  }
  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    parsed = parseArgs({ args: rest, options: spec, allowPositionals: true, strict: true }) as typeof parsed;
  } catch (e) {
    return fail(io, command, e, io.env.DE_WEB_SDK_FORMAT === "json" || rest.includes("json"));
  }
  const v = parsed.values;
  if (v.help) {
    io.stdout(HELP);
    return 0;
  }
  switch (command) {
    case "init":
      return cmdInit(io, parsed.positionals, { ...(v as object), install: v["no-install"] ? false : true } as never);
    case "sync":
      return cmdSync(io, v as never);
    case "resolve":
      return cmdResolve(io, parsed.positionals, v as never);
    case "check":
      return cmdCheck(io, v as never, parsed.positionals);
    case "feedback":
      return cmdFeedback(io, parsed.positionals[0], v as never);
    case "skill":
      return cmdSkill(io, parsed.positionals[0], v as never);
    case "mcp": {
      // Loaded only here, so other commands don't pay for the MCP library.
      const { runMcpServer } = await import("./mcp/server.ts");
      await runMcpServer({ root: v.root as string | undefined, env: io.env, rootKeys: io.rootKeys, version: io.version });
      return 0;
    }
  }
  return 2;
}
