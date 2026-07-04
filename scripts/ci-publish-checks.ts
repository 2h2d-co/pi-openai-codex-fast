import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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

if (process.argv.length > 2) {
  throw new Error("ci-publish-checks.ts does not accept arguments.");
}

assertCiReleaseGitState(version);
const npmTag = deriveNpmTag(version);
writeGithubOutput("npm_tag", npmTag);
writeGithubOutput("package_name", packageName);
writeGithubOutput("package_version", version);
writeGithubOutput("release_tag", `v${version}`);
writeGithubOutput("is_prerelease", version.includes("-") ? "true" : "false");

console.log(`Validated CI release for ${packageName}@${version} with npm dist-tag "${npmTag}".`);

function assertCiReleaseGitState(version: string): void {
  const releaseTag = `v${version}`;
  const eventName = getRequiredEnv("GITHUB_EVENT_NAME");
  const ref = getRequiredEnv("GITHUB_REF");
  const sha = getRequiredEnv("GITHUB_SHA");

  if (getRequiredEnv("GITHUB_ACTIONS") !== "true") {
    throw new Error("Refusing release because GITHUB_ACTIONS is not true.");
  }
  if (eventName !== "push") {
    throw new Error(`Refusing release for event "${eventName}".`);
  }
  if (ref !== "refs/heads/main") {
    throw new Error(`Refusing release from ref "${ref}".`);
  }

  const insideWorkTree = runGit(["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") {
    throw new Error("Refusing release outside of a Git work tree.");
  }

  const head = runGit(["rev-parse", "HEAD"]);
  if (sha !== head) {
    throw new Error(`Refusing release because GITHUB_SHA does not match HEAD (${head}).`);
  }

  const subject = runGit(["log", "-1", "--pretty=%s"]);
  const expectedSubject = `release: ${releaseTag}`;
  if (subject !== expectedSubject) {
    throw new Error(
      `Refusing release because HEAD subject is "${subject}", not "${expectedSubject}".`,
    );
  }

  if (!gitSucceeds(["rev-parse", "--verify", "--quiet", `refs/tags/${releaseTag}`])) {
    throw new Error(`Refusing release because tag "${releaseTag}" does not exist.`);
  }

  const tagCommit = runGit(["rev-list", "-n", "1", releaseTag]);
  if (tagCommit !== head) {
    throw new Error(`Refusing release because tag "${releaseTag}" does not point at HEAD.`);
  }
}

function deriveNpmTag(version: string): string {
  const prerelease = version.match(/-([0-9A-Za-z.-]+)$/)?.[1];
  if (!prerelease) {
    return "latest";
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

  return firstIdentifier;
}

function writeGithubOutput(name: string, value: string): void {
  const outputPath = getRequiredEnv("GITHUB_OUTPUT");
  appendFileSync(outputPath, `${name}=${value}\n`);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
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
