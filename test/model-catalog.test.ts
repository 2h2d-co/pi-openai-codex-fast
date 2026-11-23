import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  CODEX_MODEL_CATALOG_CLIENT_VERSION,
  CODEX_MODEL_CATALOG_TTL_MS,
  CodexModelCatalog,
  catalogUrl,
  extractAccountId,
  modelsEtagFromEvent,
  modelsEtagFromHeaders,
  parseCatalogModels,
  speedRefusal,
} from "../model-catalog.ts";

const PRO_200 = { "gpt-6.2-sol": ["priority", "ultrafast"], "gpt-6.2-astra": ["priority"] };
const PRO_500 = {
  "gpt-6.2-sol": ["priority", "ultrafast"],
  "gpt-6.2-astra": ["priority", "ultrafast"],
};

function token(accountId: string): string {
  const claims = Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  ).toString("base64url");
  return `header.${claims}.signature`;
}

function account(accountId: string) {
  return { accountId, apiKey: token(accountId), baseUrl: "https://chatgpt.com/backend-api" };
}

type CatalogServer = {
  models: Record<string, readonly string[]>;
  etag: string;
  /** Answer with this HTTP status, or throw a network error for `"network"`. */
  failure: number | "network" | undefined;
  requests: Array<{ url: URL; headers: Headers }>;
  fetch: typeof fetch;
};

/** A fake Codex backend that answers model catalog requests and records them. */
function catalogServer(models: Record<string, readonly string[]>): CatalogServer {
  const server: CatalogServer = {
    models,
    etag: '"catalog-1"',
    failure: undefined,
    requests: [],
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      server.requests.push({ url, headers: new Headers(init?.headers) });
      if (server.failure === "network") throw new TypeError("fetch failed");
      if (server.failure !== undefined) return new Response(null, { status: server.failure });
      return Response.json(
        {
          models: Object.entries(server.models).map(([slug, tiers]) => ({
            slug,
            service_tiers: tiers.map((id) => ({ id })),
          })),
        },
        { headers: { etag: server.etag } },
      );
    },
  };
  return server;
}

function clock() {
  const state = { now: Date.parse("2026-11-23T12:00:00Z") };
  return { now: () => state.now, advance: (ms: number) => (state.now += ms) };
}

async function catalogFile(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-fast-model-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "agent", "pi-openai-codex-fast-model-catalog.json");
}

test("requests the catalog with the account's token and the Codex client version", async () => {
  const server = catalogServer(PRO_200);
  const catalog = new CodexModelCatalog({ fetch: server.fetch, file: () => undefined });
  await catalog.load(account("account-1"));

  const request = server.requests[0];
  assert.ok(request);
  assert.equal(request.url.href, catalogUrl(undefined).href);
  assert.equal(
    request.url.href,
    `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_MODEL_CATALOG_CLIENT_VERSION}`,
  );
  assert.equal(request.headers.get("authorization"), `Bearer ${token("account-1")}`);
  assert.equal(request.headers.get("chatgpt-account-id"), "account-1");
  assert.deepEqual(catalog.serviceTiers("account-1", "gpt-6.2-astra"), new Set(["priority"]));
  assert.equal(catalog.serviceTiers("account-1", "gpt-7-sol"), undefined);
  assert.equal(
    catalogUrl("http://127.0.0.1:1234/codex/").href,
    `http://127.0.0.1:1234/codex/models?client_version=${CODEX_MODEL_CATALOG_CLIENT_VERSION}`,
  );
});

test("reloads after the TTL in the background, and waits after a changed ETag", async () => {
  const server = catalogServer(PRO_200);
  const time = clock();
  const catalog = new CodexModelCatalog({
    fetch: server.fetch,
    now: time.now,
    file: () => undefined,
  });
  await catalog.load(account("account-1"));

  server.models = PRO_500;
  time.advance(CODEX_MODEL_CATALOG_TTL_MS);
  await catalog.load(account("account-1"));
  assert.deepEqual(catalog.serviceTiers("account-1", "gpt-6.2-astra"), new Set(["priority"]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.requests.length, 2);
  assert.deepEqual(
    catalog.serviceTiers("account-1", "gpt-6.2-astra"),
    new Set(["priority", "ultrafast"]),
  );

  // A matching ETag keeps the catalog fresh; a changed one makes the next load wait for it.
  time.advance(CODEX_MODEL_CATALOG_TTL_MS - 1);
  catalog.noteModelsEtag("account-1", '"catalog-1"');
  time.advance(CODEX_MODEL_CATALOG_TTL_MS - 1);
  await catalog.load(account("account-1"));
  assert.equal(server.requests.length, 2);
  server.models = PRO_200;
  catalog.noteModelsEtag("account-1", '"catalog-2"');
  await catalog.load(account("account-1"));
  assert.equal(server.requests.length, 3);
  assert.deepEqual(catalog.serviceTiers("account-1", "gpt-6.2-astra"), new Set(["priority"]));
});

test("reports a failed load and retries it after 30 seconds", async () => {
  const server = catalogServer(PRO_200);
  const time = clock();
  const catalog = new CodexModelCatalog({
    fetch: server.fetch,
    now: time.now,
    file: () => undefined,
  });

  server.failure = 401;
  await catalog.load(account("account-1"));
  assert.equal(catalog.failure("account-1"), "HTTP 401");
  await catalog.load(account("account-1"));
  assert.equal(server.requests.length, 1);

  server.failure = "network";
  time.advance(30_000);
  await catalog.load(account("account-1"));
  assert.equal(catalog.failure("account-1"), "network error");

  server.failure = undefined;
  time.advance(30_000);
  await catalog.load(account("account-1"));
  assert.equal(catalog.failure("account-1"), undefined);
  assert.deepEqual(
    catalog.serviceTiers("account-1", "gpt-6.2-sol"),
    new Set(PRO_200["gpt-6.2-sol"]),
  );
});

test("keeps each account's catalog across processes without writing account ids", async (t) => {
  const file = await catalogFile(t);
  const server = catalogServer(PRO_500);
  const time = clock();
  await new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file }).load(
    account("account-secret-id"),
  );
  assert.doesNotMatch(await readFile(file, "utf8"), /account-secret-id/);

  // Offline, a saved catalog of any age still answers, and the failed reload keeps it.
  server.failure = "network";
  time.advance(24 * 60 * 60_000);
  const offline = new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file });
  await offline.load(account("account-secret-id"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.requests.length, 2);
  assert.deepEqual(
    offline.serviceTiers("account-secret-id", "gpt-6.2-astra"),
    new Set(PRO_500["gpt-6.2-astra"]),
  );
  assert.equal(offline.serviceTiers("account-other", "gpt-6.2-astra"), undefined);

  await writeFile(file, "{ not json");
  server.failure = undefined;
  const broken = new CodexModelCatalog({ fetch: server.fetch, now: time.now, file: () => file });
  await broken.load(account("account-secret-id"));
  assert.equal(server.requests.length, 3);
});

test("stops waiting for the catalog when the request is aborted", async () => {
  const catalog = new CodexModelCatalog({
    fetch: () => new Promise<Response>(() => {}),
    file: () => undefined,
  });
  const controller = new AbortController();
  const load = catalog.load(account("account-1"), controller.signal);
  controller.abort();
  await load;
  assert.equal(catalog.serviceTiers("account-1", "gpt-6.2-sol"), undefined);
});

test("parses catalogs, account ids, and catalog ETags", () => {
  assert.throws(() => parseCatalogModels({ data: [] }), /invalid catalog response/);
  assert.deepEqual(
    parseCatalogModels({
      models: [
        { slug: "gpt-6.2-sol", service_tiers: [{ id: "ultrafast" }, { name: "no id" }, "fast"] },
        { slug: "", service_tiers: [{ id: "priority" }] },
        { slug: "gpt-6-luna" },
      ],
    }),
    new Map([
      ["gpt-6.2-sol", new Set(["ultrafast"])],
      ["gpt-6-luna", new Set()],
    ]),
  );
  assert.equal(extractAccountId(token("account-1")), "account-1");
  assert.throws(() => extractAccountId("not-a-token"), /malformed/);
  assert.throws(() => extractAccountId(token("")), /no ChatGPT account id/);
  assert.equal(modelsEtagFromHeaders({ "X-Models-Etag": '"one"' }), '"one"');
  assert.equal(modelsEtagFromHeaders({ etag: '"other"' }), undefined);
  assert.equal(
    modelsEtagFromEvent({ type: "response.metadata", headers: { "x-models-etag": '"two"' } }),
    '"two"',
  );
  assert.equal(
    modelsEtagFromEvent({ type: "response.created", headers: { "x-models-etag": '"no"' } }),
    undefined,
  );
});

test("refuses a speed only when the catalog shows the plan lacks it", () => {
  const both = new Set(["priority", "ultrafast"]);
  const fastOnly = new Set(["priority"]);
  assert.equal(speedRefusal("ultrafast", "gpt-6.2-sol", both, undefined), undefined);
  assert.equal(
    speedRefusal("ultrafast", "gpt-6.2-astra", fastOnly, undefined),
    "Your ChatGPT plan does not include Ultrafast for gpt-6.2-astra. Select openai-codex-fast/gpt-6.2-astra instead.",
  );
  // A model the catalog leaves out has no confirmed Ultrafast either.
  assert.match(
    speedRefusal("ultrafast", "gpt-7-sol", undefined, undefined) ?? "",
    /does not include/,
  );
  assert.match(
    speedRefusal("ultrafast", "gpt-6.2-sol", undefined, "timed out") ?? "",
    /could not be loaded \(timed out\)/,
  );
  assert.equal(speedRefusal("priority", "gpt-6-luna", undefined, "HTTP 503"), undefined);
  assert.equal(speedRefusal("priority", "gpt-6-luna", fastOnly, undefined), undefined);
  assert.equal(
    speedRefusal("priority", "gpt-6-luna", new Set(), undefined),
    "Your ChatGPT plan does not include Fast for gpt-6-luna. Select openai-codex/gpt-6-luna instead.",
  );
});
