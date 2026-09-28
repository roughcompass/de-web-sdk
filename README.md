# de-web-sdk

de-web-sdk lets teams that set rules for client-facing web UI publish those rules as versioned **agent packs**. App repos, and the coding agents working in them, then apply the rules and check the result.

A pack carries rules, the checks that enforce them, skills, reference docs, and agent commands. Producers publish packs to an npm registry from their own repos. Consumer repos install packs as dev dependencies. The SDK then gives every agent the rules through a managed block in `AGENTS.md` and a local MCP server, and runs the checks in CI.

> **Status: alpha.** Version `0.1.0-alpha.0`, unpublished. The `@de-web-sdk` scope is a placeholder until the enterprise's Artifactory scopes exist. Progress is tracked in the first OpenSpec change's [task list](openspec/changes/add-pack-format-v0/tasks.md).

## Packages

| Package | Who uses it | What it provides |
|---|---|---|
| [`@de-web-sdk/cli`](packages/cli) | App repos, their agents, and CI | The `de-web-sdk` command: `init`, `sync`, `resolve`, `check`, `skill`, `feedback`, and the `mcp` server |
| [`@de-web-sdk/pack`](packages/pack) | Pack producers | The `de-web-sdk-pack` command: `new`, `validate`, `build`, `keygen`, `sign`, `eval`, and `feedback` |
| [`@de-web-sdk/core`](packages/core) | The other packages, and Node.js tools that embed the SDK | The pack format and JSON Schemas, provenance verification, composition, the check adapter contract, and baselines |
| [`de-web-sdk-vscode`](packages/vscode) | Producers in VS Code | Pack evals with Copilot's models, guided Copilot trials, and blind trial review. Ships as a VSIX file |

## How it works

1. A producer writes a pack: a `pack.json` manifest with rules, check adapters that return SARIF, fixtures, skills, docs, and eval tasks. `build` refuses a pack that makes agents worse on any required model, and `sign` adds a Sigstore-format signature where npm provenance isn't available.
2. A consumer runs `init`. The repo installs packs with its own package manager and lockfile, and verifies each pack's provenance and file digests before using it.
3. `sync` writes one managed block in `AGENTS.md`, which Claude Code and GitHub Copilot both read, and registers the SDK's MCP server in `.mcp.json`. Skills and rule detail stay in their installed packages, and the SDK verifies them each time it serves them.
4. Agents call `resolve` before editing and `check` before finishing. CI runs `check` in report mode first, then in enforce mode against a baseline.

## Get started

- Adopting packs in an app repo: [consumer guide](docs/consumer-guide.md)
- Publishing a pack: [producer guide](docs/producer-guide.md)

Both need Node.js 22.22.2, 24.15, or 26 or later in those release lines.

## Develop

```sh
npm ci
npm run build
npm test
```

| Command | What it does |
|---|---|
| `npm run build` | Builds every package with TypeScript project references |
| `npm test` | Runs every package's tests with `node:test`, against the TypeScript sources |
| `npm run typecheck` | Type-checks, the same way as `build` |
| `npm run clean` | Removes build output |

The repo is an npm workspace. Tests import packages' TypeScript sources through the `development` export condition, so they need no build. The VS Code extension packages with `npm run package --workspace de-web-sdk-vscode`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow, and [AGENTS.md](AGENTS.md) for the conventions coding agents follow in this repo.

## Specification

Design and requirements live in [OpenSpec](https://github.com/Fission-AI/OpenSpec):

- [`openspec/scope.md`](openspec/scope.md): the product scope, priorities, and open questions
- [`openspec/changes/add-pack-format-v0/`](openspec/changes/add-pack-format-v0): the first change, with its proposal, design decisions D1 to D22, requirements for ten capabilities, and tasks

```sh
OPENSPEC_TELEMETRY=0 npx -y @fission-ai/openspec@1.13.2 validate --all --strict
```

## Security

The SDK's security boundary is provenance and digest verification: packs run check code in consumer repos and CI, so unverified packs never load. Report vulnerabilities as [SECURITY.md](SECURITY.md) describes.

## License

No license has been chosen yet. Until one is, the packages are marked `UNLICENSED`, which grants no rights to use them.
