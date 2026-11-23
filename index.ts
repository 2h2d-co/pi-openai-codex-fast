import type {
  ExtensionAPI,
  ModelChangeEntry,
  ModelRegistry,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  getModels,
  isContextOverflow,
  streamOpenAICodexResponses,
  type Api,
  type AssistantMessage,
  type Model,
  type OpenAICodexResponsesOptions,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai/compat";

const OPENAI_CODEX_API = "openai-codex-responses";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const PLACEHOLDER_API_KEY = "__openai_codex_fast_reuses_openai_codex_auth__";

/** A provider that sends built-in Codex models through a faster service tier. */
type SpeedProvider = {
  provider: string;
  name: string;
  api: string;
  serviceTier: "priority" | "ultrafast";
  modelIds: ReadonlySet<string>;
};

const SPEED_PROVIDERS: readonly SpeedProvider[] = [
  {
    provider: "openai-codex-fast",
    name: "OpenAI Codex Fast",
    api: "openai-codex-fast-responses",
    serviceTier: "priority",
    modelIds: new Set([
      "gpt-6.2-sol",
      "gpt-6.2-astra",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-astra",
      "gpt-6-luna",
      "gpt-6-sol",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]),
  },
  {
    provider: "openai-codex-ultrafast",
    name: "OpenAI Codex Ultrafast",
    api: "openai-codex-ultrafast-responses",
    serviceTier: "ultrafast",
    // Codex accepts Ultrafast for any model and silently serves Standard speed when the account's
    // plan does not include Ultrafast for that model.
    modelIds: new Set(["gpt-6.2-sol"]),
  },
];

// Ultrafast costs 6 times the Standard rate. GPT-6.2 models cost 3 times the Standard rate through
// February 28, 2027, Pacific time.
const GPT_6_2_ULTRAFAST_LIST_PRICE_FROM = Date.parse("2027-03-01T00:00:00-08:00");

type ExtensionDiagnostic = {
  type: "warning" | "error";
  code: "auth-failed" | "missing-openai-codex-auth" | "no-models" | "no-model-base-url";
  provider: string;
  message: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; diagnostic: ExtensionDiagnostic };
type OpenAICodexApi = typeof OPENAI_CODEX_API;

function authFailedDiagnostic(provider: string, reason: string): ExtensionDiagnostic {
  return {
    type: "error",
    code: "auth-failed",
    provider,
    message: `${OPENAI_CODEX_PROVIDER} auth failed: ${reason}`,
  };
}

async function getOpenAICodexAuth(
  provider: string,
  modelRegistry: ModelRegistry,
  model: Model<OpenAICodexApi>,
): Promise<Result<string>> {
  try {
    const auth = await modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      return { ok: false, diagnostic: authFailedDiagnostic(provider, auth.error) };
    }
    if (auth.apiKey) {
      return { ok: true, value: auth.apiKey };
    }

    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "missing-openai-codex-auth",
        provider,
        message: `No ${OPENAI_CODEX_PROVIDER} auth found. Log in to ${OPENAI_CODEX_PROVIDER} first.`,
      },
    };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return {
      ok: false,
      diagnostic: authFailedDiagnostic(provider, error.message),
    };
  }
}

function getSpeedModels(
  speed: SpeedProvider,
  openAICodexModels: readonly Model<OpenAICodexApi>[],
): ProviderModelConfig[] {
  return openAICodexModels
    .filter((model) => speed.modelIds.has(model.id))
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

function getProviderBaseUrl(
  provider: string,
  models: readonly ProviderModelConfig[],
): Result<string> {
  if (models.length === 0) {
    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "no-models",
        provider,
        message: `No models available for ${provider}. The provider will not be registered.`,
      },
    };
  }

  const baseUrl = models.find((model) => model.baseUrl)?.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      diagnostic: {
        type: "error",
        code: "no-model-base-url",
        provider,
        message: `No base URL found for any ${provider} model. The provider will not be registered.`,
      },
    };
  }

  return { ok: true, value: baseUrl };
}

/** The multiple of the Standard rate that an Ultrafast request started at `timestamp` costs. */
function ultrafastCostMultiplier(modelId: string, timestamp: number): number {
  return modelId.startsWith("gpt-6.2-") && timestamp < GPT_6_2_ULTRAFAST_LIST_PRICE_FROM ? 3 : 6;
}

/** Pi prices Ultrafast at the Standard rate, so recompute the cost from the catalog rates. */
function withUltrafastPricing(model: Model<Api>, message: AssistantMessage): AssistantMessage {
  const usage = structuredClone(message.usage);
  calculateCost(model, usage);
  const multiplier = ultrafastCostMultiplier(model.id, message.timestamp);
  usage.cost.input *= multiplier;
  usage.cost.output *= multiplier;
  usage.cost.cacheRead *= multiplier;
  usage.cost.cacheWrite *= multiplier;
  usage.cost.total =
    usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return { ...message, usage };
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

function streamSimpleOpenAICodexSpeed(
  speed: SpeedProvider,
  modelRegistry: ModelRegistry | undefined,
  openAICodexModels: readonly Model<OpenAICodexApi>[],
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) {
  const outer = createAssistantMessageEventStream();

  const streamTask = (async () => {
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
        `${speed.provider} session is not initialized.`,
        options,
      );
      return;
    }

    const auth = await getOpenAICodexAuth(speed.provider, modelRegistry, codexModel);
    if (!auth.ok) {
      endWithCanonicalError(outer, model.id, auth.diagnostic.message, options);
      return;
    }

    const clampedReasoning = options?.reasoning
      ? clampThinkingLevel(codexModel, options.reasoning)
      : "off";
    // Like Pi's Codex adapter, send off as effort `none`. Models that carry thinking changes in
    // `configuration_update` items then keep the prompt cache when thinking is switched off.
    const reasoningEffort =
      clampedReasoning !== "off" ? clampedReasoning : codexModel.reasoning ? "none" : undefined;
    const requestOptions: OpenAICodexResponsesOptions = {
      ...options,
      apiKey: auth.value,
      serviceTier: speed.serviceTier,
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
            provider: speed.provider,
            model: model.id,
          },
        });
      } else if (event.type === "done" && speed.serviceTier === "ultrafast") {
        outer.push({ ...event, message: withUltrafastPricing(codexModel, event.message) });
      } else {
        outer.push(event);
      }
    }
    outer.end();
  })();
  streamTask.catch((error: unknown) => {
    endWithCanonicalError(
      outer,
      model.id,
      error instanceof Error ? error.message : String(error),
      options,
    );
  });

  return outer;
}

export default function (pi: ExtensionAPI) {
  const openAICodexModels = getModels(OPENAI_CODEX_PROVIDER);
  const diagnostics: ExtensionDiagnostic[] = [];
  const registeredProviders = new Set<string>();
  let modelRegistry: ModelRegistry | undefined;

  for (const speed of SPEED_PROVIDERS) {
    const models = getSpeedModels(speed, openAICodexModels);
    const baseUrl = getProviderBaseUrl(speed.provider, models);
    if (!baseUrl.ok) {
      diagnostics.push(baseUrl.diagnostic);
      continue;
    }
    pi.registerProvider(speed.provider, {
      name: speed.name,
      baseUrl: baseUrl.value,
      apiKey: PLACEHOLDER_API_KEY,
      api: speed.api,
      models,
      streamSimple: (model, context, options) =>
        streamSimpleOpenAICodexSpeed(
          speed,
          modelRegistry,
          openAICodexModels,
          model,
          context,
          options,
        ),
    });
    registeredProviders.add(speed.provider);
  }

  pi.on("session_start", async (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
    for (const diagnostic of diagnostics.splice(0)) {
      if (ctx.hasUI) {
        ctx.ui.notify(diagnostic.message, diagnostic.type);
      } else if (diagnostic.type === "error") {
        console.error(`[${diagnostic.provider}] ${diagnostic.message}`);
      } else {
        console.warn(`[${diagnostic.provider}] ${diagnostic.message}`);
      }
    }

    const latestModelChange = ctx.sessionManager
      .getBranch()
      .findLast((entry): entry is ModelChangeEntry => entry.type === "model_change");

    if (!latestModelChange || !registeredProviders.has(latestModelChange.provider)) {
      return;
    }

    const { provider, modelId } = latestModelChange;
    if (ctx.model?.provider === provider && ctx.model.id === modelId) {
      return;
    }

    const speedModel = ctx.modelRegistry.find(provider, modelId);
    if (speedModel) {
      await pi.setModel(speedModel);
    }
  });
}
