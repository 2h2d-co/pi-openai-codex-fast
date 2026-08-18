import {
  type ExtensionAPI,
  type ModelChangeEntry,
  type ModelRegistry,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  getModels,
  isContextOverflow,
  streamOpenAICodexResponses,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type OpenAICodexResponsesOptions,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

const OPENAI_CODEX_FAST_API = "openai-codex-fast-responses";
const OPENAI_CODEX_API = "openai-codex-responses";
const OPENAI_CODEX_FAST_PROVIDER = "openai-codex-fast";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const PLACEHOLDER_API_KEY = "__openai_codex_fast_reuses_openai_codex_auth__";
const OPENAI_CODEX_FAST_MODEL_IDS = new Set([
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

type ExtensionDiagnostic = {
  type: "warning" | "error";
  code: "auth-failed" | "missing-openai-codex-auth" | "no-fast-models" | "no-model-base-url";
  message: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; diagnostic: ExtensionDiagnostic };
type OpenAICodexApi = typeof OPENAI_CODEX_API;

function authFailedDiagnostic(reason: string): ExtensionDiagnostic {
  return {
    type: "error",
    code: "auth-failed",
    message: `${OPENAI_CODEX_PROVIDER} auth failed: ${reason}`,
  };
}

async function getOpenAICodexAuth(
  modelRegistry: ModelRegistry,
  model: Model<OpenAICodexApi>,
): Promise<Result<string>> {
  try {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return { ok: false, diagnostic: authFailedDiagnostic(auth.error) };
    }
    if (auth.apiKey) {
      return { ok: true, value: auth.apiKey };
    }

    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "missing-openai-codex-auth",
        message: `No ${OPENAI_CODEX_PROVIDER} auth found. Log in to ${OPENAI_CODEX_PROVIDER} first.`,
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: authFailedDiagnostic(error instanceof Error ? error.message : String(error)),
    };
  }
}

function getOpenAICodexFastModels(
  openAICodexModels: readonly Model<OpenAICodexApi>[],
): ProviderModelConfig[] {
  return openAICodexModels
    .filter((model) => OPENAI_CODEX_FAST_MODEL_IDS.has(model.id))
    .map((model): ProviderModelConfig => {
      const config: ProviderModelConfig = {
        id: model.id,
        name: model.name,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      };
      if (model.thinkingLevelMap !== undefined) {
        config.thinkingLevelMap = model.thinkingLevelMap;
      }
      if (model.headers !== undefined) {
        config.headers = model.headers;
      }
      if (model.compat !== undefined) {
        config.compat = model.compat;
      }
      return config;
    });
}

function getFastProviderBaseUrl(
  openAICodexFastModels: readonly ProviderModelConfig[],
): Result<string> {
  if (openAICodexFastModels.length === 0) {
    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "no-fast-models",
        message: `No models available for ${OPENAI_CODEX_FAST_PROVIDER}. The provider will not be registered.`,
      },
    };
  }

  const baseUrl = openAICodexFastModels.find((model) => model.baseUrl)?.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "no-model-base-url",
        message: `No base URL found for any ${OPENAI_CODEX_FAST_PROVIDER} model. The provider will not be registered.`,
      },
    };
  }

  return { ok: true, value: baseUrl };
}

function endWithCanonicalError(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  modelId: string,
  errorMessage: string,
  options?: SimpleStreamOptions,
): void {
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: OPENAI_CODEX_API,
    provider: OPENAI_CODEX_PROVIDER,
    model: modelId,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: options?.signal?.aborted ? "aborted" : "error",
    errorMessage,
    timestamp: Date.now(),
  };
  stream.push({
    type: "error",
    reason: message.stopReason === "aborted" ? "aborted" : "error",
    error: message,
  });
  stream.end(message);
}

function streamSimpleOpenAICodexFast(
  modelRegistry: ModelRegistry | undefined,
  openAICodexModels: readonly Model<OpenAICodexApi>[],
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) {
  const outer = createAssistantMessageEventStream();

  void (async () => {
    try {
      const codexModel = openAICodexModels.find((m) => m.id === model.id);
      if (!codexModel) {
        endWithCanonicalError(
          outer,
          model.id,
          `Underlying ${OPENAI_CODEX_PROVIDER} model not found for ${model.id}.`,
          options,
        );
        return;
      }

      if (!modelRegistry) {
        endWithCanonicalError(
          outer,
          model.id,
          `${OPENAI_CODEX_FAST_PROVIDER} session is not initialized.`,
          options,
        );
        return;
      }

      const auth = await getOpenAICodexAuth(modelRegistry, codexModel);
      if (!auth.ok) {
        endWithCanonicalError(outer, model.id, auth.diagnostic.message, options);
        return;
      }

      const clampedReasoning = options?.reasoning
        ? clampThinkingLevel(codexModel, options.reasoning)
        : undefined;
      const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
      const requestOptions: OpenAICodexResponsesOptions = {
        ...options,
        apiKey: auth.value,
        serviceTier: "priority",
      };
      if (reasoningEffort) {
        requestOptions.reasoningEffort = reasoningEffort;
      }
      const inner = streamOpenAICodexResponses(codexModel, context, requestOptions);

      for await (const event of inner) {
        if (event.type === "error" && isContextOverflow(event.error, model.contextWindow)) {
          outer.push({
            ...event,
            error: {
              ...event.error,
              provider: OPENAI_CODEX_FAST_PROVIDER,
              model: model.id,
            },
          });
        } else {
          outer.push(event);
        }
      }
      outer.end();
    } catch (error) {
      endWithCanonicalError(
        outer,
        model.id,
        error instanceof Error ? error.message : String(error),
        options,
      );
    }
  })();

  return outer;
}

export default function (pi: ExtensionAPI) {
  const openAICodexModels = getModels(OPENAI_CODEX_PROVIDER);
  const openAICodexFastModels = getOpenAICodexFastModels(openAICodexModels);
  const diagnostics: ExtensionDiagnostic[] = [];
  const baseUrl = getFastProviderBaseUrl(openAICodexFastModels);
  let modelRegistry: ModelRegistry | undefined;
  let providerRegistered = false;

  if (!baseUrl.ok) {
    diagnostics.push(baseUrl.diagnostic);
  } else {
    pi.registerProvider(OPENAI_CODEX_FAST_PROVIDER, {
      name: "OpenAI Codex Fast",
      baseUrl: baseUrl.value,
      apiKey: PLACEHOLDER_API_KEY,
      api: OPENAI_CODEX_FAST_API,
      models: openAICodexFastModels,
      streamSimple: (model, context, options) =>
        streamSimpleOpenAICodexFast(modelRegistry, openAICodexModels, model, context, options),
    });
    providerRegistered = true;
  }

  pi.on("session_start", async (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
    for (const diagnostic of diagnostics.splice(0)) {
      if (ctx.hasUI) {
        ctx.ui.notify(diagnostic.message, diagnostic.type);
      } else if (diagnostic.type === "error") {
        console.error(`[${OPENAI_CODEX_FAST_PROVIDER}] ${diagnostic.message}`);
      } else {
        console.warn(`[${OPENAI_CODEX_FAST_PROVIDER}] ${diagnostic.message}`);
      }
    }
    if (!providerRegistered) {
      return;
    }

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
