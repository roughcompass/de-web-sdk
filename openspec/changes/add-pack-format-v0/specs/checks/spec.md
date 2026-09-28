# Spec Delta: checks

## Purpose

Defines the contract between machine rules and check adapters, and how `check` loads and runs adapters that producers publish in packs.

## ADDED Requirements

### Requirement: Check adapter contract

A check adapter SHALL receive the repo root, the repo's facts, and the rule's options. It SHALL return each violation as a SARIF 2.1.0 result, with a relative location and a partial fingerprint as its stable key.

#### Scenario: Unrelated edit above a violation

- **WHEN** lines are added above a violation in the same file
- **THEN** the violation's stable key does not change

#### Scenario: Adapter that wraps a producer's analyzer

- **WHEN** an adapter calls a producer's own analyzer, which already returns SARIF
- **THEN** `check` reports the analyzer's findings as violations without a conversion step

### Requirement: Adapters load from verified packs

`check` SHALL load an adapter only from the rule's own pack or from a pack that the rule's pack declares as a dependency. The adapter's pack SHALL have passed provenance verification, unless it is the repo's local pack.

#### Scenario: Adapter from a dependency pack

- **WHEN** a machine rule uses an adapter from a pack that its own pack declares as a dependency
- **AND** both packs pass trust verification
- **THEN** `check` runs the adapter for that rule

#### Scenario: Adapter pack not installed

- **WHEN** a machine rule's adapter comes from a pack that is not installed
- **THEN** `check` reports an adapter error that names the missing pack

#### Scenario: New kind of check

- **WHEN** a producer publishes a pack with an adapter that the SDK has never seen
- **THEN** consumer repos that install the pack run the adapter without a new SDK version

### Requirement: Adapter isolation

`check` SHALL run each adapter in a separate process that cannot write files, start processes, or create worker threads. The process SHALL be able to read the repo, the adapter's package, and the installed packages that the adapter can import. This SHALL include adapters from the local pack. Each adapter run SHALL have a time limit, 60 seconds by default.

#### Scenario: Adapter tries to change the repo

- **WHEN** an adapter tries to write a file or start a process
- **THEN** the attempt fails with an access error
- **AND** no file in the repo changes

#### Scenario: Adapter with its own dependency

- **WHEN** a producer's fixture runs an adapter that imports a package its pack depends on
- **THEN** the import succeeds, though the fixture sits outside the producer's `node_modules`

#### Scenario: Adapter exceeds the time limit

- **WHEN** an adapter runs longer than the time limit
- **THEN** `check` stops the adapter and reports an adapter error that names it

### Requirement: Adapter errors are distinct from results

When an adapter can't evaluate a rule, `check` SHALL report an adapter error. It SHALL NOT report the rule as passing or as violated.

#### Scenario: Missing input

- **WHEN** an adapter's required input file does not exist
- **THEN** `check` reports an adapter error that names the missing file

#### Scenario: Adapter crashes

- **WHEN** an adapter exits with an unhandled error
- **THEN** `check` reports an adapter error that names the adapter
