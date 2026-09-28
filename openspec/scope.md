# de-web-sdk scope

**Status:** Draft for review, 2026-09-27

de-web-sdk should replace per-team publishing with one format, and per-repo interpretation with one check. Each organization that sets rules for client-facing web UI would publish them once. Repos and coding agents would apply those rules the same way and verify the result. The SDK would own the format, the composition logic, and delivery. Each organization would keep authority over its own rules.

Every OpenSpec change cites the sections here that it implements. The first change is [add-pack-format-v0](./changes/add-pack-format-v0/proposal.md).

## Standards reach neither developers nor agents in a usable form

Rules live wherever each organization put them: Confluence pages, READMEs, lint configs, chat messages, and review comments. Developers stitch them together by hand. Agents see only what lands in their context, so their code compiles and breaks standards anyway. Reviewers check conformance by hand, one pull request at a time. When an organization changes a rule, the teams that depend on it have no reliable way to find out.

## What the SDK provides

- **A contract.** A versioned specification for a *pack*, the unit an organization publishes. A pack holds rules, skills, reference docs, agent commands, contracts, checks, codemods, and evals. Every item carries an owner, a rationale, and applicability metadata. The name is provisional; see [open question 10](#open-questions).
- **A toolchain.** Producers author, validate, evaluate, sign, and publish packs. Consumers install, resolve, check, baseline, waive, and upgrade packs, and send feedback to pack owners.
- **Integrations.** The SDK converts resolved packs into the formats agents and tools already read, such as AGENTS.md, Agent Skills, agent plugins, Model Context Protocol (MCP) servers, lint configs, and continuous integration (CI) checks. No team should have to change agent vendors to adopt it.

A pack is the source a producer writes, not another plugin format. AGENTS.md blocks, installed skills, and plugins are build outputs that the SDK regenerates when a pack or an agent tool changes.

## Who publishes and who consumes

Producers are an open set. The SDK must treat them as data. Any organization becomes a producer by publishing a conforming pack. Adding, merging, or retiring a producer must not require an SDK release. Today's producers are analytics, content, the design language, the Salt design system kit, authentication, entitlements, the platform web runtime, and each line of business (LOB). Most LOBs both consume platform packs and publish their own.

Salt is building its own agent tooling on an unreleased branch. The SDK should wrap that tooling in place, not duplicate it. [Design decision D20](./changes/add-pack-format-v0/design.md#d20-salt-adopts-the-format-without-duplicating-its-own-tooling) describes how.

Consumers include app developers, interactive and autonomous coding agents, CI pipelines and reviewers, governance and audit, and project templates. They also include agent processes the SDK team hasn't seen. Those rely on a command-line contract with no prompts, offline operation, versioned JSON, and stable exit codes.

## Rules compose in layers of ownership

```
enterprise baseline   security, accessibility, legal
platform domains      runtime, auth, entitlements, analytics, content, design language, design kit
line of business      theme, brand, i18n choice, domain vocabulary
app team              team conventions, published as a team pack
repo                  local rules, declared facts, ignored generated code, exceptions
```

The specification fixes the precedence rules, not the layers, so an enterprise can add or merge layers. Composition must follow these rules:

1. A lower layer can tighten a rule or choose among options a higher layer allows.
2. Platform domains are peers. When two peer packs conflict, composition fails and names both owners. Installation order never decides a conflict.
3. A consumer sets a rule aside only through a recorded exception with an owner, a reason, and an expiry date. An exception to a `locked` rule also needs the rule owner's approval.
4. The repo layer can also declare facts, add local rules, and ignore generated or vendored code. Ignored paths never apply to locked rules.

## Design principles

Each principle targets a reason developers might route around the SDK.

| Principle | What it requires |
|---|---|
| Checks over prose | Every rule declares machine or advisory enforcement. Machine rules ship with a check. |
| Version-matched guidance | A pack versions in lockstep with the package it governs, or ships inside it. |
| One source, many formats | A producer writes a pack once. The SDK generates what each agent tool reads. |
| Minimal context per task | The always-loaded instruction file stays short. The resolver selects only the rules that apply, within a context budget. |
| Value before enforcement | A brownfield repo gets better agent output within 15 minutes of install, with no code changes and no new CI failures. |
| Self-explaining rules | Each violation names the rule, its owner, its rationale, a fix, and how to contest it. |
| Producer autonomy | Each organization publishes from its own repo on its own schedule. The SDK team reviews format conformance, not content. |
| Wrap, don't duplicate | When a producer already ships agent tooling, a pack points to it in place. |
| Measured value | Each rules pack ships evals that compare agent output with and without it on every required model. They measure task success and use of the APIs the pack points to. A pack that makes either worse must not publish. |
| No new infrastructure to start | The SDK runs on a package manager, git, and CI. Central services can add discovery and audit, but they're never a prerequisite. |
| Trusted by construction | Packs carry npm provenance or a Sigstore-format signature and come only from allowlisted sources. The package manager's lockfile pins them. |

## Brownfield repos adopt in stages

Installing the SDK must not fail a brownfield repo's build. Each repo moves through these stages at its own pace.

| Stage | What happens |
|---|---|
| Observe | `init` detects the stack, resolves packs, and generates agent context. CI lists violations without failing. |
| Baseline | `check --baseline` records existing violations. CI fails only on new ones. |
| Ratchet | CI confirms the baseline only shrinks. Codemods and agents fix old violations in small pull requests. |
| Enforce | Each rule becomes blocking once its baseline count reaches zero. |

A repo not yet on Module Federation 2 (MF2) can't meet a locked MF2 rule. It gets a time-boxed exception that the rule's owner approves, and still benefits from every other pack.

## A shared ontology connects the domains

Many tasks cross domains. A request to "add a gated feature card" draws on the design kit, entitlements, analytics, content, the LOB, and the runtime. The SDK should own a small core meta-model, with types such as Remote, Component, Token, Contract, Event, Rule, and Owner. Each domain adds instances and extends types in its own namespace. The resolver can then follow typed links from a task to each domain's rules. Tokens should use the Design Tokens Community Group (DTCG) format, and component catalogs should be generated from source.

## Cross-repo contracts need a publishing format

MF2 publishes remote types and a deployment manifest. It leaves lifecycle, events, error handling, and version negotiation between host and child undefined. The SDK should define how producers publish cross-repo contracts. A contract would include TypeScript types, JSON Schema for runtime payloads, and conformance tests that run in each consumer's CI. The runtime team would own the content of the host-to-child contract.

## Registry and governance functions are pluggable

A federated SDK needs discovery, adoption tracking, change notification, impact analysis, and audit. The SDK should define them as an interface and assume no backend. By default they run on systems the enterprise already has:

- Discovery through packs published to the enterprise registry
- Adoption tracking through each repo's lockfile and SDK configuration
- Change notification through upgrade pull requests from Renovate or Dependabot
- Impact analysis through source-code search
- Audit through a resolution record attached to each pull request

An enterprise catalog can take over any of these. The resolution record is the only default that requires new work. It lists pack versions, content digests, and exceptions, so anyone can verify which rules applied without a central service.

## Scope by priority

Must items are needed for the SDK to do its job. Should items matter but can follow, and could items wait for evidence that teams need them. The last column shows what the [first change](./changes/add-pack-format-v0/proposal.md) includes. A prototype is built against local fixtures and not published.

| Capability | Priority | First change |
|---|---|---|
| Pack format: a public schema for rules, skills, docs, commands, and adapters, including content referenced in dependencies | Must | Yes |
| Composition: pack sources, repo facts, applicability, exceptions, locked rules, and ignored paths | Must | Yes |
| Conflict detection and layered precedence between packs | Must | No |
| Ontology meta-model | Should | No |
| Producer toolkit: scaffold, validate, evaluate, review, sign, and publish | Must | Yes |
| Consumer CLI: `init`, `sync`, `resolve`, `check`, and `feedback` | Must | Yes |
| Consumer CLI: `upgrade`, `explain`, and `waive` | Should | No |
| Agent contract: no prompts, offline operation, versioned JSON, and exit codes 0 to 3 | Must | Yes |
| Agent adapters: committed entry points, linked skills and docs, and Claude Code and GitHub Copilot support | Must | Yes |
| Agent adapters: Agent Plugins and Claude Code plugin outputs | Should | No |
| Local MCP server that hosts tools from packs, including views of the running shell | Should | No |
| MCP servers that packs declare for agents, within enterprise policy | Could | No |
| Per-tool hooks, such as blocking edits until an agent loads a pack's skill | Could | No |
| Check adapters: a SARIF-based contract and isolated execution | Must | Yes |
| Check adapters: a lint plugin host and TypeScript contract types | Should | No |
| Cross-repo contract format: types, JSON Schema, and consumer conformance tests | Must | No |
| Adoption: report and enforce modes, baselines, and shrink-only enforcement | Must | Yes |
| Codemod runner | Should | No |
| Supply-chain controls: npm provenance or Sigstore-format signatures, digests, hidden-character checks, source allowlists, and an enterprise trust policy | Must | Yes |
| Resolution record for each build, including exceptions | Must | Yes |
| Registry interface: discovery, adoption tracking, change notification, and impact analysis | Should | No |
| Evals: model matrix, API adoption, publish gate, human review, and feedback, in the pipeline or locally | Must | Yes |
| VS Code extension for local evals with Copilot's models, guided Copilot trials, and review | Must | Yes |
| Setup hooks for the platform's project template and shared CI pipeline | Must | Yes |
| Reference packs for the platform runtime, with an adapter pack and a migration skill | Must | Yes |
| Salt pack that wraps Salt's knowledge, Skill, CLI, and analyzer until Salt publishes its own | Must | Prototype |
| OpenSpec schema and generated configuration for consumer repos | Should | No |

### Out of scope

- Building or changing the design system, runtime, authentication, entitlements, analytics, or content platforms
- Building an enterprise service catalog, developer portal, or approval workflow system
- Choosing or mandating an agent vendor
- Defining new agent instruction, skill, or plugin formats
- Mobile and native apps (assumption)
- Runtime generative UI, where agents compose UI for clients at run time (assumption; see open question 1)

## Scenarios the scope must satisfy

Each scenario is an end-to-end test. If the SDK can't support one, the scope is incomplete.

- **Cross-domain feature.** An agent adds a gated feature card to a brownfield LOB app. Its first attempt passes all checks.
- **Deprecation.** The design kit deprecates a component and ships a codemod. Agents stop suggesting it, and the producer sees how many repos have migrated.
- **Contract change.** The runtime publishes v3 of the host-to-child contract. Each remote's CI reports compatibility before the host ships.
- **New LOB.** A new LOB publishes a theme and i18n pack that extends the platform packs. Its app teams inherit both with one install.
- **New producer.** An organization not listed today publishes its first pack. Consumer repos resolve it on their next upgrade, with no SDK release.
- **Brownfield onboarding.** A five-year-old repo records its existing violations as a baseline. It adds no new ones, and the count falls each month.
- **Audit.** The resolution record on an agent's pull request shows which rules applied and who approved each exception.
- **New project.** A remote created from the platform template follows the rules from its first agent session. CI blocks violations from the first pull request.
- **Repo override.** A remote adds a local rule and ignores its generated code. `check` skips the generated files except for locked rules.
- **Migration.** An agent migrates a Module Federation 1 (MF1) remote with the runtime pack's migration skill. `check` then confirms a valid MF2 manifest.
- **Salt release.** Repos that upgrade Salt get its version-matched Skill, guides, and commands on their next `sync`, with nothing copied into the repo.
- **Unknown agent process.** An agent process the SDK team has never seen learns the commands from AGENTS.md and treats `check` as its acceptance gate.
- **Field feedback.** A reviewer's dispute reaches the pack owner and becomes an eval task. The next version's eval shows whether the fix worked.
- **Harmful pack.** A pack change lowers a required model's pass rate or API adoption below the no-pack result. Signing fails until the owner fixes it or records an override.

## Success measures to test in a pilot

These targets are hypotheses. A pilot should confirm or replace them.

| Measure | Target |
|---|---|
| Install to useful agent context in a brownfield repo | Under 15 minutes, with no code changes |
| Agent pull requests that pass checks without human fixes | A measurable gain over a no-pack baseline |
| Agents' use of platform APIs | A measurable gain in eval API adoption over a no-pack baseline, confirmed on sampled pilot pull requests |
| Producer change to agent use | Next session for advisory changes; an upgrade pull request within one day for breaking changes |
| Brownfield baseline trend | Falls every month in adopting repos |
| Exceptions | Every exception has an owner and expiry; count and median age are reported |
| Producer effort to publish a new checkable rule | Under one day, with no SDK team involvement |
| UI consistency | A rising share of UI built from kit components and tokens |
| Developer sentiment and feedback turnaround | Opt-out rate, survey score, and time from report to fix, tracked from the first pilot |

## Risks that would make the SDK an obstacle

| Risk | Mitigation |
|---|---|
| Rule bloat: context overflows and guidance contradicts itself | Applicability scoping, context budgets, conflict detection at compose time, and eval gates on publish |
| Governance theater: prose rules that nobody checks | A declared enforcement mode on every rule, and a reported machine-to-advisory ratio per pack |
| Central bottleneck: the SDK team gates every rule change | Self-service publishing validated against the schema, with the SDK team owning only the format |
| Brownfield revolt: CI goes red on day one, and teams disable the SDK | Report mode at install, baselines, recorded exceptions, and new-code-only enforcement |
| Federation drift: one remote relaxes a shared rule and breaks the shell | Locked rules, owner-approved exceptions, and no way to turn off a pack's rule |
| Agent tool churn: vendors change formats faster than packs can follow | All agent formats generated from one source, built on open standards |
| Duplicate tooling: the SDK restates what a producer such as Salt ships | Packs point to producers' own tooling in place, and `sync` skips skills the producer already installed |
| Version skew: remotes and hosts run different contract versions | Semantic versioning, contract conformance tests in CI, and automated upgrade pull requests |
| Supply-chain and prompt-injection attacks: a compromised pack instructs agents to do harm | Signed packs, content digests, sanitization, pinned versions, allowlisted sources, and a private registry |
| Infrastructure dependency: adoption stalls while a central service is built | A default implementation that needs only a package registry, git, and CI |
| Eval theater: evals pass but don't reflect real use | Enterprise-set required models, API adoption beside pass rates, field feedback turned into eval tasks, and human review of grader disagreements |

## Open questions

Questions 1 through 4 change the scope most.

1. Is the SDK only for agents that build UI, or also for agents that compose UI for clients at run time?
2. Can platform and design system teams require blocking CI checks in LOB repos, or does each LOB opt in? *Partial answer, 2026-09-27:* the platform owns a shared Jules pipeline, so it could require the check. The first change makes the step opt-in.
3. Which coding agents are approved, and do restrictions apply, such as a ban on external MCP servers? *Partial answer, 2026-09-27:* the first adapters target Claude Code and GitHub Copilot. GitHub Copilot's CLI isn't supported. Other restrictions are unknown.
4. Which enterprise systems must the SDK integrate with rather than duplicate? *Partial answer, 2026-09-27:* packages and VSIX files ship through JFrog Artifactory, and CI runs on Jules. A developer portal, service catalog, and dependency-update bot are unknown.
5. Which React versions, MF2 bundlers, and TypeScript configurations must the SDK support? *Partial answer, 2026-09-27:* the pilot repo uses Vite with MF2. MF1 repos use webpack.
6. How many brownfield repos exist, how far are they from MF2, and are any not on React? *Partial answer, 2026-09-27:* some repos still use MF1. Counts are unknown.
7. Is the design language a separate product from the React kit? *Partial answer, 2026-09-27:* Salt ships its themes and React components from one repo with one owner team. Whether the enterprise's design language has a separate owner is open, and the answer decides what the Salt pack covers.
8. Does the host-to-child TypeScript contract already exist, or does its definition depend on this work?
9. Which team owns the SDK, and what capacity does it have?
10. Is "pack" the right term, or does the enterprise already have a word for this unit?
11. Which enterprise-hosted models and endpoints should pack evals use, and who maintains the eval profile? *Partial answer, 2026-09-27:* evals don't wait for these endpoints. They also run locally, and local results count toward the gate.
12. Who publishes the enterprise trust policy: the platform team or a security team?
13. Will the Salt team publish their tooling as a pack, generated from their knowledge bundle? Until they do, who owns the enterprise's Salt wrapper pack?
