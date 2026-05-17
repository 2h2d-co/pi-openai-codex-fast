# pi-openai-codex-fast

Pi package that adds an `openai-codex-fast` provider backed by built-in `openai-codex` with `serviceTier: "priority"`.

## Behavior

`openai-codex-fast` is a separate selectable provider that delegates to Pi's built-in `openai-codex` implementation with the same model id and `serviceTier: "priority"`. Normal `openai-codex/<modelId>` selections are left on the normal/default-tier path.

Currently exposed fast models:

- `gpt-5.5`
- `gpt-5.4`
- `gpt-5.4-mini`

Runtime behavior when `openai-codex-fast/<modelId>` is selected:

- Reuses existing `openai-codex` auth from Pi auth storage.
- Sends Codex requests through the built-in Codex response API with `serviceTier: "priority"`.
- Stores all generated assistant messages canonically as built-in Codex, including normal replies, tool-calling replies, and setup/error/aborted replies:
  - `provider: "openai-codex"`
  - `api: "openai-codex-responses"`
- Does not rewrite stored assistant history back to `openai-codex-fast` or `openai-codex-fast-responses`.

Fast-mode recovery:

- No custom fast-mode session state is persisted.
- On any `session_start` reason (`startup`, `reload`, `new`, `resume`, or `fork`), the extension scans the current branch backward for the latest overall `model_change`.
- If that latest `model_change` is `openai-codex-fast/<modelId>`, it selects `openai-codex-fast/<modelId>` again.
- If the latest `model_change` is anything else, it does nothing and lets Pi's normal model recovery handle it.
- The extension does not handle `session_tree`, so branch switches do not trigger model reconciliation.

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
npm test # typecheck + integration tests against real Pi runtime/local Codex server
npm run check
npm run lint
npm run fmt
npm run benchmark
```

## Packaging

This package publishes these project files explicitly:

- `index.ts`
- `README.md`
- `LICENSE`

Release helper:

```bash
npm run release:publish
npm run release:publish -- --execute
```

`npm run release:publish` runs `npm run check` first and defaults to an npm dry-run. Pass `--execute` to perform the real publish.
