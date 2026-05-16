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

const authStorage = AuthStorage.create();
const builtInCodexModels = getModels(OPENAI_CODEX_PROVIDER);
const builtInCodexModelsById = new Map(builtInCodexModels.map((model) => [model.id, model]));
const fastCodexModels = builtInCodexModels.filter((model) =>
  OPENAI_CODEX_FAST_MODEL_IDS.has(model.id),
);

if (fastCodexModels.length === 0) {
  throw new Error(
    `No ${OPENAI_CODEX_PROVIDER} models matched the configured fast-model allowlist.`,
  );
}

const fastProviderModels = fastCodexModels.map((model) => ({
  id: model.id,
  name: model.name,
  baseUrl: model.baseUrl,
  reasoning: model.reasoning,
  thinkingLevelMap: model.thinkingLevelMap,
  input: model.input,
  cost: model.cost,
  contextWindow: model.contextWindow,
  maxTokens: model.maxTokens,
  headers: model.headers,
  compat: model.compat,
})) as ProviderModelConfig[];

function streamSimpleOpenAICodexFast(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const outer = createAssistantMessageEventStream();

  void (async () => {
    try {
      const canonicalModel = builtInCodexModelsById.get(model.id) as
        | Model<"openai-codex-responses">
        | undefined;
      if (!canonicalModel) {
        throw new Error(`Underlying ${OPENAI_CODEX_PROVIDER} model not found for ${model.id}.`);
      }

      authStorage.reload();
      const apiKey = await authStorage.getApiKey(OPENAI_CODEX_PROVIDER, { includeFallback: false });
      if (!apiKey) {
        throw new Error(
          `No stored ${OPENAI_CODEX_PROVIDER} auth found. Log in to ${OPENAI_CODEX_PROVIDER} first.`,
        );
      }

      const clampedReasoning = options?.reasoning
        ? clampThinkingLevel(canonicalModel, options.reasoning)
        : undefined;
      const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
      const inner = streamOpenAICodexResponses(
        canonicalModel,
        {
          ...context,
          messages: context.messages.map((message) =>
            message.role === "assistant" &&
            (message.provider === OPENAI_CODEX_FAST_PROVIDER ||
              message.api === OPENAI_CODEX_FAST_API)
              ? { ...message, provider: OPENAI_CODEX_PROVIDER, api: OPENAI_CODEX_API }
              : message,
          ),
        },
        {
          ...options,
          apiKey,
          serviceTier: "priority",
          ...(reasoningEffort ? { reasoningEffort } : {}),
        },
      );

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

export default function (pi: ExtensionAPI) {
  pi.registerProvider(OPENAI_CODEX_FAST_PROVIDER, {
    name: "OpenAI Codex Fast",
    baseUrl: fastCodexModels[0]!.baseUrl,
    apiKey: PLACEHOLDER_API_KEY,
    api: OPENAI_CODEX_FAST_API,
    models: fastProviderModels,
    streamSimple: streamSimpleOpenAICodexFast,
  });

  pi.on("session_start", async (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i -= 1) {
      const entry = branch[i];
      if (entry?.type !== "model_change") continue;
      const { provider, modelId } = entry as ModelChangeEntry;
      if (provider !== OPENAI_CODEX_FAST_PROVIDER) return;
      if (ctx.model?.provider === OPENAI_CODEX_FAST_PROVIDER && ctx.model.id === modelId) {
        return;
      }

      const fastModel = ctx.modelRegistry.find(OPENAI_CODEX_FAST_PROVIDER, modelId);
      if (fastModel) {
        await pi.setModel(fastModel);
      }
      return;
    }
  });
}
