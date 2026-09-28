# Spec Delta: mcp-server

## Purpose

Gives agents that support the Model Context Protocol (MCP) the SDK's rules, checks, skills, docs, and feedback through a local server. Its results match the CLI's.

## ADDED Requirements

### Requirement: Local server

The SDK SHALL provide a local MCP server that agent tools start for a repo. The server SHALL find the repo from the agent tool's project directory or roots, and otherwise from its working directory. It SHALL give agents instructions that match the workflow in the repo's AGENTS.md block.

#### Scenario: Agent tool starts the server

- **WHEN** Claude Code or VS Code starts the server in a repo after `sync`
- **THEN** the agent sees tools for rules, checks, skills, pack files, and feedback
- **AND** it receives the server's instructions

#### Scenario: Started outside the repo

- **WHEN** an agent tool starts the server with the repo as its project directory but another working directory
- **THEN** the server serves that repo's rules

### Requirement: Same results as the CLI

The server's rules tool SHALL return what `resolve` returns for the same files, and its check tool SHALL return what `check` returns. New violations SHALL be a normal result. A configuration, trust, integrity, or adapter error SHALL be reported as a tool error with the same diagnostics the CLI prints.

#### Scenario: Rules for a file

- **WHEN** an agent asks the server for the rules for `src/app.tsx`
- **THEN** the JSON result equals the JSON that `resolve src/app.tsx` prints

#### Scenario: Tampered pack

- **WHEN** an installed pack fails verification and an agent calls any tool
- **THEN** the tool returns an error that names exit code 3

### Requirement: Read-only except feedback

No server tool SHALL write repo files or change the repo's configuration. Only the tool that sends feedback SHALL reach outside the machine.

#### Scenario: Check through the server

- **WHEN** an agent runs a check through the server
- **THEN** the repo's working tree is unchanged

### Requirement: Content verified when served

The server SHALL serve skills and other pack files only from collected packs. It SHALL verify each file against its pack's digest when it serves it, and SHALL refuse a file that changed after install.

#### Scenario: Skill edited after install

- **WHEN** a developer edits an installed skill file and an agent asks the server for it
- **THEN** the server returns a trust error that says the file changed after install

#### Scenario: File outside the packs

- **WHEN** an agent asks the server for a repo file that no pack delivers
- **THEN** the server refuses it

### Requirement: Skills and workflows as prompts

The server SHALL offer each applicable skill as a prompt that returns the skill's verified instructions. It SHALL offer a check-and-fix prompt that tells the agent to get the rules, make the change, and check until no new violations remain.

#### Scenario: Developer invokes a skill

- **WHEN** a developer picks a pack's skill from the agent tool's prompt list
- **THEN** the agent receives the skill's instructions from the verified pack

### Requirement: Confirmation before sending feedback

The server SHALL send a feedback report only when its submit tool is called for a draft that the server created. Calling the submit tool SHALL be the confirmation, whether the developer or an agent acting for them calls it. Drafting a report SHALL send nothing, and each draft SHALL be sent at most once.

#### Scenario: Agent submits for the developer

- **WHEN** an agent working for a developer drafts a report and then submits the draft
- **THEN** the server sends it through the pack's feedback adapter and returns the reference it received

#### Scenario: Draft only

- **WHEN** an agent drafts a report and doesn't submit it
- **THEN** nothing is sent
