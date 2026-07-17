import { join } from "node:path";
import {
  getAgentDir,
  ModelRuntime,
  type ExtensionAPI,
  type ModelChangeEntry,
  type ModelRegistry,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  clampThinkingLevel,
  createAssistantMessageEventStream,
  hasApi,
  isContextOverflow,
  streamOpenAICodexResponses,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
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
type OpenAICodexAuthSource =
  | { modelRuntime: ModelRuntime }
  | { modelRegistry: ModelRegistry; model: Model<OpenAICodexApi> };

function authFailedDiagnostic(reason: string): ExtensionDiagnostic {
  return {
    type: "error",
    code: "auth-failed",
    message: `${OPENAI_CODEX_PROVIDER} auth failed: ${reason}`,
  };
}

async function getOpenAICodexAuth(source: OpenAICodexAuthSource): Promise<Result<string>> {
  try {
    let apiKey: string | undefined;
    if ("modelRuntime" in source) {
      apiKey = (await source.modelRuntime.getAuth(OPENAI_CODEX_PROVIDER))?.auth.apiKey;
    } else {
      const auth = await source.modelRegistry.getApiKeyAndHeaders(source.model);
      if (!auth.ok) {
        return { ok: false, diagnostic: authFailedDiagnostic(auth.error) };
      }
      apiKey = auth.apiKey;
    }

    if (apiKey) {
      return { ok: true, value: apiKey };
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

async function createAuthModelRuntime(authPath: string): Promise<ModelRuntime> {
  return ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
}

function getOpenAICodexFastModels(
  openAICodexModels: readonly Model<OpenAICodexApi>[],
): ProviderModelConfig[] {
  return openAICodexModels
    .filter((model) => OPENAI_CODEX_FAST_MODEL_IDS.has(model.id))
    .map(
      (model): ProviderModelConfig => ({
        id: model.id,
        name: model.name,
        baseUrl: model.baseUrl,
        reasoning: model.reasoning,
        ...(model.thinkingLevelMap !== undefined
          ? { thinkingLevelMap: model.thinkingLevelMap }
          : {}),
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.headers !== undefined ? { headers: model.headers } : {}),
        ...(model.compat !== undefined ? { compat: model.compat } : {}),
      }),
    );
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
  authPath: string,
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

      const auth = await getOpenAICodexAuth(
        modelRegistry
          ? { modelRegistry, model: codexModel }
          : { modelRuntime: await createAuthModelRuntime(authPath) },
      );
      if (!auth.ok) {
        endWithCanonicalError(outer, model.id, auth.diagnostic.message, options);
        return;
      }

      const clampedReasoning = options?.reasoning
        ? clampThinkingLevel(codexModel, options.reasoning)
        : undefined;
      const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
      const inner = streamOpenAICodexResponses(codexModel, context, {
        ...options,
        apiKey: auth.value,
        serviceTier: "priority",
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });

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

export default async function (pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const authPath = join(agentDir, "auth.json");
  const startupModelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const openAICodexModels = startupModelRuntime
    .getModels(OPENAI_CODEX_PROVIDER)
    .filter((model): model is Model<OpenAICodexApi> => hasApi(model, OPENAI_CODEX_API));
  const openAICodexFastModels = getOpenAICodexFastModels(openAICodexModels);
  const diagnostics: ExtensionDiagnostic[] = [];
  let modelRegistry: ModelRegistry | undefined;
  let providerRegistered = false;

  async function registerFastProviderIfReady(fallbackModelRuntime?: ModelRuntime): Promise<void> {
    if (providerRegistered) {
      return;
    }

    const authModel = openAICodexModels[0];
    const auth = await getOpenAICodexAuth(
      modelRegistry && authModel
        ? { modelRegistry, model: authModel }
        : { modelRuntime: fallbackModelRuntime ?? (await createAuthModelRuntime(authPath)) },
    );
    if (!auth.ok) {
      diagnostics.push(auth.diagnostic);
    }

    const baseUrl = getFastProviderBaseUrl(openAICodexFastModels);
    if (!baseUrl.ok) {
      diagnostics.push(baseUrl.diagnostic);
    }

    if (!auth.ok || !baseUrl.ok) {
      return;
    }

    pi.registerProvider(OPENAI_CODEX_FAST_PROVIDER, {
      name: "OpenAI Codex Fast",
      baseUrl: baseUrl.value,
      apiKey: PLACEHOLDER_API_KEY,
      api: OPENAI_CODEX_FAST_API,
      models: openAICodexFastModels,
      streamSimple: (model, context, options) =>
        streamSimpleOpenAICodexFast(
          authPath,
          modelRegistry,
          openAICodexModels,
          model,
          context,
          options,
        ),
    });
    providerRegistered = true;
  }

  pi.on("session_start", async (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
    if (!providerRegistered && diagnostics.length === 0) {
      await registerFastProviderIfReady();
    }
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

  await registerFastProviderIfReady(startupModelRuntime);
}
