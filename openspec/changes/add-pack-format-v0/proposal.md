# Proposal: add-pack-format-v0

## Why

The [scope](../../scope.md) proposes one format for publishing web UI rules and one way to apply and check them. None of it has been built or measured. This change builds the thinnest slice that runs end to end for producers, developers, and agents. It tests whether packs improve agent output across models, whether repos adopt in minutes, and whether producers can publish verifiable packs from their own repos.

## What Changes

This change implements the items that the [scope table](../../scope.md#scope-by-priority) marks for the first change.

- **Packs.** A manifest declares a pack's owner, feedback channel, rules, skills, reference docs, agent commands, and check adapters. It can point to that content in a dependency instead of copying it. A pack can be its own npm package, live inside the library it governs, bundle other packs, or sit in a repo as local rules. The format is a public JSON Schema, so open-source producers can adopt it.
- **Composition and repo overrides.** `sync` assembles one rule set from a repo's packs and facts. A repo can declare facts, add local rules, ignore generated code, and record exceptions. It can't turn off a pack's rule, and exceptions to locked rules need the rule owner's approval.
- **Commands.** `init` sets up a repo in one command, for developers and for the platform's project template. `sync` regenerates agent files, and `resolve` returns the rules, skills, docs, and commands for specific files. `check` runs machine rules, and `feedback` sends a report to a rule's owner.
- **Agent contract.** Commands never prompt without a terminal, work offline once packs are installed, and return versioned JSON with exit codes 0 to 3. JSON output carries no absolute paths or source text. Any agent process that can run shell commands can use the SDK.
- **Agent adapters.** Committed entry points, such as a managed block in AGENTS.md, list every applicable rule and name the commands agents run. Rule detail, skills, and docs stay in their installed packages, and `sync` links to them. Claude Code and GitHub Copilot get their own entry points, and a repo chooses which tools get files.
- **Trust.** Consumers verify npm provenance, or a Sigstore-format signature where npm provenance isn't available, and every file's digest. The package manager's lockfile pins packs, and `check` writes a resolution record for audit. A signed enterprise trust policy lists approved producers, so adding one needs no SDK release.
- **Pluggable checks.** Adapters return SARIF results and run in a separate process that can read the repo but not change it. An adapter can wrap a producer's own analyzer, and every machine rule ships fixtures that prove its check.
- **Adoption modes.** Existing repos start in report mode, where CI lists violations without failing. `check --baseline --enforce` records existing violations and starts enforcing new ones.
- **Evals across models, with a publish gate.** Every rules pack runs its eval tasks with and without the pack on each required model. Evals measure whether tasks pass and whether agents use the APIs the pack points to. The build fails when the pack makes either measure worse on a required model.
- **Evals wherever producers work.** Evals run in the pipeline, and also locally with Claude Code or in VS Code with Copilot, through the developer's own access. Local results count toward the gate like pipeline results. A new VS Code extension runs Copilot's models, guides trials in Copilot's own agent mode, and hosts trial review.
- **Human feedback.** Reviewers judge eval trials without knowing which condition produced them. Developers' feedback reports become draft eval tasks. Both feed the next pack version.
- **Platform hooks.** The shared Jules pipeline runs `check` in repos that opt in, and it publishes packs through the eval gate. The platform's project template runs `init`, so new repos start conformant.
- **Reference repo.** A new producer repo publishes a Module Federation 2 (MF2) manifest adapter pack and a platform runtime reference pack. The reference pack includes a migration skill for Module Federation 1 (MF1) repos.
- **Salt.** A prototype wrapper pack points to Salt's knowledge, Skill, and CLI in place, and adds only the enterprise's rules. Salt can later generate its own manifest from its knowledge bundle.

## Capabilities

### New Capabilities

- `pack-format`: the public format, including rules, skills, reference docs, agent commands, check adapters, content referenced in dependencies, pack dependencies, and embedding
- `composition`: how `sync` collects packs and facts into one rule set, and the repo overrides it allows
- `producer-toolkit`: scaffolding, validating, building, and signing a pack for an npm registry
- `security-and-provenance`: the trust policy, provenance verification, file digests, pinning through the package manager, and hidden-character rejection
- `consumer-cli`: the `init`, `sync`, `resolve`, `check`, and `feedback` commands, the resolution record, and the guarantees agent processes rely on
- `checks`: the SARIF-based check adapter contract, and how `check` loads adapters from verified packs and isolates them
- `brownfield-adoption`: report and enforce modes, baselines, and shrink-only enforcement
- `agent-adapters`: target tools, committed entry points, content kept in its package, pack skills, and Claude Code and GitHub Copilot entry points
- `evals-and-telemetry`: eval trials across models in the pipeline or locally, API adoption, the publish gate, blind human review, and feedback that becomes eval tasks

### Modified Capabilities

None. The repo has no specs yet.

## Impact

- **This repo.** It gains the SDK's three packages, a VS Code extension, and the OpenSpec specs. It holds no packs.
- **Reference repo.** A new repo holds the adapter pack and the reference pack. The SDK team owns it until the runtime team takes it over.
- **Shared Jules pipeline.** The platform adds a step that runs `sync` and `check` after the build in repos with SDK configuration. It also adds a publishing flavor for packs that runs the eval gate. The SDK step pins its own Node.js version, 22.13 or later, so app builds keep theirs. See [design.md](./design.md#open-questions).
- **Platform project template.** It gains SDK setup, so new repos start with packs, configuration, and agent entry points.
- **Pilot repo.** It gains a `.de-web-sdk/` directory, managed entry points, a managed `.gitignore` block, and dev dependencies for the SDK and its packs. Its source files don't change.
- **App teams.** Each team owns its repo's local rules, ignored paths, and exceptions.
- **Salt team.** The wrapper prototype shows how Salt's knowledge, Skill, and CLI plug in unchanged. Their review decides whether Salt generates its own manifest.
- **Artifactory.** The SDK, the reference repo, and the enterprise trust policy each need an npm scope. Artifactory must also pass npm provenance through for the public packages it proxies. No new service is required.
- **Runtime team.** The reference pack's rules and version ranges are placeholders. The runtime team must confirm or replace them before any repo enforces them, and it approves exceptions to its locked rules.
- **Model access.** In the pipeline, evals need credentials and a token budget for each required model, and the eval profile configures enterprise-hosted endpoints. That isn't the only way to run them. Producers can also run evals locally, with Claude Code or in VS Code with Copilot, on their own access and quota. Those results count toward the gate. Evals therefore don't wait for enterprise endpoints.
- **VS Code extension distribution.** The extension ships as a VSIX file in Artifactory, which developers install with `code --install-extension`. The enterprise's VS Code policy must allow it.
- **Pack owners' time.** Owners review trials where people and graders disagree, and they triage feedback reports.
