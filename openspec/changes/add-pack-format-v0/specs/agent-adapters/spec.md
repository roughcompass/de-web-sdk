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

`sync` SHALL write the entry points that tools read from the repository. They are a delimited block in AGENTS.md and the instruction files that Claude Code and GitHub Copilot load. The entry points SHALL list every applicable rule with a one-line summary, and SHALL point to detail rather than copy it. They SHALL name the commands an agent runs to get rules for specific files, check its work, and report feedback. They SHALL also list the agent commands that packs declare. The AGENTS.md block SHALL stay within a line budget, 40 lines by default. `sync` SHALL preserve all content outside the blocks it manages.

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
- **THEN** the loaded block tells it to run `resolve` before editing and `check` before finishing

#### Scenario: Agent without installed dependencies

- **WHEN** an agent reads the repo without installing dependencies, such as a review bot
- **THEN** the committed entry points still show every applicable rule's summary

### Requirement: Content stays in its package

Rule detail, skills, and reference docs SHALL stay in the installed packages that ship them. `sync` SHALL point or link to that content instead of copying it into the repo. It SHALL write the files it generates for linking to paths that a managed block in the repo's ignore file lists.

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

`sync` SHALL write the files that Claude Code loads. A Claude Code session in the repo SHALL receive the managed block and be able to open the rule detail it points to.

#### Scenario: New Claude Code session

- **WHEN** a developer starts a Claude Code session in a repo after `sync`
- **THEN** the managed block is part of the context Claude Code loads at startup

### Requirement: GitHub Copilot entry points

`sync` SHALL write the files that GitHub Copilot loads. Copilot SHALL receive the managed block. Where Copilot supports instructions scoped to file paths, rules with path patterns SHALL be written as scoped instructions.

#### Scenario: Path-scoped rule

- **WHEN** a rule applies only to files matching `src/remotes/**`
- **THEN** Copilot receives that rule when it works on a matching file
- **AND** Copilot does not receive it for other files

### Requirement: Pack skills

`sync` SHALL make each applicable skill from the repo's packs available to every target tool that supports Agent Skills, by linking to the installed skill. Each installed skill's name SHALL include its pack's name, so skills from different packs can't collide. `sync` SHALL NOT install a skill whose content another installed skill already carries, and SHALL report the existing copy.

#### Scenario: Migration skill

- **WHEN** the runtime pack ships an MF2 migration skill that applies only to MF1 repos
- **THEN** `sync` installs the skill in an MF1 repo
- **AND** it doesn't install the skill in an MF2 repo

#### Scenario: Two packs ship skills with the same name

- **WHEN** two packs each ship a skill named `setup`
- **THEN** `sync` installs both, each under a name that includes its pack

#### Scenario: Skill already installed by the producer's own tooling

- **WHEN** a producer's own setup already installed a skill with the same content
- **THEN** `sync` doesn't install a second copy
- **AND** it reports the existing copy and where it came from

### Requirement: Check-and-fix skill

For each target tool that supports Agent Skills, `sync` SHALL generate a check-and-fix skill. The skill SHALL direct the agent to run `resolve` for the files it will change and `check` after changing them. It SHALL direct the agent to apply each fix until no new violations remain. When the developer disputes a rule, the skill SHALL direct the agent to offer a feedback report.

#### Scenario: Agent fixes a violation

- **WHEN** an agent follows the generated skill in a repo with one new violation
- **THEN** it runs `check`, applies the reported fix, and reruns `check` until `check` exits with 0

#### Scenario: Developer disputes a rule

- **WHEN** a developer tells the agent that a reported rule is wrong
- **THEN** the agent offers to create a feedback report with the developer's reason

### Requirement: Generated files are marked and deterministic

Every generated file SHALL carry a notice that names the generator and says not to edit the file, placed where the file's format allows. Rerunning `sync` with the same installed packs SHALL produce byte-identical output.

#### Scenario: Regeneration

- **WHEN** `sync` runs twice with the same installed packs
- **THEN** every generated file is byte-identical across both runs

#### Scenario: File with frontmatter

- **WHEN** `sync` generates a skill file that must start with frontmatter
- **THEN** the notice appears inside the frontmatter, and the file stays valid
