# Changelog

All notable changes to the SDK's packages are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). The packages share one version.

## [Unreleased]

### Added

- Pack format v0: a `pack.json` manifest with a public JSON Schema, for standalone, embedded, bundle, adapter, and local packs.
- `@de-web-sdk/core`: provenance and signature verification, file digests, trust policies with integrity pins, composition with repo overrides, isolated SARIF check adapters, baselines, served skills, and feedback adapters.
- `@de-web-sdk/cli`: `init`, `sync`, `resolve`, `check`, `skill`, and `feedback`, and a local MCP server, `de-web-sdk mcp`, registered in `.mcp.json`.
- `@de-web-sdk/pack`: `new`, `validate`, `build`, `keygen`, `sign`, evals across models with a publish gate, blind trial review, and feedback import.
- `de-web-sdk-vscode`: pack evals with Copilot's models through VS Code's language model API, guided Copilot trials, and trial review in the diff editor.
- Consumer and producer guides.
