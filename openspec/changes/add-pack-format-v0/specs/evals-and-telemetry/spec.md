# Spec Delta: evals-and-telemetry

## Purpose

Measures whether packs help agents pass tasks and use the right APIs, blocks packs that make agents worse, and feeds human judgment back into packs.

## ADDED Requirements

### Requirement: Eval task contents

An eval task SHALL declare a prompt, a starting repo state, its graders, and the rules it exercises. It MAY declare the APIs its result should use.

#### Scenario: Task without a grader

- **WHEN** a producer validates a pack containing an eval task with no grader
- **THEN** validation fails and names the task

### Requirement: Rule coverage

Validation SHALL warn about every rule that no eval task exercises.

#### Scenario: Uncovered rule

- **WHEN** a pack has a rule that no eval task lists
- **THEN** validation passes with a warning that names the rule

### Requirement: Configurable models

A pack's eval configuration SHALL list the models its evals cover, by alias. An eval profile SHALL map each alias to its model and to one or more routes that reach it. A route SHALL be an endpoint, the local Claude Code installation, or VS Code's language model API. The runner SHALL use the first route that works where it runs. The profile SHALL name the aliases that every pack must cover. Pack files SHALL NOT contain endpoints or credentials.

#### Scenario: Required model the pack doesn't list

- **WHEN** the eval profile requires a model that a pack's eval configuration doesn't list
- **THEN** the runner evaluates the pack on that model anyway

#### Scenario: Model moves to a new endpoint

- **WHEN** the enterprise serves a model from a new endpoint
- **THEN** only the eval profile changes

#### Scenario: Same alias on a laptop

- **WHEN** a producer runs evals on a machine without pipeline credentials
- **THEN** the runner reaches each alias through a local route, and the report names the route

### Requirement: Pluggable agent drivers

The runner SHALL run agents through drivers. The SDK SHALL ship a Claude Code driver and a reference harness driver for OpenAI-compatible endpoints. It SHALL also ship a VS Code driver that runs the reference harness with Copilot's models. Teams MAY add drivers without an SDK release. The SDK's drivers SHALL give agents the SDK's MCP server in trials, without the tool that sends feedback. Their own prompts SHALL NOT name the SDK's tools or commands, so only the pack and the repo's files lead agents to them. Each trial SHALL record which SDK tools and commands the agent used.

#### Scenario: Claude model through Claude Code

- **WHEN** a profile alias maps to the Claude Code driver and a Claude model
- **THEN** each run starts a fresh headless Claude Code session that uses that model

#### Scenario: Model family offered in Copilot, through an endpoint

- **WHEN** a profile alias maps to the reference harness driver and a model behind an enterprise endpoint
- **THEN** each run loads the repo instruction files that GitHub Copilot documents, and uses that model

#### Scenario: Copilot model in VS Code

- **WHEN** a producer runs evals from the VS Code extension and consents to its use of Copilot's models
- **THEN** each run drives the reference harness with a Copilot model through VS Code's language model API
- **AND** it loads the repo instruction files that GitHub Copilot documents

#### Scenario: Trial without the pack

- **WHEN** the reference harness runs a trial without the pack
- **THEN** nothing in its prompt names the SDK's commands
- **AND** a refused command's error lists the commands the trial allows

### Requirement: Local runs

Producers SHALL be able to run evals on their own machine without pipeline credentials. They SHALL be able to use Claude Code, through its existing sign-in, or VS Code, through Copilot's models. Before a local run starts, the runner SHALL show how many trials will run on the developer's own quota and ask for confirmation. Drivers SHALL limit each local trial to its worktree and to the task's build and check commands. The runner SHALL pace its requests to stay within each tool's rate limits.

#### Scenario: Claude Code on a laptop

- **WHEN** a producer who is signed in to Claude Code runs the evals locally
- **THEN** the trials run through that sign-in, with no endpoint or credential from the profile

#### Scenario: Confirmation before spending quota

- **WHEN** a producer starts a local run in an interactive terminal or in VS Code
- **THEN** the runner shows the trial count and waits for confirmation, unless the producer passed `--yes`

#### Scenario: Agent tries an unlisted command

- **WHEN** an agent in a local trial tries to run a command other than the task's build and check commands
- **THEN** the driver refuses the command, and the trial continues

### Requirement: Guided Copilot trials

The VS Code extension SHALL run a task in Copilot's own agent mode. It SHALL open the trial's worktree in a new window and give Copilot the task prompt. It SHALL grade the result when the developer marks the trial finished. Guided trials SHALL appear in the report beside the reference harness's results for the same tasks, and SHALL NOT count toward the gate.

#### Scenario: Guided trial

- **WHEN** a developer marks a guided trial finished
- **THEN** the extension grades the worktree with the task's graders and records the trial

#### Scenario: Harness compared with Copilot

- **WHEN** guided trials and reference harness trials run the same tasks on the same model family
- **THEN** the report shows both pass rates side by side

### Requirement: Paired runs

For each model, the runner SHALL run each task a configured number of times in each condition. Each run is a trial. The conditions are without the pack, with the candidate version, and with the published version when one exists. All conditions SHALL use the same driver, route, model, and starting state.

#### Scenario: First version

- **WHEN** a pack has no published version
- **THEN** the runner compares the candidate with the no-pack condition only

#### Scenario: Update to a published pack

- **WHEN** a pack has a published version
- **THEN** the report compares the candidate with both the published version and the no-pack condition

#### Scenario: Published version the producer repo doesn't trust

- **WHEN** the published version fails verification under the trust policy in the producer's repo
- **THEN** the run stops before any trial starts
- **AND** it names the trust policy file and the option that skips the published condition

### Requirement: Trial integrity

The runner SHALL retry a trial once only when the driver fails before the agent acts, such as during a provider outage. Every other failure SHALL count against the trial. Each trial SHALL record where it ran: the environment, driver, route, tool version, and the model that the tool reports. Raw prompts, transcripts, and diffs SHALL stay in a local cache that the pack's repo ignores.

#### Scenario: Provider outage

- **WHEN** a trial fails because the model endpoint is unreachable before the agent takes any action
- **THEN** the runner retries the trial once

#### Scenario: Agent times out

- **WHEN** an agent runs past its time budget
- **THEN** the trial fails and isn't retried

### Requirement: Reuse of earlier results

The runner SHALL reuse no-pack and published results until an input changes. The inputs are the task, starting state, driver, route, model, agent version, SDK version, and pack digest.

#### Scenario: Second candidate

- **WHEN** a producer evaluates a second candidate with no other changes
- **THEN** the runner runs only the candidate condition

### Requirement: Grading

Every grader SHALL run `check` on the agent's result. A task MAY add its own assertions, such as tests or scripts. A trial passes when every grader passes.

#### Scenario: Result passes check but fails a task assertion

- **WHEN** an agent's result passes `check` but fails the task's own test
- **THEN** the trial fails

### Requirement: API adoption

For each trial of a task that declares expected APIs, the runner SHALL record whether the agent's changes use every expected API. A model's API adoption rate SHALL be the share of those trials that do. A pack whose tasks declare no expected APIs has no API adoption rate.

#### Scenario: Agent writes its own dialog

- **WHEN** a task expects the design system's `Dialog` and the agent builds its own modal instead
- **THEN** the trial counts against API adoption, even if every grader passes

### Requirement: Eval report

The runner SHALL report the pass rate and the API adoption rate for each model and condition, by task and overall. The report SHALL include trial counts, where the trials ran, driver and model versions, and the pack version and digest. It SHALL also show changes from the published version and trials where reviewers disagreed with graders.

#### Scenario: Completed eval

- **WHEN** an eval finishes
- **THEN** the report shows each model's rates for every condition side by side
- **AND** it includes the trial counts, where the trials ran, the versions, and the digest

### Requirement: Publish gate

Building SHALL fail when either rate is lower with the candidate than without the pack for a required model, at the profile's confidence level. Building SHALL also fail when a required model has fewer trials per condition than the profile's minimum. The defaults are 95% confidence and 20 trials per condition. Results from local runs SHALL count toward the gate the same way as pipeline results. Each alias's gate decision SHALL use its most recent run that has enough trials, from one environment.

#### Scenario: Pack lowers the pass rate

- **WHEN** a required model passes 10 of 20 trials with the candidate and 17 of 20 without the pack
- **THEN** the build fails and names the model and both pass rates

#### Scenario: Pack lowers API adoption

- **WHEN** a required model uses the expected APIs in 6 of 20 trials with the candidate and 15 of 20 without the pack
- **THEN** the build fails and names the model and both adoption rates

#### Scenario: Difference within noise

- **WHEN** a required model passes 15 of 20 trials with the candidate and 16 of 20 without the pack
- **THEN** the gate passes

#### Scenario: Too few trials

- **WHEN** a required model has 10 trials per condition and the minimum is 20
- **THEN** the build fails and states how many trials are needed

#### Scenario: Local results meet the gate

- **WHEN** a local Claude Code run gives a required alias 20 trials per condition, and neither rate drops with the candidate
- **THEN** the gate passes for that alias

#### Scenario: Local and pipeline runs for one alias

- **WHEN** a required alias has a local run and a later pipeline run, both with enough trials
- **THEN** the gate uses the pipeline run, and the report names its environment

### Requirement: Gate override

A pack owner MAY override the gate for a model by recording a reason, an approver, and an expiry date. Building SHALL then succeed until the override expires.

#### Scenario: Recorded override

- **WHEN** an owner records an override for a model with a reason, an approver, and an expiry date
- **THEN** the build succeeds
- **AND** the manifest records the override

#### Scenario: Expired override

- **WHEN** an override's expiry date has passed
- **THEN** the build fails on the gate again

### Requirement: Eval summary in the manifest

The published manifest SHALL carry each required model's rates with and without the pack, where those trials ran, and any overrides. `sync` SHALL show overrides to consumers.

#### Scenario: Consumer installs a pack with an override

- **WHEN** a consumer runs `sync` with a pack that carries an override
- **THEN** the output shows the model, the reason, and who approved it

### Requirement: Human review of eval runs

The toolchain SHALL show a reviewer each trial's changes, `check` result, and grader verdict, without showing which condition produced the trial. It SHALL offer this review in the terminal and in VS Code. It SHALL record whether the reviewer agrees, with a reason. Reviewers MAY mark claims in the agent's output that the pack's content doesn't support, and the report SHALL show that rate. When a report compares two pack versions, the reviewer MAY pick the better result for a task or call them equal. Reviews SHALL be stored in the pack's repo.

#### Scenario: Reviewer disagrees with a grader

- **WHEN** a reviewer marks a passing trial as wrong and gives a reason
- **THEN** the review is stored in the pack's repo
- **AND** the next report lists the trial as a disagreement

#### Scenario: Blind review

- **WHEN** a reviewer opens a trial
- **THEN** nothing on screen says whether the trial ran with or without the pack

#### Scenario: Review in VS Code

- **WHEN** a reviewer starts the review from the VS Code extension
- **THEN** each trial's changes open in VS Code's diff editor, with the verdict and reason recorded from the same window

#### Scenario: Side-by-side comparison

- **WHEN** a reviewer compares the candidate's and the published version's results for one task
- **THEN** the choice is stored with the task, both versions, and the reason

### Requirement: Feedback becomes eval tasks

The toolchain SHALL import feedback reports into the pack's repo, draft an eval task from a report, and list open reports by rule. A report SHALL count as resolved when its eval task meets the profile's pass threshold on every required model, 80% by default.

#### Scenario: Draft a task from a report

- **WHEN** a producer imports a false-positive report and drafts a task from it
- **THEN** the drafted task references the report's rule and message

#### Scenario: Report resolved

- **WHEN** the task drafted from a report meets the threshold on every required model
- **THEN** the report's status changes to resolved
