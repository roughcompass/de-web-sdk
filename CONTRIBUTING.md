# Contributing

## Set up

You need Node.js 22.22.2, 24.15, or 26 or later in those release lines, and git. `.nvmrc` names the version the maintainers use.

```sh
npm ci
npm run build
npm test
```

`.npmrc` turns off dependencies' install scripts. If a new dependency needs one, say why in the pull request.

## Work from the spec

This repo uses [OpenSpec](https://github.com/Fission-AI/OpenSpec). The product scope is [`openspec/scope.md`](openspec/scope.md), and work happens in changes under `openspec/changes/`.

1. Find the task in the change's `tasks.md`, or propose a new change when the work isn't covered.
2. Implement it with tests. A behavior change needs a test that fails without it.
3. Record what implementation revealed: decisions in `design.md` with the rejected alternative, and behavior in `specs/` as results someone can observe.
4. Check off the task only after verifying it the way the task says.
5. Update `docs/` when the change affects what producers or consumers do.

Validate the specs before you open a pull request:

```sh
OPENSPEC_TELEMETRY=0 npx -y @fission-ai/openspec@1.13.2 validate --all --strict
```

## Write code

[AGENTS.md](AGENTS.md) lists the conventions and security invariants, for people and coding agents alike. In short: TypeScript with erasable syntax only, Node.js built-ins where possible, and no weakening of pack verification or adapter isolation without a recorded design decision.

## Write docs and specs

Write in American English, in short active sentences. Give each claim its evidence: a version, a doc link, or a command that shows it. Keep facts, recommendations, and requirements distinct.

## Commit and review

- Write each commit subject as a short imperative sentence, and use the body to say why.
- Keep one concern per commit, so a revert stays small.
- Pull requests need passing CI, and review from a code owner in [`.github/CODEOWNERS`](.github/CODEOWNERS).

## Release

Nothing is published yet. Once the enterprise's Artifactory scopes exist, the shared pipeline publishes the packages there, and the VS Code extension as a VSIX file. A public release would publish from CI with npm provenance.
