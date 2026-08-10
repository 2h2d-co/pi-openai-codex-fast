# Changelog

## Unreleased

### Security

- Require npm releases to match a locally built SHA-256 recorded in an SSH-signed release commit before trusted publishing can stage the package.

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
