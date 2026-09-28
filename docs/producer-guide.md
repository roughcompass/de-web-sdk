# Producer guide

This guide is for teams that set rules for client-facing web UI and want to publish them as packs. A pack carries rules, the checks that enforce them, skills, reference docs, and agent commands. It publishes to an npm registry from the producer's own repo, and consumer repos install it like any other dev dependency.

The producer toolkit ships as the `@de-web-sdk/pack` package, which provides the `de-web-sdk-pack` command. The package scope is a placeholder until the enterprise's Artifactory scopes exist. The toolkit supports Node.js 22.22.2, 24.15, and 26 or later in those release lines, and refuses to run before 22.13.

## Choose a pack kind

Every kind uses the same `pack.json` format, defined by a public JSON Schema. The schema and an example manifest for each kind ship in `@de-web-sdk/core/schema/`.

| Kind | Use it when | Contains |
|---|---|---|
| Standalone pack | Your rules don't track one library's version | Rules, skills, docs, commands, and adapters, or references to them in dependencies |
| Embedded pack | Your rules describe a library you publish | The same, in a directory of the library's package |
| Bundle | Repos should install several packs at once | Only dependencies on other packs |
| Adapter pack | Several rules packs share a kind of check | Only adapters |

A standalone pack that mostly points into another package is a wrapper. For example, a Salt wrapper points to Salt's Skill, guides, and CLI in place, and adds only the enterprise's rules.

## Scaffold a pack

```sh
npx -p @de-web-sdk/pack de-web-sdk-pack new @example-analytics/tracking-pack --owner "Analytics" --feedback "https://git.example.com/analytics/tracking-pack/issues/new?title={title}&body={body}"
cd tracking-pack
npm install
```

`new` runs the toolkit without installing it, and the new pack lists the toolkit as a dev dependency. After `npm install`, run the toolkit with `npx --no de-web-sdk-pack`, which fails when the toolkit isn't installed instead of downloading a package with that name.

The pack's identifier is its npm package name. The feedback link is where consumers report problems and contest rules. When it contains `{title}` and `{body}`, the consumer CLI fills in the report. The new pack has one advisory rule, its guidance, an eval configuration, and one eval task, and it passes `validate` unedited.

## Choose how feedback reaches you

Your pack's `feedback` link is always where people contest rules, and the fallback for everything else. To have the SDK send reports for consumers, add a `feedbackAdapter`. It names the MCP server that receives reports, as consumers configure it for VS Code or Claude Code, and the tool and arguments to call:

```json
"feedbackAdapter": {
  "type": "jira",
  "mcp": {
    "server": "atlassian",
    "tool": "createJiraIssue",
    "arguments": { "projectKey": "ANLT", "issueTypeName": "Bug", "summary": "{title}", "description": "{body}" }
  }
}
```

The types are `link`, the default, `mcp`, `jira`, and `feature-request`. Jira and the feature request tool are reached through their MCP servers until the enterprise names its setup, so both need the `mcp` block. Argument strings can use `{title}`, `{body}`, `{rule}`, `{ruleId}`, `{kind}`, `{message}`, `{pack}`, `{packVersion}`, and `{report}`. The body holds the report as JSON, so `feedback import` can read an issue exported from your tracker. Consumers approve each report before it's sent, and the SDK falls back to your link when the server isn't configured on their machine.

## Write rules

Each rule needs an identifier that is unique in the pack, a title, a rationale, and an enforcement mode:

- An `advisory` rule reaches agents through `resolve` and the generated entry points, and never fails `check`.
- A `machine` rule names a check adapter and its options. `check` runs it and fails on new violations.

```json
{
  "id": "track-page-views",
  "title": "Track page views through the analytics client",
  "enforcement": "machine",
  "paths": ["src/pages/**/*.tsx"],
  "appliesWhen": { "packages": { "@example-analytics/client": "^3.0.0" } },
  "rationale": "Page views sent any other way skip consent checks and break the funnel reports.",
  "guidance": "guidance/track-page-views.md",
  "fix": "Call usePageView() from @example-analytics/client in the page component.",
  "check": { "adapter": "page-views", "options": { "hook": "usePageView" } }
}
```

A rule inherits the pack's owner, `appliesWhen`, and `paths` unless it declares its own. Conditions can test four facts: installed `packages` with semver ranges, the `bundler`, the `moduleFederation` generation, and the repo's `role`. Mark a rule `locked` when one remote relaxing it can break other remotes. Consumers then need your approval to record an exception to it, and ignored paths don't apply to it.

Keep guidance in its own Markdown file. `resolve` returns it to agents on demand, and the committed entry points show only the title.

## Write a check adapter

An adapter is a JavaScript module whose default export returns SARIF 2.1.0 results. Declare it in the manifest, and name it from a rule's `check`:

```json
"adapters": [{ "name": "page-views", "module": "adapters/page-views.mjs" }]
```

```js
// adapters/page-views.mjs
export default async function check({ files, options, readText, result }) {
  const results = [];
  for (const file of files) {
    const text = await readText(file);
    if (text && !text.includes(options.hook)) {
      results.push(result({ file, fingerprint: "missing-hook", message: `This page doesn't call ${options.hook}().` }));
    }
  }
  return { results };
}
```

The adapter receives:

| Field | What it holds |
|---|---|
| `root` | The repo root |
| `facts` | The repo's bundler, Module Federation generation, role, and installed package versions |
| `options` | The rule's `check.options` |
| `files` | Repo files the rule covers, after its `paths` and the repo's ignored paths |
| `readText`, `readJson`, `exists` | Readers for repo-relative files |
| `result` | Builds a SARIF result with your fingerprint as its partial fingerprint |

The fingerprint is the violation's stable key in consumers' baselines. Leave line numbers out of it, so unrelated edits don't turn a baselined violation into a new one. An adapter can also return a full SARIF log, so an adapter that calls your own analyzer can pass its output through. Return `{ "error": "..." }` when the adapter can't evaluate the rule, such as when a build output is missing. `check` reports that as an adapter error, never as a pass.

Adapters run in a separate Node.js process with the permission model enabled. They can read the repo and installed packages, and they can't write files, start processes, or create worker threads. Each run stops after 60 seconds by default. The isolation catches mistakes. It isn't a security boundary, so provenance verification decides which adapters run at all.

A rule can use an adapter from another pack only when your pack lists that pack as an npm dependency. Set `check.pack` to its identifier.

## Add fixtures for machine rules

Every machine rule needs at least one positive fixture that violates it and one negative fixture that doesn't. Each fixture is a small repo:

```text
fixtures/
  track-page-views/
    positive/
      page-without-hook/src/pages/home.tsx
    negative/
      page-with-hook/src/pages/home.tsx
```

`validate` runs the rule's check on every fixture and fails unless it flags each positive fixture and no negative one. When a fixture needs facts that detection can't find, declare them in the fixture's own `.de-web-sdk/config.json`.

## Ship skills, docs, and commands

Skills use the Agent Skills format: a directory with a `SKILL.md` whose frontmatter has a `name` and a `description`. Nothing is installed on consumers' machines. Agents get each applicable skill through the SDK's MCP server or `skill` command, under a name that starts with your pack's scope and name. The SDK checks each of the skill's files against your manifest's digests as it serves them. Refer to supporting files by paths relative to the skill's folder; agents read them through the SDK.

```json
"skills": [{ "name": "add-tracking", "path": "skills/add-tracking" }],
"docs": [{ "title": "Event catalog", "path": "docs/events.md" }],
"commands": [{ "name": "events", "run": "analytics-events search \"<event>\"", "use": "Before adding an event, to find its approved name" }]
```

A command's binary must come from your pack's package or from a package the pack depends on. Name that package in `from`. Agents see each command with an `npx --no` prefix, because installed binaries aren't on their PATH. List commands in eval tasks without the prefix; trials accept both forms. Skills, docs, and adapters can also live in a dependency or peer dependency. Set `from` to the package, and set `path` relative to it. The wrapper then carries no copy, and consumers verify the referenced package's provenance too.

## Embed a pack in a library

A library can carry its own pack, so its rules always match the installed version. Name the pack's directory in the library's `package.json`:

```json
{ "name": "@example-ds/core", "agentPack": "./agent-pack" }
```

Consumers collect packs embedded in their direct dependencies, and in packs that a collected pack depends on. The `agentPack` field name is pending open question 10 in the scope.

## Write eval tasks

Every pack with rules needs at least one eval task. Evals run each task with and without your pack on every required model, and `build` refuses a pack that makes agents worse. `evals/config.json` lists the model aliases you want covered, the runs per task, and the task files. It never holds endpoints or credentials:

```json
{ "models": ["claude-sonnet"], "runs": 5, "tasks": ["evals/tasks/add-page.json"] }
```

A task declares a prompt, a starting repo state, the rules it exercises, and its graders:

```json
{
  "id": "add-page",
  "prompt": "Add a pricing page at /pricing that lists the three plans.",
  "start": "evals/fixtures/app",
  "build": "npm run build",
  "exercises": ["track-page-views"],
  "expects": [{ "package": "@example-analytics/client", "export": "usePageView" }],
  "graders": [
    { "type": "check" },
    { "type": "script", "run": "node evals/graders/pricing-page.mjs" }
  ]
}
```

Keep the answer out of the starting state. In a sample run, an agent without the pack copied the hook from an existing page and passed. That task couldn't show what the pack adds. A trial passes when every grader passes. The `check` grader runs `check` in enforce mode with your candidate pack installed, whichever condition the trial ran in. A script grader runs from your pack's repo, and the environment variable `DE_WEB_SDK_TRIAL_DIR` holds the trial's worktree. It fails by exiting with a nonzero code, and the trial records what it printed. `expects` lists the exports a good result uses. The runner measures API adoption separately, so an agent that passes by writing its own version of your API still counts against it. `validate` warns about every rule that no task exercises.

## Run evals

The platform maintains one eval profile that maps each model alias to its model and to the routes that reach it. Point the toolkit at it with `--profile`, or set `DE_WEB_SDK_EVAL_PROFILE`. To see which route reaches each model on your machine:

```sh
npx --no de-web-sdk-pack eval doctor
```

Evals run in the pipeline and on your own machine, and local results count toward the gate the same way. Locally, Claude models run through your own Claude Code sign-in. Copilot's models run through the SDK's VS Code extension. Install its VSIX from Artifactory, then run "de-web-sdk: Run pack evals with Copilot models" from the Command Palette, or start the eval bridge and run:

```sh
npx --no de-web-sdk-pack eval run --local
```

Before a local run starts, the runner shows how many trials will use your quota and asks you to confirm. Pass `--yes` to confirm without a terminal. Trials can edit only their own worktree and run only the SDK's `resolve` and `check`, the task's `build`, and any commands the task lists. Other commands are refused and the trial continues. The runner paces requests through VS Code to stay within Copilot's rate limits.

Each run records its trials in `evals/runs/`, which you commit. Raw transcripts and diffs stay in `evals/.cache/`, which the runner adds to `.gitignore`. When the task, starting state, driver, route, model, and agent version haven't changed, the runner reuses earlier no-pack and published-version results. A new candidate then runs only its own trials. A trial is retried once only when the driver fails before the agent acts.

Once a version of your pack is published, trials also run with that version. They install it under the trust policy in your pack repo's `.de-web-sdk/trust.json`, so list your scope's public key there, or extend the enterprise trust policy. The runner checks that the published version verifies before any trial starts. Pass `--published none` to skip the comparison.

## Pass the gate

`build` passes when neither the pass rate nor API adoption is lower with your candidate than without the pack, for every required model. It uses a one-sided Fisher's exact test at the profile's confidence level, 95% by default, and needs at least 20 trials per condition by default. Each model's decision uses its most recent run with enough trials. If a result is wrong, the owner can record an expiring override in `evals/config.json`:

```json
"overrides": [{ "model": "copilot-gpt", "reason": "The grader rejects valid lazy routes; fix tracked in #57.", "approvedBy": "analytics-lead", "expires": "2026-11-30" }]
```

The published manifest carries each required model's rates, where its trials ran, and any override, and `sync` shows overrides to consumers.

## Review trials

Graders miss things, so review trials without seeing which condition produced them:

```sh
npx --no de-web-sdk-pack eval review
```

Agree or disagree with each grader verdict, give a reason, and count any claims your pack's content doesn't support. Reviews are stored under `evals/reviews/`, and the next report lists disagreements first. In VS Code, "de-web-sdk: Review eval trials" opens each change in the diff editor. `eval review --compare` shows the candidate's and the published version's results for one task as A and B, and stores your choice with the reason.

Guided trials measure how far the reference harness is from real Copilot. "de-web-sdk: Start a guided Copilot trial" opens a trial worktree in a new window and gives Copilot's agent mode the prompt. When the agent finishes, run "de-web-sdk: Mark this guided trial finished". The report shows guided results beside the harness's results, and they don't count toward the gate.

## Turn feedback into eval tasks

Import each consumer report, then draft a task from it:

```sh
npx --no de-web-sdk-pack feedback import report.json
npx --no de-web-sdk-pack eval add --from-feedback <report id>
```

The drafted task references the report's rule and message. Edit its prompt and starting state so it reproduces the problem. The report resolves when that task passes at the profile's threshold, 80% by default, on every required model. `feedback list` shows open reports by rule.

## Build, sign, and publish

```sh
npx --no de-web-sdk-pack validate
npx --no de-web-sdk-pack build --out dist-pack
```

`build` validates the pack, rejects hidden characters in every published text file, and records each published file's SHA-256 digest in `pack.json`, along with the eval summary. It then applies the eval gate and writes an npm tarball. Two builds of the same content produce byte-identical manifests. Keep evals, fixtures, and feedback out of the tarball with the `files` list in `package.json`. After a build, editing a published file makes `validate` warn and `sign` refuse until you build again.

Internal packs publish to Artifactory, where npm provenance isn't available, so sign the built manifest with your scope's key. Create the key pair once and keep the private key in the pipeline's secret store:

```sh
npx --no de-web-sdk-pack keygen --out keys
npx --no de-web-sdk-pack sign --key env:PACK_SIGNING_KEY --out dist-pack
```

The new pack's `.gitignore` excludes `keys/`, and `keygen` warns when git would commit the private key. `sign` writes `pack.sigstore.json` in the Sigstore bundle format, which standard Sigstore verifiers accept with your public key, and rebuilds the tarball. The new pack's `files` list already includes it. `keygen` prints the trust policy entry for your public key. The platform adds it to the enterprise trust policy for your scope, and repos pick it up with their next dependency update.

Open-source packs published from CI with npm provenance need no signature. The trust policy then lists your source repository and release workflow for your scope.

Publish with the standard npm client:

```sh
npm publish ./dist-pack/example-analytics-tracking-pack-0.1.0.tgz
```

Keep the `./`. Without it, npm reads `dist-pack/...` as a GitHub repository. npm publishes to the registry that your npm configuration names for the pack's scope.

The shared Jules pipeline's producer flavor runs `validate`, the evals, `build`, `sign`, and `npm publish` in that order, and holds the signing keys and model credentials.
