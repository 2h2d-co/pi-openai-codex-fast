import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  resolveModelScopeWithDiagnostics,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CompactionSettings,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Credential, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(rootDir, process.env["TEST_EXTENSION_PATH"] ?? "index.ts");

const CODEX_PROVIDER = "openai-codex";
const CODEX_API = "openai-codex-responses";
const FAST_PROVIDER = "openai-codex-fast";
const FAST_API = "openai-codex-fast-responses";
const MODEL_ID = "gpt-5.5";
const FAST_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
];
const SESSION_START_REASONS: SessionStartEvent["reason"][] = [
  "startup",
  "reload",
  "new",
  "resume",
  "fork",
];
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const ACCOUNT_ID_CLAIM = "https://api.openai.com/auth";

type JsonPrimitive = boolean | null | number | string;

type JsonValue = JsonObject | JsonPrimitive | JsonValue[];

type JsonObject = {
  [key: string]: JsonValue;
};

type SseEvent = JsonObject;

type CompletedSseEvent = {
  type: "response.completed";
  response: {
    id: string;
    status: "completed";
    service_tier: "default";
    usage: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      input_tokens_details: {
        cached_tokens: 0;
      };
    };
  };
};

type CodexModelsModule = {
  getBuiltinModels: (provider: typeof CODEX_PROVIDER) => Model<typeof CODEX_API>[];
};

type PackageManifest = {
  name: string;
  pi: {
    extensions: string[];
  };
};

interface UsageFixture {
  input: number;
  output: number;
}

interface CodexResponseBatch {
  status?: number;
  events?: SseEvent[];
}

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: JsonObject;
}

interface CodexTestServer {
  baseUrl: string;
  requests: CapturedRequest[];
}

interface IntegrationSessionOptions {
  bindExtensions?: boolean;
  codexBaseUrl?: string;
  compaction?: CompactionSettings;
  sessionManager?: SessionManager;
  sessionStartReason?: SessionStartEvent["reason"];
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object" && Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && isJsonValue(value) && value !== null && !Array.isArray(value);
}

function parseJsonObject(value: string): JsonObject {
  const parsed: unknown = JSON.parse(value);
  if (!isJsonObject(parsed)) {
    throw new Error("Expected a JSON object.");
  }
  return parsed;
}

function isAddressInfo(value: AddressInfo | string | null): value is AddressInfo {
  return typeof value === "object" && value !== null;
}

function isCodexModelsModule(value: unknown): value is CodexModelsModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "getBuiltinModels" in value &&
    typeof value.getBuiltinModels === "function"
  );
}

function isPackageManifest(value: unknown): value is PackageManifest {
  if (!isJsonObject(value) || !isString(value["name"]) || !isJsonObject(value["pi"])) {
    return false;
  }
  const extensions = value["pi"]["extensions"];
  return Array.isArray(extensions) && extensions.every(isString);
}

function base64Json(value: JsonValue): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function fakeCodexToken(): string {
  return [
    base64Json({ alg: "none", typ: "JWT" }),
    base64Json({ [ACCOUNT_ID_CLAIM]: { chatgpt_account_id: "acct_test" } }),
    "signature",
  ].join(".");
}

function codexCredential(token = fakeCodexToken()): Credential {
  return {
    type: "oauth",
    access: token,
    refresh: "refresh_test",
    expires: Date.now() + 60 * 60 * 1000,
    accountId: "acct_test",
  };
}

async function writeCodexAuth(agentDir: string, token = fakeCodexToken()): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({ [CODEX_PROVIDER]: codexCredential(token) }, null, 2),
  );
}

function responseCompleted(
  id: string,
  usage: UsageFixture = { input: 10, output: 5 },
): CompletedSseEvent {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      service_tier: "default",
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        total_tokens: usage.input + usage.output,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  };
}

function textResponseEvents(text: string, id = "resp_text"): SseEvent[] {
  return [
    { type: "response.created", response: { id } },
    {
      type: "response.output_item.added",
      item: { id: `msg_${id}`, type: "message", role: "assistant", content: [] },
    },
    {
      type: "response.content_part.added",
      part: { type: "output_text", text: "", annotations: [] },
    },
    { type: "response.output_text.delta", delta: text },
    {
      type: "response.output_item.done",
      item: {
        id: `msg_${id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    responseCompleted(id),
  ];
}

function contextOverflowResponseEvents(id = "resp_overflow"): SseEvent[] {
  return [
    { type: "response.created", response: { id } },
    {
      type: "response.failed",
      response: {
        id,
        status: "failed",
        error: {
          code: "context_length_exceeded",
          message: "Your input exceeds the context window of this model.",
        },
      },
    },
  ];
}

function toolCallResponseEvents(id = "resp_tool"): SseEvent[] {
  const args = JSON.stringify({ reason: "integration-test" });
  return [
    { type: "response.created", response: { id } },
    {
      type: "response.output_item.added",
      item: {
        id: `fc_${id}`,
        type: "function_call",
        call_id: `call_${id}`,
        name: "missing_tool",
        arguments: "",
      },
    },
    { type: "response.function_call_arguments.delta", delta: args },
    { type: "response.function_call_arguments.done", arguments: args },
    {
      type: "response.output_item.done",
      item: {
        id: `fc_${id}`,
        type: "function_call",
        call_id: `call_${id}`,
        name: "missing_tool",
        arguments: args,
      },
    },
    responseCompleted(id),
  ];
}

function sse(events: SseEvent[]): string {
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function startCodexServer(
  t: TestContext,
  responseBatches: CodexResponseBatch[],
): Promise<CodexTestServer> {
  const requests: CapturedRequest[] = [];
  let requestIndex = 0;
  const server = createServer((req, res) => {
    const request = async () => {
      const bodyChunks: Buffer[] = [];
      for await (const rawChunk of req) {
        const chunk: unknown = rawChunk;
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError("Expected an HTTP request body byte chunk.");
        }
        bodyChunks.push(Buffer.from(chunk));
      }

      const bodyBuffer = Buffer.concat(bodyChunks);
      const contentEncoding = req.headers["content-encoding"];
      const contentEncodings = (
        isString(contentEncoding) ? [contentEncoding] : (contentEncoding ?? [])
      )
        .flatMap((encoding) => encoding.split(","))
        .map((encoding) => encoding.trim().toLowerCase());
      const rawBody = contentEncodings.includes("zstd")
        ? zstdDecompressSync(bodyBuffer).toString("utf8")
        : bodyBuffer.toString("utf8");
      const body = rawBody ? parseJsonObject(rawBody) : {};
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      const isModelRequest = isString(body["model"]);
      const batch = isModelRequest
        ? (responseBatches[Math.min(requestIndex, responseBatches.length - 1)] ?? {})
        : {};
      if (isModelRequest) {
        requestIndex += 1;
      }

      res.writeHead(batch.status ?? 200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.end(sse(batch.events ?? []));
    };
    request().catch((error: unknown) => {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  t.after(
    () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolveClose();
          }
        });
      }),
  );

  const address = server.address();
  assert.ok(isAddressInfo(address));
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

async function pointBuiltInCodexAt(baseUrl: string, t: TestContext): Promise<void> {
  type GetCodexModels = () => Model<typeof CODEX_API>[];
  const getCodexModels: GetCodexModels[] = [() => getBuiltinModels(CODEX_PROVIDER)];
  const nestedPiAiPath = resolve(
    rootDir,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/all.js",
  );

  try {
    const nestedPiAi: unknown = await import(pathToFileURL(nestedPiAiPath).href);
    if (isCodexModelsModule(nestedPiAi)) {
      const getNestedModels = nestedPiAi.getBuiltinModels;
      getCodexModels.push(() => getNestedModels(CODEX_PROVIDER));
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND")) {
      throw error;
    }
    // No nested Pi AI copy is installed in this dependency layout.
  }

  const previousBaseUrls: Array<[Model<typeof CODEX_API>, string]> = [];
  for (const getModels of getCodexModels) {
    const models = getModels();
    for (const model of models) {
      previousBaseUrls.push([model, model.baseUrl]);
      model.baseUrl = baseUrl;
    }
  }

  t.after(() => {
    for (const [model, previousBaseUrl] of previousBaseUrls) {
      model.baseUrl = previousBaseUrl;
    }
  });
}

async function createTestModelRuntime(agentDir: string): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  });
}

async function reloadResourceLoaderWithAgentDir(
  resourceLoader: DefaultResourceLoader,
  agentDir: string,
): Promise<void> {
  const previousAgentDir = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = agentDir;
  try {
    await resourceLoader.reload();
  } finally {
    if (previousAgentDir === undefined) {
      delete process.env[AGENT_DIR_ENV];
    } else {
      process.env[AGENT_DIR_ENV] = previousAgentDir;
    }
  }
}

async function createIntegrationSession(
  t: TestContext,
  options: IntegrationSessionOptions = {},
): Promise<CreateAgentSessionResult> {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-openai-codex-fast-"));
  const cwd = join(tempRoot, "cwd");
  const agentDir = join(tempRoot, "agent");
  await mkdir(cwd, { recursive: true });
  await writeCodexAuth(agentDir);
  t.after(async () => rm(tempRoot, { recursive: true, force: true }));

  if (options.codexBaseUrl) {
    await pointBuiltInCodexAt(options.codexBaseUrl, t);
  }

  const modelRuntime = await createTestModelRuntime(agentDir);
  const settingsManager = SettingsManager.inMemory({
    transport: "sse",
    defaultThinkingLevel: "off",
    retry: { enabled: false, provider: { maxRetries: 0 } },
    compaction: options.compaction ?? { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await reloadResourceLoaderWithAgentDir(resourceLoader, agentDir);

  const initialModel = modelRuntime.getModel(CODEX_PROVIDER, MODEL_ID);
  assert.ok(initialModel, `Expected built-in ${CODEX_PROVIDER}/${MODEL_ID} to exist`);

  const sessionOptions: CreateAgentSessionOptions = {
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager: options.sessionManager ?? SessionManager.inMemory(cwd),
    resourceLoader,
    model: initialModel,
    thinkingLevel: "off",
    noTools: "all",
  };
  if (options.sessionStartReason) {
    sessionOptions.sessionStartEvent = {
      type: "session_start",
      reason: options.sessionStartReason,
    };
  }
  const result = await createAgentSession(sessionOptions);
  t.after(() => result.session.dispose());

  assert.deepEqual(result.extensionsResult.errors, []);
  assert.ok(modelRuntime.getModel(FAST_PROVIDER, MODEL_ID));
  if (options.bindExtensions !== false) {
    await result.session.bindExtensions({});
  }
  return result;
}

async function selectFastModel(session: AgentSession, modelId = MODEL_ID): Promise<Model<Api>> {
  const fastModel = session.modelRuntime.getModel(FAST_PROVIDER, modelId);
  assert.ok(fastModel, `Expected registered ${FAST_PROVIDER}/${modelId} model`);
  await session.setModel(fastModel);
  assert.equal(session.model?.provider, FAST_PROVIDER);
  assert.equal(session.model?.id, modelId);
  return fastModel;
}

function assistantMessages(session: AgentSession): AssistantMessage[] {
  const messages: AssistantMessage[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      messages.push(entry.message);
    }
  }
  return messages;
}

function assertCanonicalAssistantMessages(session: AgentSession): void {
  for (const message of assistantMessages(session)) {
    assert.equal(message.provider, CODEX_PROVIDER);
    assert.equal(message.api, CODEX_API);
  }
}

test("package manifest keeps npm package name while loading the top-level extension path", async () => {
  const packageJson: unknown = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  assert.ok(isPackageManifest(packageJson));

  assert.equal(packageJson.name, "pi-openai-codex-fast");
  assert.deepEqual(packageJson.pi.extensions, ["./index.ts"]);
});

test("registers fast models before session_start without requiring Codex auth", async (t) => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-openai-codex-fast-no-auth-"));
  const cwd = join(tempRoot, "cwd");
  const agentDir = join(tempRoot, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  t.after(async () => rm(tempRoot, { recursive: true, force: true }));

  const modelRuntime = await createTestModelRuntime(agentDir);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await reloadResourceLoaderWithAgentDir(resourceLoader, agentDir);

  const extensionsResult = resourceLoader.getExtensions();
  assert.equal(extensionsResult.extensions.length, 1);
  assert.equal(extensionsResult.runtime.pendingProviderRegistrations.length, 1);
  assert.deepEqual(extensionsResult.errors, []);

  const result = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    noTools: "all",
  });
  t.after(() => result.session.dispose());

  assert.ok(result.session.modelRuntime.getModel(FAST_PROVIDER, MODEL_ID));
  const scope = await resolveModelScopeWithDiagnostics(
    [`${FAST_PROVIDER}/gpt-5.6-sol`, `${FAST_PROVIDER}/gpt-5.6-terra`, `${FAST_PROVIDER}/gpt-5.5`],
    result.session.modelRuntime,
  );
  assert.deepEqual(scope.diagnostics, []);
  assert.deepEqual(
    scope.scopedModels.map(({ model }) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5"],
  );
  await result.session.bindExtensions({});
  assert.ok(result.session.modelRuntime.getModel(FAST_PROVIDER, MODEL_ID));
});

test("loads through Pi's resource loader and registers a real fast provider", async (t) => {
  const { session } = await createIntegrationSession(t);
  const fastModels = session.modelRuntime
    .getModels(FAST_PROVIDER)
    .filter((model) => model.provider === FAST_PROVIDER);

  assert.deepEqual(fastModels.map((model) => model.id).sort(), [...FAST_MODEL_IDS].sort());
  assert.ok(fastModels.every((model) => model.api === FAST_API));
  assert.ok(!fastModels.some((model) => model.id === "gpt-5.2"));
  assert.equal(session.extensionRunner.hasHandlers("session_start"), true);
  assert.equal(session.extensionRunner.hasHandlers("session_tree"), false);
});

test("runs a real Pi prompt through fast Codex as priority while storing canonical assistant history", async (t) => {
  const server = await startCodexServer(t, [{ events: textResponseEvents("fast ok") }]);
  const { session } = await createIntegrationSession(t, { codexBaseUrl: server.baseUrl });

  await selectFastModel(session);
  await session.prompt("hello from integration", { expandPromptTemplates: false });

  assert.equal(server.requests.length, 1);
  const request = server.requests[0];
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/codex/responses");
  assert.equal(request.headers.authorization, `Bearer ${fakeCodexToken()}`);
  assert.equal(request.body["model"], MODEL_ID);
  assert.equal(request.body["service_tier"], "priority");

  const messages = assistantMessages(session);
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.ok(message);
  assert.equal(message.provider, CODEX_PROVIDER);
  assert.equal(message.api, CODEX_API);
  const content = message.content[0];
  if (!content || content.type !== "text") {
    assert.fail("Expected a text assistant message");
  }
  assert.equal(content.text, "fast ok");
  assertCanonicalAssistantMessages(session);
  assert.ok(!session.sessionManager.getBranch().some((entry) => entry.type === "custom"));
});

test("remaps fast context overflow errors and lets Pi compact and retry", async (t) => {
  const server = await startCodexServer(t, [
    { events: textResponseEvents("seed ok", "resp_seed") },
    { events: contextOverflowResponseEvents() },
    { events: textResponseEvents("overflow summary", "resp_summary") },
    { events: textResponseEvents("recovered after compaction", "resp_retry") },
  ]);
  const { session } = await createIntegrationSession(t, {
    codexBaseUrl: server.baseUrl,
    // Keep no recent history so the seed exchange is summarized before retrying.
    compaction: { enabled: true, keepRecentTokens: 0, reserveTokens: 16_384 },
  });
  const compactionEvents: Array<{
    reason: string;
    willRetry?: boolean;
    errorMessage?: string | undefined;
  }> = [];
  session.subscribe((event) => {
    if (event.type === "compaction_start") {
      compactionEvents.push({ reason: event.reason });
    }
    if (event.type === "compaction_end") {
      compactionEvents.push({
        reason: event.reason,
        willRetry: event.willRetry,
        errorMessage: event.errorMessage,
      });
    }
  });

  await selectFastModel(session);
  await session.prompt("seed history", { expandPromptTemplates: false });
  await session.prompt("overflow then recover", { expandPromptTemplates: false });

  const modelRequests = server.requests.filter((request) => request.body["model"] === MODEL_ID);
  assert.equal(modelRequests.length, 4);
  assert.ok(modelRequests.every((request) => request.body["service_tier"] === "priority"));
  assert.deepEqual(compactionEvents, [
    { reason: "overflow" },
    { reason: "overflow", willRetry: true, errorMessage: undefined },
  ]);

  const compactionEntries = session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "compaction");
  assert.equal(compactionEntries.length, 1);

  const messages = assistantMessages(session);
  assert.equal(messages.length, 3);
  const seedSuccess = messages[0];
  const overflowError = messages[1];
  const retrySuccess = messages[2];
  assert.ok(seedSuccess);
  assert.ok(overflowError);
  assert.ok(retrySuccess);
  assert.equal(seedSuccess.stopReason, "stop");
  assert.equal(seedSuccess.provider, CODEX_PROVIDER);
  assert.equal(seedSuccess.api, CODEX_API);
  assert.equal(overflowError.stopReason, "error");
  assert.equal(overflowError.provider, FAST_PROVIDER);
  assert.equal(overflowError.api, CODEX_API);
  assert.match(overflowError.errorMessage ?? "", /exceeds the context window/i);
  assert.equal(retrySuccess.stopReason, "stop");
  assert.equal(retrySuccess.provider, CODEX_PROVIDER);
  assert.equal(retrySuccess.api, CODEX_API);
  const content = retrySuccess.content[0];
  if (!content || content.type !== "text") {
    assert.fail("Expected retry success to contain text");
  }
  assert.equal(content.text, "recovered after compaction");
});

test("stores tool-calling fast replies canonically through the real Pi agent loop", async (t) => {
  const server = await startCodexServer(t, [
    { events: toolCallResponseEvents() },
    { events: textResponseEvents("tool follow-up complete", "resp_after_tool") },
  ]);
  const { session } = await createIntegrationSession(t, { codexBaseUrl: server.baseUrl });

  await selectFastModel(session);
  await session.prompt("please call a tool", { expandPromptTemplates: false });

  assert.equal(server.requests.length, 2);
  assert.ok(server.requests.every((request) => request.body["service_tier"] === "priority"));

  const messages = assistantMessages(session);
  assert.equal(messages.length, 2);
  const firstMessage = messages[0];
  const secondMessage = messages[1];
  assert.ok(firstMessage);
  assert.ok(secondMessage);
  assert.equal(firstMessage.provider, CODEX_PROVIDER);
  assert.equal(firstMessage.api, CODEX_API);
  const firstContent = firstMessage.content[0];
  if (!firstContent || firstContent.type !== "toolCall") {
    assert.fail("Expected first assistant message to contain a tool call");
  }
  const secondContent = secondMessage.content[0];
  if (!secondContent || secondContent.type !== "text") {
    assert.fail("Expected second assistant message to contain text");
  }
  assert.equal(secondContent.text, "tool follow-up complete");
  assertCanonicalAssistantMessages(session);
});

test("stores fast setup errors canonically without sending a provider request", async (t) => {
  const server = await startCodexServer(t, [
    { events: textResponseEvents("should not be requested") },
  ]);
  const { session } = await createIntegrationSession(t, { codexBaseUrl: server.baseUrl });

  await selectFastModel(session);
  await session.modelRuntime.logout(CODEX_PROVIDER);
  await session.prompt("this should fail before fetch", { expandPromptTemplates: false });

  assert.equal(server.requests.length, 0);
  const messages = assistantMessages(session);
  assert.equal(messages.length, 1);
  const message = messages[0];
  assert.ok(message);
  assert.equal(message.provider, CODEX_PROVIDER);
  assert.equal(message.api, CODEX_API);
  assert.equal(message.stopReason, "error");
  assert.ok(message.errorMessage);
  assert.match(message.errorMessage, /No openai-codex auth found/);
});

test("recovers fast mode through Pi session_start for every supported reason", async (t) => {
  for (const reason of SESSION_START_REASONS) {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-openai-codex-fast-recovery-"));
    const cwd = join(tempRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    t.after(async () => rm(tempRoot, { recursive: true, force: true }));

    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendModelChange(FAST_PROVIDER, MODEL_ID);
    sessionManager.appendMessage({ role: "user", content: "prior message", timestamp: Date.now() });

    const { session } = await createIntegrationSession(t, {
      bindExtensions: false,
      sessionManager,
      sessionStartReason: reason,
    });
    assert.notEqual(session.model?.provider, FAST_PROVIDER);

    await session.bindExtensions({});
    assert.equal(session.model?.provider, FAST_PROVIDER, reason);
    assert.equal(session.model?.id, MODEL_ID, reason);
  }
});

test("does not recover fast mode when the latest overall model_change is not fast", async (t) => {
  for (const provider of [CODEX_PROVIDER, "anthropic"]) {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-openai-codex-fast-no-recovery-"));
    const cwd = join(tempRoot, "cwd");
    await mkdir(cwd, { recursive: true });
    t.after(async () => rm(tempRoot, { recursive: true, force: true }));

    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.appendModelChange(FAST_PROVIDER, MODEL_ID);
    sessionManager.appendMessage({
      role: "user",
      content: "prior fast branch",
      timestamp: Date.now(),
    });
    sessionManager.appendModelChange(
      provider,
      provider === CODEX_PROVIDER ? MODEL_ID : "claude-sonnet",
    );
    sessionManager.appendMessage({ role: "user", content: "latest branch", timestamp: Date.now() });

    const { session } = await createIntegrationSession(t, {
      bindExtensions: false,
      sessionManager,
      sessionStartReason: "startup",
    });
    await session.bindExtensions({});

    assert.notEqual(session.model?.provider, FAST_PROVIDER, provider);
  }
});
