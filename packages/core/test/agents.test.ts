import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, sync, SdkError, walkFiles } from "../src/index.ts";
import { installPack, write } from "./helpers.ts";
import { ADAPTER_PACK, machine, RUNTIME_PACK, scenario, setConfig } from "./scenario.ts";

const opts = (root: string) => ({ root, rootKeys: [], network: false });
const read = (root: string, rel: string) => readFileSync(path.join(root, rel), "utf8");

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of walkFiles(root, { skipDirs: ["node_modules", ".git"] })) out[f] = read(root, f);
  return out;
}

const migrationSkill = {
  "skills/migrate-to-mf2/SKILL.md": "---\nname: migrate-to-mf2\ndescription: Migrate a webpack remote from MF1 to MF2.\n---\n\n1. Replace the plugin.\n",
};

describe("agent entry points", () => {
  it("adds the managed block and keeps people's AGENTS.md content byte for byte", async () => {
    const s = await scenario();
    const human = "# Team notes\r\n\r\nUse pnpm.  Trailing spaces stay.  \n";
    write(s.root, "AGENTS.md", human);
    await sync(opts(s.root));
    const text = read(s.root, "AGENTS.md");
    assert.ok(text.startsWith(human));
    assert.match(text, /<!-- de-web-sdk:begin -->[\s\S]*<!-- de-web-sdk:end -->/);
    await sync(opts(s.root));
    assert.ok(read(s.root, "AGENTS.md").startsWith(human));
  });

  it("creates AGENTS.md with only the managed block, naming the MCP tools and CLI commands", async () => {
    const s = await scenario();
    await sync(opts(s.root));
    const text = read(s.root, "AGENTS.md");
    assert.ok(text.startsWith("<!-- de-web-sdk:begin -->"));
    assert.ok(text.trimEnd().endsWith("<!-- de-web-sdk:end -->"));
    assert.match(text, /call `resolve` \(`npx --no de-web-sdk resolve <files>`\)/);
    assert.match(text, /call `check` \(`npx --no de-web-sdk check \[files\]`\)/);
    assert.match(text, /Load a skill with `get_skill` \(`npx --no de-web-sdk skill <name>`\)/);
    assert.match(text, /call `draft_feedback`.*Review the draft with the developer when they're present, then call `submit_feedback`/);
    assert.match(text, new RegExp(`\`${RUNTIME_PACK}#react-singleton\` \\[machine, locked\\]`));
  });
  it("lists pack commands where agents look", async () => {
    const s = await scenario({ runtimeManifest: { commands: [{ name: "ctx", run: "runtime-ctx \"<task>\"", use: "Before changing federation config", from: undefined as never }] } });
    // The runtime package provides the binary itself.
    const pkgPath = path.join(s.runtimeDir, "package.json");
    const pkg = JSON.parse(read(s.runtimeDir, "package.json"));
    pkg.bin = { "runtime-ctx": "bin/ctx.js" };
    void pkgPath;
    await installPack(s.root, {
      name: RUNTIME_PACK,
      keys: s.keys,
      dependencies: { [ADAPTER_PACK]: "^1.0.0" },
      bin: { "runtime-ctx": "bin/ctx.js" },
      files: { "bin/ctx.js": "#!/usr/bin/env node\n" },
      manifest: { commands: [{ name: "ctx", run: 'runtime-ctx "<task>"', use: "Before changing federation config" }] },
    });
    await sync(opts(s.root));
    assert.match(read(s.root, "AGENTS.md"), /Pack commands:\n- `npx --no runtime-ctx "<task>"`: Before changing federation config/);
  });

  it("points to rule groups when the rules don't fit the line budget", async () => {
    const rules = Array.from({ length: 50 }, (_, i) => ({ id: `rule-${i}`, title: `Rule ${i}`, enforcement: "advisory" as const, rationale: "x" }));
    const s = await scenario({ rules });
    await sync(opts(s.root));
    const block = read(s.root, "AGENTS.md");
    assert.ok(block.trimEnd().split("\n").length <= 40);
    assert.match(block, new RegExp(`\`${RUNTIME_PACK}\`: 50 rules\\. Call \`resolve\` with pack ${RUNTIME_PACK} \\(\`npx --no de-web-sdk resolve --pack ${RUNTIME_PACK}\`\\)`));
  });
  it("writes no Claude Code files when the configuration names only Copilot", async () => {
    const s = await scenario({ config: { mode: "enforce", targets: ["github-copilot"] } });
    await sync(opts(s.root));
    assert.equal(existsSync(path.join(s.root, "CLAUDE.md")), false);
    assert.equal(existsSync(path.join(s.root, ".claude")), false);
    assert.ok(existsSync(path.join(s.root, ".mcp.json")));
  });
  it("removes only its own import from CLAUDE.md when Claude Code is dropped", async () => {
    const s = await scenario();
    write(s.root, "CLAUDE.md", "# Our Claude notes\n");
    write(s.root, ".claude/skills/team-skill/SKILL.md", "---\nname: team-skill\ndescription: Ours.\n---\n");
    await sync(opts(s.root));
    assert.match(read(s.root, "CLAUDE.md"), /@AGENTS\.md/);
    setConfig(s.root, { mode: "enforce", targets: ["github-copilot"] });
    await sync(opts(s.root));
    assert.equal(read(s.root, "CLAUDE.md"), "# Our Claude notes\n");
    assert.deepEqual(readdirSync(path.join(s.root, ".claude/skills")), ["team-skill"]);
  });
  it("produces byte-identical output across runs and changes nothing the second time", async () => {
    const s = await scenario({ skills: [{ name: "migrate-to-mf2", path: "skills/migrate-to-mf2" }], runtimeFiles: migrationSkill });
    await sync(opts(s.root));
    const first = snapshot(s.root);
    const mtimes = Object.keys(first).map((f) => statSync(path.join(s.root, f)).mtimeMs);
    const second = await sync(opts(s.root));
    assert.deepEqual(snapshot(s.root), first);
    assert.deepEqual(second.applied.written, []);
    assert.deepEqual(Object.keys(first).map((f) => statSync(path.join(s.root, f)).mtimeMs), mtimes);
  });

  it("never changes configuration, the trust policy, or source files", async () => {
    const s = await scenario();
    const before = { config: read(s.root, ".de-web-sdk/config.json"), trust: read(s.root, ".de-web-sdk/trust.json"), src: read(s.root, "src/app.tsx"), pkg: read(s.root, "package.json") };
    await sync(opts(s.root));
    assert.deepEqual({ config: read(s.root, ".de-web-sdk/config.json"), trust: read(s.root, ".de-web-sdk/trust.json"), src: read(s.root, "src/app.tsx"), pkg: read(s.root, "package.json") }, before);
  });

  it("lists the migration skill for an MF1 repo but not an MF2 repo, and installs no skill files", async () => {
    const skills = [{ name: "migrate-to-mf2", path: "skills/migrate-to-mf2", appliesWhen: { moduleFederation: ["1"] } }];
    const mf1 = await scenario({ mf: "1", skills, runtimeFiles: migrationSkill });
    await sync(opts(mf1.root));
    assert.match(read(mf1.root, "AGENTS.md"), /Skills \(load with `get_skill`\):\n- `example-platform-runtime-migrate-to-mf2`: Migrate a webpack remote from MF1 to MF2\./);
    assert.equal(existsSync(path.join(mf1.root, ".claude/skills")), false);
    assert.equal(existsSync(path.join(mf1.root, ".github/skills")), false);

    const mf2 = await scenario({ mf: "2", skills, runtimeFiles: migrationSkill });
    await sync(opts(mf2.root));
    assert.doesNotMatch(read(mf2.root, "AGENTS.md"), /migrate-to-mf2/);
  });
  it("names two packs' setup skills so they include each pack", async () => {
    const s = await scenario({ skills: [{ name: "setup", path: "skills/setup" }], runtimeFiles: { "skills/setup/SKILL.md": "---\nname: setup\ndescription: Set up the runtime.\n---\n" } });
    await installPack(s.root, { name: "@example-platform/analytics", keys: s.keys, files: { "skills/setup/SKILL.md": "---\nname: setup\ndescription: Set up tracking.\n---\n" }, manifest: { skills: [{ name: "setup", path: "skills/setup" }] } });
    const pkg = JSON.parse(read(s.root, "package.json"));
    pkg.devDependencies["@example-platform/analytics"] = "^1.0.0";
    write(s.root, "package.json", pkg);
    await sync(opts(s.root));
    const block = read(s.root, "AGENTS.md");
    assert.match(block, /`example-platform-analytics-setup`: Set up tracking\./);
    assert.match(block, /`example-platform-runtime-setup`: Set up the runtime\./);
  });
  it("leaves skills that other tools installed alone", async () => {
    const s = await scenario();
    write(s.root, ".claude/skills/salt-design-system/SKILL.md", "---\nname: salt-design-system\ndescription: Use Salt.\n---\n");
    await sync(opts(s.root));
    assert.ok(existsSync(path.join(s.root, ".claude/skills/salt-design-system/SKILL.md")));
  });
  it("lists path-scoped rules in AGENTS.md with their paths, for every target", async () => {
    const s = await scenario({ rules: [{ id: "scoped", title: "Scoped rule", enforcement: "advisory", rationale: "x", paths: ["src/remotes/**"] }] });
    await sync(opts(s.root));
    assert.match(read(s.root, "AGENTS.md"), /`@example-platform\/runtime#scoped` \[advisory\]: Scoped rule\. Applies to `src\/remotes\/\*\*`\./);
    assert.equal(existsSync(path.join(s.root, ".github/instructions")), false);
  });

  it("removes skill files an earlier version generated", async () => {
    const s = await scenario({ skills: [{ name: "migrate-to-mf2", path: "skills/migrate-to-mf2" }], runtimeFiles: migrationSkill });
    write(s.root, ".claude/skills/example-platform-runtime-migrate-to-mf2/SKILL.md", "---\nname: example-platform-runtime-migrate-to-mf2\ndescription: x\n# Generated by de-web-sdk sync from x. Don't edit.\n---\n");
    write(s.root, ".claude/skills/de-web-sdk-check-and-fix/SKILL.md", "---\nname: de-web-sdk-check-and-fix\ndescription: x\n# Generated by de-web-sdk sync. Don't edit.\n---\n");
    await sync(opts(s.root));
    assert.deepEqual(existsSync(path.join(s.root, ".claude/skills")) ? readdirSync(path.join(s.root, ".claude/skills")) : [], []);
  });
  it("removes the Copilot instruction files and the CLAUDE.md that an earlier version generated", async () => {
    const s = await scenario();
    write(s.root, "CLAUDE.md", "<!-- de-web-sdk:begin -->\n<!-- Generated by de-web-sdk sync. Don't edit; run `npx de-web-sdk sync` to update. -->\n@AGENTS.md\n<!-- de-web-sdk:end -->\n");
    write(s.root, ".github/instructions/de-web-sdk-1234abcd.instructions.md", "---\n# Generated by de-web-sdk sync. Don't edit.\napplyTo: \"src/**\"\n---\n");
    write(s.root, ".github/instructions/team.instructions.md", "---\napplyTo: \"**\"\n---\nOurs.\n");
    write(s.root, ".github/skills/de-web-sdk-check-and-fix/SKILL.md", "---\nname: de-web-sdk-check-and-fix\ndescription: x\n# Generated by de-web-sdk sync. Don't edit.\n---\n");
    await sync(opts(s.root));
    assert.equal(existsSync(path.join(s.root, "CLAUDE.md")), false);
    assert.deepEqual(readdirSync(path.join(s.root, ".github/instructions")), ["team.instructions.md"]);
    assert.equal(existsSync(path.join(s.root, ".github/skills/de-web-sdk-check-and-fix")), false);
  });

  it("keeps generated paths in a managed .gitignore block and commits no pack content", async () => {
    const s = await scenario({ git: true, skills: [{ name: "migrate-to-mf2", path: "skills/migrate-to-mf2" }], runtimeFiles: migrationSkill });
    write(s.root, ".gitignore", "node_modules/\n");
    await sync(opts(s.root));
    const ignore = read(s.root, ".gitignore");
    assert.ok(ignore.startsWith("node_modules/\n"));
    for (const p of ["/.de-web-sdk/context/", "/.de-web-sdk/cache/"]) assert.ok(ignore.includes(p), p);
    const { execFileSync } = await import("node:child_process");
    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: s.root, encoding: "utf8" });
    const untracked = status.split("\n").filter(Boolean).map((l) => l.slice(3));
    assert.deepEqual(untracked.sort(), [".de-web-sdk/config.json", ".de-web-sdk/trust.json", ".gitignore", ".mcp.json", "AGENTS.md", "dist/mf-manifest.json", "package.json", "src/app.tsx", "vite.config.ts"]);
  });
  it("leaves generated files unchanged when a pack fails verification", async () => {
    const s = await scenario();
    await sync(opts(s.root));
    const before = snapshot(s.root);
    write(s.runtimeDir, "guidance/lazy-remotes.md", "tampered\n");
    await assert.rejects(sync(opts(s.root)), (e: unknown) => e instanceof SdkError && e.exitCode === 3);
    assert.deepEqual(snapshot(s.root), before);
  });

  it("writes the SDK's MCP server into .mcp.json and keeps other servers", async () => {
    const s = await scenario();
    write(s.root, ".mcp.json", { mcpServers: { atlassian: { type: "http", url: "https://mcp.example.com/mcp" } } });
    await sync(opts(s.root));
    const config = JSON.parse(read(s.root, ".mcp.json"));
    assert.deepEqual(Object.keys(config.mcpServers), ["atlassian", "de-web-sdk"]);
    assert.deepEqual(config.mcpServers["de-web-sdk"], { type: "stdio", command: "node", args: ["node_modules/@de-web-sdk/cli/bin/de-web-sdk.js", "mcp"] });
    const again = await sync(opts(s.root));
    assert.ok(!again.applied.written.includes(".mcp.json"));
  });

  it("leaves an invalid .mcp.json unchanged and warns", async () => {
    const s = await scenario();
    write(s.root, ".mcp.json", "{ not json");
    const result = await sync(opts(s.root));
    assert.equal(read(s.root, ".mcp.json"), "{ not json");
    assert.ok(result.plan.warnings.some((w) => w.code === "mcp.configInvalid"));
  });

  it("removes its server entry when the repo turns the MCP server off", async () => {
    const s = await scenario();
    await sync(opts(s.root));
    setConfig(s.root, { mode: "enforce", mcpServer: false });
    await sync(opts(s.root));
    assert.equal(existsSync(path.join(s.root, ".mcp.json")), false);
  });
  it("doesn't commit a change when a pack's guidance changes but its rule list doesn't", async () => {
    const s = await scenario();
    await sync(opts(s.root));
    const committed = ["AGENTS.md", ".gitignore"].map((f) => read(s.root, f));
    await installPack(s.root, {
      name: RUNTIME_PACK,
      keys: s.keys,
      version: "1.1.0",
      dependencies: { [ADAPTER_PACK]: "^1.0.0" },
      files: { "guidance/lazy-remotes.md": "New guidance text with more detail.\n" },
      manifest: {
        rules: [
          machine("react-singleton", "shared-singletons", { title: "Rule react-singleton", locked: true, appliesWhen: { moduleFederation: ["2"] }, check: { pack: ADAPTER_PACK, adapter: "shared-singletons", options: { packages: ["react", "react-dom"] } } }),
          { id: "lazy-remotes", title: "Lazy-load remotes below the fold", enforcement: "advisory", rationale: "First render.", appliesWhen: { role: ["host", "both"] }, guidance: "guidance/lazy-remotes.md" },
          { id: "mf2-only", title: "Only for MF2", enforcement: "advisory", rationale: "MF2 things.", appliesWhen: { moduleFederation: ["2"] } },
        ],
      },
    });
    await sync(opts(s.root));
    assert.deepEqual(["AGENTS.md", ".gitignore"].map((f) => read(s.root, f)), committed);
  });

  it("creates no CLAUDE.md, because Claude Code reads AGENTS.md when a repo has none", async () => {
    const s = await scenario();
    await sync(opts(s.root));
    assert.equal(existsSync(path.join(s.root, "CLAUDE.md")), false);
  });

  it("adds an AGENTS.md import to an existing CLAUDE.md, which would otherwise hide AGENTS.md from Claude Code", async () => {
    const s = await scenario();
    write(s.root, "CLAUDE.md", "# Team notes\n");
    write(s.root, ".claude/CLAUDE.md", "Also ours.\n\n@AGENTS.md\n");
    await sync(opts(s.root));
    assert.match(read(s.root, "CLAUDE.md"), /^# Team notes\n\n<!-- de-web-sdk:begin -->\n<!-- Generated by de-web-sdk sync[^\n]*-->\n@AGENTS\.md\n<!-- de-web-sdk:end -->\n$/);
    assert.equal(read(s.root, ".claude/CLAUDE.md"), "Also ours.\n\n@AGENTS.md\n", "a file that already imports AGENTS.md is left alone");
  });
});
