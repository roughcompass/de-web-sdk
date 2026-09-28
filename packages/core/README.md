# @de-web-sdk/core

The core library behind de-web-sdk's CLI and producer toolkit. Node.js tools can embed it instead of calling the CLI.

It provides:

- The pack format: the `pack.json` JSON Schemas in `schema/`, with an example manifest for each kind of pack, and validation
- Trust: npm provenance and Sigstore-format signature verification, trust policies, and file digests
- Composition: one rule set from a repo's packs, facts, local rules, ignored paths, and exceptions
- Checks: the SARIF adapter contract, from `@de-web-sdk/core/adapter`, isolated adapter runs, and baselines
- Agent files, served skills, and feedback reports

Check adapters import only `@de-web-sdk/core/adapter`, so they don't depend on the rest of the SDK. See the [producer guide](https://github.com/roughcompass/de-web-sdk/blob/main/docs/producer-guide.md#write-a-check-adapter).

Requires Node.js 22.22.2, 24.15, or 26 or later in those release lines.
