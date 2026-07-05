import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type PackageJson = {
  name?: unknown;
  version?: unknown;
};

const packageJsonPath = resolve(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
const packageName = typeof pkg.name === "string" ? pkg.name : "<unknown-package>";
const version = pkg.version;

if (typeof version !== "string" || version.length === 0) {
  throw new Error(`Missing or invalid version in ${packageJsonPath}`);
}

const cliArgs = process.argv.slice(2);
const execute = cliArgs.includes("--execute");
const extraArgs = cliArgs.filter((arg) => arg !== "--execute");

if (extraArgs.some((arg) => arg === "--tag" || arg.startsWith("--tag=") || arg === "-t")) {
  throw new Error(
    "Do not pass --tag to publish-prerelease; the dist-tag is derived from package.json version.",
  );
}

const npmTag = deriveNpmTag(version);
const publishArgs = ["publish", "--tag", npmTag, "--allow-directory=all", ...extraArgs];

if (!execute) {
  publishArgs.push("--dry-run");
} else {
  assertPublishGitState(version);
}

console.log(
  `${execute ? "Publishing" : "Dry-run publishing"} ${packageName}@${version} with npm dist-tag "${npmTag}"`,
);
if (!execute) {
  console.log("Pass --execute to perform the real npm publish.");
}

const result = spawnSync("npm", publishArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

function assertPublishGitState(version: string): void {
  const releaseTag = `v${version}`;
  const insideWorkTree = runGit(["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") {
    throw new Error("Refusing to publish outside of a Git work tree.");
  }

  const status = runGit(["status", "--porcelain"]);
  if (status.length > 0) {
    throw new Error(`Refusing to publish with uncommitted changes:\n${status}`);
  }

  const head = runGit(["rev-parse", "HEAD"]);
  const branch = runGit(["branch", "--show-current"]);
  if (!branch) {
    throw new Error("Refusing to publish from a detached HEAD.");
  }

  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remote = runGit(["config", `branch.${branch}.remote`]);
  runGit(["fetch", "--quiet", remote]);
  if (!gitSucceeds(["merge-base", "--is-ancestor", head, upstream])) {
    throw new Error(
      `Refusing to publish because HEAD is not pushed to upstream "${upstream}". Push the release commit first.`,
    );
  }

  if (!gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/tags/${releaseTag}`])) {
    throw new Error(`Refusing to publish because local tag "${releaseTag}" does not exist.`);
  }

  const tagCommit = runGit(["rev-list", "-n", "1", releaseTag]);
  if (tagCommit !== head) {
    throw new Error(`Refusing to publish because tag "${releaseTag}" does not point at HEAD.`);
  }

  const localTagObject = runGit(["rev-parse", `refs/tags/${releaseTag}`]);
  const remoteTagObject = getRemoteTagObject(remote, releaseTag);
  if (remoteTagObject !== localTagObject) {
    throw new Error(
      `Refusing to publish because tag "${releaseTag}" is not pushed to remote "${remote}". Push the release tag first.`,
    );
  }
}

function getRemoteTagObject(remote: string, releaseTag: string): string | undefined {
  const output = runGit(["ls-remote", "--tags", remote, `refs/tags/${releaseTag}`]);
  for (const line of output.split("\n")) {
    const [object, ref] = line.trim().split(/\s+/);
    if (object && ref === `refs/tags/${releaseTag}`) {
      return object;
    }
  }
  return undefined;
}

function runGit(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout.trim();
}

function gitSucceeds(args: string[]): boolean {
  const result = spawnSync("git", args, {
    stdio: "ignore",
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0;
}

function deriveNpmTag(version: string): string {
  const prerelease = version.match(/-([0-9A-Za-z.-]+)$/)?.[1];
  if (!prerelease) {
    throw new Error(
      `Refusing prerelease publish of stable version "${version}" because it would use the "latest" npm dist-tag. Use a prerelease version like 1.2.3-alpha.0, 1.2.3-beta.0, or 1.2.3-rc.0.`,
    );
  }

  const firstIdentifier = prerelease.split(".")[0]?.toLowerCase();
  if (!firstIdentifier) {
    throw new Error(`Could not derive npm dist-tag from version "${version}"`);
  }

  if (/^\d+$/.test(firstIdentifier)) {
    throw new Error(
      `Version "${version}" has a numeric prerelease identifier. Use a named prerelease like alpha, beta, rc, or publish manually.`,
    );
  }

  if (!/^[a-z][a-z0-9-]*$/.test(firstIdentifier)) {
    throw new Error(
      `Derived npm dist-tag "${firstIdentifier}" from version "${version}" is invalid. Use a prerelease like alpha.0, beta.1, or rc.2.`,
    );
  }

  if (firstIdentifier === "latest") {
    throw new Error(
      `Refusing prerelease publish of version "${version}" because it derives the forbidden "latest" npm dist-tag.`,
    );
  }

  return firstIdentifier;
}
