import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main as consumer } from "@de-web-sdk/cli";
import { makeRepo, tmpDir, write } from "../../core/test/helpers.ts";
import { toolkit } from "./fixture.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const guide = readFileSync(path.resolve(here, "../../../docs/producer-guide.md"), "utf8");

function block(lang: string, contains: string): string {
  const found = [...guide.matchAll(new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g"))].map((m) => m[1]!).find((b) => b.includes(contains));
  assert.ok(found, `no ${lang} block containing ${contains}`);
  return found;
}

function argv(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

/** Writes a page that uses the hook when the pack's rule reached the agent. */
const DRIVER = `
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
export default {
  name: "guide-driver",
  async available() { return { ok: true }; },
  async version() { return "guide 1"; },
  async run(trial) {
    const agents = path.join(trial.worktree, "AGENTS.md");
    const told = existsSync(agents) && readFileSync(agents, "utf8").includes("track-page-views");
    mkdirSync(path.join(trial.worktree, "src/pages"), { recursive: true });
    writeFileSync(path.join(trial.worktree, "src/pages/pricing.tsx"), told
      ? 'import { usePageView } from "@example-analytics/client";\\nexport const Pricing = () => { usePageView(); return null; };\\n'
      : "export const Pricing = () => null;\\n");
    return { status: "completed", acted: true };
  },
};
`;

describe("producer guide", () => {
  it("publishes a sample pack by following the guide, and a consumer repo enforces it", async () => {
    const parent = tmpDir("dws-guide-");
    // Scaffold, as the guide's first command shows.
    const line = block("sh", "de-web-sdk-pack new").split("\n")[0]!;
    const words = argv(line);
    assert.deepEqual(words.slice(0, 3), ["npx", "-p", "@de-web-sdk/pack"], "the first command names the toolkit's package, so npx can't fetch a look-alike");
    const scaffold = words.slice(words.indexOf("de-web-sdk-pack") + 1);
    assert.equal((await toolkit(parent, scaffold)).code, 0);
    const dir = path.join(parent, "tracking-pack");

    // The guide's rule, adapter declaration, and adapter code.
    const rule = JSON.parse(block("json", '"id": "track-page-views"'));
    const adapters = JSON.parse(`{${block("json", '"adapters": [{ "name": "page-views"').trim()}}`).adapters;
    const manifest = JSON.parse(readFileSync(path.join(dir, "pack.json"), "utf8"));
    manifest.rules = [rule];
    manifest.adapters = adapters;
    write(dir, "pack.json", manifest);
    write(dir, "adapters/page-views.mjs", block("js", "adapters/page-views.mjs"));
    write(dir, "guidance/track-page-views.md", "Call usePageView() in every page component.\n");
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    pkg.files.push("adapters");
    write(dir, "package.json", pkg);

    // Fixtures, in the guide's layout.
    write(dir, "fixtures/track-page-views/positive/page-without-hook/src/pages/home.tsx", "export const Home = () => null;\n");
    write(dir, "fixtures/track-page-views/negative/page-with-hook/src/pages/home.tsx", 'import { usePageView } from "@example-analytics/client";\nexport const Home = () => { usePageView(); return null; };\n');

    // An eval task whose starting app has the analytics client installed.
    write(dir, "evals/tasks/example-task.json", { id: "add-page", prompt: "Add a pricing page.", start: "evals/fixtures/example-app", exercises: ["track-page-views"], expects: [{ package: "@example-analytics/client", export: "usePageView" }], graders: [{ type: "check" }] });
    write(dir, "evals/fixtures/example-app/package.json", { name: "example-app", version: "0.0.0", private: true, dependencies: { "@example-analytics/client": "^3.0.0" } });
    write(dir, "evals/fixtures/example-app/node_modules/@example-analytics/client/package.json", { name: "@example-analytics/client", version: "3.1.0" });
    write(dir, "evals/fixtures/example-app/.gitignore", "node_modules/\n");
    write(dir, "drivers/guide.mjs", DRIVER);
    const profile = write(parent, "profile.json", { required: ["claude-sonnet"], gate: { minTrials: 2 }, models: { "claude-sonnet": { model: "claude-sonnet-5", routes: [{ driver: path.join(dir, "drivers/guide.mjs") }] } } });
    write(dir, "evals/config.json", { models: ["claude-sonnet"], runs: 2, tasks: ["evals/tasks/example-task.json"] });

    const validated = await toolkit(dir, ["validate"]);
    assert.equal(validated.code, 0, validated.stderr + validated.stdout);
    const evals = await toolkit(dir, ["eval", "run", "--local", "--yes", "--published", "none"], { DE_WEB_SDK_EVAL_PROFILE: profile });
    assert.equal(evals.code, 0, evals.stderr);
    assert.match(evals.stdout, /Gate: passes/);

    // Build, sign, and publish, as the guide's last section shows.
    const built = await toolkit(dir, ["build", "--out", "dist-pack"], { DE_WEB_SDK_EVAL_PROFILE: profile });
    assert.equal(built.code, 0, built.stderr + built.stdout);
    const keygen = await toolkit(dir, ["keygen", "--out", "keys"]);
    const publicKey = /"keys": \["([^"]+)"\]/.exec(keygen.stdout)![1]!;
    pkg.files.push("pack.sigstore.json");
    const signed = await toolkit(dir, ["sign", "--key", "env:PACK_SIGNING_KEY", "--out", "dist-pack"], { PACK_SIGNING_KEY: readFileSync(path.join(dir, "keys/private.pem"), "utf8") });
    assert.equal(signed.code, 0, signed.stderr);
    const tarball = path.join(dir, "dist-pack/example-analytics-tracking-pack-0.1.0.tgz");
    assert.ok(existsSync(tarball));
    // The guide's publish command, run as written from the pack's directory.
    const publish = argv(block("sh", "npm publish").trim());
    const dryRun = execFileSync("npm", [...publish.slice(1), "--dry-run", "--json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // npm 11.19 and later key the dry run's JSON by package name; earlier versions don't.
    const parsed = JSON.parse(dryRun) as { name?: string } & Record<string, { name?: string }>;
    assert.equal(parsed.name ?? Object.values(parsed)[0]?.name, "@example-analytics/tracking-pack");

    // A consumer installs the tarball, trusts the producer's key, and runs check.
    const app = makeRepo({ dependencies: { "@example-analytics/client": "^3.0.0" }, trust: { scopes: { "@example-analytics": { keys: [publicKey] } } }, files: { "src/pages/home.tsx": "export const Home = () => null;\n" } });
    write(app, "node_modules/@example-analytics/client/package.json", { name: "@example-analytics/client", version: "3.1.0" });
    let out = "";
    const io = { cwd: app, env: { ...process.env, DE_WEB_SDK_OFFLINE: "1" }, stdout: (t: string) => (out += t), stderr: (t: string) => (out += t), interactive: false, rootKeys: [] };
    assert.equal(await consumer(["init", tarball, "--enforce"], io), 0, out);
    out = "";
    assert.equal(await consumer(["check"], io), 1, out);
    assert.match(out, /@example-analytics\/tracking-pack#track-page-views[\s\S]*src\/pages\/home\.tsx[\s\S]*This page doesn't call usePageView\(\)/);
  });
});
