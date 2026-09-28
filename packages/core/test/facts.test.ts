import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectFacts, readLockfile } from "../src/index.ts";
import { makeRepo, write } from "./helpers.ts";

function installed(root: string, name: string, version: string) {
  write(root, `node_modules/${name}/package.json`, { name, version });
}

describe("detection", () => {
  it("reports a Vite remote on MF2 from the build manifest", () => {
    const root = makeRepo({ devDependencies: { vite: "^6.0.0", "@module-federation/vite": "^1.0.0" }, dependencies: { react: "^19.0.0" } });
    installed(root, "vite", "6.2.1");
    installed(root, "@module-federation/vite", "1.4.0");
    installed(root, "react", "19.1.0");
    write(root, "vite.config.ts", "export default {}\n");
    write(root, "dist/mf-manifest.json", { exposes: [{ name: "./Cart" }], remotes: [], shared: [] });
    const { facts } = detectFacts(root);
    assert.equal(facts.bundler, "vite");
    assert.equal(facts.bundlerVersion, "6.2.1");
    assert.equal(facts.moduleFederation, "2");
    assert.equal(facts.role, "remote");
    assert.equal(facts.react, "19.1.0");
  });

  it("reports a webpack host on MF1 from its config text, without loading it", () => {
    const root = makeRepo({ devDependencies: { webpack: "^5.0.0" } });
    installed(root, "webpack", "5.98.0");
    write(
      root,
      "webpack.config.js",
      "throw new Error('never run');\nconst { ModuleFederationPlugin } = require('webpack').container;\nmodule.exports = { plugins: [new ModuleFederationPlugin({ name: 'shell', remotes: { cart: 'cart@/remoteEntry.js' }, exposes: {} })] };\n",
    );
    const { facts } = detectFacts(root);
    assert.equal(facts.bundler, "webpack");
    assert.equal(facts.moduleFederation, "1");
    assert.equal(facts.role, "host");
  });

  it("reports Yarn Plug'n'Play as a limitation and treats versions as unknown", () => {
    const root = makeRepo({ dependencies: { react: "^18.0.0" } });
    write(root, ".pnp.cjs", "throw new Error('never run');\n");
    write(root, "yarn.lock", "__metadata:\n  version: 8\n");
    const report = detectFacts(root);
    assert.match(report.limitations.join(" "), /Plug'n'Play/);
    assert.equal(report.versionOf("react"), undefined);
    assert.deepEqual(report.facts.packages, {});
  });

  it("records a fact it can't determine as unknown", () => {
    const root = makeRepo({ devDependencies: { "@module-federation/enhanced": "^0.9.0", webpack: "^5.0.0" } });
    const { facts } = detectFacts(root);
    assert.equal(facts.moduleFederation, "2");
    assert.equal(facts.role, "unknown");
  });

  it("lets declared facts win and reports each disagreement", () => {
    const root = makeRepo({ devDependencies: { webpack: "^5.0.0" } });
    write(root, "webpack.config.js", "new ModuleFederationPlugin({ exposes: { './A': './a' } })\n");
    const report = detectFacts(root, { moduleFederation: "2" });
    assert.equal(report.facts.moduleFederation, "2");
    assert.deepEqual(report.disagreements, [{ fact: "moduleFederation", declared: "2", detected: "1" }]);
  });

  it("applies declared facts in an empty new repo without reporting disagreement", () => {
    const root = makeRepo();
    const report = detectFacts(root, { moduleFederation: "2", role: "remote", bundler: "vite" });
    assert.equal(report.facts.role, "remote");
    assert.equal(report.facts.bundler, "vite");
    assert.deepEqual(
      report.disagreements.map((d) => d.fact),
      ["bundler", "moduleFederation", "role"],
    );
  });

  it("lists workspace packages it didn't evaluate", () => {
    const root = makeRepo();
    write(root, "package.json", { name: "mono", workspaces: ["packages/*"] });
    write(root, "packages/a/package.json", { name: "a" });
    assert.deepEqual(detectFacts(root).notEvaluated, ["packages/a"]);
  });
});

describe("lockfiles", () => {
  it("reads npm, pnpm, Yarn 1, and Yarn Berry lockfiles", () => {
    const npm = makeRepo();
    write(npm, "package-lock.json", { lockfileVersion: 3, packages: { "node_modules/react": { version: "18.3.1", integrity: "sha512-abc" } } });
    assert.deepEqual(readLockfile(npm).lookup("react"), { version: "18.3.1", integrity: "sha512-abc" });

    const pnpm = makeRepo();
    write(pnpm, "pnpm-lock.yaml", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^18.2.0\n        version: 18.3.1\n      react-dom:\n        specifier: ^18.2.0\n        version: 18.3.1(react@18.3.1)\npackages:\n  react@18.3.1:\n    resolution: {integrity: sha512-xyz}\n");
    assert.deepEqual(readLockfile(pnpm).lookup("react"), { version: "18.3.1", integrity: "sha512-xyz" });
    assert.equal(readLockfile(pnpm).lookup("react-dom")?.version, "18.3.1");

    const yarn1 = makeRepo();
    write(yarn1, "yarn.lock", '# yarn lockfile v1\n\n"@scope/pkg@^1.0.0", "@scope/pkg@^1.1.0":\n  version "1.2.0"\n  integrity sha512-q\n\nreact@^18.2.0:\n  version "18.3.1"\n');
    assert.equal(readLockfile(yarn1).lookup("@scope/pkg")?.version, "1.2.0");
    assert.equal(readLockfile(yarn1).lookup("@scope/pkg")?.integrity, "sha512-q");
    assert.equal(readLockfile(yarn1).lookup("react", "^18.2.0")?.version, "18.3.1");

    const berry = makeRepo();
    write(berry, "yarn.lock", '__metadata:\n  version: 8\n\n"react@npm:^18.2.0":\n  version: 18.3.1\n  resolution: "react@npm:18.3.1"\n');
    assert.equal(readLockfile(berry).lookup("react", "^18.2.0")?.version, "18.3.1");
  });

  it("uses the lockfile when a package isn't installed", () => {
    const root = makeRepo({ dependencies: { react: "^18.2.0" } });
    write(root, "package-lock.json", { lockfileVersion: 3, packages: { "node_modules/react": { version: "18.3.1" } } });
    assert.equal(detectFacts(root).facts.packages.react, "18.3.1");
  });
});
