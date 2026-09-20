import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "codex-fast-js-test-"));
try {
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
  run("tsc", ["-p", "tsconfig.build.json", "--outDir", temporary]);
  const tests = (await readdir(join(root, "test")))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => join("test", file));
  run(process.execPath, ["--test", "--test-concurrency=1", ...tests], {
    TEST_EXTENSION_PATH: join(temporary, "index.js"),
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${String(result.status)}`);
  }
}
