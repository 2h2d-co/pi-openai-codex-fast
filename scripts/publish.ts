import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const packageJsonPath = resolve(process.cwd(), "package.json");
const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const name = pkg.name ?? "<unknown-package>";
const version = pkg.version;

if (typeof version !== "string" || version.length === 0) {
  throw new Error(`Missing or invalid version in ${packageJsonPath}`);
}

const cliArgs = process.argv.slice(2);
const execute = cliArgs.includes("--execute");
const extraArgs = cliArgs.filter((arg) => arg !== "--execute");

if (
  extraArgs.some(
    (arg, index) =>
      arg === "--tag" || arg.startsWith("--tag=") || (arg === "-t" && index < extraArgs.length - 1),
  )
) {
  throw new Error(
    "Do not pass --tag to release scripts; the dist-tag is derived from package.json version.",
  );
}

const prerelease = version.match(/-([0-9A-Za-z.-]+)$/)?.[1];
const tag = prerelease ? deriveTag(prerelease, version) : "latest";
const publishArgs = ["publish", "--tag", tag, ...extraArgs];

if (!execute) {
  publishArgs.push("--dry-run");
} else {
  assertReleaseGitState(version);
}

console.log(
  `${execute ? "Publishing" : "Dry-run publishing"} ${name}@${version} with npm dist-tag "${tag}"`,
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

function assertReleaseGitState(version: string): void {
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

  const remote = runGit(["config", `branch.${branch}.remote`]);
  if (!remote) {
    throw new Error(`Refusing to publish because branch "${branch}" has no upstream remote.`);
  }

  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
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

function deriveTag(prerelease: string, fullVersion: string) {
  const firstIdentifier = prerelease.split(".")[0]?.toLowerCase();

  if (!firstIdentifier) {
    throw new Error(`Could not derive npm dist-tag from version "${fullVersion}"`);
  }

  if (/^\d+$/.test(firstIdentifier)) {
    throw new Error(
      `Version "${fullVersion}" has a numeric prerelease identifier. Use a named prerelease like alpha, beta, rc, or publish manually.`,
    );
  }

  if (!/^[a-z][a-z0-9-]*$/.test(firstIdentifier)) {
    throw new Error(
      `Derived npm dist-tag "${firstIdentifier}" from version "${fullVersion}" is invalid. Use a prerelease like alpha.0, beta.1, or rc.2.`,
    );
  }

  return firstIdentifier;
}
