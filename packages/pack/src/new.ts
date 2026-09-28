import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { formatJson, SCHEMA_URL, SdkError, writeFileAtomic } from "@de-web-sdk/core";

export interface NewPackOptions {
  id: string;
  team: string;
  contact?: string;
  feedback: string;
  dir: string;
  sdkVersion: string;
}

/**
 * `new`: scaffolds a pack with one example rule, its guidance, an eval
 * configuration, and one eval task. It passes `validate` unedited.
 */
export async function scaffoldPack(options: NewPackOptions): Promise<string[]> {
  if (!/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/.test(options.id)) {
    throw new SdkError("usage", `${JSON.stringify(options.id)} isn't an npm package name. The pack's identifier is its package name`);
  }
  if (!/^(https?:\/\/|mailto:)/.test(options.feedback)) throw new SdkError("usage", "--feedback must be an https or mailto link");
  if (existsSync(options.dir) && readdirSync(options.dir).length) throw new SdkError("usage", `${options.dir} isn't empty`);
  const files: Record<string, string> = {
    "package.json": formatJson({
      name: options.id,
      version: "0.1.0",
      description: `Agent pack from ${options.team}.`,
      files: ["pack.json", "pack.sigstore.json", "guidance"],
      scripts: {
        validate: "de-web-sdk-pack validate",
        evals: "de-web-sdk-pack eval run",
        build: "de-web-sdk-pack build --out dist-pack",
      },
      devDependencies: { "@de-web-sdk/pack": `^${options.sdkVersion}` },
    }),
    "pack.json": formatJson({
      $schema: SCHEMA_URL,
      specVersion: "0",
      id: options.id,
      version: "0.1.0",
      owner: { team: options.team, ...(options.contact ? { contact: options.contact } : {}) },
      feedback: options.feedback,
      rules: [
        {
          id: "example-rule",
          title: "Replace this example rule with your first rule",
          enforcement: "advisory",
          rationale: "Explain why the rule exists, so agents and developers can apply it with judgment.",
          guidance: "guidance/example-rule.md",
        },
      ],
    }),
    "guidance/example-rule.md": "# Example rule\n\nDescribe what agents should do, with a short example of the preferred code.\n",
    "evals/config.json": formatJson({ models: [], runs: 5, tasks: ["evals/tasks/example-task.json"] }),
    "evals/tasks/example-task.json": formatJson({
      id: "example-task",
      prompt: "Add a function named greet to src/index.ts that returns a greeting for a name.",
      start: "evals/fixtures/example-app",
      exercises: ["example-rule"],
      graders: [{ type: "check" }],
    }),
    "evals/fixtures/example-app/package.json": formatJson({ name: "example-app", version: "0.0.0", private: true }),
    "evals/fixtures/example-app/src/index.ts": "export {};\n",
    "evals/.gitignore": ".cache/\n",
    ".gitignore": "node_modules/\ndist-pack/\n*.tgz\nkeys/\n",
  };
  for (const [rel, content] of Object.entries(files)) await writeFileAtomic(path.join(options.dir, rel), content);
  return Object.keys(files);
}
