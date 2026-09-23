# pi-openai-codex-fast

Pi package that adds an `openai-codex-fast` provider backed by built-in `openai-codex` with `serviceTier: "priority"`.

Requires Pi `>=0.87.1 <0.88.0`.

## Behavior

`openai-codex-fast` is a separate selectable provider that delegates to Pi's built-in `openai-codex` implementation with the same model id and `serviceTier: "priority"`. Normal `openai-codex/<modelId>` selections are left on the normal/default-tier path.

Currently exposed fast models:

- `gpt-6-astra`
- `gpt-6-luna`
- `gpt-6-sol`
- `gpt-5.6-luna`
- `gpt-5.6-terra`
- `gpt-5.6-sol`
- `gpt-5.5`

Runtime behavior when `openai-codex-fast/<modelId>` is selected:

- Reuses existing `openai-codex` auth from Pi auth storage.
- Sends Codex requests through the built-in Codex response API with `serviceTier: "priority"`.
- Stores generated assistant messages canonically as built-in Codex, including normal replies, tool-calling replies, and setup/error/aborted replies:
  - `provider: "openai-codex"`
  - `api: "openai-codex-responses"`
- Context-overflow errors are the one exception. They keep `provider: "openai-codex-fast"` with `api: "openai-codex-responses"` because Pi only runs compact-and-retry recovery when the failed message's provider matches the selected model.
- Does not otherwise rewrite stored assistant history back to `openai-codex-fast`, and never stores `openai-codex-fast-responses`.
- Preserves Pi's transcript-backed system instructions and tool changes by passing the normalized conversation to the built-in Codex adapter.

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
npm run check # repository-wide hk quality gate
npm test # integration tests for both direct TS loading and built JS
npm run build
npm run test:ts
npm run test:js
npm run lint
npm run fmt
hk check --all --check
npm run benchmark
```

`npm run test:js` compiles into a temporary directory and preserves existing
`dist/` output. `npm run test:ts` and `npm run test:js` set `PI_PACKAGE_DIR`
to the repository's `node_modules/@earendil-works/pi-coding-agent` for their
in-process Pi so an inherited global `PI_PACKAGE_DIR` cannot select another
runtime's package metadata. Other Pi launches are not affected.

### Live test

Run `mise run test:live` to test the packed extension through the shipped Pi
CLI with the existing Codex login. It exercises `gpt-5.6-luna`, `gpt-6-sol`,
and `gpt-6-luna` at medium reasoning effort. Each model must pass priority
requests and pricing, canonical tool history, prompt reload, session resume, a built-in
file read, and the normal-tier control.
Tests use isolated configuration and synthetic prompts. The default test suite
and CI skip it.

- Archive: without `PI_PACKAGE_ARCHIVE`, the test packs the current worktree
  into a temporary directory. With `PI_PACKAGE_ARCHIVE`, it tests exactly that
  archive. A relative path resolves from the test process's working directory,
  which is the repository root under `mise run test:live`. An empty value, a
  missing file, a directory, or content that is not a gzip tar archive fails
  the test; it never falls back to packing the worktree.
- CLI: by default the test runs the repository's Pi development dependency.
  Set `PI_TEST_CLI_PATH` to another `cli.js` to test a different installation.
  The peer range is `>=0.87.1 <0.88.0`, and the test asserts that the selected
  CLI reports exactly `0.87.1`, the tested version.
- Runtime: each CLI child process receives `PI_PACKAGE_DIR` set to the selected
  executable's package directory. The Mise task also binds `PI_PACKAGE_DIR` to
  the repository dependency while it reads the Codex bearer token through
  `pi auth print-bearer-token`.

## Packaging

This package publishes the TypeScript extension entrypoint and these project files explicitly:

- `index.ts`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`

The build output is a local test artifact for verifying the extension also works as native JavaScript; it is not published.

Release flow:

1. Run `npm run release -- X.Y.Z` from a clean, synchronized `main`. The version needs a non-empty `CHANGELOG.md` section (`Unreleased` for prereleases).
2. The command bumps the version in `package.json` and `package-lock.json`, stages those two files, exports the staged index into a temporary directory, and packs it there. It then runs `mise run test:live` with `PI_PACKAGE_ARCHIVE` set to that exact archive. Only after that live test passes does it record the archive's SHA-256 in an SSH-signed release commit, verify the signature, prove that a rebuild from the committed tree produces the same digest, and create a lightweight tag. The post-commit rebuild does not repeat the live test. Missing credentials, a failed live test, or a failed prerequisite stop the release before the commit.
3. Inspect the result, then push atomically with `git push --atomic origin main vX.Y.Z`.
4. A read-only GitHub Actions job validates and packs the package. After approval in the tag-restricted `npm-publish` environment, a separate GitHub-owned job verifies the signature and signed digest before attesting and staging that exact archive through npm trusted publishing.
5. A final job creates the immutable GitHub release for the tag from the same verified archive, its
   checksum, and the version's `CHANGELOG.md` section (`Unreleased` for prereleases).
6. Approve the staged package on npmjs.com, or with `npm stage approve <stage-id>`.

### Recovering from a failed release command

The release command never reverts anything on its own. Inspect first, then
undo only what the failed attempt produced. Do not use blanket commands such
as `git restore`, `git reset --hard`, or `git clean`; they would also discard
unrelated work.

Failure before the release commit (a prerequisite check, version update,
`npm ci`, `npm pack`, package validation, the live test, or signing):

- If the failure happened before the version bump (not on `main`, dirty
  worktree, missing changelog section, `HEAD` differing from `origin/main`, or
  an existing tag), nothing changed.
- Otherwise version changes can remain in `package.json` and
  `package-lock.json`. They are staged once the version update and `git add`
  succeed. No release commit or tag was created by this attempt. Inspect with:

  ```bash
  git status --short
  git diff -- package.json package-lock.json
  git diff --cached -- package.json package-lock.json
  ```

  Undo only this attempt's version edits in the worktree and index. Preserve
  concurrent changes, including changes in those same files. Do not stage
  whole files containing unrelated edits. Fix the cause and confirm that
  `main` is clean and synchronized before rerunning the release command.

Failure after the release commit (signature verification, the reproducibility
rebuild, or the tag checks):

- A local signed `release: vX.Y.Z` commit now exists on `main`, and the tag may
  or may not exist. Inspect with:

  ```bash
  git status --short
  git log --oneline -2
  git tag --points-at HEAD
  ```

- Do not push the commit or tag. A commit whose archive did not reproduce, or
  whose signature did not verify, must not reach `origin`. Do not rerun the
  release command; it refuses because `HEAD` no longer matches `origin/main`.
- Removing the local commit or tag changes local refs. Review the exact
  refs and a recovery path, and obtain explicit approval before doing so.
  Never replace a published tag. Fix the underlying cause before starting a
  new release.

Prerelease tags such as `vX.Y.Z-alpha.N` use the same CI flow. CI derives the npm dist-tag from the first prerelease identifier (`alpha` for `X.Y.Z-alpha.N`, `beta` for `X.Y.Z-beta.N`, and so on); stable versions use `latest`.
