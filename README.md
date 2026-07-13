# pi-openai-codex-fast

Pi package that adds an `openai-codex-fast` provider backed by built-in `openai-codex` with `serviceTier: "priority"`.

## Behavior

`openai-codex-fast` is a separate selectable provider that delegates to Pi's built-in `openai-codex` implementation with the same model id and `serviceTier: "priority"`. Normal `openai-codex/<modelId>` selections are left on the normal/default-tier path.

Currently exposed fast models:

- `gpt-5.6-luna`
- `gpt-5.6-terra`
- `gpt-5.6-sol`
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
npm test # typecheck + integration tests for both direct TS loading and built JS
npm run check
npm run build
npm run test:ts
npm run test:js
npm run lint
npm run fmt
hk check --all --check
npm run benchmark
```

## Packaging

This package publishes the TypeScript extension entrypoint and these project files explicitly:

- `index.ts`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`

The build output is a local test artifact for verifying the extension also works as native JavaScript; it is not published.

Release flow:

1. Create a release commit named `release: vX.Y.Z`.
2. Tag that commit as `vX.Y.Z`.
3. Push `main` and the tag to GitHub.
4. The tag push triggers GitHub Actions to stage the package on npm via trusted publishing with npm provenance.
5. Approve the staged package on npmjs.com, or with `npm stage approve <stage-id>`.

Prerelease tags such as `vX.Y.Z-alpha.N` use the same CI flow. CI derives the npm dist-tag from the first prerelease identifier (`alpha` for `X.Y.Z-alpha.N`, `beta` for `X.Y.Z-beta.N`, and so on); stable versions use `latest`.
