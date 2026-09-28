# Spec Delta: brownfield-adoption

## Purpose

Lets a repo adopt packs without failing its build, then reduces its existing violations over time.

## ADDED Requirements

### Requirement: Report and enforce modes

The repo's configuration SHALL put `check` in report mode or enforce mode. In report mode, `check` SHALL list violations and adapter errors and exit with 0. It SHALL still exit with 2 on a configuration error and 3 on a trust or integrity error. `init` SHALL choose report mode unless the caller asks for enforce mode.

#### Scenario: Existing repo right after setup

- **WHEN** the pipeline runs `check` in a repo that `init` just set up
- **THEN** the output lists the violations
- **AND** the step passes

#### Scenario: Trust error in report mode

- **WHEN** a pack fails verification in a repo that is in report mode
- **THEN** `check` exits with 3

#### Scenario: New project in enforce mode

- **WHEN** the platform template runs `init` in enforce mode
- **AND** the new repo's first pull request adds a violation
- **THEN** `check` fails that pull request

### Requirement: Record a baseline

`check --baseline` SHALL record every current violation in a baseline file that the repo commits, and SHALL exit with 0. With `--enforce`, it SHALL also switch the repo to enforce mode.

#### Scenario: First baseline

- **WHEN** a repo with 40 existing violations runs `check --baseline`
- **THEN** the baseline file lists all 40
- **AND** the command exits with 0

#### Scenario: Baseline and enforce together

- **WHEN** a developer runs `check --baseline --enforce`
- **THEN** the baseline records every current violation
- **AND** the configuration switches to enforce mode

### Requirement: Fail only on new violations

In enforce mode with a baseline, `check` SHALL fail only on violations that the baseline does not list. It SHALL report baselined violations separately. Without a baseline, every violation SHALL fail.

#### Scenario: Existing violation only

- **WHEN** every current violation is in the baseline
- **THEN** `check` exits with 0 and reports the baselined count

#### Scenario: New violation

- **WHEN** a pull request introduces a violation that the baseline does not list
- **THEN** `check` exits with 1 and reports only the new violation as failing

#### Scenario: No baseline file

- **WHEN** a repo in enforce mode has no baseline file, such as a new project
- **THEN** every violation fails `check`

### Requirement: Shrink-only baseline

Given a base git ref, `check` SHALL fail when the baseline lists any entry that the base ref's baseline does not. When the base ref has no baseline file, `check` SHALL pass and report that a new baseline is being introduced.

#### Scenario: Regenerated baseline hides a new violation

- **WHEN** a pull request regenerates the baseline to include a new violation
- **AND** `check` runs with the target branch as the base ref
- **THEN** `check` exits with 1 and names each added entry

#### Scenario: First adoption

- **WHEN** a pull request adds the first baseline file
- **THEN** `check` passes and reports that a new baseline is being introduced

### Requirement: Remove fixed entries

`check` SHALL report baseline entries that no longer match a violation. `check --prune-baseline` SHALL remove them.

#### Scenario: Violation fixed

- **WHEN** a developer fixes a baselined violation
- **THEN** `check` reports the entry as stale
- **AND** `check --prune-baseline` removes it, and the shrink-only check passes
