import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/main.ts";
import { git, installPack, makeKeys, makeRepo, write } from "../../core/test/helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const GUIDE = path.resolve(here, "../../../docs/consumer-guide.md");

/** Every `npx --no de-web-sdk` line in the guide's shell blocks, in order. */
function guideCommands(): string[] {
  const text = readFileSync(GUIDE, "utf8");
  const blocks = [...text.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]!);
  return blocks.flatMap((b) => b.split("\n")).map((l) => l.trim()).filter((l) => l.startsWith("npx --no de-web-sdk "));
}

/** Splits a shell line into arguments, honoring double quotes. */
function argv(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!).slice(3);
}

const MANIFEST_ADAPTER = `
export default async function check({ facts, readJson, result }) {
  if (facts.moduleFederation === "1") return { results: [result({ file: "webpack.config.js", fingerprint: "mf1", message: "This remote uses MF1 and must migrate to MF2." })] };
  const manifest = await readJson("dist/mf-manifest.json");
  if (!manifest) return { error: "No MF2 manifest at dist/mf-manifest.json. Run check after the build." };
  return { results: [] };
}
`;

async function mf1Repo() {
  const keys = makeKeys();
  const root = makeRepo({
    git: true,
    dependencies: { react: "^18.3.0" },
    devDependencies: { webpack: "^5.0.0", "@example-platform/web-runtime-pack": "^2.1.0" },
    trust: { scopes: { "@example-platform": { keys: [keys.encoded] } } },
    files: {
      "webpack.config.js": "const { ModuleFederationPlugin } = require('webpack').container;\nmodule.exports = { plugins: [new ModuleFederationPlugin({ name: 'cart', exposes: { './Cart': './src/remotes/cart.tsx' } })] };\n",
      "src/remotes/cart.tsx": "export const Cart = () => null;\n",
      ".gitignore": "node_modules/\n",
    },
  });
  write(root, "node_modules/webpack/package.json", { name: "webpack", version: "5.98.0" });
  write(root, "node_modules/react/package.json", { name: "react", version: "18.3.1" });
  await installPack(root, {
    name: "@example-platform/mf2-manifest-adapter",
    keys,
    files: { "adapters/manifest-valid.mjs": MANIFEST_ADAPTER },
    manifest: { adapters: [{ name: "manifest-valid", module: "adapters/manifest-valid.mjs" }] },
  });
  await installPack(root, {
    name: "@example-platform/web-runtime-pack",
    version: "2.1.0",
    keys,
    dependencies: { "@example-platform/mf2-manifest-adapter": "^1.0.0" },
    files: {
      "guidance/mf2-manifest.md": "Enable the manifest option.\n",
      "skills/migrate-to-mf2/SKILL.md": "---\nname: migrate-to-mf2\ndescription: Migrate a webpack remote from MF1 to MF2.\n---\n\n1. Declare MF2.\n",
    },
    manifest: {
      appliesWhen: { moduleFederation: ["1", "2"] },
      rules: [
        { id: "mf2-manifest", title: "Each remote publishes a valid MF2 manifest", enforcement: "machine", locked: true, appliesWhen: { role: ["remote", "both"] }, rationale: "The shell finds remotes through the MF2 manifest.", guidance: "guidance/mf2-manifest.md", check: { pack: "@example-platform/mf2-manifest-adapter", adapter: "manifest-valid" }, fix: "Migrate to MF2 with the migrate-to-mf2 skill." },
        { id: "react-singleton", title: "Share react and react-dom as singletons", enforcement: "machine", locked: true, appliesWhen: { moduleFederation: ["2"] }, rationale: "Two copies of React break hooks.", check: { pack: "@example-platform/mf2-manifest-adapter", adapter: "manifest-valid" } },
      ],
      skills: [{ name: "migrate-to-mf2", path: "skills/migrate-to-mf2", appliesWhen: { moduleFederation: ["1"] } }],
    },
  });
  git(root, "add", "-A");
  git(root, "commit", "-qm", "app");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

async function run(cwd: string, args: string[]) {
  let out = "";
  // Commands written for people may ask before acting, so the walkthrough answers yes.
  const code = await main(args, { cwd, env: { ...process.env, DE_WEB_SDK_OFFLINE: "1", DE_WEB_SDK_HOME: cwd }, stdout: (t) => (out += t), stderr: (t) => (out += t), interactive: true, ask: async () => "y", rootKeys: [] });
  return { code, out };
}

describe("consumer guide", () => {
  it("runs every command as written on an MF1 fixture", async () => {
    const commands = guideCommands();
    assert.ok(commands.length >= 9, `found only ${commands.length} commands`);
    const text = readFileSync(GUIDE, "utf8");
    assert.doesNotMatch(text, /(^|[^-\w])npx de-web-sdk/m, "every command uses npx --no, so npx never downloads a package by that name");
    const root = await mf1Repo();
    const fresh = makeRepo();
    for (const line of commands) {
      let args = argv(line);
      // The fixture installs packs ahead of time, so init doesn't reach a registry.
      if (args[0] === "init") args = [...args, "--no-install"];
      const cwd = args.includes("--fact") ? fresh : root;
      const { code, out } = await run(cwd, args);
      assert.ok(code === 0 || code === 1, `\`${line}\` exited with ${code}:\n${out}`);
      if (line === "npx --no de-web-sdk init @example-platform/web-runtime-pack") {
        assert.match(out, /bundler webpack 5\.98\.0, Module Federation 1, role remote/);
        assert.match(out, /rule @example-platform\/web-runtime-pack#react-singleton: requires moduleFederation 2, and the repo has 1/);
      }
      if (line === "npx --no de-web-sdk check --baseline-ref origin/main") assert.equal(code, 0, out);
    }
    assert.match(readFileSync(path.join(root, "AGENTS.md"), "utf8"), /`example-platform-web-runtime-pack-migrate-to-mf2`: Migrate a webpack remote from MF1 to MF2\./, "MF1 repos receive the migration skill");
    assert.equal(existsSync(path.join(root, ".claude/skills")), false, "no skill files are installed");
    const skill = await run(root, ["skill", "example-platform-web-runtime-pack-migrate-to-mf2"]);
    assert.equal(skill.code, 0, skill.out);
    assert.match(skill.out, /1\. Declare MF2\./);
    assert.equal(JSON.parse(readFileSync(path.join(root, ".de-web-sdk/config.json"), "utf8")).mode, "enforce");
    assert.ok(existsSync(path.join(root, "reports/resolution.json")));
    assert.deepEqual(JSON.parse(readFileSync(path.join(fresh, ".de-web-sdk/config.json"), "utf8")), { mode: "enforce", facts: { moduleFederation: "2", role: "remote" } });
  });
});
