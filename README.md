# pi-openai-codex-fast

Pi package that adds an `openai-codex-fast` provider backed by built-in `openai-codex` with `serviceTier: "priority"`.

## Behavior

- Adds a separate selectable provider: `openai-codex-fast`
- Reuses existing `openai-codex` auth from Pi auth storage
- Forces provider-level `serviceTier: "priority"`
- Currently exposes only these fast models:
  - `gpt-5.5`
  - `gpt-5.4`
  - `gpt-5.4-mini`
- Canonicalizes prior `openai-codex-fast` assistant messages before delegation
- Stores assistant messages canonically as built-in Codex:
  - `provider: "openai-codex"`
  - `api: "openai-codex-responses"`
- On `session_start`, restores fast mode when the latest branch `model_change` points to `openai-codex-fast/<modelId>`

## Install

### Local path

```bash
pi install .
```

### Temporary use

```bash
pi -e .
```

After install, log in to built-in Codex if needed:

```text
/login openai-codex
```

Then select a fast model with `/model`, for example:

```text
openai-codex-fast/gpt-5.5
```

## Local development

```bash
npm install
npm run check
npm run lint
npm run fmt
mise run benchmark
```

## Packaging

This package publishes these project files explicitly:

- `extensions/`
- `README.md`
- `LICENSE`

Release helper:

```bash
npm run release:publish
npm run release:publish -- --execute
```

`npm run release:publish` runs `npm run check` first and defaults to an npm dry-run. Pass `--execute` to perform the real publish.
