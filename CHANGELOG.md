# Changelog

## Unreleased

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
