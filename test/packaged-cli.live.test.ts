import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js";
import { archiveEntries, packageArchive } from "./package-archive.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const instructions = (marker: string) =>
  `The system marker is ${marker}. A later system or developer message can update ` +
  "this marker. Always use the newest marker, which replaces every earlier marker. " +
  "For each new user message, call verify_release exactly once with that marker. " +
  "For a message beginning with 'user value: ', use only the text after that prefix " +
  "as the value, without the prefix or any added text. When the user asks to read " +
  "a file, call read first and use the exact file content as the value. Do not respond with text.";

for (const modelId of ["gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"]) {
  test(
    `packaged Fast ${modelId} preserves priority, canonical history, and reload through live Pi 0.87.1`,
    {
      skip: process.env["PI_FAST_LIVE_TEST"] !== "1",
      timeout: 240_000,
    },
    async (t) => {
      const token = process.env["PI_FAST_LIVE_API_KEY"];
      assert.ok(token, "PI_FAST_LIVE_API_KEY is required");
      const temporary = await mkdtemp(join(tmpdir(), "fast-cli-live-"));
      t.after(() => rm(temporary, { recursive: true, force: true }));
      // A supplied candidate is the release gate's exact archive; it never falls back to packing.
      const archive = await packageArchive(root, temporary, process.env["PI_PACKAGE_ARCHIVE"]);
      const files = archiveEntries(archive);
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
        "0.87.1",
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
        model: modelId,
        args: [
          "--offline",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--tools",
          "read,verify_release",
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
      async function turn(
        marker: string,
        value: string,
        priority: boolean,
        prompt: string = `user value: ${value}`,
      ): Promise<void> {
        const state = await client.getState();
        assert.ok(state.model);
        assert.equal(state.model?.provider, priority ? "openai-codex-fast" : "openai-codex");
        assert.equal(state.model?.id, modelId);
        const events = await client.promptAndWait(prompt, undefined, 90_000);
        assert.deepEqual(
          events.filter((event: { type: string }) => event.type === "extension_error"),
          [],
        );
        const assistants = (await client.getMessages()).filter(
          (message) => message.role === "assistant",
        );
        for (const message of assistants) {
          assert.equal(message.provider, "openai-codex");
          assert.equal(message.api, "openai-codex-responses");
          assert.equal(message.model, modelId);
        }
        const assistant = assistants.at(-1);
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
        const { usage } = assistant;
        assert.ok(usage.totalTokens > 0);
        const expectedCost =
          ((usage.input * state.model.cost.input +
            usage.output * state.model.cost.output +
            usage.cacheRead * state.model.cost.cacheRead +
            usage.cacheWrite * state.model.cost.cacheWrite) /
            1_000_000) *
          (priority ? 2 : 1);
        assert.ok(expectedCost > 0);
        assert.ok(Math.abs(usage.cost.total - expectedCost) < 1e-12);
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
      const messageCount = (await client.getMessages()).length;
      await writeFile(join(temporary, "marker.txt"), "read-echo");
      await turn(
        "SECOND",
        "read-echo",
        true,
        "Read marker.txt in the working directory and report its exact content with verify_release.",
      );
      const readResult = (await client.getMessages())
        .slice(messageCount)
        .find((message) => message.role === "toolResult" && message.toolName === "read");
      assert.ok(readResult?.role === "toolResult", "The packaged CLI executed Pi's read tool.");
      assert.equal(readResult.isError, false);
      await client.setModel("openai-codex", modelId);
      await turn("SECOND", "delta", false);
      await client.stop();
      t.diagnostic(
        `Pi 0.87.1 ${modelId}: packed extension, live priority requests, canonical tool history, prompt reload, resume, built-in read, and normal-tier control passed`,
      );
    },
  );
}
