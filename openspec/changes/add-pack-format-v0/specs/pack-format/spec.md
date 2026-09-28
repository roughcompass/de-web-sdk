# Spec Delta: pack-format

## Purpose

Defines what a pack contains, so any producer, including open-source projects, can publish agent content that every consumer reads the same way.

## ADDED Requirements

### Requirement: Published format

The pack format SHALL be defined by a versioned JSON Schema at a stable public URL, and every manifest SHALL reference it. No field SHALL require a value that only one enterprise can supply.

#### Scenario: Producer without the SDK

- **WHEN** a producer outside the enterprise checks a manifest with a generic JSON Schema validator
- **THEN** the validator reports the same field errors that `validate` reports

### Requirement: Pack manifest

A pack SHALL include a manifest that declares its specification version, identifier, version, owner, and feedback channel. A published pack's identifier SHALL be the name of the npm package that contains it. The manifest MAY also declare packages the pack governs, each with a version range.

#### Scenario: Complete manifest

- **WHEN** a producer validates a pack whose manifest declares every required field
- **THEN** validation succeeds

#### Scenario: Missing required fields

- **WHEN** a producer validates a pack whose manifest omits the owner and the feedback channel
- **THEN** validation fails and names both missing fields

### Requirement: Rule metadata

Every rule SHALL declare an identifier that is unique within the pack, a rationale, and an enforcement mode of `machine` or `advisory`. A rule SHALL inherit the pack's owner and applicability unless it declares its own. A rule MAY be marked locked.

#### Scenario: Rule without a rationale

- **WHEN** a producer validates a pack containing a rule with no rationale
- **THEN** validation fails and names the rule

#### Scenario: Unknown enforcement mode

- **WHEN** a rule declares an enforcement mode other than `machine` or `advisory`
- **THEN** validation fails and lists the allowed values

#### Scenario: Inherited owner

- **WHEN** a rule declares no owner
- **THEN** consumers see the pack's owner as the rule's owner

### Requirement: Machine rules ship with a check

A rule with enforcement mode `machine` SHALL reference a check adapter and its options. The adapter SHALL come from the rule's own pack or from a pack that the rule's pack declares as a dependency. A rule with enforcement mode `advisory` SHALL appear in agent context and SHALL NOT cause a `check` failure.

#### Scenario: Machine rule without a check

- **WHEN** a producer validates a pack containing a `machine` rule that references no check adapter
- **THEN** validation fails and names the rule

#### Scenario: Adapter from an undeclared pack

- **WHEN** a machine rule references an adapter in a pack that its own pack does not declare as a dependency
- **THEN** validation fails and names the rule and the adapter's pack

#### Scenario: Advisory rule in a consumer repo

- **WHEN** a consumer runs `sync` and `check` in a repo where an advisory rule applies
- **THEN** the rule appears in the generated agent context
- **AND** `check` reports no failure for it

### Requirement: Machine rules ship with fixtures

Every machine rule SHALL have, in the pack's source repo, at least one positive fixture that violates the rule and one negative fixture that doesn't. Validation SHALL run the rule's check on them and fail unless the check flags every positive fixture and no negative fixture.

#### Scenario: Check misses a positive fixture

- **WHEN** a rule's check doesn't flag one of the rule's positive fixtures
- **THEN** validation fails and names the rule and the fixture

### Requirement: Packs can ship check adapters

A pack MAY include check adapters. Each adapter SHALL have a name that is unique within the pack and SHALL point to code inside the pack.

#### Scenario: Declared adapter without code

- **WHEN** a pack declares an adapter whose code file is missing
- **THEN** validation fails and names the adapter

### Requirement: Packs can ship skills

A pack MAY include skills in the Agent Skills format. Each skill SHALL have a name that is unique within the pack and a description.

#### Scenario: Skill without a description

- **WHEN** a producer validates a pack containing a skill with no description
- **THEN** validation fails and names the skill

### Requirement: Packs can ship reference docs

A pack MAY declare reference docs, such as Markdown guides or search indexes. Each doc entry SHALL have a title.

#### Scenario: Doc entry without a title

- **WHEN** a producer validates a pack containing a doc entry with no title
- **THEN** validation fails and names the entry

### Requirement: Packs can declare agent commands

A pack MAY declare commands that agents can run, each with a description of when to use it. Each command SHALL run a binary from the pack's package or from a package that the pack depends on.

#### Scenario: Command from an undeclared package

- **WHEN** a pack declares a command whose binary comes from a package that the pack doesn't depend on
- **THEN** validation fails and names the command

### Requirement: Content from dependencies

A pack MAY reference skills, reference docs, and adapters that live in another package. That package SHALL be one that the pack lists as a dependency or a peer dependency.

#### Scenario: Wrapper pack

- **WHEN** a pack references a skill in a peer dependency
- **THEN** validation succeeds without the skill's files in the pack

#### Scenario: Reference to a package that isn't a dependency

- **WHEN** a pack references a doc in a package that it doesn't depend on
- **THEN** validation fails and names the package

### Requirement: Applicability conditions

A pack SHALL declare where it applies, using repo facts and file path patterns. Its rules, skills, reference docs, and commands SHALL inherit that applicability unless they declare their own. Facts SHALL include package versions, the bundler, the Module Federation generation, and whether the repo is a host or a remote.

#### Scenario: Condition on an undefined fact

- **WHEN** a rule declares a condition on a fact that the specification doesn't define
- **THEN** validation fails and names the fact

### Requirement: Pack dependencies

A pack MAY depend on other packs. A pack that only depends on other packs SHALL be valid without rules, skills, adapters, or eval tasks.

#### Scenario: Bundle

- **WHEN** a producer validates a pack that depends on two packs and declares nothing else
- **THEN** validation succeeds

### Requirement: Embedded packs

A library package MAY embed a pack in a directory that it names in its package manifest. The field that names the directory SHALL name the pack format, not an enterprise. An embedded pack SHALL follow the same format as a standalone pack.

#### Scenario: Named directory without a manifest

- **WHEN** a producer validates a library whose named pack directory contains no manifest
- **THEN** validation fails and names the directory

### Requirement: File digests

The manifest SHALL list every other file in the published pack with its SHA-256 digest.

#### Scenario: Unlisted file

- **WHEN** a pack contains a file that the manifest does not list
- **THEN** validation fails and names the file

#### Scenario: Digest mismatch

- **WHEN** a listed file's content does not match its digest
- **THEN** validation fails and names the file

### Requirement: Rules packs include eval tasks

A published pack that contains rules SHALL have at least one eval task in its source repo. Validation SHALL NOT require eval tasks for a pack that contains only adapters.

#### Scenario: Rules pack without evals

- **WHEN** a producer validates a pack that contains rules and no eval task
- **THEN** validation fails and states that at least one eval task is required

#### Scenario: Adapter-only pack

- **WHEN** a producer validates a pack that contains adapters and no rules
- **THEN** validation succeeds without eval tasks

### Requirement: Specification versions

A consumer SHALL refuse a pack whose specification major version it does not support. Within a supported major version, a consumer SHALL ignore manifest fields it doesn't recognize.

#### Scenario: Unsupported major version

- **WHEN** a consumer that supports specification version 0 finds a pack declaring version 1
- **THEN** it refuses the pack and names both versions

#### Scenario: Field from a newer minor version

- **WHEN** a pack uses a manifest field that a later minor version added
- **THEN** an older consumer ignores the field and uses the pack
