import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Runs the live packaged-CLI test through the repository's Pi dependency. Pi finds its own
// package directory, so an inherited PI_PACKAGE_DIR is removed rather than replaced.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const env: NodeJS.ProcessEnv = { ...process.env };
delete env["PI_PACKAGE_DIR"];

const token = execFileSync(
  process.execPath,
  [pi, "auth", "print-bearer-token", "--provider", "openai-codex", "--model", "gpt-5.6-luna"],
  { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
).trim();
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "test/packaged-cli.live.test.ts"],
  {
    cwd: root,
    env: { ...env, PI_FAST_LIVE_TEST: "1", PI_FAST_LIVE_API_KEY: token },
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
