import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import type { Manifest, Rule } from "../src/index.ts";
import { GREP_ADAPTER, installPack, makeKeys, makeRepo, write, type KeyPair } from "./helpers.ts";

export const ADAPTERS: Record<string, string> = {
  "adapters/shared-singletons.mjs": `
export default async function check({ options, readJson, result }) {
  const file = options.manifest ?? "dist/mf-manifest.json";
  const manifest = await readJson(file);
  if (!manifest) return { error: "No MF2 manifest at " + file + ". Run check after the build." };
  const results = [];
  for (const name of options.packages) {
    const shared = (manifest.shared ?? []).find((s) => s.name === name);
    if (shared && !shared.singleton) results.push(result({ file, fingerprint: name, message: name + " is shared without the singleton setting." }));
  }
  return { results };
}
`,
  "adapters/grep.mjs": GREP_ADAPTER,
  "adapters/writer.mjs": `import { writeFileSync } from "node:fs";\nexport default async function (ctx) { writeFileSync(ctx.root + "/pwned.txt", "x"); return { results: [] }; }\n`,
  "adapters/spawner.mjs": `import { execSync } from "node:child_process";\nexport default async function () { execSync("echo hi"); return { results: [] }; }\n`,
  "adapters/hang.mjs": `export default async function () { await new Promise(() => setInterval(() => {}, 1000)); }\n`,
  "adapters/crash.mjs": `export default async function () { throw new Error("boom"); }\n`,
  "adapters/sarif.mjs": `export default async function () { return { version: "2.1.0", runs: [{ tool: { driver: { name: "salt-analyzer" } }, results: [{ ruleId: "deprecated-api", level: "error", message: { text: "ButtonBar is deprecated" }, locations: [{ physicalLocation: { artifactLocation: { uri: "src/app.tsx" }, region: { startLine: 3 } } }], partialFingerprints: { "salt/v1": "ButtonBar" } }] }] }; }\n`,
};

export const ADAPTER_PACK = "@example-platform/mf2-adapter";
export const RUNTIME_PACK = "@example-platform/runtime";

export function machine(id: string, adapter: string, extra: Partial<Rule> = {}, pack: string | undefined = ADAPTER_PACK): Rule {
  return {
    id,
    title: `Rule ${id}`,
    enforcement: "machine",
    rationale: `Because ${id} matters.`,
    fix: `Fix ${id}.`,
    check: { ...(pack ? { pack } : {}), adapter, options: {} },
    ...extra,
  };
}

export interface Scenario {
  root: string;
  keys: KeyPair;
  runtimeDir: string;
  adapterDir: string;
}

export interface ScenarioOptions {
  rules?: Rule[];
  skills?: Manifest["skills"];
  runtimeFiles?: Record<string, string>;
  config?: object;
  mf?: "1" | "2";
  files?: Record<string, string>;
  git?: boolean;
  runtimeManifest?: Partial<Manifest>;
}

/** A Vite MF2 remote with a signed runtime pack whose machine rules use a signed adapter pack. */
export async function scenario(options: ScenarioOptions = {}): Promise<Scenario> {
  const keys = makeKeys();
  const mf = options.mf ?? "2";
  const root = makeRepo({
    devDependencies: mf === "2" ? { vite: "^6.0.0", "@module-federation/vite": "^1.0.0", [RUNTIME_PACK]: "^1.0.0" } : { webpack: "^5.0.0", [RUNTIME_PACK]: "^1.0.0" },
    dependencies: { react: "^19.0.0" },
    trust: { scopes: { "@example-platform": { keys: [keys.encoded] } } },
    config: options.config ?? { mode: "enforce" },
    git: options.git,
    files: {
      ...(mf === "2"
        ? { "vite.config.ts": "export default {}\n", "dist/mf-manifest.json": JSON.stringify({ exposes: [{ name: "./Cart" }], remotes: [], shared: [{ name: "react", singleton: false }, { name: "react-dom", singleton: true }] }) }
        : { "webpack.config.js": "new ModuleFederationPlugin({ exposes: { './Cart': './src/cart' } })\n" }),
      "src/app.tsx": "export const App = () => null;\n",
      ...options.files,
    },
  });
  write(root, "node_modules/react/package.json", { name: "react", version: "19.1.0" });
  if (mf === "2") {
    write(root, "node_modules/vite/package.json", { name: "vite", version: "6.2.1" });
    write(root, "node_modules/@module-federation/vite/package.json", { name: "@module-federation/vite", version: "1.4.0" });
  } else {
    write(root, "node_modules/webpack/package.json", { name: "webpack", version: "5.98.0" });
  }
  const adapterDir = await installPack(root, {
    name: ADAPTER_PACK,
    keys,
    files: ADAPTERS,
    manifest: { adapters: Object.keys(ADAPTERS).map((f) => ({ name: path.basename(f, ".mjs"), module: f })) },
  });
  const rules = options.rules ?? [
    machine("react-singleton", "shared-singletons", { locked: true, appliesWhen: { moduleFederation: ["2"] }, check: { pack: ADAPTER_PACK, adapter: "shared-singletons", options: { packages: ["react", "react-dom"] } } }),
    { id: "lazy-remotes", title: "Lazy-load remotes below the fold", enforcement: "advisory", rationale: "First render.", appliesWhen: { role: ["host", "both"] }, guidance: "guidance/lazy-remotes.md" },
    { id: "mf2-only", title: "Only for MF2", enforcement: "advisory", rationale: "MF2 things.", appliesWhen: { moduleFederation: ["2"] } },
  ];
  const runtimeDir = await installPack(root, {
    name: RUNTIME_PACK,
    keys,
    dependencies: { [ADAPTER_PACK]: "^1.0.0" },
    files: { "guidance/lazy-remotes.md": "Use React.lazy for remotes below the fold.\n", ...options.runtimeFiles },
    manifest: { rules, ...(options.skills ? { skills: options.skills } : {}), ...options.runtimeManifest },
  });
  return { root, keys, runtimeDir, adapterDir };
}

export function setConfig(root: string, config: object) {
  write(root, ".de-web-sdk/config.json", config);
}

export function readConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, ".de-web-sdk/config.json"), "utf8"));
}

export function addDevDependency(root: string, name: string) {
  const pkgPath = path.join(root, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.devDependencies = { ...pkg.devDependencies, [name]: "^1.0.0" };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
}
