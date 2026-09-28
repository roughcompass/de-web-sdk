# Design: add-pack-format-v0

## Context

See [proposal.md](./proposal.md) for motivation, and its Impact section for the repos and systems this change touches. The implementation lives in the repo's `packages/` directory, and tasks.md marks what has been verified. The industry sources cited below come from a web research pass on 2026-09-27, and nobody has verified them independently.

These constraints decide the design:

- Packages ship through JFrog Artifactory.
- A shared, platform-owned Jules pipeline builds every repo, and a platform-owned template creates new remotes.
- The pilot repo builds with Vite and Module Federation 2 (MF2). Other repos still build with webpack and Module Federation 1 (MF1).
- The first agent targets are Claude Code and GitHub Copilot. GitHub Copilot's CLI isn't supported in the enterprise.
- Evals must run locally, in Claude Code or in VS Code with Copilot, as well as in the pipeline.
- The enterprise's agent development process is unknown.
- Salt, the design system, is building its own agent tooling on an unreleased branch. The SDK must wrap it, not duplicate it.

## Goals / Non-Goals

**Goals:**

- A developer sets up an existing repo with one command, and agents improve before anything is enforced.
- A new repo from the platform template follows the rules from its first commit.
- A repo adapts the rules to its own code without forking a pack or silently relaxing a rule.
- Any agent process that can run shell commands can use the SDK without SDK changes.
- Every rules pack is evaluated on every required model before it publishes, for task success and API use. Human judgment feeds its next version.
- A producer can ship a new kind of check or skill from its own repo without an SDK release.
- Salt can adopt the format by generating a manifest from its own knowledge, and the enterprise can wrap Salt's tooling before then.
- `init` runs safely in an MF1 repo, and its agents get MF1-appropriate guidance and the migration skill.

**Non-Goals:**

- Conflict detection and layered precedence between packs, including a repo changing a pack rule's options.
- The `upgrade`, `explain`, and `waive` commands. Teams record exceptions in the configuration file.
- Tools that packs add to the SDK's MCP server, MCP servers that packs declare for agents, plugins, and hooks. The [scope table](../../scope.md#scope-by-priority) ranks each as should or could.
- The lint plugin host and the cross-repo contract format.
- A registry interface beyond the resolution record.
- Pluggable stack detection. Rules can depend on any installed package's version, but the bundler, Module Federation generation, and role are built in.
- Several applications in one repo. The SDK evaluates the root package and reports other workspace packages as not evaluated, rather than guessing.
- Adapter permissions beyond reading the repo.
- A `create` command. The platform template creates new repos.
- Requiring outside producers, such as Salt, to use this SDK's toolkit, signing, or eval runner.
- Driving GitHub Copilot's CLI in evals, because it isn't supported.
- Fully automating Copilot's own agent mode. Guided trials need a developer to mark each one finished.
- MF1 checks beyond the migration rule, and Rspack checks beyond detection.

## Decisions

### D1. The SDK is written in TypeScript and distributed as npm packages

Consumer repos already run Node.js for their builds, so the SDK adds no new runtime. Artifactory, npm lockfiles, and dependency-update bots already handle npm distribution and upgrades. The SDK supports Node.js 22.22.2, 24.15, and 26 or later in those release lines, the range its Sigstore libraries declare, and refuses to run before 22.13, for the reason in D4. It declares that range in `engines`, so npm warns at install on other versions. Salt's knowledge and CLI packages also require Node.js 22 or later. The shared pipeline's SDK step pins its version, so app builds on older Node.js aren't affected.

*Rejected:* pinning Sigstore's older major to keep 22.13 supported. Signature verification is the SDK's security boundary, and it should stay on the release line that gets fixes. The newer floor is the latest release in each supported Node.js line, which updates reach without a major upgrade.

*Rejected:* a single Go or Rust binary. It starts faster and needs no Node.js, but it needs a second distribution channel and loses npm lockfile pinning.

### D2. The SDK repo splits deliverables by user

The repo splits deliverables only where a separate user or release schedule exists.

| Package | Users | Contents |
|---|---|---|
| Core library | Both CLIs, adapter code, and Node.js-based agent processes | Pack format and validation, provenance verification, composition, the adapter contract and runner, and baseline logic |
| Consumer CLI, `de-web-sdk` | Consumer repos, the project template, the pipeline, and agents | The `init`, `sync`, `resolve`, `check`, `skill`, and `feedback` commands, the local MCP server (`mcp`), feedback adapters that need an MCP client, agent file generation, and report formats |
| Producer toolkit, `de-web-sdk-pack` | Producer repos | The `new`, `validate`, `build`, `sign`, `eval`, and `feedback` commands |
| VS Code extension | Producers and reviewers who work in VS Code | The VS Code eval driver, guided Copilot trials, and trial review in the diff editor |

Keeping producer code out of the consumer CLI keeps signing and eval dependencies out of every consumer's CI. The extension is the only way to reach Copilot's models without Copilot's CLI, because VS Code offers those models only to extensions. It ships as a VSIX file in Artifactory, and developers install it with `code --install-extension`. VSIX installs don't update themselves, so the producer toolkit checks the extension's version and names the VSIX to install when they don't match. Adapter code depends only on the core library, for the contract types. The eval runner calls the consumer CLI, so evals exercise the same commands consumers run. Package scopes wait on Artifactory, as noted in Open Questions, so the implementation uses the placeholder scope `@de-web-sdk`.

*Rejected:* one package. Every consumer's CI would install signing and eval code, and adapter code would depend on a CLI.

*Rejected:* one package per capability. Most capabilities have no separate user, so the split would add release coordination with no benefit.

### D3. Packs come in five kinds that share one public format

| Kind | Where it lives | Contains | Provenance |
|---|---|---|---|
| Standalone pack | Its own npm package | Rules, skills, docs, commands, and adapters, or references to them in dependencies | npm provenance or a signature |
| Embedded pack | A directory inside the library it governs | The same, for that library | The library's provenance |
| Bundle | Its own npm package | Only dependencies on other packs | npm provenance or a signature |
| Adapter pack | Its own npm package | Only adapters | npm provenance or a signature |
| Local pack | `.de-web-sdk/local/` in the consumer repo | The repo's own rules, skills, and adapters | None, because the repo's pull requests review it |

Every pack has `pack.json`, which references the format's JSON Schema at a stable public URL. A pack can carry rules with their guidance, skills in the Agent Skills format, reference docs, agent commands, and adapters. It can also point to those items in a package it depends on, including a peer dependency, instead of copying them. A standalone pack that mostly points into another package is a wrapper. A rules pack's evals stay in its source repo, and the manifest carries their summary. Digests use the `sha256:<hex>` form, as Salt's knowledge bundle does. The local pack references a variant of the schema that requires no identifier or version.

A library embeds a pack by naming its directory in its `package.json`. The field is named for the format, `agentPack` until [open question 10](../../scope.md#open-questions) settles the name, so an open-source library carries no enterprise branding. Installing the library installs its rules, and the rules always match the installed version. A bundle suits packs that don't track a library's version. Rule references in configuration and output use `<pack>#<rule>`, and local rules use `local#<rule>`.

Within a major specification version, consumers ignore manifest fields they don't recognize. Later minor versions can add fields, such as tools for a local MCP server, without breaking older SDKs. Conditions are the exception: an item whose condition uses a fact the consumer doesn't know is excluded, and `sync` names the fact. Ignoring the condition instead would apply the item too broadly.

*Rejected:* a format named for this SDK. Outside producers such as Salt would have to ship enterprise branding in public packages, which they have good reason to refuse.

*Rejected:* OCI artifacts in Artifactory. They suit signing tools such as cosign, but consumer repos don't resolve OCI artifacts today. Dependency-update bots would also need new configuration.

*Rejected:* standalone packs only. A bundle can't know which library version a repo runs, so version-matched guidance would need every repo to pin pack versions by hand.

### D4. Check adapters ship in packs and run in an isolated process

The core library defines the adapter contract. A pack declares each adapter by name and points it to a JavaScript module in `adapters/`. A machine rule names its adapter by pack and adapter name, and leaves out the pack when the adapter is in its own pack. A rule can use another pack's adapter only if its own pack lists that pack as an npm dependency.

Adapters return SARIF 2.1.0 results, with partial fingerprints as stable keys. SARIF is the common format for analyzer results, and Salt's analyzer already renders it. An adapter can call a producer's own analyzer through its Node.js API, such as Salt's `analyzeSaltArtifacts`, instead of reimplementing it. Every machine rule ships positive and negative fixtures, and `validate` runs the check on them.

An adapter's default export receives the repo root, the repo's facts, the rule's options, the files the rule covers, and read-only file helpers. It returns SARIF results, a whole SARIF log, or an error when it can't evaluate the rule. The context includes the core library's `result()` helper, which stores the adapter's fingerprint as a partial fingerprint, so an adapter needs no dependency on the SDK.

`check` starts one Node.js child process per adapter run, with the permission model enabled. The process can read the repo, the SDK's installed files, the adapter's package, and every `node_modules` folder that Node.js would search from that package. It can also read the real locations of symlinked packages in those folders, because Node.js checks a symlinked package at its real path. An adapter can therefore import its own dependencies in two awkward cases. The repo may be a producer's fixture elsewhere on disk, or a trial worktree whose packages link into the producer's repo. The reference repo's adapter pack found both cases, because it imports `semver`. It gets no permission to write files, start processes, or create worker threads. Results come back on standard output. Each run has a time limit of 60 seconds by default.

The isolation guards against adapter mistakes. It is not a security boundary. Node.js calls its permission model a "seat belt" that "does not protect against malicious code," and the model doesn't restrict network access ([Node.js permissions](https://nodejs.org/docs/latest-v24.x/api/permissions.html)). Provenance verification in D5 is the security boundary. The permission model is stable from Node.js 22.13, so the CLI refuses to run on anything older.

*Rejected:* a result format of the SDK's own. Every producer that already emits SARIF would need a conversion step.

*Rejected:* built-in adapters only. Every new kind of check would need an SDK release, which breaks the [producer autonomy](../../scope.md#design-principles) principle.

*Rejected:* loading adapters in the `check` process. A crash or hang in one adapter would stop the whole run, and nothing would guard against writes.

*Rejected:* a WebAssembly sandbox. It isolates more strongly, but adapter authors would need a separate build toolchain. Revisit it if producers outside the platform teams start publishing adapters.

### D5. Provenance comes from npm where it can, and from Sigstore-format signatures elsewhere

Public packages published from CI with npm trusted publishing carry npm provenance, a Sigstore attestation that names the source repository and workflow. Salt's knowledge and CLI packages already set `provenance: true`. The SDK verifies that provenance against the identity that the trust policy lists for the scope, so an open-source producer needs no SDK signing step. Task 1.8 confirms that Artifactory passes provenance attestations through for the public packages it proxies.

Internal packs publish from Jules to Artifactory, where npm provenance isn't available. For them, the producer toolkit signs the built manifest with the producer's key and writes the signature in the Sigstore bundle format. Standard Sigstore tools can verify it, and the SDK verifies both kinds through one library. The manifest carries a SHA-256 digest for every published file, so one attestation or signature covers the whole pack, including skills and adapter code. `build` writes the digests into the source `pack.json`, so `sign` signs what `build` checked. After an edit, `validate` warns and `sign` refuses until the next build, because consumers would reject the stale digests. `keygen` writes the private key readable only by its owner and won't replace an existing one. It also warns when git would commit the key, and new packs ignore `keys/`. This matches the per-file digest model of the MCP Skills extension ([overview](https://modelcontextprotocol.io/extensions/skills/overview)).

The enterprise trust policy is a signed package that maps producer scopes to provenance identities or keys. Root public keys built into the consumer CLI verify it. A repo's `trust.json` extends it and can add scopes, such as a line of business (LOB) scope. Adding a producer or rotating a key means publishing a new trust policy version, which reaches repos as an ordinary dependency update. Rotating a root key needs an SDK release. The policy lists npm scopes, so an unscoped package can't be trusted.

npm serves provenance attestations from the registry, not inside the package. `sync` therefore fetches each version's attestation once, while the registry is reachable, and caches it in `.de-web-sdk/cache/`, which git ignores. Verification then runs offline against the Sigstore trusted root. The SDK ships Sigstore's public trusted root, and the enterprise trust policy can carry a newer one. The attestation names the tarball's SHA-512 digest, which the SDK compares with the integrity in the repo's lockfile. Yarn Berry's lockfile records no such digest, so for Yarn Berry the SDK matches the package name and version and warns.

Some packages can't carry either proof: a build that an enterprise vendors or proxies without attestations, or a producer's unreleased build. A pack can sign its own manifest, but an ordinary package that a pack references has no manifest to sign. So a trust policy scope can also pin exact versions by tarball integrity, `"integrity": { "@salt-ds/knowledge@0.0.0": "sha512-..." }`. The SDK accepts that version only when the lockfile records the same integrity, and the package manager checked it at install. The Salt prototype found this gap, because Salt's unreleased build has no provenance yet.

*Rejected:* signing a referenced package's tarball digest with the enterprise's key. It needs a signature file shipped beside the package, and a pin in the signed enterprise policy gives the same assurance.

*Rejected:* a custom signature format. The first draft signed a canonical manifest with a bespoke detached signature. Sigstore bundles do the same job, and tools outside the SDK can verify them.

*Rejected:* per-repo key lists only. Every repo would copy keys by hand, and rotating one key would touch every repo.

*Rejected:* fetching attestations on every run. `resolve` and `check` would then need the network, and sandboxed agents often have none.

*Rejected:* Sigstore keyless signing for internal packs. It needs an OpenID Connect identity for Jules and access to Fulcio and Rekor, public or self-hosted. Revisit it if the enterprise runs a private Sigstore instance.

### D6. The package manager pins packs, and `check` records what applied

The repo's lockfile already pins each pack's version and integrity, and the package manager verifies that integrity at install. The SDK doesn't keep a second lock file. `check` verifies provenance and file digests on every run, and it can write a resolution record. The record lists each collected pack's identifier, version, and manifest digest, the repo's facts, active exceptions and ignored paths, and the results. The pipeline stores it with each build, which makes it the resolution record described in the scope's [registry section](../../scope.md#registry-and-governance-functions-are-pluggable).

*Rejected:* an SDK lock file. The first draft kept one, and every dependency update then failed CI until someone ran `sync` and committed it. It duplicated what the package manager's lockfile and provenance already guarantee.

### D7. Setup is one command, and daily commands never prompt

| Command | Who runs it | What it does |
|---|---|---|
| `init` | Developers and the project template, once | Creates configuration and the trust policy, adds named packs, records declared facts, then runs `sync` |
| `sync` | Developers, agents, and the pipeline, after installs | Verifies packs, assembles the rule set, and regenerates agent files |
| `resolve` | Agents, before editing | Returns the rules, skills, docs, and commands for given files, as Markdown or JSON |
| `check` | Agents, developers, and the pipeline | Runs machine rules, explains each violation, and writes the resolution record on request. Given files, it counts only violations in them |
| `skill` | Agents without MCP | Prints a skill, or one of its files, from its verified pack |
| `feedback` | Developers, or agents on their behalf | Creates a report for a rule's owner, and sends it through the pack's feedback adapter after the developer approves |
| `mcp` | Claude Code and VS Code, through `.mcp.json` | Runs the local MCP server (D21) |

`init` adds packs with the package manager that the repo's lockfile shows: npm, pnpm, or Yarn. Consumers add `@de-web-sdk/cli` as a dev dependency before running `init`. The lockfile then pins the CLI, and the `.mcp.json` entry can start it from `node_modules`. `sync` warns when the CLI isn't installed. Producers run `new` through `npx -p @de-web-sdk/pack`, the one command that runs before the toolkit is installed. Every command accepts `--yes` and never prompts without a terminal. Setting `DE_WEB_SDK_FORMAT=json` switches every command to JSON output, so an agent process can configure it once.

*Rejected:* one `init` command that also regenerates. Developers expect `init` to run once, and dependency-update pull requests need a command that never installs anything.

*Rejected:* installing packs in `sync`. Dependency changes stay explicit and reviewable.

*Rejected:* having `init` install the CLI. `init` usually runs from a copy that npx fetched, so it would pin whatever version that was, without the developer choosing it. The guides' earlier first command, `npx de-web-sdk init`, also asked npx for an unscoped package that nobody publishes, which anyone could later claim.

### D8. One contract serves every agent process, through the CLI and a local MCP server

The enterprise's agent process is unknown, so the SDK offers one contract that any process can rely on. The CLI is its baseline, and the local MCP server (D21) gives the same results to agents that support MCP. The command-line surface follows a write-up of DHH's Rails World 2026 keynote. In the write-up's words, "any serious app needs a command-line surface for that agent to drive" ([write-up](https://sublimecoding.com/blog/dhh-rails-world-2026-keynote)). It also matches the conventions of Salt's CLI: offline, deterministic, bounded output, and exit codes 0 to 3.

The SDK guarantees:

- No prompts without a terminal, and failures that name the missing flag
- Offline operation for `sync`, `resolve`, and `check` once packs are installed and their npm provenance attestations are cached
- A schema version in all JSON output, with field changes only in a new major version, and a published JSON Schema for each command's output
- Exit codes 0 to 3, as the consumer-cli spec defines
- JSON output without absolute paths or source text, and text output that quotes repo values as data
- `resolve` output within a 16 KiB budget, with every omission named
- Committed entry points that list every applicable rule and skill, for agents that don't install dependencies
- The same rules, checks, skills, and feedback through the CLI and the MCP server
- The agent commands that packs declare, such as `salt-ds context`, listed where agents look

The agent process must:

- Work in a checkout with dependencies installed, or reach Artifactory to install them
- Run shell commands with a Node.js version the SDK supports (D1)
- Load AGENTS.md or its tool's instruction files, or be configured to call `resolve` and `check`
- Build the repo before `check` when a rule reads build output, and treat exit code 0 as done

Node.js-based processes can call the core library instead of the CLI.

*Rejected:* MCP as the only agent interface. CI has no MCP host, not every agent process supports MCP, and enterprise policy can block workspace MCP servers. The CLI therefore stays the baseline, and AGENTS.md names the CLI command beside each MCP tool.

### D9. Repo files live in one directory

| Path | Written by | Committed | Holds |
|---|---|---|---|
| `.de-web-sdk/config.json` | People and `init` | Yes | Mode, declared facts, target tools, exceptions, ignored paths, and options |
| `.de-web-sdk/trust.json` | People and `init` | Yes | Trusted scopes and identities, and the enterprise trust policy it extends |
| `.de-web-sdk/local/` | People | Yes | The local pack |
| `.de-web-sdk/baseline.json` | `check --baseline` | Yes | Existing violations |
| `.de-web-sdk/context/` | `sync` | No | A generated index of rule detail, skills, and docs in `node_modules` |
| `.de-web-sdk/cache/` | `sync` | No | Cached npm provenance attestations |
| `.mcp.json` entry `de-web-sdk` | `sync` | Yes | The SDK's MCP server, which Claude Code and VS Code start. `sync` keeps other servers in the file |

A committed `config.json` opts the repo into the shared pipeline's `check` step. Teams can protect `trust.json` with a code-owners rule. `sync` keeps every generated path in a managed block of `.gitignore`.

*Rejected:* files at the repo root. They'd crowd every repo's root, and code-owners rules would be harder to target.

### D10. Composition assembles one rule set, and repos adapt it within limits

`sync` collects the repo's direct dependencies that are packs, the packs embedded in them, every pack that a collected pack depends on, and the local pack. It doesn't collect packs embedded deeper in the dependency tree, so an indirect dependency can't add rules without the repo choosing it.

| Override | Use it for | Limit |
|---|---|---|
| Declared facts | A new repo, or a migration, where detection gives the wrong answer | `sync` reports every disagreement with detection |
| Local rules | The repo's own conventions, such as which API client to use | They apply only to the repo, and they need no provenance or evals |
| Ignored paths | Generated or vendored code | Each needs a reason, `check` reports the count, and locked rules still apply |
| Exceptions | A rule the team can't meet yet | Each needs an owner, a reason, and an expiry date, and a locked rule's exception also needs the owner's approval. An expired exception is a configuration error |

A repo can't turn off a pack's rule or change its options. Packs mark federation-critical rules as locked, so no remote drifts from the shell without the rule owner's approval. The runtime reference pack locks its MF2 manifest and React singleton rules.

*Rejected:* ESLint-style overrides that turn rules off or change their options. In a federation, one remote that quietly relaxes a shared rule can break the shell for every remote. Exceptions keep each relaxation visible, owned, and temporary.

*Rejected:* no local rules. Teams would keep conventions in hand-written AGENTS.md text, which `resolve` can't return, `check` can't enforce, and Copilot's path-scoped files don't carry.

*Rejected:* detection only. It gives an empty repo no rules and a migrating repo the wrong ones.

### D11. Stack detection reads files and never runs repo code

- **Versions** are the exact installed versions that the lockfile and installed packages show, as Salt's resolver reads them. `sync` reports layouts it can't read, such as Yarn Plug'n'Play or Bun, and never runs a Plug'n'Play loader.
- **Bundler** comes from dependencies and config file names: `vite.config.*`, `webpack.config.*`, or `rspack.config.*`.
- **MF2** is detected when an MF2 bundler plugin is installed, such as `@module-federation/vite` or `@module-federation/enhanced`.
- **MF1** is detected when a webpack config references `ModuleFederationPlugin` and no MF2 plugin is installed.
- **Role** comes from `exposes` and `remotes` in the MF2 build manifest when one exists. Otherwise it comes from the config text. Failing both, it's unknown unless the repo declares it.

*Rejected:* loading the bundler config. It's more accurate, but it runs repo code during `sync`, which can have side effects and slows the first run.

### D12. Committed entry points point to content that stays in its package

- **Target tools.** `config.json` names the target tools, and every supported tool is the default. `sync` removes files it generated for a tool the repo drops.
- **Committed.** One block in AGENTS.md, delimited by `<!-- de-web-sdk:begin -->` and `<!-- de-web-sdk:end -->`, and one server entry in `.mcp.json`. The block lists each applicable rule with a one-line summary and any path patterns, and each applicable skill with its description. It also names the SDK's MCP tools with the equivalent CLI commands, and the agent commands that packs declare. Its commands use `npx --no`, because `npx` without a terminal would otherwise install whatever registry package is named `de-web-sdk`. Pack commands get the same prefix, because installed binaries sit in `node_modules/.bin`, which isn't on an agent's PATH. The publish walkthrough in task 3.9 found this: the bare command failed in an agent's shell. It points to detail rather than copying it, so review bots that don't install dependencies still see every rule. AGENTS.md is the cross-agent format that Claude Code and VS Code's Copilot both document ([Claude Code memory](https://code.claude.com/docs/en/memory), [VS Code custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)).
- **Served, not installed.** Rule detail, skills, and reference docs stay in `node_modules`, as Next.js does with its docs and Salt does with its Skill. `sync` installs no skill files, because developers can edit files on their machines. Agents load skills through the MCP server or the `skill` command, which verify each file against its pack's digest as they serve it. `sync` removes skill files that earlier versions generated.
- **Claude Code** reads AGENTS.md from version 2.1.277, but only when the repo has no CLAUDE.md. `sync` therefore creates no CLAUDE.md, and adds an `@AGENTS.md` import in a managed block to an existing CLAUDE.md that lacks one. Claude Code starts the servers in a project's `.mcp.json` after the developer approves them once ([Claude Code MCP](https://code.claude.com/docs/en/mcp)).
- **GitHub Copilot** reads AGENTS.md in VS Code chat, the cloud agent, and code review ([support matrix](https://docs.github.com/en/copilot/reference/custom-instructions-support)). `sync` writes no Copilot-only instruction files. Path-scoped rules appear in the AGENTS.md block with their patterns, and `resolve` scopes them to files. Visual Studio chat and JetBrains chat read only `.github/copilot-instructions.md`, so task 1.2 confirms which surfaces the enterprise uses.
- **MCP configuration.** VS Code reads a repo-root `.mcp.json` as well as `.vscode/mcp.json`, and starts workspace servers in trusted folders ([VS Code MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)). The entry runs `node` on the installed CLI, which works on every platform and never fetches a package. A repo can set `mcpServer` to false in `config.json`, and `sync` then removes the entry.
- **Where the tools load files.** Task 1.2 checked the documentation on 2026-09-27, and tested VS Code 1.139.1.

  | Tool | Instructions | MCP servers | Source |
  |---|---|---|---|
  | Claude Code 2.1.277 and later | AGENTS.md when the repo has no CLAUDE.md; otherwise CLAUDE.md and what it imports | Repo-root `.mcp.json`, after a one-time approval | [Memory](https://code.claude.com/docs/en/memory), [MCP](https://code.claude.com/docs/en/mcp) |
  | Claude Code before 2.1.277 | CLAUDE.md only, so it needs the `@AGENTS.md` import | Repo-root `.mcp.json` | [Memory](https://code.claude.com/docs/en/memory) |
  | VS Code chat | AGENTS.md, `.github/copilot-instructions.md`, and `.github/instructions/*.instructions.md` | Repo-root `.mcp.json` and `.vscode/mcp.json`, in trusted folders | [Custom instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions), [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers) |
  | Copilot cloud agent and code review | AGENTS.md and `.github/copilot-instructions.md` | Configured in the repository's settings on GitHub | [Support matrix](https://docs.github.com/en/copilot/reference/custom-instructions-support) |
  | Visual Studio and JetBrains chat | `.github/copilot-instructions.md` only | Per product | [Support matrix](https://docs.github.com/en/copilot/reference/custom-instructions-support) |

- **Stale entry points.** When a dependency update changes the rule list, `check` evaluates the new rules and warns that the entry points need `sync`. It doesn't fail, so dependency-update pull requests pass.
- **Other tools' skills.** Skills that other tooling installed, such as Salt's `salt-design-system` Skill, stay as they are.
- **Notices.** Generated Markdown files carry the generator notice. JSON can't hold a comment, so `.mcp.json` carries none, and `sync` touches only its own entry.

*Rejected:* a separate entry point per tool, such as a CLAUDE.md import in every repo and Copilot's path-scoped instruction files. Both tools read AGENTS.md, so extra files would repeat its rules and could drift from it.

*Rejected:* installing skills in each tool's skill folder, as pointer files or links. Developers can edit files on their machines, so what agents load could drift from the verified pack. Serving skills through the SDK costs native skill activation until the hosts support MCP's Skills extension (D21).

*Rejected:* committing generated copies. The first draft copied rule detail and skills into `.de-web-sdk/context/`. Salt's knowledge package alone unpacks to about 25 MB, so copies would bloat every repo and change on every release.

*Rejected for now:* plugins. Agent Plugins 1.0 bundles skills and MCP configuration, but hooks, commands, and rules aren't portable between tools yet ([specification](https://github.com/agentplugins/agent-plugins-spec)).

### D13. Packs ship skills for multi-step work

Rules say what to do. Skills carry workflows, such as migrating a remote to MF2 or adding analytics tracking to a flow. A pack's skills use the Agent Skills format and declare applicability like rules. The AGENTS.md block lists the applicable ones under names that start with the pack's scope and name. Agents load them through the MCP server's `get_skill` tool or the `skill` command. The MCP server also offers each skill as a prompt, and the SDK's check-and-fix workflow as a prompt. The runtime reference pack ships an MF1-to-MF2 migration skill that only MF1 repos receive.

This follows libraries that already ship skills in their packages. TanStack Intent places skills inside npm packages ([docs](https://tanstack.com/intent/latest)), and Rails Hyperdrive installs the skills that gems in a bundle ship ([post](https://evilmartians.com/chronicles/rails-hyperdrive-supercharged-agentic-development-for-rails)). Salt ships its `salt-design-system` Skill the same way. A skill can also serve as a producer's setup wizard, as PostHog's wizard does for its SDK ([repo](https://github.com/PostHog/wizard)). Evals run with a pack's skills installed, so the gate covers them.

*Rejected:* workflows written only by the SDK team. The SDK team would become the central bottleneck that the scope lists among its [risks](../../scope.md#risks-that-would-make-the-sdk-an-obstacle).

*Rejected for now:* blocking agent edits until a skill loads, as TanStack Intent can. It needs per-tool hooks, which this change leaves out.

### D14. Adoption runs in modes, with a stable-key baseline

- **Modes.** `config.json` sets report or enforce mode. `init` chooses report mode for an existing repo, so the pipeline shows violations without failing. Report mode still exits with 2 on a configuration error and 3 on a trust or integrity error. The platform template asks for enforce mode. `check --baseline --enforce` records existing violations and switches modes in one step. These modes follow the scope's observe, baseline, and enforce [adoption stages](../../scope.md#brownfield-repos-adopt-in-stages).
- **Baseline.** `baseline.json` holds one sorted entry per line, each with a rule, a file, and the result's SARIF partial fingerprint. The reference MF2 adapter fingerprints on the shared dependency's name, and source-code adapters leave line numbers out of their fingerprints. For the shrink-only check, `check --baseline-ref <ref>` reads the base baseline with `git show`, and the pipeline passes the target branch.

*Rejected:* enforcing from the first commit in existing repos. The pipeline would fail every pull request until someone built and baselined, which the scope lists as the "brownfield revolt" [risk](../../scope.md#risks-that-would-make-the-sdk-an-obstacle).

*Rejected:* ESLint-style counts per rule and file. They're simpler, but a fixed violation can hide a new one in the same file.

### D15. The shared pipeline runs the SDK

The platform adds the SDK to the shared Jules pipeline once, instead of asking every repo to edit its pipeline.

- **Consumer step.** After the build, in repos with `.de-web-sdk/config.json`, the step runs `sync` and then `check` with the target branch as the base ref. It publishes JUnit XML or SARIF, whichever Jules displays, stores the resolution record, and pins its own Node.js version.
- **Producer flavor.** For pack repos, the pipeline runs `validate`, the evals on the required models, `build`, `sign`, and `npm publish`. It holds the signing keys and the model credentials.

*Rejected:* a documented step that each repo adds. Rollout would be slower, and every repo's copy would drift.

### D16. New repos come from the platform template

The template runs `init --yes --enforce` during generation, naming the baseline bundle and declaring the new repo's facts. The new repo has no baseline, so every violation fails from its first pull request. Its agents get the rules in their first session. Task 1.5 confirms how the template runs commands during generation. If it can't, the template commits the entry points, and developers run `sync` after their first install.

*Rejected:* a `create` command in the SDK. The platform already owns a template, and two ways to create a repo would drift.

### D17. Evals run across models, and a gate blocks harm

- **Eval profile.** The platform maintains a profile that maps each model alias to its model and to routes that reach it. A route is an enterprise endpoint for the pipeline, the local Claude Code installation, or VS Code's language model API. The runner uses the first route that works where it runs. The profile marks required aliases and sets the gate's confidence level and minimum trials. Packs list aliases, never endpoints or credentials.
- **Drivers.** The Claude Code driver runs `claude -p` with the alias's model. In the pipeline it uses the route's endpoint, such as Amazon Bedrock, Google Vertex AI, or an enterprise gateway. On a laptop it uses the developer's own Claude Code sign-in. The reference harness driver runs a small tool-using agent against any OpenAI-compatible endpoint. The VS Code driver runs the same harness and reaches Copilot's models through a bridge in the SDK's extension. VS Code offers those models to extensions through its language model API once the developer consents. It also offers a `copilotcli` vendor, which the enterprise doesn't support, so routes name the `copilot` vendor. The bridge listens only on the local machine, requires a random token, and reports the extension's version. Both harness drivers load the repo instruction files GitHub Copilot documents, so they test Copilot's model families with the context Copilot would load. Teams can add drivers, for example for the enterprise's own agent process. The Claude Code driver loads only the trial's `.mcp.json`, and the harness drivers start the same server with an MCP client. Trials therefore exercise the SDK's MCP tools. No trial can send feedback. Each trial records which SDK tools and commands the agent used.
- **Local runs.** Producers run the same evals on their own machine, with Claude Code or in VS Code, even before any enterprise endpoint exists. Their results count toward the gate the same way as pipeline results. The runner shows the trial count and asks before spending the developer's quota. Drivers limit each trial to its worktree and to the task's build and check commands. The reference harness enforces that list without putting it in its prompt, as Claude Code's allow list and real Copilot do. A refused command's error lists what the trial allows. The first harness listed the allowed commands, which named the SDK's commands in every condition, including the one without the pack. The Claude Code driver runs each session with the `dontAsk` permission mode and an allow list, so Claude Code refuses every other command without prompting. VS Code's documentation asks extensions not to use the language model API for integration tests, because of rate limits ([Language Model API](https://code.visualstudio.com/api/extension-guides/ai/language-model)). The runner therefore paces its requests. A full gate run through Copilot in VS Code can take longer than one through Claude Code or the pipeline.
- **Guided Copilot trials.** The extension opens a trial's worktree in a new window and gives Copilot's own agent mode the task prompt. When the developer marks the trial finished, the extension grades it. Guided trials measure how far the reference harness is from real Copilot, and reviewers can judge them like any other trial. They don't count toward the gate, because the runner can't choose Copilot's model or tell by itself when the agent is done. Copilot's agent mode can't work in a folder VS Code hasn't trusted, so trial folders share one parent, `~/.de-web-sdk/trials/`, that the developer trusts once. Task 1.11 confirms whether the extension can start agent mode with the prompt, or must copy the prompt for the developer to paste.
- **Conditions.** Each task runs without the pack, with the candidate, and with the published version when one exists. Each trial starts from a fresh git worktree, and the "with" conditions run `sync` there first. The runner signs the candidate with a throwaway key and trusts that key in the worktree. A dependency pack that resolves to local source, such as another pack in the same workspace, gets the same treatment. Its source folder holds unpublished files and no signature, so linking it would fail verification. The published version must verify through the producer repo's own trust policy, `.de-web-sdk/trust.json`. The runner checks that the candidate and the published version both verify before any trial starts. The publish walkthrough otherwise lost 40 trials when the third condition failed to verify. Trial worktrees also get the starting state's `node_modules` as copy-on-write clones, or as plain copies where cloning isn't supported. A task's build can then run `vite` or `webpack`. The first runner symlinked packages into the starting state and left out package binaries. Salt's inspection refuses symlinks that leave the repo and hard-linked files, so neither linking method works. The reference repo and the Salt prototype found these gaps.
- **Trials.** A trial is retried once only when the driver fails before the agent acts. Every other failure counts. Each trial records its environment, driver, route, tool version, and the model the tool reports. Raw prompts, transcripts, and diffs stay in an ignored local cache, and the pack's repo keeps only reviews and summaries. Salt's evaluation protocol follows the same rules.
- **Two measures.** A trial passes when every grader passes. The `check` grader runs with the candidate installed in every condition, so all conditions are graded by the same rules. Script graders run from the pack's repo, with the trial's worktree in `DE_WEB_SDK_TRIAL_DIR`. A task can also list the APIs its result should use, as package exports. The runner checks whether the agent's changed files import them. Evil Martians report that top models passed most runs on their benchmark of real Rails tasks. Agents reached for the Rails API each task turned on in only 41% of runs ([post](https://evilmartians.com/chronicles/rails-hyperdrive-supercharged-agentic-development-for-rails)). The report and the gate therefore treat API adoption as a separate measure.
- **Reuse.** No-pack and published results don't depend on the candidate. The runner reuses them until the task, driver, route, model, agent version, SDK version, or published digest changes. The SDK version counts because the agent files and tools it gives agents change between versions. A new candidate therefore runs only its own trials.
- **Gate.** `build` refuses a pack when either measure is lower with it than without it for a required model, at 95% confidence by default. It also refuses when a required model has fewer than 20 trials per condition. A one-sided Fisher's exact test sets the noise margin. With 20 trials and pass rates near 80%, a fixed 10-point margin would block a harmless pack about 20% of the time. The gate sits in `build`, so it applies whichever way the pack is later signed. Each alias's decision uses its most recent run with enough trials, from one environment, whether that run was local or in the pipeline.
- **Overrides.** An owner can override a model's result with a reason, an approver, and an expiry date. The published manifest carries the override, and `sync` shows it to consumers.
- **Cadence.** The producer flavor runs the full eval on each release candidate. A scheduled run re-evaluates published packs when the eval profile changes a required model.

*Rejected:* pipeline-only evals. Evals would wait for enterprise endpoints that nobody has named yet, and producers couldn't test a change before pushing it.

*Rejected:* driving GitHub Copilot's CLI. It isn't supported in the enterprise. If the Copilot coding agent is enabled later, a driver could assign eval tasks to it in a scratch repo.

*Rejected:* `claude plugin eval` ([docs](https://code.claude.com/docs/en/plugin-evals)). It needs a plugin package, which this slice doesn't produce.

*Rejected:* report-only evals. A pack that makes agents worse could ship, which breaks the [measured value](../../scope.md#design-principles) principle.

### D18. Human review and field feedback feed the next version

- **Review.** `eval review` shows each trial's diff, `check` output, and grader verdict, without saying which condition produced it. The VS Code extension offers the same review with each diff in VS Code's diff editor. The reviewer agrees or disagrees and gives a reason, and can mark claims that the pack's content doesn't support. For two pack versions, the reviewer can pick the better result or call them equal. Reviews live under `evals/reviews/` in the pack's repo. Reports list disagreements first, which points owners at weak graders or unclear guidance.
- **Field feedback.** The consumer `feedback` command creates a report with the pack, version, rule, kind, and message. It prints the manifest's feedback link, prefilled when the channel accepts it, so it works with issue trackers and support pages alike. When the pack declares a feedback adapter, `feedback --submit` and the MCP server can send the report instead (D22). The kinds are false positive, missed violation, unclear guidance, and agent ignored the rule. Reports contain no file contents unless the reporter names lines.
- **Loop.** A producer imports a report with `feedback import`, which stores it under `feedback/`. `eval add --from-feedback` drafts an eval task from it. The report resolves when that task passes 80% of trials on every required model, by default.

*Rejected:* a central feedback service. It's new infrastructure, which the [no new infrastructure](../../scope.md#design-principles) principle rules out to start.

*Rejected:* letting reviewers' verdicts change grader results in the gate. The gate would then depend on who reviewed which trial. Disagreements drive fixes to graders and guidance instead.

### D19. The reference packs live in their own repo

A new reference repo acts as a producer on the shared pipeline's producer flavor. It publishes the MF2 manifest adapter pack and the platform runtime rules pack, which lists the adapter pack as a dependency. The SDK team owns the repo until the runtime team takes it over.

| Rule | Mode | Locked | Applies to |
|---|---|---|---|
| Each remote publishes a valid MF2 manifest | machine | Yes | Remotes |
| `react` and `react-dom` are shared singletons | machine | Yes | MF2 repos |
| Shared dependencies require versions inside platform-approved ranges | machine | No | MF2 repos |
| Lazy-load remotes below the fold | advisory | No | Hosts |

The rules pack also ships the MF1-to-MF2 migration skill. The version ranges are placeholders until the runtime team sets them. Eval tasks cover every rule and the skill, including a host fixture for the advisory rule and an MF1 fixture for the migration.

The adapter reads `mf-manifest.json`, which MF2 bundler plugins can emit, so one adapter covers Vite, webpack, and Rspack. The trade-off is that `check` must run after the build, which the pipeline step already does. Task 1.1 confirms that the pilot's Vite build lists shared dependencies with their singleton and required-version settings. If it doesn't, the adapter reads those two settings from the Vite config instead, which works only when they're written as literals.

The reference repo's own OpenSpec specs define the adapter. They start from this behavior:

| Situation | Result |
|---|---|
| The manifest lists `react` as shared without the singleton setting | A violation for `react` |
| A shared dependency requires a version outside the approved range | A violation that names the required version and the range |
| The repo uses MF2 and the build manifest doesn't exist | An adapter error that says to run `check` after the build |
| A remote uses MF1 | A violation stating that the remote must migrate to MF2 |

*Rejected:* keeping the reference packs in this repo. Workspace links would hide the install, signing, and publishing problems that every real producer will hit.

*Rejected:* waiting for the runtime team to write the packs. That would delay the slice. The team reviews them instead.

### D20. Salt adopts the format without duplicating its own tooling

Salt is building agent tooling on its unreleased `ai-platform` branch. Its decision record, ADR 0001, defines `@salt-ds/knowledge`, a version-matched offline bundle with a packaged Skill, generated Markdown guides, and an analyzer shipped as signed package code. It also defines `@salt-ds/cli`, whose `salt-ds info`, `docs`, and `context` commands serve agents. Salt left MCP out of its first release, and it delivers its Skill through a managed pointer into `node_modules`.

Salt can adopt the format now through a wrapper, and later by generating its own manifest:

- **Now, through a wrapper.** An enterprise-owned wrapper pack lists `@salt-ds/knowledge` and `@salt-ds/cli` as peer dependencies. It points to Salt's Skill and guides in place, declares the `salt-ds` commands, and wraps Salt's analyzer in an adapter. It adds only the enterprise's own rules and evals, and Salt changes nothing.
- **Later, as a projection.** Salt generates `pack.json` from its knowledge bundle, as it already generates Markdown, AGENTS.md, and Skill projections from one canonical source. The natural home is `@salt-ds/cli`, because Salt's knowledge package must not depend on its CLI. The wrapper then shrinks to the enterprise's own rules.

The format decisions above keep the projection cheap for Salt:

| Salt already has | The format accepts it through |
|---|---|
| npm provenance on both packages | Provenance verification, with no SDK signing step (D5) |
| A packaged Agent Skill and generated guides | Skills and docs referenced in place (D3, D12) |
| The `salt-ds` CLI | Declared agent commands (D3, D8) |
| An analyzer that renders SARIF | The SARIF adapter contract (D4) |
| Exact-version compatibility | Conditions on exact installed versions (D11) |
| Exit codes 0 to 3 | The same exit codes (D8) |
| `sha256:<hex>` digests | The same digest form (D3) |
| An evaluation protocol with blind review and strict retries | Blind review, retry rules, and fixture checks (D4, D17) |

Salt's analyzer, retrieval, and compatibility logic stay Salt's. The SDK doesn't reimplement Salt's lockfile resolver or search.

*Rejected:* a separate design kit pack that restates Salt's guidance. It would drift from Salt's canonical source on every release, which is the duplication Salt's own architecture forbids.

*Rejected:* waiting for Salt to publish its own pack. Repos would get no Salt rules until then, and Salt would have no enterprise eval evidence to decide with.

### D21. A local MCP server serves the SDK to agents

`de-web-sdk mcp` runs an MCP server over standard input and output. `sync` registers it in `.mcp.json` (D12), so Claude Code and VS Code start it for the repo.

- **Tools.** `resolve` and `check` return the same results as the CLI. `get_skill` returns a skill's instructions and file list, and `read_pack_file` returns one verified page of any file a pack delivers. `draft_feedback` and `submit_feedback` handle reports. Every tool except `submit_feedback` is read-only, and no tool writes repo files.
- **Prompts and resources.** The server offers a check-and-fix prompt and one prompt per applicable skill. Claude Code and VS Code list MCP prompts as commands. Skills are also resources at `skill://<name>/<path>`, the URI form that MCP's Skills extension uses.
- **Instructions.** The server's instructions repeat the workflow in AGENTS.md. They're static, so the server starts without loading packs.
- **Verification.** Each call loads the workspace through the same checks as the CLI, and `check` always loads fresh. Skill and pack files are verified against their digests as they're served, so a file edited after install is refused.
- **Repo root.** `CLAUDE_PROJECT_DIR`, then the client's first root, then the working directory. In VS Code 1.139.1, Copilot's agent mode started the server from the repo-root `.mcp.json` and called its tools.
- **The CLI stays the baseline.** CI, review bots, and agent processes without MCP use the CLI, and so do repos whose policy blocks workspace MCP servers. VS Code's `chat.mcp.access` setting and Claude Code's managed server allow lists can do that ([VS Code enterprise AI settings](https://code.visualstudio.com/docs/enterprise/ai-settings)).

MCP's Skills extension, SEP-2640, is final, but neither Claude Code nor VS Code supports it yet ([client matrix](https://modelcontextprotocol.io/extensions/client-matrix)). The MCP SDK the server uses negotiates protocol revision 2025-11-25, and the extension targets 2026-07-28. `skills/list` and `skills/get` therefore wait until the SDK and the hosts support that revision. Until then, agents discover skills from AGENTS.md and load them through tools, not as native skills, and evals measure whether they still use them.

*Rejected:* a separate MCP package. Consumer CI installs every dev dependency anyway, so it would save nothing, and a second version could drift from the CLI that wrote AGENTS.md.

*Rejected for now:* tools that packs add to the server, and MCP servers that packs declare. The scope table ranks them as should and could.

### D22. Packs choose built-in feedback adapters

A pack's `feedback` field stays its link, which outputs cite as the way to contest a rule and which every adapter falls back to. An optional `feedbackAdapter` field selects how the SDK sends reports. Adding a field keeps older SDKs working, because they ignore fields they don't recognize (D3).

| Type | What happens |
|---|---|
| `link` | The developer opens the prefilled link. This is the default |
| `mcp` | The SDK calls a tool on an MCP server |
| `jira` | A placeholder. The SDK calls a Jira MCP server until the enterprise names its Jira setup |
| `feature-request` | A placeholder. The SDK calls the feature request tool's MCP server until the enterprise names the tool |

For the MCP-backed types, the pack names the server, and can give a URL to match it by. It also names the tool, and gives argument templates that can use the report's title, body, rule, and message. The SDK finds the server among the developer's configured MCP servers: the repo's `.mcp.json` and `.vscode/mcp.json`, Claude Code's settings, and VS Code's user settings. It connects as an MCP client with the credentials that configuration names. For a server whose sign-in only VS Code holds, it asks the SDK's VS Code extension to call the tool through VS Code. VS Code lists an MCP server's tools, named like `mcp_<server>_<tool>`, only once that server has started.

Nothing is sent until the developer, or an agent acting for them, approves the draft. The CLI shows the report and asks on a terminal, and otherwise needs `--yes`, which an agent can pass for the developer. The MCP server sends only when its submit tool is called for a draft it created, and sends each draft once. The submit tool is marked as reaching outside the machine. Claude Code and VS Code therefore ask before running it, unless the developer has allowed it. Every failure returns the prefilled link with the reason. The adapter code is built into the SDK, and check adapters run with an allowlisted environment. Pack code therefore never sees a developer's tokens.

*Rejected:* feedback adapters shipped as pack code, like check adapters. They'd hold developers' credentials and reach the network, and the adapter sandbox isn't a security boundary.

*Rejected:* handing the report to the agent to submit through its own MCP connection. The SDK couldn't confirm the submission, and the CLI couldn't submit at all.

*Rejected:* a server-side prompt that only a person can answer, through MCP's elicitation. Agents acting for developers couldn't submit, and developers already control tool approval in their agent tools.

*Rejected:* an enterprise allow list of feedback destinations. Packs already pass provenance checks, and the developer approves every report and its destination.

## Risks / Trade-offs

- [The Vite plugin's manifest may omit singleton or required-version settings] → Task 1.1 checks before adapter work starts. The fallback reads literal settings from the Vite config.
- [Agent tools may move or rename instruction files] → Entry points are thin, and one task per tool rechecks the locations.
- [Some developers run Claude Code older than 2.1.277, or a Copilot surface that ignores AGENTS.md] → A CLAUDE.md that holds `@AGENTS.md` covers older Claude Code, and task 1.2 decides whether to add `.github/copilot-instructions.md`.
- [Salt's unreleased tooling changes before release] → The wrapper uses only paths and commands that Salt's docs name, and the prototype reruns on each Salt candidate.
- [Artifactory drops provenance attestations for proxied public packages] → Task 1.8 checks. If it does, the enterprise mirrors the attestations, or pins the approved versions by integrity in its trust policy.
- [Eval results are noisy] → The gate uses Fisher's exact test with a minimum trial count. Owners can record an override.
- [Evals across models cost too much] → No-pack and published results are reused, evals run only when pack content changes, and the profile sets trial counts.
- [Import checks miss APIs used through configuration] → Tasks add script graders for those APIs. The API adoption rate covers only tasks that declare expected APIs.
- [Reference harness results differ from Copilot's] → Reports name the driver, and guided Copilot trials measure the gap on the same tasks.
- [Local results are self-reported] → Reports record where each trial ran, and the pack's repo commits and reviews them. The published summary shows consumers where each alias's gate trials ran.
- [Rate limits slow or stop Copilot runs in VS Code] → The runner paces its requests. Producers can also meet the gate through Claude Code or the pipeline.
- [A developer runs an outdated extension] → VSIX installs don't update themselves, so the producer toolkit checks the extension's version and names the VSIX to install.
- [A developer's Copilot plan or the enterprise's policy hides a model] → The runner reports each alias it couldn't reach. The gate treats that alias as missing trials.
- [Many packs ship skills, and agents pick the wrong one] → Skills are scoped by applicability, named by pack, and covered by evals.
- [Agents use skills less without native skill activation] → AGENTS.md lists each skill, the MCP server offers each as a prompt, and trials record SDK use. Hosts that adopt MCP's Skills extension get native skills later.
- [Enterprise policy blocks workspace MCP servers] → Agents fall back to the CLI commands that AGENTS.md names, and task 1.12 confirms the policy.
- [A feedback MCP server needs a sign-in the SDK can't reuse] → The VS Code route or the prefilled link.
- [An npm-provenance pack's manifest is edited after install] → The package manager checks integrity at install. The SDK can't recompute the tarball's digest from installed files. File digests still catch edits to every other file, and a pack that needs more can also carry a signature.
- [The enterprise has no root keys yet] → The CLI ships with none, so no enterprise trust policy verifies until the platform creates them. Until then, repos list scopes directly in `trust.json`.
- [Repos use ignored paths to hide authored code] → Each ignored path needs a reason, and `check` reports the count on every run. Locked rules ignore the list.
- [Reviewers lack time] → Reports put disagreements first, and feedback reports point reviewers at specific rules.
- [A feedback report leaks code] → Reports carry no file contents unless the reporter names lines.
- [Declared facts go stale] → `sync` reports every disagreement with detection.
- [Exceptions pile up] → Every exception expires, and `check` lists active ones on every run.
- [A signing key leaks] → Each producer scope has its own key, and a new enterprise trust policy version rotates it without touching repos.
- [A buggy or slow adapter breaks consumer CI] → Time limits stop hung adapters, and adapter errors are reported apart from violations.
- [An adapter is malicious] → Only packs with verified provenance from allowlisted scopes run. Isolation limits mistakes but can't stop a deliberate attack, and adapters can still reach the network.
- [A developer machine runs an older Node.js] → Before 22.13, the CLI refuses to run and states the version it needs. Between 22.13 and the supported range, npm warns at install, and the CLI warns in a terminal. The SDK's tests also pass on 24.14. CI is unaffected, because the pipeline step pins its own Node.js.
- [Jules may display neither JUnit nor SARIF] → Exit codes and text output still gate the build.
- [Committed entry points conflict in merges] → Output is deterministic, so rerunning `sync` resolves conflicts.
- [Parallel pull requests conflict on the baseline] → Sorted, one-per-line entries keep conflicts to single lines.
- [Placeholder rules get enforced before review] → The pilot starts in report mode, and no other repo adopts until the runtime team signs off.

## Migration Plan

1. Publish the three SDK packages, the enterprise trust policy, and the VS Code extension's VSIX file to Artifactory.
2. Add the consumer step and the producer flavor to the shared Jules pipeline.
3. In the reference repo, publish the adapter pack and the rules pack through the producer flavor, including the eval gate.
4. In the pilot repo, run `init` with the reference pack and commit. The pipeline step starts in report mode.
5. Build the pilot repo, run `check --baseline --enforce`, and commit.
6. Add SDK setup to the platform template, and create one new repo from it.
7. Run `init` in one webpack MF1 repo without committing, to confirm detection, guidance, and the migration skill.
8. Build the Salt wrapper prototype against a local build of Salt's branch, and review it with the Salt team.
9. Run the reference pack's evals locally with Claude Code and in VS Code, and compare them with the pipeline's results.
10. File one feedback report from the pilot, and follow it through to a published fix.

To roll back a repo, delete `.de-web-sdk/`, the managed blocks, the `de-web-sdk` entry in `.mcp.json`, and the SDK's dev dependencies. The pipeline step skips repos without the configuration.

## Open Questions

These can be answered during implementation without changing the specs or the task list.

- How does the shared Jules pipeline add an opt-in step, expose the target branch, and display JUnit or SARIF reports?
- What will the Artifactory scopes and the reference repo be named?
- Who holds the enterprise trust policy's root keys and the reference repo's signing key?
- Which enterprise-hosted models and endpoints should the eval profile list, and who maintains it?
- How does the platform template run commands during generation?
- Who owns the enterprise's Salt wrapper pack until Salt publishes its own?
- Which Claude Code and Copilot versions and surfaces does the enterprise run? Claude Code older than 2.1.277 reads only CLAUDE.md, and Visual Studio and JetBrains chat read only `.github/copilot-instructions.md`.