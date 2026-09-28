# Spec Delta: composition

## Purpose

Defines how `sync` assembles one rule set for a repo from its packs and facts, and what a repo can override.

## ADDED Requirements

### Requirement: Pack sources

`sync` SHALL collect the repo's direct dependencies that are packs, including dev dependencies. It SHALL also collect packs embedded in those dependencies, every pack that a collected pack depends on, and the repo's local pack. It SHALL NOT collect packs embedded in indirect dependencies.

#### Scenario: Baseline bundle

- **WHEN** a repo installs a bundle that depends on two rules packs
- **THEN** the rule set includes the rules of both packs

#### Scenario: Library upgrade brings matching rules

- **WHEN** a repo upgrades a library that embeds a pack from 3.x to 4.x
- **THEN** the next `sync` collects the 4.x rules with no separate pack install

#### Scenario: Pack embedded in an indirect dependency

- **WHEN** a dependency of one of the repo's dependencies embeds a pack
- **THEN** `sync` doesn't collect that pack

#### Scenario: Embedded pack from an unlisted scope

- **WHEN** a direct dependency embeds a pack from a scope that the trust policy doesn't list
- **THEN** `sync` skips the pack and reports the package and its scope

### Requirement: Rule identity

Consumers SHALL identify each rule by its pack and its identifier. Local rules SHALL use `local` as their pack.

#### Scenario: Same rule identifier in two packs

- **WHEN** two collected packs each define a rule named `no-raw-values`
- **THEN** both rules apply, and every output names each rule with its pack

### Requirement: Detected facts

`sync` SHALL detect the React version, the bundler and its version, the Module Federation generation, and whether the repo is a host, a remote, or both. Supported bundlers are Vite, webpack, and Rspack. The Module Federation generation is none, Module Federation 1 (MF1), or Module Federation 2 (MF2). Package versions SHALL be the exact installed versions that the lockfile and installed packages show. When `sync` can't read the layout, it SHALL report the limitation and treat those versions as unknown. Detection SHALL NOT execute repo code.

#### Scenario: Vite remote on MF2

- **WHEN** `sync` runs in a Vite repo that exposes modules through MF2
- **THEN** it reports Vite, MF2, and the remote role

#### Scenario: webpack host on MF1

- **WHEN** `sync` runs in a webpack repo that consumes remotes through MF1
- **THEN** it reports webpack, MF1, and the host role

#### Scenario: Layout that can't be read

- **WHEN** a repo uses Yarn Plug'n'Play
- **THEN** `sync` reports that it can't read exact versions, without running the Plug'n'Play loader
- **AND** it treats package versions as unknown

#### Scenario: Fact that can't be detected

- **WHEN** `sync` can't determine a fact and the repo doesn't declare it
- **THEN** it records the fact as unknown
- **AND** it excludes rules that depend on that fact and reports each exclusion

### Requirement: Declared facts

The repo's configuration MAY declare facts. A declared fact SHALL take precedence over the detected value, and `sync` SHALL report each disagreement.

#### Scenario: New project before code exists

- **WHEN** a new repo declares that it is an MF2 remote and has no federation config yet
- **THEN** rules for MF2 remotes apply

#### Scenario: Migration in progress

- **WHEN** a repo declares MF2 while detection finds MF1
- **THEN** rules for MF2 apply
- **AND** `sync` reports the disagreement

### Requirement: Applicability

`sync` SHALL apply the conditions of every collected pack, rule, and skill to the repo's facts and file paths. A pack that governs packages SHALL apply only if each governed package is installed at a version inside its range. `sync` SHALL list every excluded pack, rule, and skill with the reason.

#### Scenario: MF2-only rule in an MF1 repo

- **WHEN** a rule applies only to MF2 repos and the repo uses MF1
- **THEN** `sync` excludes the rule and names the condition that failed

#### Scenario: Rule scoped to file paths

- **WHEN** a rule declares file path patterns
- **THEN** the rule applies only to files that match them

#### Scenario: Governed package outside the range

- **WHEN** a pack governs a package at `^3.0.0` and the repo has version 2.4.1 installed
- **THEN** `sync` excludes the pack and reports the installed version and the declared range

### Requirement: Local rules

A repo MAY define local rules, skills, and adapters in a local pack that it commits. The local pack SHALL follow the pack format and SHALL apply only to that repo. It SHALL NOT need an identifier, a version, a signature, file digests, or eval tasks. `sync` SHALL validate the local pack and report each error with its file and field.

#### Scenario: Repo convention

- **WHEN** a repo adds a local rule named `use-api-client` for files under `src/api/**`
- **THEN** `resolve`, `check`, and the generated agent files include the rule as `local#use-api-client`

#### Scenario: Invalid local pack

- **WHEN** the local pack contains a rule with no rationale
- **THEN** `sync` fails and names the file and the field

### Requirement: Recorded exceptions

The repo's configuration MAY record exceptions. Each exception SHALL name a rule, an owner, a reason, and an expiry date, and MAY limit itself to file paths. `check` SHALL skip violations that an active exception covers, list active exceptions in its output, and fail on an expired exception.

#### Scenario: Active exception

- **WHEN** an active exception covers a violation
- **THEN** `check` doesn't fail on the violation
- **AND** the output lists the exception

#### Scenario: Expired exception

- **WHEN** an exception's expiry date has passed
- **THEN** `check` fails and names the exception and its owner

#### Scenario: Exception without a reason

- **WHEN** an exception has no reason
- **THEN** `check` reports a configuration error

### Requirement: Locked rules

An exception to a locked rule SHALL also name who approved it and link to the approval. `check` SHALL report a configuration error for an exception to a locked rule that lacks either.

#### Scenario: Unapproved exception to a locked rule

- **WHEN** an exception covers a locked rule and names no approver
- **THEN** `check` reports a configuration error that names the rule and its owner

#### Scenario: Approved exception to a locked rule

- **WHEN** an exception to a locked rule names an approver and links to the approval
- **THEN** `check` skips the covered violations and lists the approval in its output

### Requirement: Ignored paths

The repo's configuration MAY list paths for `check` to ignore, each with a reason. `check` SHALL report how many files it ignored. Ignored paths SHALL NOT apply to locked rules.

#### Scenario: Generated code

- **WHEN** the configuration ignores `src/generated/**`
- **THEN** `check` reports no violations in those files and states how many files it ignored

#### Scenario: Locked rule in an ignored path

- **WHEN** a locked rule finds a violation in an ignored path
- **THEN** `check` reports the violation

### Requirement: No silent opt-out

A repo SHALL NOT turn off a pack's rule. Recorded exceptions and ignored paths SHALL be the only ways to set a rule aside, and `check` SHALL list both in its output.

#### Scenario: Rule turned off in configuration

- **WHEN** the repo's configuration tries to turn off a pack's rule
- **THEN** `sync` reports a configuration error that points to recorded exceptions and ignored paths
