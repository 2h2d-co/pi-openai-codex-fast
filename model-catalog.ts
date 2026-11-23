import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * The Codex CLI version that model catalog requests name. The catalog leaves out every model
 * whose `minimal_client_version` is newer, so this must be at least the newest exposed model's.
 */
export const CODEX_MODEL_CATALOG_CLIENT_VERSION = "0.171.0";

/** The agent-directory file that keeps each account's last catalog across Pi processes. */
export const CODEX_MODEL_CATALOG_FILE = "pi-openai-codex-fast-model-catalog.json";

/** The response header that carries the ETag of the account's current model catalog. */
export const MODELS_ETAG_HEADER = "x-models-etag";

/** Like the Codex CLI, refresh a catalog older than five minutes. */
export const CODEX_MODEL_CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 5_000;
/** Wait this long before retrying a failed load for an account without a catalog. */
const FAILED_LOAD_RETRY_MS = 30_000;
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** The signed-in account whose catalog a request needs. */
export type CodexCatalogAccount = {
  accountId: string;
  apiKey: string;
  /** The Codex base URL of the requested model, such as `https://chatgpt.com/backend-api`. */
  baseUrl: string | undefined;
};

type CatalogSnapshot = {
  fetchedAt: number;
  etag: string | undefined;
  models: ReadonlyMap<string, ReadonlySet<string>>;
};

type CatalogOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  /** The file that persists catalogs, or `undefined` to keep them in memory only. */
  file?: () => string | undefined;
};

type JsonRecord = Record<string, unknown>;

class CatalogLoadError extends Error {}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** The ChatGPT account id that a Codex access token's claims carry. */
export function extractAccountId(token: string): string {
  const claims = token.split(".")[1];
  if (claims === undefined) throw new Error("The OpenAI Codex access token is malformed.");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(claims, "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("The OpenAI Codex access token is malformed.", { cause: error });
  }
  const authentication = isRecord(payload) ? payload["https://api.openai.com/auth"] : undefined;
  const accountId = isRecord(authentication) ? authentication["chatgpt_account_id"] : undefined;
  if (!isString(accountId) || accountId.length === 0) {
    throw new Error("The OpenAI Codex access token has no ChatGPT account id.");
  }
  return accountId;
}

/** Parse the `models` list of a catalog response into each model's service tier ids. */
export function parseCatalogModels(value: unknown): ReadonlyMap<string, ReadonlySet<string>> {
  if (!isRecord(value) || !Array.isArray(value["models"])) {
    throw new CatalogLoadError("invalid catalog response");
  }
  const models = new Map<string, ReadonlySet<string>>();
  for (const model of value["models"]) {
    if (!isRecord(model) || !isString(model["slug"]) || model["slug"].length === 0) continue;
    const tiers: unknown[] = Array.isArray(model["service_tiers"]) ? model["service_tiers"] : [];
    models.set(
      model["slug"],
      new Set(
        tiers.flatMap((tier) => (isRecord(tier) && isString(tier["id"]) ? [tier["id"]] : [])),
      ),
    );
  }
  return models;
}

/** The model catalog URL under a Codex base URL. */
export function catalogUrl(baseUrl: string | undefined): URL {
  const base = (baseUrl?.trim() || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
  const codex = base.endsWith("/codex") ? base : `${base}/codex`;
  const url = new URL(`${codex}/models`);
  url.searchParams.set("client_version", CODEX_MODEL_CATALOG_CLIENT_VERSION);
  return url;
}

function accountKey(accountId: string): string {
  return createHash("sha256").update(accountId).digest("hex");
}

function persistedSnapshot(value: unknown): CatalogSnapshot | undefined {
  if (!isRecord(value) || typeof value["fetchedAt"] !== "number" || !isRecord(value["models"])) {
    return undefined;
  }
  const models = new Map<string, ReadonlySet<string>>();
  for (const [modelId, tiers] of Object.entries(value["models"])) {
    if (!Array.isArray(tiers) || !tiers.every(isString)) return undefined;
    models.set(modelId, new Set(tiers));
  }
  return {
    // A catalog requested for another client version can lack newer models, so refresh it.
    fetchedAt:
      value["clientVersion"] === CODEX_MODEL_CATALOG_CLIENT_VERSION ? value["fetchedAt"] : 0,
    etag: isString(value["etag"]) ? value["etag"] : undefined,
    models,
  };
}

function failureReason(error: unknown): string {
  if (error instanceof CatalogLoadError) return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timed out";
  }
  return "network error";
}

function untilAborted(promise: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    promise.then(done, (error: unknown) => {
      // `refresh` records its own failures and never rejects.
      void error;
      done();
    });
  });
}

/**
 * Each account's Codex model catalog, which lists the service tiers the account's plan includes
 * for every model. Like the Codex CLI, a speed provider sends its tier only when the catalog lists
 * it for the model.
 */
export class CodexModelCatalog {
  private readonly snapshots = new Map<string, CatalogSnapshot>();
  private readonly loads = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, { at: number; reason: string }>();
  private readonly changedEtags = new Set<string>();
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private readonly file: () => string | undefined;

  constructor(options: CatalogOptions = {}) {
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = options.now ?? (() => Date.now());
    // The agent directory is fixed when the extension loads, as it is for the rest of the process.
    const file = join(getAgentDir(), CODEX_MODEL_CATALOG_FILE);
    this.file = options.file ?? (() => file);
  }

  /**
   * Load the account's catalog unless a current one is available. A catalog older than the TTL
   * still answers while a newer one loads, but a reported ETag change waits for the new catalog.
   * Never rejects.
   */
  async load(account: CodexCatalogAccount, signal?: AbortSignal): Promise<void> {
    const snapshot = this.snapshot(account.accountId);
    if (snapshot) {
      if (this.changedEtags.has(account.accountId)) {
        await untilAborted(this.refresh(account), signal);
      } else if (this.now() - snapshot.fetchedAt >= CODEX_MODEL_CATALOG_TTL_MS) {
        this.refreshInBackground(account);
      }
      return;
    }
    const failure = this.failures.get(account.accountId);
    if (failure && this.now() - failure.at < FAILED_LOAD_RETRY_MS) return;
    await untilAborted(this.refresh(account), signal);
  }

  /** The tiers the account's catalog lists for a model, or `undefined` when unknown. */
  serviceTiers(accountId: string, modelId: string): ReadonlySet<string> | undefined {
    return this.snapshot(accountId)?.models.get(modelId);
  }

  /** Why the account has no catalog, when its last load failed. */
  failure(accountId: string): string | undefined {
    return this.snapshot(accountId) ? undefined : this.failures.get(accountId)?.reason;
  }

  /** Record the catalog ETag a Codex response reported for the account. */
  noteModelsEtag(accountId: string, etag: string): void {
    const snapshot = this.snapshots.get(accountId);
    if (!snapshot) return;
    if (snapshot.etag === etag) {
      // Like the Codex CLI, a matching ETag keeps the catalog fresh.
      snapshot.fetchedAt = this.now();
      this.changedEtags.delete(accountId);
    } else {
      this.changedEtags.add(accountId);
    }
  }

  private snapshot(accountId: string): CatalogSnapshot | undefined {
    let snapshot = this.snapshots.get(accountId);
    if (!snapshot) {
      snapshot = this.readPersisted(accountId);
      if (snapshot) this.snapshots.set(accountId, snapshot);
    }
    return snapshot;
  }

  private refreshInBackground(account: CodexCatalogAccount): void {
    this.refresh(account).catch((error: unknown) => {
      // `refresh` records its own failures and never rejects.
      void error;
    });
  }

  private refresh(account: CodexCatalogAccount): Promise<void> {
    const pending = this.loads.get(account.accountId);
    if (pending) return pending;
    const load = (async () => {
      try {
        const snapshot = await this.request(account);
        this.snapshots.set(account.accountId, snapshot);
        this.failures.delete(account.accountId);
        this.changedEtags.delete(account.accountId);
        this.persist(account.accountId, snapshot);
      } catch (error) {
        this.failures.set(account.accountId, { at: this.now(), reason: failureReason(error) });
      } finally {
        this.loads.delete(account.accountId);
      }
    })();
    this.loads.set(account.accountId, load);
    return load;
  }

  private async request(account: CodexCatalogAccount): Promise<CatalogSnapshot> {
    const response = await this.fetch(catalogUrl(account.baseUrl), {
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        "chatgpt-account-id": account.accountId,
        originator: "pi",
      },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new CatalogLoadError(`HTTP ${String(response.status)}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new CatalogLoadError("invalid catalog response", { cause: error });
    }
    return {
      fetchedAt: this.now(),
      etag: response.headers.get("etag") ?? undefined,
      models: parseCatalogModels(body),
    };
  }

  private readAccounts(file: string): JsonRecord {
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      return isRecord(value) && isRecord(value["accounts"]) ? { ...value["accounts"] } : {};
    } catch (error) {
      // A missing or unreadable file only means no catalog was kept.
      void error;
      return {};
    }
  }

  private readPersisted(accountId: string): CatalogSnapshot | undefined {
    const file = this.file();
    if (file === undefined) return undefined;
    return persistedSnapshot(this.readAccounts(file)[accountKey(accountId)]);
  }

  private persist(accountId: string, snapshot: CatalogSnapshot): void {
    const file = this.file();
    if (file === undefined) return;
    const entry: JsonRecord = {
      fetchedAt: snapshot.fetchedAt,
      clientVersion: CODEX_MODEL_CATALOG_CLIENT_VERSION,
      models: Object.fromEntries(
        [...snapshot.models].map(([modelId, tiers]) => [modelId, [...tiers]]),
      ),
    };
    if (snapshot.etag !== undefined) entry["etag"] = snapshot.etag;
    const accounts = { ...this.readAccounts(file), [accountKey(accountId)]: entry };
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify({ accounts }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, file);
    } catch (error) {
      // The in-memory catalog still serves this process when the file cannot be written.
      void error;
      rmSync(temporary, { force: true });
    }
  }
}

/** The model catalog ETag that a Codex response's headers carry. */
export function modelsEtagFromHeaders(headers: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === MODELS_ETAG_HEADER && value.length > 0) return value;
  }
  return undefined;
}

/** The model catalog ETag that a Codex WebSocket metadata event's headers carry. */
export function modelsEtagFromEvent(event: unknown): string | undefined {
  if (!isRecord(event) || !isRecord(event["headers"])) return undefined;
  if (event["type"] !== "response.metadata" && event["type"] !== "codex.response.metadata") {
    return undefined;
  }
  const headers = Object.fromEntries(
    Object.entries(event["headers"]).filter((entry): entry is [string, string] =>
      isString(entry[1]),
    ),
  );
  return modelsEtagFromHeaders(headers);
}

/**
 * Why a speed provider cannot send its tier to a model, given the tiers the account's model
 * catalog lists for it. Like the Codex CLI without a catalog, Fast proceeds and Ultrafast waits
 * for the catalog. Codex would otherwise serve the request at Standard speed without an error.
 */
export function speedRefusal(
  serviceTier: "priority" | "ultrafast",
  modelId: string,
  catalogTiers: ReadonlySet<string> | undefined,
  catalogFailure: string | undefined,
): string | undefined {
  if (serviceTier === "priority") {
    return catalogTiers === undefined || catalogTiers.has("priority")
      ? undefined
      : `Your ChatGPT plan does not include Fast for ${modelId}. Select openai-codex/${modelId} instead.`;
  }
  if (catalogTiers?.has("ultrafast")) return undefined;
  if (catalogTiers === undefined && catalogFailure !== undefined) {
    return `The OpenAI Codex model catalog could not be loaded (${catalogFailure}), so Ultrafast cannot be confirmed for ${modelId}. Try again, or select openai-codex-fast/${modelId}.`;
  }
  return `Your ChatGPT plan does not include Ultrafast for ${modelId}. Select openai-codex-fast/${modelId} instead.`;
}
