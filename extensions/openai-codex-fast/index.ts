import {
  AuthStorage,
  type ExtensionAPI,
  type ModelChangeEntry,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  getModels,
  streamOpenAICodexResponses,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const OPENAI_CODEX_FAST_API = "openai-codex-fast-responses";
const OPENAI_CODEX_API = "openai-codex-responses";
const OPENAI_CODEX_FAST_PROVIDER = "openai-codex-fast";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const PLACEHOLDER_API_KEY = "__openai_codex_fast_reuses_openai_codex_auth__";
const OPENAI_CODEX_FAST_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]);

const OPENAI_CODEX_MODELS = getModels(OPENAI_CODEX_PROVIDER);
const OPENAI_CODEX_FAST_MODELS = OPENAI_CODEX_MODELS.filter((model) =>
  OPENAI_CODEX_FAST_MODEL_IDS.has(model.id),
).map(
  (model): ProviderModelConfig => ({
    id: model.id,
    name: model.name,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap !== undefined ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.headers !== undefined ? { headers: model.headers } : {}),
    ...(model.compat !== undefined ? { compat: model.compat } : {}),
  }),
);

const authStorage = AuthStorage.create();

async function requireOpenAICodexAuth(): Promise<string> {
  authStorage.reload();
  const apiKey = await authStorage.getApiKey(OPENAI_CODEX_PROVIDER, { includeFallback: false });
  if (!apiKey) {
    throw new Error(
      `No ${OPENAI_CODEX_PROVIDER} auth found. Log in to ${OPENAI_CODEX_PROVIDER} first.`,
    );
  }
  return apiKey;
}

function streamSimpleOpenAICodexFast(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const outer = createAssistantMessageEventStream();

  void (async () => {
    try {
      const codexModel = OPENAI_CODEX_MODELS.find((m) => m.id === model.id);
      if (!codexModel) {
        throw new Error(`Underlying ${OPENAI_CODEX_PROVIDER} model not found for ${model.id}.`);
      }

      const apiKey = await requireOpenAICodexAuth();

      const clampedReasoning = options?.reasoning
        ? clampThinkingLevel(codexModel, options.reasoning)
        : undefined;
      const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
      const inner = streamOpenAICodexResponses(codexModel, context, {
        ...options,
        apiKey,
        serviceTier: "priority",
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

      for await (const event of inner) {
        outer.push(event);
      }
      outer.end();
    } catch (error) {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: OPENAI_CODEX_API,
        provider: OPENAI_CODEX_PROVIDER,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: options?.signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      outer.push({
        type: "error",
        reason: message.stopReason === "aborted" ? "aborted" : "error",
        error: message,
      });
      outer.end(message);
    }
  })();

  return outer;
}

export default async function (pi: ExtensionAPI) {
  await requireOpenAICodexAuth();

  if (OPENAI_CODEX_FAST_MODELS.length === 0) {
    throw new Error(
      `[${OPENAI_CODEX_FAST_PROVIDER}]: No models available. The provider will not be registered.`,
    );
  }

  const baseUrl = OPENAI_CODEX_FAST_MODELS.find((model) => model.baseUrl)?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `[${OPENAI_CODEX_FAST_PROVIDER}]: No base URL found for any model. The provider will not be registered.`,
    );
  }

  pi.registerProvider(OPENAI_CODEX_FAST_PROVIDER, {
    name: "OpenAI Codex Fast",
    baseUrl,
    apiKey: PLACEHOLDER_API_KEY,
    api: OPENAI_CODEX_FAST_API,
    models: OPENAI_CODEX_FAST_MODELS,
    streamSimple: streamSimpleOpenAICodexFast,
  });

  pi.on("session_start", async (_event, ctx) => {
    const latestModelChange = ctx.sessionManager
      .getBranch()
      .findLast((entry): entry is ModelChangeEntry => entry.type === "model_change");

    if (latestModelChange?.provider !== OPENAI_CODEX_FAST_PROVIDER) {
      return;
    }

    const { modelId } = latestModelChange;
    if (ctx.model?.provider === OPENAI_CODEX_FAST_PROVIDER && ctx.model.id === modelId) {
      return;
    }

    const fastModel = ctx.modelRegistry.find(OPENAI_CODEX_FAST_PROVIDER, modelId);
    if (fastModel) {
      await pi.setModel(fastModel);
    }
  });
}
