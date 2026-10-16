# pi-openai-codex-fast Project Instructions

pi-openai-codex-fast is a Pi coding agent extension for exposing OpenAI Codex models through a priority-service-tier `openai-codex-fast` provider.

## Conventions

- Format commit messages according to [Conventional Commits](https://www.conventionalcommits.org/).
- Maintain `CHANGELOG.md` using the [Keep a Changelog](https://keepachangelog.com/) style.
- Add changelog entries for changes whose commit would be `feat:` or `fix:`; keep entries under `Unreleased` until a release is made.
- Credit external contributors in their changelog entry with a GitHub profile link and pull request link, for example `Contributed by [@user](https://github.com/user) in [#N](https://github.com/2h2d-co/pi-openai-codex-fast/pull/N).`
- Release commits should do the following:
  - update the package version;
  - keep changelog entries under `Unreleased` for prereleases and move them into a release section only for stable releases;
  - use `npm run release -- X.Y.Z` to build the package locally, create an SSH-signed `release: vX.Y.Z` commit containing its `Npm-Artifact-SHA256` trailer, verify a clean rebuild, and create the matching lightweight tag;
  - push the release commit and tag atomically; do not use `git tag -a`, `git tag -s`, `git tag -m`, or `cog bump --annotated`.
  - The tag workflow creates the immutable GitHub release from the verified archive and the version's changelog section. Never create GitHub releases by hand.
- Push stable or prerelease `vX.Y.Z*` tags and let CI stage the package with trusted publishing/provenance. CI derives `latest` for stable versions and the first prerelease identifier (`alpha`, `beta`, `rc`, etc.) for prereleases.
- Live tests report every error they meet as a test diagnostic, even when they pass: extension error and warning notices, extension errors, and failed responses. Use `test/support/error-log.ts`. Summarize failed responses by stop reason, HTTP status, and error category; never print provider error text or credentials.
- Keep tests in `test/*.test.ts`, code that tests import or load into Pi in `test/support/`, and test data in `test/fixtures/`.
