# @de-web-sdk/cli

The consumer CLI for de-web-sdk. It sets up an app repo to follow the rules in its agent packs, and gives agents those rules. It also checks conformance in CI and sends feedback to rule owners.

```sh
npm install --save-dev @de-web-sdk/cli
npx --no de-web-sdk init <pack>...
npx --no de-web-sdk check
```

| Command | What it does |
|---|---|
| `init` | Writes the repo's configuration and trust policy, adds the named packs, and runs `sync` |
| `sync` | Verifies installed packs, and writes the `AGENTS.md` block and the `.mcp.json` entry |
| `resolve [files]` | Returns the rules, skills, docs, and commands for the given files |
| `check [files]` | Runs machine rules, and exits with 0, 1 for new violations, 2 for configuration errors, or 3 for verification failures |
| `skill <name>` | Prints a skill, or one of its files, from its verified pack |
| `feedback <rule>` | Drafts a report for the rule's owner, and sends it with `--submit` |
| `mcp` | Runs the local MCP server that Claude Code and VS Code start from `.mcp.json` |

Every command works without a terminal, and takes `--format json`. The [consumer guide](https://github.com/roughcompass/de-web-sdk/blob/main/docs/consumer-guide.md) covers setup, baselines, repo overrides, and feedback.

Requires Node.js 22.22.2, 24.15, or 26 or later in those release lines.
