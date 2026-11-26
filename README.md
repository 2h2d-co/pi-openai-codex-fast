# pi-openai-codex-fast

Pi package that adds two providers backed by built-in `openai-codex`: `openai-codex-fast` sends `serviceTier: "priority"` (Fast), and `openai-codex-ultrafast` sends `serviceTier: "ultrafast"` (Ultrafast).

Requires Pi `>=1.6.1 <1.7.0`.

**Pi's virtual models are not supported.** Pi's experimental virtual models,
registered with `pi.registerVirtualModel()`, are not tested with this package.
Select an `openai-codex-fast` or `openai-codex-ultrafast` model directly.

## Behavior

`openai-codex-fast` and `openai-codex-ultrafast` are separate selectable providers. Each delegates to Pi's built-in `openai-codex` implementation with the same model id and its service tier. Normal `openai-codex/<modelId>` selections are left on the normal/default-tier path.

Currently exposed fast models:

- `gpt-6.2-sol`
- `gpt-6.2-astra`
- `gpt-6.1-sol`
- `gpt-6.1-terra`
- `gpt-6-astra`
- `gpt-6-luna`
- `gpt-6-sol`
- `gpt-5.6-luna`
- `gpt-5.6-terra`
- `gpt-5.6-sol`

Currently exposed ultrafast models, the four models OpenAI offers Ultrafast for:

- `gpt-6.2-sol`
- `gpt-6.2-astra`
- `gpt-6-astra`
- `gpt-6.1-sol`

The ChatGPT plan decides which models get each speed. Pro $200 includes Ultrafast only for
GPT-6.2 Sol. Pro $500 and eligible Enterprise and Edu workspaces include it for all four models.
Plus, Pro $100, and Business do not include Ultrafast. Codex accepts a tier the plan lacks and
silently answers at Standard speed, so both providers check the account's model catalog first,
as the Codex CLI does. The catalog is the Codex backend's `/codex/models` list, and it names the
tiers the signed-in account has on each model.

- When the catalog does not list the provider's tier for the model, the provider refuses the
  request before sending it, with an error that names the provider to select instead. With Pro
  $200, for example, `openai-codex-ultrafast/gpt-6.2-astra` points to
  `openai-codex-fast/gpt-6.2-astra`.
- When the catalog cannot be loaded and none was kept, `openai-codex-fast` proceeds, as the Codex
  CLI's built-in catalog allows, and `openai-codex-ultrafast` refuses with the reason. A failed
  load is retried after 30 seconds.
- The extension loads the catalog before the account's first request. After five minutes it
  reloads the catalog in the background, and the previous catalog answers requests until the new
  one arrives. When a response reports that the catalog changed, through the `x-models-etag`
  header, the next request waits for the new catalog.
- The extension keeps each account's latest catalog in
  `pi-openai-codex-fast-model-catalog.json` in the Pi agent directory, keyed by a hash of the
  account id.

Runtime behavior when `openai-codex-fast/<modelId>` or `openai-codex-ultrafast/<modelId>` is selected:

- Reuses existing `openai-codex` auth from Pi auth storage.
- Sends Codex requests through the built-in Codex response API with `serviceTier: "priority"` or `serviceTier: "ultrafast"`.
- Reports costs at the tier's API price. Fast costs 2 times the Standard rate. Ultrafast costs 6 times the Standard rate, and GPT-6.2 models cost 3 times the Standard rate through February 28, 2027, Pacific time. Pi itself prices Ultrafast requests at the Standard rate, so the extension recomputes their cost.
- Stores generated assistant messages canonically as built-in Codex, including normal replies, tool-calling replies, and setup/error/aborted replies:
  - `provider: "openai-codex"`
  - `api: "openai-codex-responses"`
- Context-overflow errors are the one exception. They keep the selected provider, such as `provider: "openai-codex-fast"`, with `api: "openai-codex-responses"` because Pi only runs compact-and-retry recovery when the failed message's provider matches the selected model.
- Does not otherwise rewrite stored assistant history back to `openai-codex-fast` or `openai-codex-ultrafast`, and never stores `openai-codex-fast-responses` or `openai-codex-ultrafast-responses`.
- Preserves Pi's transcript-backed system instructions and tool changes by passing the normalized conversation to the built-in Codex adapter.

Provider recovery:

- No custom session state is persisted.
- On any `session_start` reason (`startup`, `reload`, `new`, `resume`, or `fork`), the extension scans the current branch backward for the latest overall `model_change`.
- If that latest `model_change` is `openai-codex-fast/<modelId>` or `openai-codex-ultrafast/<modelId>`, it selects that model again.
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

Then select a fast or ultrafast model with `/model`, for example:

```text
openai-codex-fast/gpt-6.2-sol
openai-codex-ultrafast/gpt-6.2-sol
```

## Local development

```bash
mise run init
mise run check # hk quality gate, both test suites, audit, and package contents
npm run build
npm run test:ts
npm run test:js
npm run lint
npm run fmt
hk check --all --check
npm run benchmark
```

`npm run test:js` compiles into a temporary directory and preserves existing
`dist/` output. `npm run test:ts`, `npm run test:js`, and `npm run test:live`
remove an inherited `PI_PACKAGE_DIR` from their test processes, so Pi resolves
the repository dependency's own package directory. Other Pi launches are not
affected.

### Live test

Run `npm run test:live` to test the packed extension through the shipped Pi
CLI with the existing Codex login. It exercises Fast and Ultrafast on `gpt-6.2-sol` and
`gpt-6.2-astra` at medium reasoning effort. Each case first loads the account's model catalog.
When the catalog lists the case's tier for the model, the case must pass its tier's requests and
pricing, canonical tool history, prompt reload, session resume, a built-in file read, and the
normal-tier control. Codex reports `default` as the tier of every response, so an Ultrafast case
also requires Ultrafast to generate a long tool call at least 3 times as fast as Standard. When
the catalog does not list the tier, the provider must refuse the prompt before sending a request.
The live test needs a Codex login whose plan includes Ultrafast for GPT-6.2 Sol.
Tests use isolated configuration and synthetic prompts. The default test suite
and CI skip it.

- Archive: without `PI_PACKAGE_ARCHIVE`, the test packs the current worktree
  into a temporary directory. With `PI_PACKAGE_ARCHIVE`, it tests exactly that
  archive. A relative path resolves from the test process's working directory,
  which is the repository root under `npm run test:live`. An empty value, a
  missing file, a directory, or content that is not a gzip tar archive fails
  the test; it never falls back to packing the worktree.
- CLI: by default the test runs the repository's Pi development dependency.
  Set `PI_TEST_CLI_PATH` to another `cli.js` to test a different installation.
  The peer range is `>=1.6.1 <1.7.0`, and the test asserts that the selected
  CLI reports the version of the repository's Pi development dependency.
- Runtime: `scripts/test-live.ts` reads the Codex bearer token through the
  repository Pi's `pi auth print-bearer-token` and passes it to the test
  process. Each CLI child process resolves its own package directory.

## Packaging

This package publishes the TypeScript extension entrypoint and these project files explicitly:

- `index.ts`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`

The build output is a local test artifact for verifying the extension also works as native JavaScript; it is not published.

Release flow:

1. Run `npm run release -- X.Y.Z` from a clean, synchronized `main`. The version needs a non-empty `CHANGELOG.md` section (`Unreleased` for prereleases).
2. The command bumps the version in `package.json` and `package-lock.json`, stages those two files, exports the staged index into a temporary directory, and packs it there. It then runs `npm run test:live` with `PI_PACKAGE_ARCHIVE` set to that exact archive. Only after that live test passes does it record the archive's SHA-256 in an SSH-signed release commit, verify the signature, prove that a rebuild from the committed tree produces the same digest, and create a lightweight tag. The post-commit rebuild does not repeat the live test. Missing credentials, a failed live test, or a failed prerequisite stop the release before the commit.
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
