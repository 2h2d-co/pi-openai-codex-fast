# pi-openai-codex-fast Project Instructions

pi-openai-codex-fast is a Pi coding agent extension for exposing OpenAI Codex models through a priority-service-tier `openai-codex-fast` provider.

## Conventions

- Format commit messages according to [Conventional Commits](https://www.conventionalcommits.org/).
- Maintain `CHANGELOG.md` using the [Keep a Changelog](https://keepachangelog.com/) style.
- Add changelog entries for changes whose commit would be `feat:` or `fix:`; keep entries under `Unreleased` until a release is made.
- Release commits should do the following:
  - update the package version;
  - move `Unreleased` changelog entries into the new release section;
  - commit with `release: vX.Y.Z` as the commit message;
  - tag the release with the matching `vX.Y.Z` tag.
- Stable releases: push stable `vX.Y.Z` tags and let CI publish/stage `latest` with trusted publishing/provenance.
- Prereleases: use local `npm run publish:prerelease` for `vX.Y.Z-alpha.N`/`beta`/`rc`/etc.; it uses regular `npm publish`, derives a non-`latest` dist-tag, and has no provenance.
- CI ignores prerelease tags.
