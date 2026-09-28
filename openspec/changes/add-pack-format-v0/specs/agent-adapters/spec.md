# Spec Delta: agent-adapters

## Purpose

Turns a repo's rule set into files that agents load, and points agents to the skills, docs, and commands that packs ship.

## ADDED Requirements

### Requirement: Target tools

The repo's configuration SHALL name the agent tools that get entry points, and SHALL default to every supported tool. `sync` SHALL remove the files it generated for a tool that the configuration no longer names.

#### Scenario: Copilot only

- **WHEN** the configuration names only GitHub Copilot
- **THEN** `sync` writes no Claude Code files

#### Scenario: Tool removed

- **WHEN** a repo removes Claude Code from its target tools
- **THEN** the next `sync` deletes the Claude Code files it generated
- **AND** it leaves files written by people unchanged

### Requirement: Committed entry points

`sync` SHALL write a delimited block in AGENTS.md, which Claude Code and GitHub Copilot both read. The block SHALL list every applicable rule, with a one-line summary and any path patterns. It SHALL list every applicable skill with its description. It SHALL point to detail rather than copy it. It SHALL name the MCP tools and matching commands that agents use to get rules, load a skill, check work, and report feedback. It SHALL also list the agent commands that packs declare, in a form that runs from the repo root. The AGENTS.md block SHALL stay within a line budget, 40 lines by default. `sync` SHALL preserve all content outside the blocks it manages.

#### Scenario: Existing AGENTS.md

- **WHEN** `sync` runs in a repo whose AGENTS.md has content written by people
- **THEN** that content is unchanged byte for byte
- **AND** the managed block is added or replaced

#### Scenario: No AGENTS.md

- **WHEN** `sync` runs in a repo without AGENTS.md
- **THEN** `sync` creates AGENTS.md containing only the managed block

#### Scenario: Budget exceeded

- **WHEN** the applicable rules would need more lines than the budget allows
- **THEN** the block lists pointers to rule groups instead of individual rules, and stays within the budget

#### Scenario: Agent that loads only AGENTS.md

- **WHEN** an agent tool that loads only AGENTS.md starts in the repo
- **THEN** the loaded block tells it to get the rules before editing and to check before finishing, through the MCP server or the CLI

#### Scenario: Agent without installed dependencies

- **WHEN** an agent reads the repo without installing dependencies, such as a review bot
- **THEN** the committed entry points still show every applicable rule's summary

#### Scenario: Pack command from an installed binary

- **WHEN** a pack declares a command whose binary its package provides
- **THEN** the block shows the command in a form an agent's shell can run from the repo root
- **AND** the command works though installed binaries aren't on the agent's PATH

### Requirement: MCP server entry

`sync` SHALL register the SDK's MCP server in the repo's MCP configuration, which Claude Code and VS Code both read. It SHALL keep every other server in it. A repo SHALL be able to turn the entry off in its configuration, and `sync` SHALL then remove it. `sync` SHALL leave MCP configuration it can't parse unchanged and warn.

#### Scenario: Repo with other MCP servers

- **WHEN** `sync` runs in a repo whose MCP configuration already lists another server
- **THEN** the configuration lists both servers, and the other server's entry is unchanged

#### Scenario: MCP server turned off

- **WHEN** a repo turns the SDK's MCP server off and runs `sync`
- **THEN** `sync` removes the SDK's entry

### Requirement: Content stays in its package

Rule detail, skills, and reference docs SHALL stay in the installed packages that ship them. `sync` SHALL point to that content instead of copying it into the repo, and SHALL install no skill files on the developer's machine.

#### Scenario: Large knowledge package

- **WHEN** a repo collects a pack whose reference docs total several megabytes
- **THEN** `sync` commits no copy of them, and the entry points point to the installed files

#### Scenario: Pack upgrade

- **WHEN** a dependency update changes a pack's guidance but not its rule list
- **THEN** no committed file changes

### Requirement: Stale entry points

`check` SHALL warn, without failing, when the committed entry points differ from what `sync` would write. The warning SHALL name the command that updates them.

#### Scenario: Rule added upstream

- **WHEN** a dependency update adds a rule and nobody has run `sync`
- **THEN** `check` evaluates the new rule
- **AND** it warns that the entry points are out of date and says to run `sync`

### Requirement: Claude Code entry points

A Claude Code session in the repo SHALL receive the managed block and be able to open the rule detail it points to. Claude Code reads AGENTS.md only when the repo has no CLAUDE.md. `sync` SHALL therefore add an AGENTS.md import to an existing CLAUDE.md that lacks one, and SHALL NOT create a CLAUDE.md.

#### Scenario: New Claude Code session

- **WHEN** a developer starts a Claude Code session in a repo after `sync`
- **THEN** the managed block is part of the context Claude Code loads at startup

#### Scenario: Repo with its own CLAUDE.md

- **WHEN** `sync` runs in a repo whose CLAUDE.md doesn't import AGENTS.md
- **THEN** `sync` adds the import in a managed block and leaves the rest of the file unchanged

### Requirement: GitHub Copilot entry points

GitHub Copilot SHALL receive the managed block through AGENTS.md. `sync` SHALL NOT write instruction files that only Copilot reads.

#### Scenario: Path-scoped rule

- **WHEN** a rule applies only to files matching `src/remotes/**`
- **THEN** the managed block lists the rule with its patterns
- **AND** `resolve` returns the rule only for matching files

### Requirement: Pack skills

Each applicable pack skill SHALL reach agents through the SDK: the MCP server and the `skill` command serve it from its verified pack. Each skill's name SHALL include its pack's name, so skills from different packs can't collide. `sync` SHALL remove skill files that earlier SDK versions generated, and SHALL leave skills that other tools installed unchanged.

#### Scenario: Migration skill

- **WHEN** the runtime pack ships an MF2 migration skill that applies only to MF1 repos
- **THEN** the AGENTS.md block lists the skill in an MF1 repo, and the SDK serves it there
- **AND** an MF2 repo's block doesn't list it

#### Scenario: Two packs ship skills with the same name

- **WHEN** two packs each ship a skill named `setup`
- **THEN** both are listed, each under a name that includes its pack

#### Scenario: Skill installed by other tooling

- **WHEN** a producer's own setup installed a skill in a tool's skill folder
- **THEN** `sync` leaves it unchanged

### Requirement: Check-and-fix workflow

The AGENTS.md block and the MCP server's check-and-fix prompt SHALL direct the agent to get the rules for the files it will change. They SHALL direct it to check after changing them. They SHALL direct the agent to apply each fix until no new violations remain. When the developer disputes a rule, they SHALL direct the agent to draft a feedback report and send it only with the developer's approval.

#### Scenario: Agent fixes a violation

- **WHEN** an agent follows the workflow in a repo with one new violation
- **THEN** it runs `check`, applies the reported fix, and reruns `check` until `check` exits with 0

#### Scenario: Developer disputes a rule

- **WHEN** a developer tells the agent that a reported rule is wrong
- **THEN** the agent drafts a feedback report with the developer's reason and asks before sending it

### Requirement: Generated files are marked and deterministic

Every generated file SHALL carry a notice that names the generator and says not to edit the file, placed where the file's format allows. Rerunning `sync` with the same installed packs SHALL produce byte-identical output.

#### Scenario: Regeneration

- **WHEN** `sync` runs twice with the same installed packs
- **THEN** every generated file is byte-identical across both runs

#### Scenario: JSON configuration

- **WHEN** `sync` writes its entry in the repo's MCP configuration, which JSON can't annotate
- **THEN** it changes only its own entry
