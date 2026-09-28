# @de-web-sdk/pack

The producer toolkit for de-web-sdk. It scaffolds, validates, evaluates, builds, and signs agent packs, which carry rules, check adapters, skills, docs, and agent commands for app repos.

```sh
npx -p @de-web-sdk/pack de-web-sdk-pack new @scope/my-pack --owner "My team" --feedback "https://..."
cd my-pack && npm install
npx --no de-web-sdk-pack validate
```

| Command | What it does |
|---|---|
| `new` | Scaffolds a pack that passes `validate` unedited |
| `validate` | Checks the manifest, the eval tasks, and every machine rule's fixtures, in one run |
| `eval run` | Runs each eval task with and without the pack, on every required model |
| `build` | Records file digests, applies the eval gate, and writes the manifest and an npm tarball |
| `keygen`, `sign` | Create a producer key pair, and sign the built manifest in the Sigstore bundle format |
| `eval review`, `feedback import` | Review trials blind, and turn consumer reports into eval tasks |

The [producer guide](https://github.com/roughcompass/de-web-sdk/blob/main/docs/producer-guide.md) walks through publishing a pack.

Requires Node.js 22.22.2, 24.15, or 26 or later in those release lines.
