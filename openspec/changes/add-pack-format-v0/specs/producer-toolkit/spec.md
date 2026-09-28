# Spec Delta: producer-toolkit

## Purpose

Gives producers commands to scaffold, validate, build, and sign a pack before they publish it to an npm-compatible registry.

## ADDED Requirements

### Requirement: Scaffold a pack

The toolchain SHALL create a new pack from an identifier, an owner, and a feedback channel. The new pack SHALL pass validation and SHALL include one example rule, its guidance, an eval configuration, and one eval task.

#### Scenario: New pack passes validation

- **WHEN** a producer scaffolds a pack and validates it without edits
- **THEN** validation succeeds

### Requirement: Validate a pack

The toolchain SHALL validate a pack against the pack format specification and report every error in one run. Each error SHALL name the file and the field.

#### Scenario: Several errors

- **WHEN** a producer validates a pack with three invalid fields in two files
- **THEN** the command exits with a nonzero code
- **AND** it reports all three errors with their files and fields

### Requirement: Build a pack

Building a pack SHALL compute a digest for every published file and write the digests and the eval summary into the manifest. It SHALL also produce an npm package tarball. For a pack with rules, building SHALL require a passing eval gate, as the evals-and-telemetry capability defines. The build SHALL be deterministic.

#### Scenario: Repeat build

- **WHEN** a producer builds the same pack contents twice
- **THEN** both builds produce byte-identical manifests

#### Scenario: No eval results for this content

- **WHEN** a producer builds a pack with rules and no eval report matches its content
- **THEN** the build fails and says to run the evals

### Requirement: Reject hidden characters at build time

Building a pack SHALL fail when any text file contains a hidden character defined by the security-and-provenance capability.

#### Scenario: Zero-width space in a rule

- **WHEN** a rule's guidance file contains U+200B
- **THEN** the build fails and names the file, the line, and the code point

### Requirement: Sign a pack

Where the registry or CI can't produce npm provenance, the toolchain SHALL sign the built manifest with the producer's key, in the Sigstore bundle format. The signature SHALL fail to verify if any byte of the manifest changes. The toolchain SHALL refuse to sign a manifest whose digests don't match the published files. It SHALL create a producer key pair on request. It SHALL write the private key readable only by its owner, and SHALL refuse to replace an existing private key.

#### Scenario: Signature over an unchanged manifest

- **WHEN** a producer signs a built pack
- **THEN** the signature verifies with the producer's public key

#### Scenario: Manifest changed after signing

- **WHEN** one byte of a signed manifest changes
- **THEN** the signature fails to verify

#### Scenario: File edited after the build

- **WHEN** a producer edits a published file after building and then signs
- **THEN** signing fails and names the changed file
- **AND** validation warns that the pack needs a new build

#### Scenario: Private key that git would commit

- **WHEN** a producer creates a key pair inside a git repository, in a folder git doesn't ignore
- **THEN** the toolchain warns that git would commit the private key

### Requirement: Publish through a standard npm registry

A built pack SHALL be publishable with the standard npm client to any npm-compatible registry, with npm provenance where the registry and CI support it. The toolchain SHALL NOT require a registry service of its own.

#### Scenario: Publish to Artifactory

- **WHEN** a producer publishes a signed pack to an Artifactory npm scope with `npm publish`
- **THEN** a consumer can install it with `npm install`
- **AND** the installed pack passes provenance and digest verification

#### Scenario: Publish to the public registry with provenance

- **WHEN** an open-source producer publishes a pack with npm provenance from its CI
- **THEN** consumers verify the pack without an SDK signature
