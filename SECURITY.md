# Security policy

## Report a vulnerability

Don't open a public issue. Report it privately with **Report a vulnerability** on this repository's **Security** tab, which opens a GitHub security advisory that only the maintainers can see. Include the affected package and version, the steps to reproduce, and the impact you expect.

Fixes go to the latest version on `main`. While the SDK is in alpha, no older version is maintained.

## What's in scope

The SDK loads packs, which can contain check code, into developers' repos, their agents, and CI. These are its security boundaries:

- **Pack verification.** Packs must pass provenance or signature verification against the repo's trust policy, and every file must match its manifest digest, before any pack code runs.
- **Adapter isolation.** Check adapters run in a separate Node.js process with the permission model: read-only file access, no child processes, no workers, a minimal environment, and a time limit. The isolation limits mistakes; verification decides which code runs at all.
- **Content served to agents.** Skills and pack files are verified again each time they're served, and files with hidden characters are refused.
- **Feedback.** Reports never include source code unless the reporter names lines, and nothing is sent without an explicit submit call.

Reports that bypass any of these are in scope. So are ways to make the CLI or MCP server run code or read files outside these rules.

## Out of scope

- A pack that its trust policy accepts behaving maliciously. The trust policy decides whom a repo trusts.
- Adapters reaching the network. Node.js's permission model doesn't restrict it, as the design records.
