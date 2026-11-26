import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-client.js";
import manifest from "../package.json" with { type: "json" };
import { CodexModelCatalog, extractAccountId } from "../model-catalog.ts";
import { describeFailure, errorLog } from "./support/error-log.ts";
import { archiveEntries, packageArchive } from "./support/package-archive.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piVersion = manifest.devDependencies["@earendil-works/pi-coding-agent"];
const instructions = (marker: string) =>
  `The system marker is ${marker}. A later system or developer message can update ` +
  "this marker. Always use the newest marker, which replaces every earlier marker. " +
  "For each new user message, call verify_release exactly once with that marker. " +
  "For a message beginning with 'user value: ', use only the text after that prefix " +
  "as the value, without the prefix or any added text. When the user asks to read " +
  "a file, call read first and use the exact file content as the value. Do not respond with text.";

// OpenAI prices GPT-6.2 Ultrafast at 3 times Standard through February 28, 2027, Pacific time,
// and at 6 times Standard from March 1, 2027.
const GPT_6_2_ULTRAFAST_LIST_PRICE_FROM = Date.parse("2027-03-01T08:00:00Z");
const liveCases = [
  ...["gpt-6.2-sol", "gpt-6.2-astra"].map((modelId) => ({
    provider: "openai-codex-fast",
    serviceTier: "priority",
    modelId,
  })),
  ...["gpt-6.2-sol", "gpt-6.2-astra"].map((modelId) => ({
    provider: "openai-codex-ultrafast",
    serviceTier: "ultrafast",
    modelId,
  })),
] as const;

for (const { provider, serviceTier, modelId } of liveCases) {
  test(
    `packaged ${provider}/${modelId} sends ${serviceTier} where the account's catalog lists it, with canonical history and reload, through live Pi ${piVersion}`,
    {
      skip: process.env["PI_FAST_LIVE_TEST"] !== "1",
      timeout: 240_000,
    },
    async (t) => {
      const token = process.env["PI_FAST_LIVE_API_KEY"];
      assert.ok(token, "PI_FAST_LIVE_API_KEY is required");
      // The account's model catalog decides whether the provider may send its tier to the model.
      const accountId = extractAccountId(token);
      const catalog = new CodexModelCatalog({ file: () => undefined });
      await catalog.load({ accountId, apiKey: token, baseUrl: undefined });
      assert.equal(catalog.failure(accountId), undefined);
      const catalogTiers = catalog.serviceTiers(accountId, modelId);
      assert.ok(catalogTiers, `The Codex model catalog does not list ${modelId}.`);
      t.diagnostic(`${modelId} catalog tiers: ${[...catalogTiers].join(", ")}`);
      const listed = catalogTiers.has(serviceTier);
      if (modelId === "gpt-6.2-sol") {
        assert.ok(listed, `The live tests need a plan with ${serviceTier} on GPT-6.2 Sol.`);
      }
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
      const env = {
        HOME: temporary,
        PI_CODING_AGENT_DIR: join(temporary, "agent"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        PI_FAST_LIVE_API_KEY: token,
      };
      assert.equal(
        execFileSync(process.execPath, [cli, "--version"], {
          env: { ...process.env, ...env },
          encoding: "utf8",
        }).trim(),
        piVersion,
        "Live validation requires the Pi version pinned as the development dependency.",
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
          retry: { enabled: false, provider: { timeoutMs: 60_000, maxRetries: 0 } },
          compaction: { enabled: false },
        }),
      );
      await writeFile(join(env.PI_CODING_AGENT_DIR, "SYSTEM.md"), instructions("FIRST"));
      const options = {
        cliPath: cli,
        cwd: temporary,
        env,
        provider,
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
          join(root, "test/support/cli-observer.ts"),
        ],
      };
      const errors = errorLog(t);
      let client = new RpcClient(options);
      t.after(async () => client.stop());
      client.onEvent(errors.rpcEvent);
      await client.start();
      if (!listed) {
        // The provider refuses a tier the plan lacks before any request, so nothing is billed.
        await client.promptAndWait("user value: refused", undefined, 90_000);
        const refused = (await client.getMessages()).at(-1);
        assert.ok(refused?.role === "assistant");
        assert.equal(refused.stopReason, "error");
        assert.equal(
          refused.errorMessage,
          serviceTier === "ultrafast"
            ? `Your ChatGPT plan does not include Ultrafast for ${modelId}. Select openai-codex-fast/${modelId} instead.`
            : `Your ChatGPT plan does not include Fast for ${modelId}. Select openai-codex/${modelId} instead.`,
        );
        assert.equal(refused.usage.cost.total, 0);
        assert.ok(
          !(await client.getEntries()).entries.some(
            (entry) => entry.type === "custom" && entry.customType === "release-test-tier",
          ),
          "The refused prompt sent no provider request.",
        );
        t.diagnostic(
          `Pi ${piVersion} ${provider}/${modelId}: packed extension refused ${serviceTier}, which the plan lacks`,
        );
        return;
      }
      async function turn(
        marker: string,
        value: string,
        speed: boolean,
        prompt: string = `user value: ${value}`,
      ): Promise<void> {
        const state = await client.getState();
        assert.ok(state.model);
        assert.equal(state.model?.provider, speed ? provider : "openai-codex");
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
          assistant.errorMessage !== undefined
            ? describeFailure(assistant)
            : JSON.stringify(
                assistant.content.map((block) => ({
                  type: block.type,
                  text: block.type === "text" ? block.text : undefined,
                })),
              ),
        );
        const { usage } = assistant;
        assert.ok(usage.totalTokens > 0);
        const multiplier = !speed
          ? 1
          : serviceTier === "priority"
            ? 2
            : assistant.timestamp < GPT_6_2_ULTRAFAST_LIST_PRICE_FROM
              ? 3
              : 6;
        const expectedCost =
          ((usage.input * state.model.cost.input +
            usage.output * state.model.cost.output +
            usage.cacheRead * state.model.cost.cacheRead +
            usage.cacheWrite * state.model.cost.cacheWrite) /
            1_000_000) *
          multiplier;
        assert.ok(expectedCost > 0);
        assert.ok(Math.abs(usage.cost.total - expectedCost) < 1e-12);
        const call = assistant.content.find((block) => block.type === "toolCall");
        assert.ok(call);
        assert.equal(call.name, "verify_release");
        const entry = (await client.getEntries()).entries
          .filter(
            (candidate) =>
              candidate.type === "custom" && candidate.customType === "release-test-tier",
          )
          .at(-1);
        assert.ok(entry?.type === "custom");
        // Verify the submitted prompt independently of the model's adherence.
        assert.deepEqual(entry.data, { serviceTier: speed ? serviceTier : null, marker });
        assert.deepEqual(call.arguments, { marker, value });
        assert.doesNotMatch(client.getStderr(), /Failed to load extension|not a function/);
      }
      /**
       * Characters per second in which the model generates a long verify_release call, measured
       * from its first to its last streamed tool-call event.
       */
      async function generationSpeed(): Promise<number> {
        const value = Array.from({ length: 250 }, (_, index) => String(index + 1)).join(" ");
        let start: number | undefined;
        let end: number | undefined;
        let characters = 0;
        const unsubscribe = client.onEvent((event) => {
          if (event.type !== "message_update") return;
          const update = event.assistantMessageEvent;
          if (update.type === "toolcall_start") start = performance.now();
          if (update.type === "toolcall_delta") characters += update.delta.length;
          if (update.type === "toolcall_end") end = performance.now();
        });
        try {
          await turn("SECOND", value, (await client.getState()).model?.provider === provider);
        } finally {
          unsubscribe();
        }
        assert.ok(start !== undefined && end !== undefined, "The tool call was streamed.");
        assert.ok(characters >= value.length, "The streamed tool call carries the value.");
        return characters / (Math.max(end - start, 1) / 1_000);
      }

      await turn("FIRST", "alpha", true);
      await writeFile(join(env.PI_CODING_AGENT_DIR, "SYSTEM.md"), instructions("SECOND"));
      await client.prompt("/release-test-reload");
      await turn("SECOND", "bravo", true);
      await client.stop();
      client = new RpcClient(options);
      client.onEvent(errors.rpcEvent);
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
      if (serviceTier === "ultrafast") {
        // Codex echoes `default` for every tier and silently serves Standard speed when the plan
        // lacks Ultrafast, so only the generation speed shows that Ultrafast served the request.
        const standard = await generationSpeed();
        await client.setModel(provider, modelId);
        const ultrafast = await generationSpeed();
        t.diagnostic(
          `Tool-call generation: Standard ${standard.toFixed(0)} and Ultrafast ${ultrafast.toFixed(0)} characters per second`,
        );
        assert.ok(
          ultrafast >= standard * 3,
          `Ultrafast generated ${ultrafast.toFixed(0)} characters per second, Standard ${standard.toFixed(0)}`,
        );
      }
      await client.stop();
      t.diagnostic(
        `Pi ${piVersion} ${provider}/${modelId}: packed extension, live ${serviceTier} requests, canonical tool history, prompt reload, resume, built-in read, and normal-tier control passed`,
      );
    },
  );
}
