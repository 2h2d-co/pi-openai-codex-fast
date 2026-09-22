import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const instructions = (marker: string) =>
  `The system marker is ${marker}. Call verify_release exactly once with that marker and ` +
  "the value from the latest user message. Do not respond with text.";

test(
  "packaged Fast preserves priority, canonical history, and reload through live Pi 0.87",
  {
    skip: process.env["PI_FAST_LIVE_TEST"] !== "1",
    timeout: 240_000,
  },
  async (t) => {
    const token = process.env["PI_FAST_LIVE_API_KEY"];
    assert.ok(token, "PI_FAST_LIVE_API_KEY is required");
    const temporary = await mkdtemp(join(tmpdir(), "fast-cli-live-"));
    t.after(() => rm(temporary, { recursive: true, force: true }));
    let archive = process.env["PI_PACKAGE_ARCHIVE"];
    if (!archive) {
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--allow-directory=all", "--pack-destination", temporary],
        { cwd: root, stdio: "pipe" },
      );
      const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      assert.ok(manifest && typeof manifest === "object" && "version" in manifest);
      assert.ok(typeof manifest.version === "string");
      archive = join(temporary, `pi-openai-codex-fast-${manifest.version}.tgz`);
    }
    const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    const expected = (await readFile(join(root, ".github/npm-package-files"), "utf8"))
      .trim()
      .split("\n")
      .map((file) => `package/${file}`)
      .sort();
    assert.deepEqual(files, expected);
    execFileSync("tar", ["-xzf", archive, "-C", temporary]);
    const cli = await realpath(
      process.env["PI_TEST_CLI_PATH"] ??
        join(root, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
    );
    const piRoot = resolve(dirname(cli), "../..");
    const env = {
      HOME: temporary,
      PI_CODING_AGENT_DIR: join(temporary, "agent"),
      PI_PACKAGE_DIR: piRoot,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      PI_FAST_LIVE_API_KEY: token,
    };
    assert.equal(
      execFileSync(process.execPath, [cli, "--version"], {
        env: { ...process.env, ...env },
        encoding: "utf8",
      }).trim(),
      "0.87.0",
    );
    await mkdir(env.PI_CODING_AGENT_DIR);
    await writeFile(
      join(env.PI_CODING_AGENT_DIR, "models.json"),
      JSON.stringify({
        providers: { "openai-codex": { apiKey: "$PI_FAST_LIVE_API_KEY" } },
      }),
    );
    await writeFile(
      join(env.PI_CODING_AGENT_DIR, "settings.json"),
      JSON.stringify({
        transport: "sse",
        retry: { enabled: false, provider: { timeoutMs: 60_000, maxRetries: 0 } },
        compaction: { enabled: false },
      }),
    );
    await writeFile(join(env.PI_CODING_AGENT_DIR, "SYSTEM.md"), instructions("FIRST"));
    const options = {
      cliPath: cli,
      cwd: temporary,
      env,
      provider: "openai-codex-fast",
      model: "gpt-5.6-luna",
      args: [
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-builtin-tools",
        "--tools",
        "verify_release",
        "--thinking",
        "medium",
        "--session",
        join(temporary, "session.jsonl"),
        "-e",
        join(temporary, "package"),
        "-e",
        join(root, "test/cli-observer.ts"),
      ],
    };
    let client = new RpcClient(options);
    t.after(async () => client.stop());
    await client.start();
    async function turn(marker: string, value: string, priority: boolean): Promise<void> {
      const state = await client.getState();
      assert.equal(state.model?.provider, priority ? "openai-codex-fast" : "openai-codex");
      const events = await client.promptAndWait(`user value: ${value}`, undefined, 90_000);
      assert.deepEqual(
        events.filter((event: { type: string }) => event.type === "extension_error"),
        [],
      );
      const assistant = (await client.getMessages())
        .filter((message) => message.role === "assistant")
        .at(-1);
      assert.ok(assistant);
      assert.equal(
        assistant.stopReason,
        "toolUse",
        assistant.errorMessage ??
          JSON.stringify(
            assistant.content.map((block) => ({
              type: block.type,
              text: block.type === "text" ? block.text : undefined,
            })),
          ),
      );
      assert.equal(assistant.provider, "openai-codex");
      assert.equal(assistant.api, "openai-codex-responses");
      const call = assistant.content.find((block) => block.type === "toolCall");
      assert.ok(call);
      assert.equal(call.name, "verify_release");
      assert.deepEqual(call.arguments, { marker, value });
      const entry = (await client.getEntries()).entries
        .filter(
          (candidate) =>
            candidate.type === "custom" && candidate.customType === "release-test-tier",
        )
        .at(-1);
      assert.ok(entry?.type === "custom");
      assert.deepEqual(entry.data, { priority });
      assert.doesNotMatch(client.getStderr(), /Failed to load extension|not a function/);
    }
    await turn("FIRST", "alpha", true);
    await writeFile(join(env.PI_CODING_AGENT_DIR, "SYSTEM.md"), instructions("SECOND"));
    await client.prompt("/release-test-reload");
    await turn("SECOND", "bravo", true);
    await client.stop();
    client = new RpcClient(options);
    await client.start();
    await turn("SECOND", "charlie", true);
    await client.setModel("openai-codex", "gpt-5.6-luna");
    await turn("SECOND", "delta", false);
    await client.stop();
    t.diagnostic(
      "Pi 0.87.0: packed extension, live priority requests, canonical tool history, prompt reload, resume, and normal-tier control passed",
    );
  },
);
