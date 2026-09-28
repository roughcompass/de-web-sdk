# Consumer guide

This guide is for developers who own a web app repo. It shows how to make the repo, and the agents working in it, follow the rules that producer teams publish as packs. It covers setup, daily use, repo overrides, pack upgrades, feedback, and migrating a Module Federation 1 (MF1) remote.

The SDK ships as the `@de-web-sdk/cli` package, which provides the `de-web-sdk` command. The package scope is a placeholder until the enterprise's Artifactory scopes exist. The CLI supports Node.js 22.22.2, 24.15, and 26 or later in those release lines, and refuses to run before 22.13. The shared Jules pipeline pins its own Node.js version for the SDK step.

## Set up an existing repo

Add the CLI as a dev dependency with your repo's package manager. Then run `init` at the repo root, naming the packs your platform team recommends:

```sh
npm install --save-dev @de-web-sdk/cli
npx --no de-web-sdk init @example-platform/web-runtime-pack
```

Your lockfile then pins the CLI's version, and the MCP server that agents start runs it from `node_modules`. The guide's commands use `npx --no`, which fails when the CLI isn't installed instead of downloading a package with that name.

`init` adds the packs as dev dependencies with your repo's package manager (npm, pnpm, or Yarn). It then writes `.de-web-sdk/config.json` in report mode and `.de-web-sdk/trust.json`, and runs `sync`. It changes no source files and no CI configuration. If your platform publishes an enterprise trust policy, pass `--trust-policy <package>` so `trust.json` extends it. Until it does, `init` stops because no scope is trusted yet. Add each pack's scope to `trust.json` with the public key its producer published, then rerun `init`:

```json
{ "scopes": { "@example-platform": { "keys": ["MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE..."] } } }
```

`sync` writes one entry point that agents load: a managed block in `AGENTS.md`, which Claude Code and GitHub Copilot both read. If your repo already has a `CLAUDE.md`, `sync` adds an `@AGENTS.md` import to it, because Claude Code skips `AGENTS.md` when a `CLAUDE.md` exists. Commit those files along with `.de-web-sdk/` and your updated lockfile. Content outside the managed blocks is never changed.

Claude Code reads `AGENTS.md` from version 2.1.277. Developers on an older version can update, or you can commit a `CLAUDE.md` that contains the line `@AGENTS.md`.

In report mode, `check` lists violations and exits with 0, so your pipeline keeps passing:

```sh
npx --no de-web-sdk check
```

When you're ready to enforce, build the app first if any rule reads build output. Then record the existing violations and switch to enforce mode in one step:

```sh
npx --no de-web-sdk check --baseline --enforce
```

Commit `.de-web-sdk/baseline.json` and the updated configuration. From then on, `check` fails only on violations that the baseline doesn't list. The shared pipeline also passes the target branch, so a pull request can't add entries to the baseline:

```sh
npx --no de-web-sdk check --baseline-ref origin/main
```

When someone fixes a baselined violation, `check` reports its entry as stale. Remove stale entries with:

```sh
npx --no de-web-sdk check --prune-baseline
```

## Start a new project

New remotes come from the platform's project template, which runs `init --yes --enforce` and declares the new repo's facts. The repo starts in enforce mode with no baseline, so every violation fails from the first pull request. If you set up a repo by hand before any code exists, declare the facts that detection can't find yet:

```sh
npx --no de-web-sdk init --enforce --fact moduleFederation=2 --fact role=remote
```

## How agents use the SDK

The managed block in `AGENTS.md` tells any agent to get the rules before editing and check before finishing. Agents in Claude Code and VS Code do that through the SDK's MCP server, which `sync` registers in `.mcp.json`. Claude Code asks you once to approve the server, and VS Code starts it in a folder you trust. Other agents run the CLI commands the block names.

The server's tools return the same results as the CLI. It also offers a check-and-fix prompt, and one prompt per skill, as commands in both tools. If your enterprise's policy blocks workspace MCP servers, set `"mcpServer": false` in `.de-web-sdk/config.json`. Agents then use the CLI instead.

The block lists each skill that applies, under a name that starts with the pack's scope and name. No skill files are installed on your machine. Agents load a skill through the server's `get_skill` tool, or with the `skill` command. The SDK checks each file against its pack's digest as it serves it:

```sh
npx --no de-web-sdk skill example-platform-web-runtime-pack-migrate-to-mf2
```

`resolve` returns the rules, skills, reference docs, and pack commands for the files an agent will change:

```sh
npx --no de-web-sdk resolve src/remotes/cart.tsx
```

Agent processes that parse output can ask for JSON:

```sh
npx --no de-web-sdk resolve --format json src/remotes/cart.tsx
```

Setting `DE_WEB_SDK_FORMAT=json` switches every command to JSON. The commands never prompt without a terminal. `sync`, `resolve`, and `check` work offline once packs are installed and any npm provenance attestations are cached. `sync` caches them on its first run with registry access, in `.de-web-sdk/cache/`.

`check` exits with one of four codes:

| Code | Meaning | What to do |
|---|---|---|
| 0 | No new violations | Done |
| 1 | New violations | Apply each reported fix and rerun `check` |
| 2 | Usage or configuration error | Fix the command or `.de-web-sdk/config.json` |
| 3 | A pack failed verification, or a check couldn't run | Report it to the pack's owner; don't work around it |

An agent can name the files it changed, as in `npx --no de-web-sdk check src/remotes/cart.tsx`. `check` then still runs every rule but counts only violations in those files. Each violation names the rule, its owner, the rationale, the location, a fix, and how to contest the rule. JSON output locates violations by relative path and line and never quotes your source code.

## Regenerate after installs

Run `sync` after installing or upgrading dependencies. It verifies every pack, rebuilds the rule set, and rewrites the generated files. It never installs anything or changes your configuration:

```sh
npx --no de-web-sdk sync
```

A dependency update needs no SDK file change. The lockfile pins each pack's version and integrity, and `check` evaluates the new version's rules. If the update adds or renames a rule, `check` warns that the committed entry points are out of date and says to run `sync`. The warning doesn't fail the build. A pack upgrade that changes only guidance leaves every committed file unchanged, because rule detail stays in `node_modules`.

## Adapt the rules to your repo

A repo adapts the rules only through declared facts, local rules, ignored paths, and recorded exceptions. Configuration can't turn off a pack's rule; `sync` rejects fields such as `rules` or `disable` and points to the options below.

**Declared facts.** Declare a fact when detection gets it wrong, such as during a migration. `sync` reports every disagreement with detection.

**Ignored paths.** List generated or vendored code, with a reason. `check` reports how many files it ignored, and locked rules still apply to them.

**Exceptions.** Record a rule you can't meet yet, with an owner, a reason, and an expiry date. `check` lists active exceptions on every run and fails with exit code 2 once one expires. An exception to a locked rule also needs the rule owner's approval.

```json
{
  "mode": "enforce",
  "targets": ["claude-code", "github-copilot"],
  "facts": { "moduleFederation": "2" },
  "ignore": [
    { "path": "src/generated/**", "reason": "OpenAPI client generated from the payments service contract" }
  ],
  "exceptions": [
    {
      "rule": "@example-platform/web-runtime-pack#react-singleton",
      "owner": "payments-web",
      "reason": "The partner checkout widget ships its own React until the partner's next release.",
      "expires": "2026-12-15",
      "approvedBy": "platform-web-runtime",
      "approval": "https://git.example.com/platform/web-runtime-pack/issues/412"
    }
  ]
}
```

`targets` names the agent tools that get entry points, and both supported tools are the default. When you drop a tool, `sync` deletes only the files it generated for that tool.

**Local rules.** Keep your repo's own conventions in `.de-web-sdk/local/pack.json`. The local pack uses the pack format but needs no identifier, version, signature, or evals. Its rules appear as `local#<rule>` in `resolve`, `check`, and the generated agent files. A local machine rule can use an adapter in `.de-web-sdk/local/adapters/`, which runs in the same isolated process as a pack's adapters.

```json
{
  "$schema": "https://schemas.example.com/agent-pack/v0-local.json",
  "specVersion": "0",
  "owner": { "team": "Payments Web", "contact": "#payments-web" },
  "feedback": "https://git.example.com/payments/checkout-remote/issues/new?title={title}&body={body}",
  "rules": [
    {
      "id": "use-api-client",
      "title": "Call backend services through src/api/client.ts",
      "enforcement": "advisory",
      "paths": ["src/**/*.{ts,tsx}"],
      "rationale": "The shared client adds the authentication, retries, and tracing headers that the backend requires."
    }
  ]
}
```

## Report a problem with a rule

If a rule is wrong or unclear, file feedback with its owner. `feedback` prints the pack's feedback link with the report filled in, or the report itself when the channel is a support page:

```sh
npx --no de-web-sdk feedback @example-platform/web-runtime-pack#mf2-manifest --kind false-positive --message "Our remote has no exposed modules yet."
```

The kinds are `false-positive`, `missed-violation`, `unclear-guidance`, and `agent-ignored-rule`. A report includes the pack, its version, the rule, your repo's facts, and your message. It includes file contents only for lines you name with `--lines src/app.tsx:10-14`.

A pack can also send reports for you, to Jira, a feature request tool, or another MCP server. `feedback` names the destination. Add `--submit` to send the report: the CLI shows it and asks first, and an agent acting for you can approve it with `--yes`. The pack's server must be configured for your VS Code or Claude Code; otherwise, the CLI prints the link instead:

```sh
npx --no de-web-sdk feedback @example-platform/web-runtime-pack#mf2-manifest --kind unclear-guidance --message "Say which plugin option emits the manifest." --submit
```

Through the MCP server, an agent drafts a report with `draft_feedback`, and sends it with `submit_feedback`. Claude Code and VS Code ask you before running the submit tool, unless you've allowed it.

## Migrate an MF1 remote

In a webpack repo that still uses MF1, `init` detects webpack and MF1 without running your build configuration. Rules that apply only to MF2 repos are excluded, and `sync` lists each exclusion with its reason. The runtime pack's migration skill applies only to MF1 repos, so agents in your repo receive it. Its first step is to declare MF2, which switches the MF2 rules on:

```json
{ "mode": "report", "facts": { "moduleFederation": "2" } }
```

Remove the declared fact once detection reports MF2.

## Trust and verification

`sync` and `check` verify every pack before using it, and a failure stops them before any adapter runs or any file is written:

- The pack's npm scope must be in `.de-web-sdk/trust.json`, directly or through the enterprise trust policy it extends.
- Its provenance must come from an identity or key that the policy lists for that scope. Public packages use npm provenance, and internal packs carry a Sigstore-format signature.
- Every file must match the digest in the pack's manifest.
- No file that reaches agents may contain hidden characters.

The MCP server and the `skill` command check skill and pack files again each time they serve one, so a file edited after install is refused.

Protect `trust.json` with a code-owners rule. The resolution record that the pipeline stores lists which packs, facts, exceptions, and ignored paths applied to each run:

```sh
npx --no de-web-sdk check --format junit --output reports/de-web-sdk.xml --record reports/resolution.json
```

## Roll back

Delete `.de-web-sdk/`, the managed blocks in `AGENTS.md`, `.gitignore`, and any `CLAUDE.md`, the `de-web-sdk` entry in `.mcp.json`, and the SDK's dev dependencies. The pipeline step skips repos without `.de-web-sdk/config.json`.
