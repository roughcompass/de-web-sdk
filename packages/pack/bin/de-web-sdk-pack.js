#!/usr/bin/env node
const [major, minor, patch] = process.versions.node.split(".").map(Number);
// The permission model that isolates check adapters is stable from Node.js 22.13.
if (major < 22 || (major === 22 && minor < 13)) {
  process.stderr.write(`de-web-sdk-pack needs Node.js 22.13 or later, for its permission model. This is Node.js ${process.versions.node}.\n`);
  process.exit(2);
}
// package.json's engines range follows the Sigstore libraries, which support the latest release line of each Node.js LTS.
const supported = (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || (major === 24 && minor >= 15) || major >= 26;
if (!supported && process.stderr.isTTY) {
  process.stderr.write(`warning: de-web-sdk-pack supports Node.js 22.22.2, 24.15, 26, or later in those lines. This is Node.js ${process.versions.node}; update it if verification fails.\n`);
}
const { main } = await import("../dist/main.js");
process.exitCode = await main(process.argv.slice(2));
