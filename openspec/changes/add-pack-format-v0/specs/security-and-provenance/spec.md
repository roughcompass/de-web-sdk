# Spec Delta: security-and-provenance

## Purpose

Ensures that consumers use pack content, and run adapter code, only from approved sources whose provenance and content they can verify.

## ADDED Requirements

### Requirement: Trust policy

A consumer repo SHALL have a trust policy that lists the npm scopes it accepts packs from. For each scope, it SHALL list the provenance identities or public keys it trusts. The SDK SHALL load packs only from listed scopes. The repo's local pack is exempt, because it changes only through the repo's own pull requests.

#### Scenario: Pack from an unlisted scope

- **WHEN** `sync` finds an installed standalone pack whose npm scope is not in the trust policy
- **THEN** `sync` fails and names the scope

### Requirement: Enterprise trust policy

A repo's trust policy MAY extend the enterprise trust policy, which is published as a signed package. The SDK SHALL verify that package against root keys built into the SDK.

#### Scenario: New producer without an SDK release

- **WHEN** the enterprise trust policy adds a producer's scope and identity
- **AND** a repo upgrades to that version and runs `sync`
- **THEN** the repo accepts packs from that scope with no new SDK version

#### Scenario: Tampered enterprise trust policy

- **WHEN** the installed enterprise trust policy fails verification against the root keys
- **THEN** `sync` and `check` fail and name the trust policy package

### Requirement: Provenance verification

`sync` and `check` SHALL verify each published pack's provenance before using it. Accepted provenance SHALL be npm provenance from an identity that the trust policy lists for the pack's scope. A signature in the Sigstore bundle format from a listed key SHALL also count.

#### Scenario: Public package with npm provenance

- **WHEN** a pack carries npm provenance from the source repository and workflow that the trust policy lists for its scope
- **THEN** `sync` accepts the pack without an SDK signature

#### Scenario: No provenance

- **WHEN** an installed pack has neither npm provenance nor a signature
- **THEN** `sync` and `check` fail and name the pack

#### Scenario: Provenance from an unlisted identity

- **WHEN** a pack's provenance comes from a repository, workflow, or key that the trust policy doesn't list for its scope
- **THEN** `sync` and `check` fail and name the pack and the identity

#### Scenario: Adapter pack without provenance

- **WHEN** a machine rule's adapter comes from an installed pack without provenance
- **THEN** `check` fails before running any adapter

### Requirement: Content from dependencies

Content that a pack references in another package SHALL come from a package that passes the same trust and provenance checks.

#### Scenario: Referenced package without provenance

- **WHEN** a pack references a skill in a package that has no provenance
- **THEN** `sync` fails and names both packages

### Requirement: File digest verification

`sync` and `check` SHALL verify every installed pack file against the digest in the pack's manifest, on every run.

#### Scenario: File edited after install

- **WHEN** a pack file in the installed dependencies is edited
- **THEN** `sync` and `check` fail and name the file

### Requirement: Pinning through the package manager

The SDK SHALL rely on the repo's package-manager lockfile to pin pack versions and their integrity. It SHALL NOT keep a lock file of its own.

#### Scenario: Dependency update

- **WHEN** a dependency-update pull request bumps a pack's version
- **THEN** `check` passes or fails on the new version's rules, and no SDK file needs updating first

### Requirement: Hidden character rejection

The SDK SHALL reject any text file that a pack delivers to agents when the file contains a hidden character. This SHALL include files that the pack references in other packages. It SHALL name the file, line, and code point. Hidden characters are:

- Unicode tag characters, U+E0000 to U+E007F
- Bidirectional controls, U+202A to U+202E and U+2066 to U+2069
- Zero-width characters, U+200B to U+200D, U+2060, and U+FEFF

#### Scenario: Tag characters in guidance

- **WHEN** an installed pack's guidance file contains characters in the range U+E0000 to U+E007F
- **THEN** `sync` fails and names the file, line, and first code point found

### Requirement: Fail closed

A trust failure SHALL stop `sync` and `check` before any output is written or any adapter runs. Generated agent files SHALL stay unchanged.

#### Scenario: Tampered pack during regeneration

- **WHEN** `sync` runs in a repo with existing generated agent files and one pack fails verification
- **THEN** `sync` exits with a nonzero code
- **AND** the existing generated files are unchanged
