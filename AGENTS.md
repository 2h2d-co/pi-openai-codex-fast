# pi-openai-codex-fast Project Instructions

pi-openai-codex-fast is a Pi coding agent extension for exposing OpenAI Codex models through a priority-service-tier `openai-codex-fast` provider.

## Conventions

- Maintain `CHANGELOG.md` using the [Keep a Changelog](https://keepachangelog.com/) style.
- Format all commit messages according to Conventional Commits.
- Add changelog entries only for changes whose commit would be `feat:` or `fix:`.
- Keep changelog entries under `Unreleased` until a release is made.
- Release commits should do the following:
  - update the package version;
  - move `Unreleased` changelog entries into the new release section;
  - commit with `release: vX.Y.Z` as the commit message;
  - tag the release with the matching `vX.Y.Z` tag.
