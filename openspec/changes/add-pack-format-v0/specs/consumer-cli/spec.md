# Spec Delta: consumer-cli

## Purpose

Gives developers, templates, pipelines, and agents commands to set up a repo, get the rules that apply, check conformance, and send feedback.

## ADDED Requirements

### Requirement: One-command setup

`init` SHALL create the repo's SDK configuration and trust policy when they are missing. It SHALL add any packs the caller names as dev dependencies, using the repo's package manager. It SHALL record any facts the caller declares, then run `sync`. It SHALL NOT change source files or CI configuration.

#### Scenario: Existing repo

- **WHEN** a developer runs `init` in an existing repo and names a baseline bundle
- **THEN** the bundle becomes a dev dependency, the configuration and trust policy exist, and `sync` has run
- **AND** no source file changes

#### Scenario: Project template

- **WHEN** the platform's project template runs `init` without a terminal, naming packs and declaring facts
- **THEN** `init` completes without prompting

### Requirement: Sync

`sync` SHALL verify installed packs, assemble the repo's rule set as the composition capability defines, and regenerate agent files. It SHALL NOT enforce rules. It SHALL NOT change source files, dependency manifests, CI configuration, or the repo's SDK configuration and trust policy.

#### Scenario: After a pack upgrade

- **WHEN** a developer runs `sync` after a pack upgrade
- **THEN** the generated agent files reflect the new version

#### Scenario: Repeat run without changes

- **WHEN** `sync` runs twice with no changes to packs or the repo
- **THEN** the second run changes no files

### Requirement: Rules for specific files

`resolve` SHALL return the rules that apply to the files it is given, or to the whole repo when given none. It SHALL write Markdown by default and JSON on request. Each rule SHALL include its pack, identifier, enforcement mode, guidance, and check. The output SHALL also list the applicable skills, reference docs, and agent commands from the repo's packs, with each item's description and installed path. It SHALL stay within a byte budget, 16 KiB by default, and SHALL name anything it omits with the command that returns it.

#### Scenario: Path-scoped rule

- **WHEN** a rule applies only to files matching `src/remotes/**`
- **AND** an agent runs `resolve` for `src/remotes/cart.tsx` and `src/app.tsx`
- **THEN** the output lists the rule for `src/remotes/cart.tsx` only

#### Scenario: Output over budget

- **WHEN** the applicable rules don't fit in the budget
- **THEN** `resolve` returns the rules that fit and names each omitted rule with the command that returns it

### Requirement: Check exit codes

`check` SHALL run every applicable machine rule. In enforce mode, it SHALL exit with:

- Exit code 0 when there are no new violations
- Exit code 1 when there are new violations
- Exit code 2 on a usage or configuration error
- Exit code 3 on a trust, integrity, or check adapter error, or when a rule can't be evaluated

#### Scenario: New violation

- **WHEN** `check` in enforce mode finds a violation that is not in the baseline
- **THEN** it exits with 1

#### Scenario: Adapter error

- **WHEN** a check adapter can't evaluate a rule in enforce mode
- **THEN** `check` exits with 3 and names the rule and the adapter error

### Requirement: Self-explaining violations

Each violation that `check` reports SHALL include the rule identifier, the rule owner, the rationale, the location, a fix, and how to contest the rule.

#### Scenario: Violation output

- **WHEN** `check` reports a violation
- **THEN** the output contains all six items for that violation

### Requirement: Output formats

`check` SHALL write human-readable text by default. On request, it SHALL write JSON, SARIF 2.1.0, or a JUnit XML report that Jenkins-compatible CI systems can display. All JSON output SHALL carry a schema version, and removing or renaming a field SHALL require a new major schema version. JSON output SHALL contain no absolute paths or source text. Text output for agents SHALL quote values that come from the repo as data.

#### Scenario: JUnit report

- **WHEN** `check` runs with the JUnit format
- **THEN** each applicable machine rule appears as a test case
- **AND** each rule with new violations appears as a failed test case that lists them

#### Scenario: No source text in JSON

- **WHEN** `check` writes JSON for a violation
- **THEN** the output locates the violation by relative path and line, and quotes no source text

### Requirement: Resolution record

On request, `check` SHALL write a resolution record. The record SHALL list each collected pack's identifier, version, and manifest digest, the repo's facts, the active exceptions and ignored paths, and the results.

#### Scenario: Audit of a pull request

- **WHEN** the pipeline stores the resolution record for a pull request
- **THEN** an auditor can read which rules applied and which exceptions were active, without rerunning `check`

### Requirement: No prompts without a terminal

No command SHALL prompt for input when it runs without an interactive terminal or with `--yes`. A command that needs a missing answer SHALL fail with a message that names the flag to supply.

#### Scenario: Agent runs setup

- **WHEN** an agent runs `init` without a terminal and names no packs
- **THEN** `init` completes without prompting
- **AND** it reports that no packs are installed

### Requirement: Works offline

`sync`, `resolve`, and `check` SHALL work without network access once packs are installed.

#### Scenario: Sandboxed agent

- **WHEN** an agent runs `sync`, `resolve`, and `check` with network access blocked
- **THEN** each command completes

### Requirement: Feedback reports

`feedback` SHALL create a report for a rule that includes the pack, its version, the rule, the kind of feedback, and the reporter's message. It SHALL print the pack's feedback link, with the report filled in when the channel accepts it, and the report itself otherwise. The report SHALL NOT include file contents unless the reporter names the lines to include.

#### Scenario: Disputed rule

- **WHEN** a developer reports a rule as a false positive with a message
- **THEN** `feedback` prints a link to the pack's feedback channel with the report filled in

#### Scenario: Channel without prefilled links

- **WHEN** a pack's feedback channel is a support page that accepts no prefilled content
- **THEN** `feedback` prints the page's link and the report for the developer to paste

#### Scenario: No code by default

- **WHEN** a developer creates a report without naming any lines
- **THEN** the report contains no file contents
