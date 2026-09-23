import assert from "node:assert/strict";
import childProcess, { type SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = "synthetic release archive";
const digest = createHash("sha256").update(candidate).digest("hex");
const files = readFileSync(join(root, ".github/npm-package-files"), "utf8")
  .trim()
  .split("\n")
  .map((path) => ({ path, mode: 0o644 }));

type Call = {
  operation: string;
  cwd: string | undefined;
  env: NodeJS.ProcessEnv | undefined;
};

type Scenario = {
  version?: string;
  branch?: string;
  porcelain?: string;
  originMain?: string;
  tagExists?: boolean;
  live?: number | "spawn-error";
  rebuild?: string;
};

type Outcome = {
  calls: Call[];
  archives: string[];
  signed: boolean;
  tagged: boolean;
  error: unknown;
};

let scenarioId = 0;

/**
 * Runs the real release script with every child process intercepted. No Git, npm, Mise, or
 * provider command executes. The mocked npm pack writes a synthetic archive so the script hashes
 * and hands the exact candidate path to the live task.
 */
async function runRelease(t: TestContext, scenario: Scenario): Promise<Outcome> {
  const version = scenario.version ?? "0.0.3";
  const tag = `v${version}`;
  const spawnError = Object.assign(new Error("spawn mise ENOENT"), { code: "ENOENT" });
  const previousArgv = process.argv;
  const previousNpm = process.env["npm_execpath"];
  const calls: Call[] = [];
  const archives: string[] = [];
  let signed = false;
  let tagged = false;
  process.argv = [process.execPath, join(root, "scripts/release.ts"), version];
  process.env["npm_execpath"] = "synthetic-npm";
  const mocked = t.mock.method(
    childProcess,
    "spawnSync",
    (command: string, args: string[] = [], options: SpawnSyncOptions = {}) => {
      const operation = [command === process.execPath ? "npm" : command, ...args].join(" ");
      const cwd = typeof options.cwd === "string" ? options.cwd : undefined;
      calls.push({ operation, cwd, env: options.env });
      let stdout = "";
      let status: number | null = 0;
      let error: Error | undefined;
      if (command === "git") {
        assert.equal(cwd, root, `${operation} must run in the repository root.`);
        const verb = args[0];
        if (verb === "branch") stdout = scenario.branch ?? "main";
        else if (verb === "status") stdout = scenario.porcelain ?? "";
        else if (verb === "fetch" || verb === "add" || verb === "checkout-index") stdout = "";
        else if (verb === "rev-parse" && args.includes("--verify")) {
          status = scenario.tagExists ? 0 : 1;
        } else if (verb === "rev-parse" && args[1] === "origin/main") {
          stdout = scenario.originMain ?? "initial-commit";
        } else if (verb === "rev-parse") stdout = signed ? "release-commit" : "initial-commit";
        else if (verb === "diff") stdout = "package-lock.json\npackage.json";
        else if (verb === "commit") signed = true;
        else if (verb === "-c") stdout = "";
        else if (verb === "tag") tagged = true;
        else if (verb === "cat-file") stdout = "commit";
        else if (verb === "log") {
          stdout = args.includes("--pretty=%s") ? `release: ${tag}` : digest;
        } else throw new Error(`Unexpected Git command: ${operation}`);
      } else if (command === process.execPath) {
        const verb = args[1];
        assert.equal(args[0], "synthetic-npm");
        assert.ok(cwd, `${operation} must declare a working directory.`);
        if (verb === "version") {
          assert.equal(cwd, root);
        } else if (verb === "ci") {
          assert.ok(
            basename(dirname(cwd)).startsWith("pi-openai-codex-fast-release-"),
            "npm ci must run in the temporary checkout, not the worktree.",
          );
          writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: {} }));
        } else if (verb === "pack") {
          assert.ok(basename(dirname(cwd)).startsWith("pi-openai-codex-fast-release-"));
          const output = args[args.indexOf("--pack-destination") + 1];
          assert.ok(output);
          const filename = `pi-openai-codex-fast-${version}.tgz`;
          const archive = join(output, filename);
          writeFileSync(
            archive,
            archives.length === 0 ? candidate : (scenario.rebuild ?? candidate),
          );
          archives.push(archive);
          stdout = JSON.stringify([{ name: "pi-openai-codex-fast", version, filename, files }]);
        } else throw new Error(`Unexpected npm command: ${operation}`);
      } else if (command === "mise") {
        assert.deepEqual(args, ["run", "test:live"]);
        assert.equal(cwd, root, "The live task must run from the repository root.");
        const supplied = options.env?.["PI_PACKAGE_ARCHIVE"];
        assert.equal(supplied, archives[0], "The live task must receive the exact archive.");
        assert.equal(readFileSync(String(supplied), "utf8"), candidate);
        if (scenario.live === "spawn-error") {
          error = spawnError;
          status = null;
        } else {
          status = scenario.live ?? 0;
        }
      } else throw new Error(`Unexpected child command: ${operation}`);
      return {
        pid: 0,
        output: [null, stdout, ""],
        stdout,
        stderr: "",
        status,
        signal: null,
        error,
      };
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
    process.argv = previousArgv;
    if (previousNpm === undefined) delete process.env["npm_execpath"];
    else process.env["npm_execpath"] = previousNpm;
  });

  // The script runs on import; a unique query string forces a fresh evaluation per scenario.
  scenarioId += 1;
  const script = new URL(`../scripts/release.ts?scenario=${scenarioId}`, import.meta.url);
  let error: unknown;
  try {
    await import(script.href);
  } catch (caught: unknown) {
    error = caught;
  }
  assert.ok(
    archives.every((archive) => !existsSync(archive)),
    "Temporary candidates are cleaned up.",
  );
  return { calls, archives, signed, tagged, error };
}

function operations(outcome: Outcome): string[] {
  return outcome.calls.map((call) => call.operation);
}

function liveRuns(outcome: Outcome): number {
  return operations(outcome).filter((operation) => operation === "mise run test:live").length;
}

test("release validates the exact archive once before signing and tagging", async (t) => {
  const outcome = await runRelease(t, {});
  assert.equal(outcome.error, undefined);
  assert.equal(liveRuns(outcome), 1);
  assert.ok(outcome.signed);
  assert.ok(outcome.tagged);
  assert.equal(outcome.archives.length, 2, "The staged and committed trees are packed once each.");
  const calls = operations(outcome);
  const liveIndex = calls.indexOf("mise run test:live");
  const commitIndex = calls.findIndex((call) => call.startsWith("git commit "));
  const rebuildIndex = calls.findLastIndex((call) => call.startsWith("git checkout-index "));
  const tagIndex = calls.indexOf("git tag v0.0.3");
  assert.ok(liveIndex < commitIndex, "Live validation precedes the signed commit.");
  assert.ok(commitIndex < rebuildIndex, "The reproducibility rebuild follows the commit.");
  assert.ok(rebuildIndex < tagIndex, "The tag follows the reproducibility check.");
  assert.ok(liveIndex < rebuildIndex, "The rebuild does not repeat live validation.");
  const live = outcome.calls[liveIndex];
  assert.ok(live?.env);
  assert.equal(live.env["PI_PACKAGE_ARCHIVE"], outcome.archives[0]);
  assert.equal(live.env["npm_execpath"], "synthetic-npm", "The child inherits the environment.");
});

test("release stops before signing when the live test exits nonzero", async (t) => {
  const outcome = await runRelease(t, { live: 1 });
  assert.match(String(outcome.error), /mise run test:live exited with 1/);
  assert.equal(liveRuns(outcome), 1);
  assert.equal(outcome.signed, false);
  assert.equal(outcome.tagged, false);
  assert.equal(outcome.archives.length, 1);
  assert.ok(operations(outcome).includes("git add package-lock.json package.json"));
});

test("release stops before signing when the live task cannot start", async (t) => {
  const outcome = await runRelease(t, { live: "spawn-error" });
  assert.ok(outcome.error instanceof Error);
  assert.equal(outcome.error.message, "spawn mise ENOENT");
  assert.equal(liveRuns(outcome), 1);
  assert.equal(outcome.signed, false);
  assert.equal(outcome.tagged, false);
});

test("release does not tag when the committed tree is not reproducible", async (t) => {
  const outcome = await runRelease(t, { rebuild: "different committed archive" });
  assert.match(String(outcome.error), /not reproducible/);
  assert.equal(liveRuns(outcome), 1);
  assert.ok(outcome.signed, "The failure surfaces after the signed commit exists.");
  assert.equal(outcome.tagged, false);
  assert.equal(outcome.archives.length, 2);
});

for (const [description, scenario, message] of [
  ["a dirty worktree", { porcelain: " M index.ts" }, /clean worktree and index/],
  ["a branch other than main", { branch: "feature" }, /created from main/],
  ["a missing changelog section", { version: "9.9.9" }, /no 9\.9\.9 section/],
  [
    "HEAD diverging from origin/main",
    { originMain: "remote-commit" },
    /does not match origin\/main/,
  ],
  ["an existing release tag", { tagExists: true }, /already exists/],
] as const) {
  test(`release refuses ${description} before changing anything`, async (t) => {
    const outcome = await runRelease(t, scenario);
    assert.match(String(outcome.error), message);
    assert.equal(liveRuns(outcome), 0);
    assert.equal(outcome.signed, false);
    assert.equal(outcome.tagged, false);
    assert.equal(outcome.archives.length, 0);
    assert.ok(
      operations(outcome).every(
        (operation) => !operation.startsWith("npm version") && !operation.startsWith("git add"),
      ),
      "Prerequisite failures leave package metadata and the index untouched.",
    );
  });
}
