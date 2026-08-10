# pi-openai-codex-fast Project Instructions

pi-openai-codex-fast is a Pi coding agent extension for exposing OpenAI Codex models through a priority-service-tier `openai-codex-fast` provider.

## Conventions

- Format commit messages according to [Conventional Commits](https://www.conventionalcommits.org/).
- Maintain `CHANGELOG.md` using the [Keep a Changelog](https://keepachangelog.com/) style.
- Add changelog entries for changes whose commit would be `feat:` or `fix:`; keep entries under `Unreleased` until a release is made.
- Release commits should do the following:
  - update the package version;
  - keep changelog entries under `Unreleased` for prereleases and move them into a release section only for stable releases;
  - use `npm run release -- X.Y.Z` to build the package locally, create an SSH-signed `release: vX.Y.Z` commit containing its `Npm-Artifact-SHA256` trailer, verify a clean rebuild, and create the matching lightweight tag;
  - push the release commit and tag atomically; do not use `git tag -a`, `git tag -s`, `git tag -m`, or `cog bump --annotated`.
- Push stable or prerelease `vX.Y.Z*` tags and let CI stage the package with trusted publishing/provenance. CI derives `latest` for stable versions and the first prerelease identifier (`alpha`, `beta`, `rc`, etc.) for prereleases.
