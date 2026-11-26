# Changelog

## Unreleased

### Changed

- Require Pi `>=1.6.1 <1.7.0`. Pi 1.6.1 sends the selected thinking level as `reasoning.effort` on the GPT-6, GPT-6.1, and GPT-6.2 models. Pi 1.6.0 sent `medium` and carried the level only in a `configuration_update` item, which Codex applies only partly above medium, so high and xhigh reasoned less.

## 0.0.28 - 2026-11-23

### Added

- Expose `gpt-6.2-astra`, `gpt-6-astra`, and `gpt-6.1-sol` as ultrafast models, alongside `gpt-6.2-sol`. These are the four models OpenAI offers Ultrafast for. Pro $500 and eligible Enterprise and Edu plans include all four, and Pro $200 includes only GPT-6.2 Sol.

### Changed

- Check the account's Codex model catalog before each request, as the Codex CLI does. `openai-codex-ultrafast` and `openai-codex-fast` refuse a model whose catalog entry does not list their tier, before sending anything, and name the provider to select instead. Codex silently served such requests at Standard speed while Pi reported the faster tier's cost. Without a loaded catalog, Fast proceeds and Ultrafast is refused. The extension keeps each account's catalog in `pi-openai-codex-fast-model-catalog.json` in the Pi agent directory.

## 0.0.27 - 2026-11-23

### Added

- Add an `openai-codex-ultrafast` provider that sends `gpt-6.2-sol` requests through Codex's Ultrafast service tier. Pi's cost totals price them at OpenAI's Ultrafast rate: 3 times the Standard rate through February 28, 2027, Pacific time, and 6 times from March 1, 2027. Ultrafast needs a ChatGPT plan that includes it for GPT-6.2 Sol, such as Pro $200.

## 0.0.26 - 2026-11-20

### Added

- Expose `gpt-6.2-sol` and `gpt-6.2-astra` as fast models.

### Fixed

- Send thinking level off as effort `none`, as Pi 1.6.0's Codex adapter does. On GPT-6 models, switching thinking off now keeps the prompt cache, and fast requests match normal ones.

### Changed

- Require Pi `>=1.6.0 <1.7.0`.

## 0.0.25 - 2026-11-10

### Changed

- Require Pi `>=1.5.2 <1.6.0`.

## 0.0.24 - 2026-11-10

### Changed

- Require Pi `>=1.5.1 <1.6.0`.

## 0.0.23 - 2026-11-04

### Added

- Add `gpt-6.1-terra`, which Pi 1.5.0 adds to `openai-codex`, to the fast-provider allowlist.

### Changed

- Require Pi `>=1.5.0 <1.6.0`.

## 0.0.22 - 2026-10-22

### Changed

- Require Pi `>=1.4.0 <1.5.0`.
- Remove `gpt-5.5` from the fast-provider allowlist. Pi 1.4.0 removed it from `openai-codex`
  because the Codex backend rejects it for ChatGPT accounts.

## 0.0.21 - 2026-10-17

### Changed

- Require Pi `>=1.3.0 <1.4.0`.

## 0.0.20 - 2026-10-15

### Changed

- Require Pi `>=1.2.0 <1.3.0`.

## 0.0.19 - 2026-10-08

### Changed

- Require Pi `>=1.1.0 <1.2.0`.

## 0.0.18 - 2026-10-02

### Changed

- Require Pi `>=1.0.0 <1.1.0`. Priority requests continue to use Pi's built-in
  Codex adapter and inherit its fix for incompatible grammar-tool replay IDs.

## 0.0.17 - 2026-09-30

### Added

- Add priority-tier Codex requests for `gpt-6.1-sol`.

### Changed

- Require Pi `>=0.99.1 <0.100.0` for the GPT-6.1 Sol model catalog.

## 0.0.16 - 2026-09-24

### Added

- Add priority-tier Codex requests for `gpt-6-luna` and `gpt-6-sol`. Contributed by [@clioo](https://github.com/clioo) in [#29](https://github.com/2h2d-co/pi-openai-codex-fast/pull/29).

### Changed

- Require Pi 0.87.1 or later within 0.87.x for the new GPT-6 model catalog.

## 0.0.15 - 2026-09-23

### Changed

- Clarify that context-overflow errors retain the `openai-codex-fast` provider identity.
  Priority requests and conversation history behavior are unchanged.

## 0.0.14 - 2026-09-22

### Changed

- Support Pi 0.87.x. Upgrade Pi to 0.87.0 or later within 0.87.x before using this release.

## 0.0.13 - 2026-09-20

### Changed

- Require Pi 0.86.x and update the development dependencies and lockfile to Pi 0.86.0.
- Remove the retired `gpt-5.4` and `gpt-5.4-mini` models from the fast-provider allowlist.

### Fixed

- Accept Pi's normalized transcript input while preserving system instructions, tool changes, priority requests, and canonical Codex history.

## 0.0.12 - 2026-09-14

### Added

- Add priority-tier Codex requests for `gpt-6-astra`. Contributed by [@clioo](https://github.com/clioo) in [#20](https://github.com/2h2d-co/pi-openai-codex-fast/pull/20).

### Changed

- Adopt the shared 2h2d Oxlint policy, including the blanket ban on non-const type assertions.
- Require Pi 0.85.1 or later within 0.85.x as the supported peer compatibility range.

### Fixed

- Convert every detached fast-provider task failure, including non-Error rejections, into a canonical terminal stream error.

### Security

- Require npm releases to match a locally built SHA-256 recorded in an SSH-signed release commit before trusted publishing can stage the package.
- Require code-owner review for release policy, protect `main` and `v*` refs, and gate npm OIDC behind a reviewed tag-only environment.
- Update transitive HTTP and glob dependencies to patched releases through the Pi 0.84.x development dependency update.

## 0.0.11 - 2026-08-01

- Require Pi 0.83.x as the supported peer compatibility range.

## 0.0.10 - 2026-07-17

- Update Pi dependencies to 0.80.10, use the session-scoped model registry for request auth, and migrate the SDK test harness to `ModelRuntime`.
- Register the fast model catalog during extension loading so startup `enabledModels` patterns resolve before `session_start`.

## 0.0.9 - 2026-07-15

- Update Pi development dependencies to 0.80.7.

## 0.0.8 - 2026-07-10

- Add priority-tier Codex requests for `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`.
- Add per-model low- and medium-thinking benchmarks for GPT-5.6 Terra and Sol.
- Update Pi development dependencies to 0.80.6.

## 0.0.7 - 2026-07-05

- Revert the extension entrypoint to top-level `index.ts` so Pi labels the installed package as `pi-openai-codex-fast`.

## 0.0.6 - 2026-07-04

- Change the Pi extension entrypoint path so Pi displays the extension as `openai-codex-fast` while the npm package remains `pi-openai-codex-fast`.

## 0.0.5 - 2026-07-01

- Add Pi 0.80.x compatibility by importing legacy Pi AI helpers from the compat entrypoint.
- Update Pi development dependencies to 0.80.3 and test against the 0.80.x package layout.

## 0.0.4 - 2026-06-22

- Align the package Node engine with Pi's `>=22.19.0` runtime range.
- Keep publishing the TypeScript extension entrypoint while testing both direct TypeScript loading and the built JavaScript artifact.
- Harden extension instance state against module-loader caching.

## 0.0.3 - 2026-06-10

- Fix Pi's context-overflow compact-and-retry recovery for `openai-codex-fast`.

## 0.0.2 - 2026-05-17

- Fix packaged extension loading by moving the entrypoint to top-level `index.ts`.
- Fix the extension display name.

## 0.0.1 - 2026-05-17

- Initial release of `openai-codex-fast`.
- Add priority-tier Codex requests for `gpt-5.5`, `gpt-5.4`, and `gpt-5.4-mini`.
- Reuse existing built-in `openai-codex` auth.
- Restore fast model selection from the latest `model_change` when sessions start.
