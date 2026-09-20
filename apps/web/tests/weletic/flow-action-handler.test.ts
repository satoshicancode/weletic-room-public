import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FlowActionExecutionError } from "../../lib/weletic/loyalty/flow-action-execution";
import { handleFlowPointsAction } from "../../lib/weletic/loyalty/flow-action-handler";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  tx: vi.fn(),
  credential: vi.fn(),
  lock: vi.fn(),
  execute: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.store },
    $transaction: mocks.tx,
  },
}));
vi.mock("../../lib/weletic/shopify/store-owned-credential", () => ({
  readStoreOwnedShopifyCredential: mocks.credential,
}));
vi.mock("../../lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: mocks.lock,
}));
vi.mock(
  "../../lib/weletic/loyalty/flow-action-execution",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../lib/weletic/loyalty/flow-action-execution")
    >()),
    executeFlowPointsActionInTransaction: mocks.execute,
  }),
);

const secret = "synthetic-flow-public-secret-not-live-12345";
const config = { enabled: true, appId: "public-test", publicAppSecret: secret };
const action = {
  handle: "weletic-adjust-points",
  shop_id: "123",
  shopify_domain: "fixture.myshopify.com",
  action_run_id: "run-1",
  properties: {
    customer_id: "gid://shopify/Customer/456",
    grant_id: `wflowgrant_${"a".repeat(20)}`,
    points_delta: "1",
  },
};
function request(key = secret) {
  const body = JSON.stringify(action);
  return new Request(
    "https://example.invalid/api/shopify/flow/points-adjustment",
    {
      method: "POST",
      body,
      headers: {
        "x-shopify-hmac-sha256": createHmac("sha256", key)
          .update(body)
          .digest("base64"),
      },
    },
  );
}
function shopResponse(
  id = "gid://shopify/Shop/123",
  domain = action.shopify_domain,
) {
  return Response.json({ data: { shop: { id, myshopifyDomain: domain } } });
}
describe("Flow handler (mocked SQL, Redis and Shopify)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("SHOPIFY_API_KEY", config.appId);
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.store.mockResolvedValue({
      id: "store-1",
      projectId: "workspace-1",
      installationGeneration: "g1",
    });
    mocks.tx.mockImplementation((fn) => fn({ tx: true }));
    mocks.credential.mockResolvedValue({
      revision: 1,
      accessToken: "synthetic-token",
    });
    mocks.fetch.mockImplementation(() => Promise.resolve(shopResponse()));
    mocks.lock.mockImplementation(({ fn }) => fn());
    mocks.execute.mockResolvedValue({
      status: "applied",
      runId: "internal-receipt",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it.each(["disabled", "app", "hmac"])(
    "rejects %s before store lookup",
    async (mode) => {
      const result = await handleFlowPointsAction(
        request(mode === "hmac" ? "wrong-secret" : secret),
        {
          ...config,
          enabled: mode !== "disabled",
          appId: mode === "app" ? "custom-test" : config.appId,
        },
      );
      expect(result.status).toBe(mode === "hmac" ? 401 : 503);
      expect(mocks.store).not.toHaveBeenCalled();
      expect(mocks.fetch).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );
  it("contains unknown stores before credentials, network or locks", async () => {
    mocks.store.mockResolvedValue(null);
    expect((await handleFlowPointsAction(request(), config)).status).toBe(403);
    expect(mocks.credential).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });
  it.each(["id", "domain"])("rejects mismatched shop %s", async (field) => {
    mocks.fetch.mockResolvedValue(
      shopResponse(
        field === "id" ? "gid://shopify/Shop/999" : "gid://shopify/Shop/123",
        field === "domain" ? "foreign.myshopify.com" : action.shopify_domain,
      ),
    );
    expect((await handleFlowPointsAction(request(), config)).status).toBe(403);
    expect(mocks.lock).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("verifies shop outside locks then revalidates credentials inside the locked transaction", async () => {
    let locked = false;
    mocks.fetch.mockImplementation(() => {
      expect(locked).toBe(false);
      return Promise.resolve(shopResponse());
    });
    mocks.lock.mockImplementation(async ({ fn }) => {
      locked = true;
      return fn();
    });
    mocks.execute.mockImplementation(() => {
      expect(locked).toBe(true);
      return { status: "applied" };
    });
    const result = await handleFlowPointsAction(request(), config);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("");
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.fetch).toHaveBeenCalledWith(
      "https://fixture.myshopify.com/admin/api/2026-07/graphql.json",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(mocks.credential).toHaveBeenCalledTimes(2);
    expect(mocks.lock).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        workspaceId: "workspace-1",
        shopifyCustomerId: action.properties.customer_id,
      }),
    );
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: action,
        scope: expect.objectContaining({
          storeId: "store-1",
          appId: config.appId,
          installationGeneration: "g1",
        }),
      }),
    );
  });
  it.each(["oversized", "malformed", "graphql", "http"])(
    "contains %s verification response without execution",
    async (failure) => {
      mocks.fetch.mockResolvedValue(
        failure === "oversized"
          ? new Response("x".repeat(16 * 1024 + 1))
          : failure === "malformed"
            ? new Response("not-json")
            : failure === "graphql"
              ? Response.json({
                  errors: [{ message: "private upstream details" }],
                })
              : new Response(null, { status: 429 }),
      );
      const result = await handleFlowPointsAction(request(), config);
      expect(result.status).toBe(503);
      expect(mocks.lock).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );
  it.each(["revision", "token", "missing"])(
    "rejects %s credential change",
    async (change) => {
      mocks.credential
        .mockResolvedValueOnce({ revision: 1, accessToken: "synthetic-token" })
        .mockResolvedValueOnce(
          change === "missing"
            ? null
            : {
                revision: change === "revision" ? 2 : 1,
                accessToken:
                  change === "token" ? "rotated-token" : "synthetic-token",
              },
        );
      expect((await handleFlowPointsAction(request(), config)).status).toBe(
        503,
      );
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );
  it("acknowledges a durable replay with the same empty success response", async () => {
    mocks.execute.mockResolvedValue({
      status: "replayed",
      runId: "private-receipt",
    });
    const result = await handleFlowPointsAction(request(), config);
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("");
  });
  it("does not ask Shopify to retry an immutable run conflict", async () => {
    mocks.execute.mockRejectedValue(
      new FlowActionExecutionError("run_conflict"),
    );
    const result = await handleFlowPointsAction(request(), config);
    expect(result.status).toBe(409);
    expect(await result.text()).toBe(
      JSON.stringify({ message: "Flow action unavailable" }),
    );
  });
  it("rejects lifecycle failure at the second credential read before execution", async () => {
    mocks.credential
      .mockResolvedValueOnce({ revision: 1, accessToken: "synthetic-token" })
      .mockRejectedValueOnce(
        new Error("retired admission or changed generation"),
      );
    expect((await handleFlowPointsAction(request(), config)).status).toBe(503);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(["network", "lock", "commit"])(
    "returns neutral retryable %s failure without in-process retry",
    async (stage) => {
      const target =
        stage === "network"
          ? mocks.fetch
          : stage === "lock"
            ? mocks.lock
            : mocks.execute;
      target.mockRejectedValue(
        new Error("sensitive-provider-token-and-customer"),
      );
      const result = await handleFlowPointsAction(request(), config);
      expect(result.status).toBe(503);
      expect(await result.text()).toBe(
        JSON.stringify({ message: "Flow action unavailable" }),
      );
      expect(target).toHaveBeenCalledTimes(1);
    },
  );
});
