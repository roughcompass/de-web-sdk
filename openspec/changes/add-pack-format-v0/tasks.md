# Tasks

## 1. Confirm external assumptions

- [ ] 1.1 Build the pilot repo with the MF2 manifest enabled and check its shared entries; verify by committing a sanitized manifest as a test fixture
- [x] 1.2 Confirm where the Claude Code and Copilot versions in use load instructions, scoped instructions, and skills; verify by recording doc links in design.md
- [ ] 1.3 Confirm how the Jules pipeline adds an opt-in step, pins Node.js, passes the target branch, and shows reports; verify in a scratch repo
- [ ] 1.4 Request Artifactory npm scopes for the SDK, the trust policy, and the reference repo; verify by publishing and installing a placeholder in each
- [ ] 1.5 Confirm how the platform template runs commands during generation; verify by generating a scratch repo that runs a placeholder command
- [ ] 1.6 List the enterprise-hosted model endpoints and whether they accept OpenAI-compatible requests; verify by recording them in a draft eval profile
- [ ] 1.7 Review the pack format and wrapper plan with the Salt team; verify by recording what they'd need to generate a manifest in design.md D20
- [ ] 1.8 Install a public package that has npm provenance through Artifactory; verify its attestation still verifies
- [ ] 1.9 Confirm that the enterprise's VS Code policy allows installing the SDK's extension from a VSIX file; verify by installing a placeholder VSIX from Artifactory
- [ ] 1.10 Deferred: list the Copilot models that VS Code's language model API offers under the enterprise's policy; verify with a test extension
- [x] 1.11 Check whether an extension can start Copilot's agent mode with a prompt; verify with a test extension, or record the copy-and-paste fallback
- [ ] 1.12 Confirm the enterprise's MCP policy in VS Code and Claude Code, such as `chat.mcp.access`; verify a workspace `.mcp.json` server starts on a managed machine
- [ ] 1.13 Name the Jira and feature request MCP servers, their tools, and their arguments; verify by recording them in design.md D22

## 2. SDK repo scaffolding

- [ ] 2.1 Create a TypeScript workspace with the core library, consumer CLI, producer toolkit, and VS Code extension; verify an empty test suite passes in Jules
- [ ] 2.2 Run the writing-standard linter on `docs/` and `openspec/` in CI; verify a planted house-term error fails the build
- [ ] 2.3 Publish prerelease builds of the three packages to the SDK's scope from Jules; verify a clean machine can install them
- [ ] 2.4 Publish a prerelease VSIX of the extension to Artifactory from Jules; verify a clean VS Code installs it with `code --install-extension`
- [x] 2.5 Check the extension's version from the producer toolkit; verify a mismatch names the VSIX to install

## 3. Pack format and producer toolkit

- [ ] 3.1 Write the JSON Schema for manifest v0 and publish it at a stable URL; verify a generic validator and `validate` report the same field errors
- [x] 3.2 Add an example manifest for each pack kind in D3 and check them against the schema, excluding digests; verify an invalid edit fails CI
- [x] 3.3 Implement the producer toolkit's `validate` so it reports every error in one run; verify with a fixture for each pack-format scenario
- [x] 3.4 Run each machine rule's check on its positive and negative fixtures in `validate`; verify a check that misses a positive fixture fails
- [x] 3.5 Implement `new` to scaffold a pack from an identifier, owner, and feedback channel; verify the new pack passes `validate` unedited
- [x] 3.6 Implement the hidden-character scanner; verify with fixtures for each code point range in the security spec
- [x] 3.7 Implement `build` with file digests and an npm tarball; verify two builds produce identical manifests
- [x] 3.8 Implement `sign` with Sigstore-format bundles and a producer key; verify a standard Sigstore verifier accepts the bundle and rejects a one-byte edit
- [x] 3.9 Write `docs/producer-guide.md`, covering rules, fixtures, skills, docs, commands, adapters, and evals; verify by following it to publish a sample pack

## 4. Trust and provenance

- [x] 4.1 Implement `trust.json` with scopes, provenance identities, keys, and an extended enterprise policy; verify an unlisted scope is refused and the local pack is exempt
- [x] 4.2 Check the enterprise trust policy against built-in root keys; verify a tampered policy fails and a newly added scope is accepted
- [x] 4.3 Verify npm provenance offline from a cached attestation, and Sigstore-format signatures, through one library; verify an unlisted repository, workflow, or key is refused
- [x] 4.4 Verify file digests and referenced dependencies on every `sync` and `check`; verify tampered packs fail before any adapter runs
- [ ] 4.5 Publish a pilot enterprise trust policy that lists the reference repo's scope; verify the pilot repo accepts the reference packs

## 5. Composition

- [x] 5.1 Implement detection, reading exact versions from npm, pnpm, and Yarn lockfiles; verify Vite MF2, webpack MF1, and Plug'n'Play fixtures
- [x] 5.2 Implement declared facts and disagreement reporting; verify with an empty-repo fixture and a migrating MF1 fixture
- [x] 5.3 Collect packs from direct dependencies, embedded packs, bundles, and the local pack; verify an indirect embedded pack is skipped
- [x] 5.4 Apply conditions for packs, rules, skills, docs, commands, and governed packages; verify each exclusion names its reason
- [x] 5.5 Validate the local pack; verify an invalid local rule fails `sync` with its file and field
- [x] 5.6 Implement exceptions, including approvals for locked rules; verify each exception and locked-rule scenario in the composition spec
- [x] 5.7 Implement ignored paths; verify generated files are skipped and a locked rule still reports in them
- [x] 5.8 Reject configuration that turns off a pack's rule; verify the error points to recorded exceptions and ignored paths

## 6. Setup commands

- [x] 6.1 Implement `init` for npm, pnpm, and Yarn; verify it adds named packs, creates configuration, and changes no source files
- [x] 6.2 Implement `sync` as observe-only and idempotent; verify with git status assertions that configuration and source files don't change

## 7. Checks

- [x] 7.1 Implement the SARIF adapter contract in the core library, with partial fingerprints; verify fingerprints survive unrelated edits
- [x] 7.2 Load adapters from the rule's own pack, a declared dependency pack, or the local pack; verify a missing adapter pack produces an adapter error
- [x] 7.3 Run adapters in child processes with the permission model and a time limit; verify with fixture adapters that write, spawn, hang, and crash
- [x] 7.4 Add an end-to-end test with an adapter pack that exists only as a test fixture; verify `check` runs its adapter
- [x] 7.5 Implement exit codes 0 to 3 and self-explaining output; verify each code with golden files
- [ ] 7.6 Implement text, JSON, SARIF, and JUnit output without absolute paths or source text; verify with golden files and the task 1.3 pipeline
- [x] 7.7 Implement the resolution record; verify it lists packs, digests, facts, exceptions, ignored paths, and results

## 8. Adoption

- [x] 8.1 Implement report and enforce modes; verify report mode passes with violations and still exits with 3 on a trust error
- [x] 8.2 Implement `check --baseline`, including `--enforce`; verify each baseline scenario, including a repo with no baseline
- [x] 8.3 Implement the shrink-only check with `--baseline-ref`; verify a regenerated baseline that hides a violation fails
- [x] 8.4 Implement stale-entry reporting and `--prune-baseline`; verify a fixed violation is pruned and the shrink-only check passes
- [x] 8.5 Write `docs/consumer-guide.md`, covering setup, baselines, repo overrides, agent use, pack upgrades, feedback, and MF1 migration; verify each command runs as written on the MF1 fixture

## 9. Agent contract and adapters

- [x] 9.1 Implement `resolve` with Markdown and JSON output and a 16 KiB budget; verify path scoping, listed skills, docs, and commands, and named omissions
- [x] 9.2 Add schema versions to all JSON output and publish the schemas; verify golden files fail when a field is renamed
- [x] 9.3 Test every command without a terminal and without network access; verify none prompts and `sync`, `resolve`, and `check` complete
- [x] 9.4 Implement target tools; verify dropping a tool deletes only the files `sync` generated for it
- [x] 9.5 Implement the committed entry points with rule summaries and commands; verify content written by people is preserved byte for byte
- [x] 9.6 Serve rule detail, skills, and docs from their packs, with no skill files installed; verify nothing is committed and old skill files are removed
- [x] 9.7 Keep generated paths in a managed `.gitignore` block; verify `git status` stays clean after `sync`
- [x] 9.8 Warn when committed entry points are stale; verify a dependency update that adds a rule warns without failing `check`
- [x] 9.9 Name pack skills with their pack's prefix in the AGENTS.md block and the SDK; verify two packs' `setup` skills don't collide
- [ ] 9.10 Verify in a Claude Code session that the AGENTS.md block, an imported block in an existing CLAUDE.md, and the MCP server's tools and prompts load
- [ ] 9.11 Verify in each Copilot surface in use that the AGENTS.md block and the MCP server load; record any surface that needs `.github/copilot-instructions.md`
- [x] 9.12 Run an agent that loads only AGENTS.md on a fixture task; verify it runs `resolve` and `check` without further instruction

## 10. Feedback

- [x] 10.1 Implement the consumer `feedback` command for prefilled links and support pages; verify reports carry no file contents unless lines are named
- [x] 10.2 Implement `feedback import` and a per-rule list of open reports in the producer toolkit; verify with sample reports
- [x] 10.3 Implement `eval add --from-feedback`; verify a drafted task references the report's rule and message

## 11. Evals

- [x] 11.1 Implement the eval profile with aliases, routes, required models, and gate settings; verify packs can't contain endpoints or credentials
- [ ] 11.2 Implement the driver interface and the Claude Code driver; verify a toy task runs in the pipeline and through a laptop's own sign-in
- [ ] 11.3 Implement the reference harness driver with Copilot's instruction files; verify against an OpenAI-compatible endpoint from task 1.6
- [x] 11.4 Implement the VS Code driver with tool calls through VS Code's language model API; verify a toy task runs with a Copilot model
- [x] 11.5 Ask before spending the developer's quota, pace requests, and limit local trials to their worktree and task commands; verify an unlisted command is refused
- [ ] 11.6 Implement guided Copilot trials in the extension; verify a trial is graded when marked finished and reported beside harness results
- [x] 11.7 Implement paired trials with reuse, one retry for failures before the agent acts, trial records, and an ignored transcript cache; verify each rule
- [x] 11.8 Measure API adoption from imports in each trial's changed files; verify a fixture that builds its own dialog counts against adoption
- [x] 11.9 Implement the report with both measures, where trials ran, coverage warnings, and disagreements; verify every field in the evals-and-telemetry spec
- [x] 11.10 Enforce the gate and expiring overrides in `build`, from each alias's latest run with enough trials; verify fixtures that lower either measure fail
- [ ] 11.11 Implement blind review in the terminal and in VS Code's diff editor, with unsupported-claim marks and side-by-side comparison; verify reviewers can't see the condition

## 12. Platform hooks

- [ ] 12.1 Add the consumer step to the shared Jules pipeline, after the build, for opted-in repos; verify repos without configuration skip it
- [ ] 12.2 Add the producer flavor with validation, evals, the gate, signing, and publishing; verify a harmful fixture pack doesn't publish
- [ ] 12.3 Add SDK setup to the platform template; verify a generated repo starts in enforce mode and its agents see the rules

## 13. Reference repo

- [ ] 13.1 Create the reference repo on the shared pipeline's producer flavor; verify `validate` runs in its pipeline
- [x] 13.2 Specify the MF2 manifest adapter in the reference repo's OpenSpec, starting from design.md D19; verify `openspec validate --strict` passes
- [ ] 13.3 Write the adapter pack; verify it against the task 1.1 fixture and a synthetic case for each behavior in D19
- [x] 13.4 Write the rules pack with its four rules, fixtures, locked flags, migration skill, and eval tasks; verify `validate` reports no warnings
- [ ] 13.5 Run the evals on every required model and review the disagreements; verify the gate passes or an override is recorded
- [ ] 13.6 Publish both packs through the producer flavor; verify install and `init` in a clean fixture

## 14. Salt wrapper prototype

- [ ] 14.1 Build Salt's knowledge and CLI packages locally from the `ai-platform` branch; verify their Skill, guides, and `salt-ds` commands work offline
- [ ] 14.2 Write the wrapper pack with peer dependencies on both packages; verify `validate` passes with no Salt content inside the wrapper
- [ ] 14.3 Wrap Salt's analyzer in an adapter that returns its SARIF; verify a fixture with a deprecated Salt API produces a violation
- [ ] 14.4 Run `sync` in a fixture app that uses Salt; verify Salt's Skill is served once from its package, the guides are pointed to, and the commands are listed
- [ ] 14.5 Share the prototype and its eval results with the Salt team; verify their decision on generating a manifest is recorded in D20

## 15. Pilots

- [ ] 15.1 Run `init` with the reference pack in the pilot repo and commit; verify the pipeline step runs in report mode and passes
- [ ] 15.2 Build, run `check --baseline --enforce`, and commit; verify a pull request with a new violation fails and a clean one passes
- [ ] 15.3 Add one local rule and one ignored path in the pilot repo; verify agents receive the rule and `check` reports the ignored count
- [ ] 15.4 Merge a dependency update that changes a pack; verify CI passes without an SDK file change and the stale warning appears
- [ ] 15.5 Create a new remote from the platform template; verify a planted violation fails its first pull request
- [ ] 15.6 Run `init` in one webpack MF1 repo; verify detection, the migration skill, MF1-appropriate guidance, and an unaffected build
- [ ] 15.7 File a feedback report from the pilot and follow it to a published fix; verify the report resolves in the next eval report
- [ ] 15.8 Run the reference pack's evals locally in Claude Code and VS Code with Copilot; verify the build accepts them and records where they ran
- [ ] 15.9 Run guided Copilot trials on one reference task; verify the report compares them with the reference harness

## 16. Local MCP server

- [x] 16.1 Implement `de-web-sdk mcp` with tools for rules, checks, skills, pack files, and feedback; verify the rules and check results match the CLI's JSON
- [x] 16.2 Serve skills and pack files verified against their digests as they're served; verify a file edited after the server started is refused
- [x] 16.3 Offer each skill and the check-and-fix workflow as prompts, and skills as `skill://` resources; verify with the official MCP client
- [x] 16.4 Register the server in `.mcp.json` from `sync`, keeping other servers; verify a merge, an invalid file, and the `mcpServer` opt-out
- [x] 16.5 Add the `skill` command for agents without MCP; verify it prints a skill and one of its files, with published output schemas
- [x] 16.6 Give eval trials the MCP server, without the feedback-sending tool, and record SDK use; verify with a scripted model and Claude Code's allowed tools
- [x] 16.7 Verify in VS Code that Copilot's agent mode starts the server from `.mcp.json` and calls its tools
- [ ] 16.8 Implement MCP's Skills extension once the MCP SDK and the hosts support protocol revision 2026-07-28; verify with MCP Inspector's skill check

## 17. Feedback adapters

- [x] 17.1 Add the `feedbackAdapter` field with the link, MCP, Jira, and feature request types; verify validation and the warning for unknown types
- [x] 17.2 Find the pack's named server among the developer's configured MCP servers and call its tool; verify with a fake tracker and fixture settings
- [x] 17.3 Send only on approval, through the CLI's prompt or `--yes` or a submit call for the server's own draft; verify drafts send nothing
- [x] 17.4 Fall back to the feedback link with a reason on every failure; verify an unconfigured server
- [x] 17.5 Route servers whose sign-in only VS Code holds through the VS Code extension; verify in VS Code with a started MCP server
- [x] 17.6 Run check adapters with an allowlisted environment; verify an adapter can't read a feedback token
- [x] 17.7 Document feedback adapters in the producer guide and submission in the consumer guide; verify each documented command runs as written
- [ ] 17.8 Configure the Jira and feature request adapters once task 1.13 names their servers; verify a submitted report reaches each
