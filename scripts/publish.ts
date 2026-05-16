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
