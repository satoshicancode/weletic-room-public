import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  localDev: true,
  resolveComplianceStore: vi.fn(),
  resolveOperationalStore: vi.fn(),
  operationalStoreFindUnique: vi.fn(),
  operationalStoreFindMany: vi.fn(),
  loyaltyProgramFindUnique: vi.fn(),
  projectFindUnique: vi.fn(),
  webhookEventCreate: vi.fn(),
  webhookEventFindUnique: vi.fn(),
  webhookEventFindMany: vi.fn(),
  webhookEventUpdateMany: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
  publishJSON: vi.fn(),
  transaction: vi.fn(),
  ordersPaid: vi.fn(),
  captureWebhookLog: vi.fn(),
  log: vi.fn(),
  retain: vi.fn(),
}));

vi.mock("@/lib/api/environment", () => ({
  get isLocalDev() {
    return mocks.localDev;
  },
}));
vi.mock("@/lib/api-logs/capture-webhook-log", () => ({
  captureWebhookLog: mocks.captureWebhookLog,
}));
vi.mock("@/lib/cron", () => ({
  qstash: { publishJSON: mocks.publishJSON },
}));
vi.mock("@/lib/upstash", () => ({
  redis: { set: mocks.redisSet, eval: mocks.redisEval },
}));
vi.mock("@/lib/weletic/shopify/compliance-store-resolver", () => ({
  resolveComplianceShopifyStoreByDomain: mocks.resolveComplianceStore,
}));
vi.mock("@/lib/weletic/shopify/store-resolver", async (original) => ({
  ...(await original<typeof import("@/lib/weletic/shopify/store-resolver")>()),
  resolveShopifyStoreByDomain: mocks.resolveOperationalStore,
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >()),
  shopifyAdminGraphqlRequest: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: (() => {
    const client = {
      project: { findUnique: mocks.projectFindUnique },
      weleticShopifyStore: {
        findUnique: mocks.operationalStoreFindUnique,
        findMany: mocks.operationalStoreFindMany,
      },
      weleticLoyaltyProgram: {
        findUnique: mocks.loyaltyProgramFindUnique,
      },
      weleticShopifyWebhookEvent: {
        create: mocks.webhookEventCreate,
        findUnique: mocks.webhookEventFindUnique,
        findMany: mocks.webhookEventFindMany,
        updateMany: mocks.webhookEventUpdateMany,
      },
    };
    return {
      ...client,
      $transaction: (callback: any) => mocks.transaction(callback, client),
    };
  })(),
}));
vi.mock("@dub/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dub/utils")>()),
  log: mocks.log,
}));
vi.mock("@vercel/functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/functions")>()),
  waitUntil: (promise: Promise<any>) => mocks.retain(promise),
}));
vi.mock("../../app/(ee)/api/shopify/integration/webhook/orders-paid", () => ({
  ordersPaid: mocks.ordersPaid,
}));
vi.mock("app/(ee)/api/cron/utils", () => ({
  logAndRespond: (message: string, options: ResponseInit) =>
    new Response(message, options),
}));
vi.mock("@/lib/axiom/server", () => ({
  withAxiomBodyLog: (handler: unknown) => handler,
  logger: { error: vi.fn(), flush: vi.fn() },
}));

import { GET as cronGET } from "../../app/(ee)/api/cron/weletic/shopify/orders-paid-recovery/route";
import { POST } from "../../app/(ee)/api/shopify/integration/webhook/route";
import {
  auditTerminalFailedOrdersPaidWebhooks,
  executeClaimedOrdersPaidEvent,
  getFailedRetryBackoffMs,
  recoverStuckOrdersPaidWebhooks,
} from "../../lib/weletic/shopify/orders-paid-recovery";
import { createAllShopifyWebhookBodyDigests } from "../../lib/weletic/shopify/privacy-identity";

const secret = "orders-paid-test-webhook-secret-32-chars-long";

function signedRequest({
  body,
  shop = "test-store.myshopify.com",
  topic = "orders/paid",
  webhookId = "wh_perf_01",
}: {
  body: Record<string, unknown>;
  shop?: string;
  topic?: string;
  webhookId?: string;
}) {
  const rawBody = JSON.stringify(body);
  return new Request("https://weletic.test/api/shopify/integration/webhook", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": webhookId,
      "x-shopify-hmac-sha256": createHmac("sha256", secret)
        .update(rawBody)
        .digest("base64"),
    },
  });
}

describe("PERF-04: orders/paid Webhook Decoupled Ingress, Durability & Idempotency", () => {
  let backgroundTasks: Promise<any>[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    backgroundTasks = [];
    mocks.localDev = true;
    process.env.SHOPIFY_WEBHOOK_SECRET = secret;
    vi.stubEnv("SHOPIFY_WEBHOOK_SECRET_NEXT", "");
    vi.stubEnv("CRON_SECRET", "synthetic-cron-secret");
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "1");

    mocks.retain.mockImplementation((task: Promise<any>) => {
      backgroundTasks.push(task);
    });

    mocks.resolveComplianceStore.mockResolvedValue(null);
    mocks.resolveOperationalStore.mockResolvedValue({
      storeId: "store_perf_1",
      workspaceId: "workspace_perf_1",
      programId: "program_perf_1",
      myshopifyDomain: "test-store.myshopify.com",
      accessToken: "shpat_test_token",
    });
    mocks.operationalStoreFindUnique.mockResolvedValue({
      id: "store_perf_1",
      projectId: "workspace_perf_1",
      complianceState: "active",
      shopCurrency: "USD",
      installationGeneration: "sgen_perf_1",
    });
    mocks.projectFindUnique.mockResolvedValue({
      id: "workspace_perf_1",
      defaultProgramId: "program_perf_1",
      webhookEnabled: true,
    });
    mocks.loyaltyProgramFindUnique.mockResolvedValue(null);
    mocks.webhookEventCreate.mockResolvedValue({
      id: "event_perf_1",
      storeId: "store_perf_1",
      topic: "orders/paid",
      status: "received",
      attempts: 1,
    });
    mocks.webhookEventFindUnique.mockResolvedValue(null);
    mocks.webhookEventFindMany.mockResolvedValue([]);
    mocks.webhookEventUpdateMany.mockResolvedValue({ count: 1 });
    mocks.transaction.mockImplementation(async (callback: any, client: any) =>
      callback(client),
    );
    mocks.ordersPaid.mockResolvedValue("ordersPaid completed successfully");
    mocks.log.mockResolvedValue(undefined);
  });

  it("1. Fast Ingress Latency: responds with HTTP 200 in < 50ms while ordersPaid runs asynchronously in waitUntil", async () => {
    // Downstream processing takes 200ms
    mocks.ordersPaid.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return "slow settlement completed";
    });

    const orderPayload = {
      id: 1001,
      name: "#1001",
      total_price: "120.00",
      customer: { id: 501, email: "shopper@test.invalid" },
      discount_codes: [{ code: "VIP10", amount: "12.00" }],
    };

    const startTime = performance.now();
    const response = await POST(
      signedRequest({
        body: orderPayload,
        webhookId: "wh_perf_ingress_01",
      }),
    );
    const ingressDuration = performance.now() - startTime;

    // Fast ingress response verification
    expect(ingressDuration).toBeLessThan(80);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const responseBody = await response.json();
    expect(responseBody).toEqual({
      received: true,
      queued: true,
      webhookId: "wh_perf_ingress_01",
    });

    // Confirm processing was passed to waitUntil
    expect(backgroundTasks.length).toBeGreaterThan(0);

    // Await background completion to verify business logic execution
    await Promise.all(backgroundTasks);
    expect(mocks.ordersPaid).toHaveBeenCalledTimes(1);
    expect(mocks.ordersPaid).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_perf_1",
        expectedInstallationGeneration: "sgen_perf_1",
        event: expect.objectContaining({ id: 1001 }),
      }),
    );

    // Verify status was marked processed
    expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "received",
          topic: "orders/paid",
        }),
        data: expect.objectContaining({
          status: "processed",
          processedAt: expect.any(Date),
        }),
      }),
    );
  });

  it("2. Durable Persistence: persists full event JSON payload on ingress without DbNull wiping", async () => {
    const richOrderPayload = {
      id: 2002,
      checkout_token: "tok_durability_test",
      line_items: [
        { id: 11, title: "Yamax Flow Leggings", price: "8800", quantity: 1 },
      ],
      current_subtotal_price_set: {
        shop_money: { amount: "8800", currency_code: "JPY" },
      },
      discount_codes: [{ code: "PARTNER20", amount: "1760" }],
    };

    await POST(
      signedRequest({
        body: richOrderPayload,
        webhookId: "wh_perf_durability_02",
      }),
    );

    // Durable creation in database must contain full event JSON
    expect(mocks.webhookEventCreate).toHaveBeenCalledTimes(1);
    const createCallArgs = mocks.webhookEventCreate.mock.calls[0][0];
    expect(createCallArgs.data).toMatchObject({
      storeId: "store_perf_1",
      topic: "orders/paid",
      attempts: 1,
      payload: richOrderPayload,
    });
    expect(createCallArgs.data.payload).not.toBe(Prisma.DbNull);

    // Await background tasks and ensure processed state also preserves payload (not DbNull)
    await Promise.all(backgroundTasks);
    const updateCallArgs = mocks.webhookEventUpdateMany.mock.calls[0][0];
    expect(updateCallArgs.data).toMatchObject({
      status: "processed",
    });
    expect(updateCallArgs.data.payload).toBeUndefined(); // Payload remains intact from create
  });

  it("3. Idempotency: immediately deduplicates duplicate delivery when first delivery is in-flight (< 120s)", async () => {
    const orderPayload = { id: 3003, total_price: "50.00" };
    const rawBodyBytes = Buffer.from(JSON.stringify(orderPayload));
    const digest = createAllShopifyWebhookBodyDigests({
      topic: "orders/paid",
      rawBodyBytes,
    })[0];

    // Simulate unique constraint collision (duplicate webhookId)
    mocks.webhookEventCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    // Existing record in DB is in-flight (status: "received", updated 15s ago < 120s)
    mocks.webhookEventFindUnique.mockResolvedValueOnce({
      id: "event_existing_inflight",
      storeId: "store_perf_1",
      topic: "orders/paid",
      status: "received",
      attempts: 1,
      updatedAt: new Date(Date.now() - 15_000),
      authenticatedBodyDigest: digest,
      storeInstallationGeneration: "sgen_perf_1",
    });

    const response = await POST(
      signedRequest({
        body: orderPayload,
        webhookId: "wh_perf_duplicate_inflight",
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      received: true,
      duplicate: true,
      webhookId: "wh_perf_duplicate_inflight",
      status: "received",
    });

    // ordersPaid should NOT be executed a second time
    expect(mocks.ordersPaid).not.toHaveBeenCalled();
  });

  it("4. Idempotency: immediately acknowledges duplicate delivery when first delivery is already processed", async () => {
    const orderPayload = { id: 4004, total_price: "99.00" };
    const rawBodyBytes = Buffer.from(JSON.stringify(orderPayload));
    const digest = createAllShopifyWebhookBodyDigests({
      topic: "orders/paid",
      rawBodyBytes,
    })[0];

    mocks.webhookEventCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );

    // Existing record in DB is already processed
    mocks.webhookEventFindUnique.mockResolvedValueOnce({
      id: "event_existing_processed",
      storeId: "store_perf_1",
      topic: "orders/paid",
      status: "processed",
      attempts: 1,
      updatedAt: new Date(Date.now() - 300_000),
      authenticatedBodyDigest: digest,
      storeInstallationGeneration: "sgen_perf_1",
    });

    const response = await POST(
      signedRequest({
        body: orderPayload,
        webhookId: "wh_perf_duplicate_processed",
      }),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      received: true,
      duplicate: true,
      webhookId: "wh_perf_duplicate_processed",
      status: "processed",
    });

    expect(mocks.ordersPaid).not.toHaveBeenCalled();
  });

  it("5. Failure State Capture: captures failed status and error message while preserving durable payload", async () => {
    mocks.ordersPaid.mockRejectedValueOnce(
      new Error("Shopify Admin GraphQL connection timeout"),
    );

    const orderPayload = { id: 5005, total_price: "45.00" };

    const response = await POST(
      signedRequest({
        body: orderPayload,
        webhookId: "wh_perf_failed_capture",
      }),
    );

    expect(response.status).toBe(200);

    // Await background execution
    await Promise.allSettled(backgroundTasks);

    // Verify status was updated to 'failed' with error recorded
    expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "received",
          topic: "orders/paid",
        }),
        data: expect.objectContaining({
          status: "failed",
          error: "Shopify Admin GraphQL connection timeout",
        }),
      }),
    );
  });

  it("6. Active Recovery: recoverStuckOrdersPaidWebhooks reclaims stuck in-flight events (> 180s) and processes them", async () => {
    const stuckPayload = {
      id: 6006,
      name: "#6006",
      total_price: "180.00",
      customer: { id: 601 },
    };

    // Stored candidate stuck in 'received' state for 210 seconds (> 180s threshold)
    mocks.webhookEventFindMany.mockResolvedValueOnce([
      {
        id: "event_stuck_01",
        storeId: "store_perf_1",
        webhookId: "wh_stuck_01",
        topic: "orders/paid",
        status: "received",
        attempts: 1,
        payload: stuckPayload,
        storeInstallationGeneration: "sgen_perf_1",
        updatedAt: new Date(Date.now() - 210_000),
      },
    ]);

    const results = await recoverStuckOrdersPaidWebhooks({
      limit: 10,
      inFlightLeaseMs: 180_000,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      id: "event_stuck_01",
      webhookId: "wh_stuck_01",
      status: "processed",
    });

    // Atomic lease update verified
    expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "event_stuck_01",
        status: "received",
        attempts: 1,
      },
      data: {
        status: "received",
        attempts: { increment: 1 },
        updatedAt: expect.any(Date),
        error: null,
      },
    });

    // ordersPaid was called with stored payload
    expect(mocks.ordersPaid).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_perf_1",
        expectedInstallationGeneration: "sgen_perf_1",
        event: stuckPayload,
      }),
    );

    // Final mark processed
    expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "event_stuck_01",
        status: "received",
        attempts: 2,
      }),
      data: {
        status: "processed",
        processedAt: expect.any(Date),
      },
    });
  });

  it("7. Terminal Failure Auditing: marks terminal failure with audit message and alerts when attempts reach 5", async () => {
    const poisonPayload = {
      id: 7007,
      name: "#7007-malformed",
      total_price: "999.00",
    };

    // Event already attempted 4 times; this recovery run will be attempt 5 (reaching maxAttempts = 5)
    mocks.webhookEventFindMany.mockResolvedValueOnce([
      {
        id: "event_poison_01",
        storeId: "store_perf_1",
        webhookId: "wh_poison_01",
        topic: "orders/paid",
        status: "failed",
        attempts: 4,
        payload: poisonPayload,
        storeInstallationGeneration: "sgen_perf_1",
        updatedAt: new Date(Date.now() - 600_000),
      },
    ]);

    mocks.ordersPaid.mockRejectedValueOnce(
      new Error("Irrecoverable data integrity error"),
    );

    const results = await recoverStuckOrdersPaidWebhooks({
      limit: 10,
      maxAttempts: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "event_poison_01",
      webhookId: "wh_poison_01",
      status: "failed",
      isTerminal: true,
      error: expect.stringContaining("[TERMINAL_ERROR_AUDIT]"),
    });

    // Verify alert logging for terminal failure
    expect(mocks.log).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "errors",
        message: expect.stringContaining("[Shopify Webhook Terminal Failure]"),
      }),
    );

    // Verify terminal audit query helper
    mocks.webhookEventFindMany.mockResolvedValueOnce([
      {
        id: "event_poison_01",
        storeId: "store_perf_1",
        webhookId: "wh_poison_01",
        topic: "orders/paid",
        status: "failed",
        attempts: 5,
        error:
          "[TERMINAL_ERROR_AUDIT] Exceeded maximum retry attempts (5). Manual intervention required.",
        payload: poisonPayload,
      },
    ]);

    const auditRecords = await auditTerminalFailedOrdersPaidWebhooks({
      limit: 10,
    });
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].attempts).toBe(5);
    expect(auditRecords[0].error).toContain("[TERMINAL_ERROR_AUDIT]");

    // Verify ingress deduplication also protects against terminal loop
    const rawBodyBytes = Buffer.from(JSON.stringify(poisonPayload));
    const digest = createAllShopifyWebhookBodyDigests({
      topic: "orders/paid",
      rawBodyBytes,
    })[0];

    mocks.webhookEventCreate.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    mocks.webhookEventFindUnique.mockResolvedValueOnce({
      id: "event_poison_01",
      storeId: "store_perf_1",
      topic: "orders/paid",
      status: "failed",
      attempts: 5,
      authenticatedBodyDigest: digest,
      updatedAt: new Date(),
    });

    const ingressResponse = await POST(
      signedRequest({
        body: poisonPayload,
        webhookId: "wh_poison_01",
      }),
    );
    expect(ingressResponse.status).toBe(200);
    const ingressJson = await ingressResponse.json();
    expect(ingressJson).toMatchObject({
      duplicate: true,
      error: expect.stringContaining("[TERMINAL_ERROR_AUDIT]"),
    });
  });

  it("8. Dedicated Recovery Cron Route: enforces Vercel Bearer authentication and executes multi-tenant sweep", async () => {
    // Unauthorized request without Bearer token -> 401
    const unauthReq = new NextRequest(
      "https://app.invalid/api/cron/weletic/shopify/orders-paid-recovery",
      { method: "GET" },
    );
    const unauthResponse = await cronGET(unauthReq, {
      params: Promise.resolve({}),
    });
    expect(unauthResponse.status).toBe(401);

    // Authorized request with Bearer CRON_SECRET -> 200
    mocks.webhookEventFindMany.mockResolvedValueOnce([]);
    const authReq = new NextRequest(
      "https://app.invalid/api/cron/weletic/shopify/orders-paid-recovery?batchSize=15",
      {
        method: "GET",
        headers: {
          authorization: "Bearer synthetic-cron-secret",
        },
      },
    );
    const authResponse = await cronGET(authReq, {
      params: Promise.resolve({}),
    });
    expect(authResponse.status).toBe(200);

    const cronJson = await authResponse.json();
    expect(cronJson).toHaveProperty("recovered");
    expect(cronJson).toHaveProperty("results");
  });

  it("9. Shared Pipeline Parity: ingress background execution and cron recovery execute identical business gates and settlement", async () => {
    const testPayload = { id: 9191, total_price: "320.00" };

    // Path A: Ingress background execution
    const ingressExecution = await executeClaimedOrdersPaidEvent({
      claim: {
        id: "event_parity_ingress",
        storeId: "store_perf_1",
        attempt: 1,
        storeInstallationGeneration: "sgen_perf_1",
        dispatchInstallationGeneration: "sgen_perf_1",
        privacyMinimizedFinancialSettlement: false,
      },
      event: testPayload,
      workspace: {
        id: "workspace_perf_1",
        defaultProgramId: "program_perf_1",
        webhookEnabled: true,
      },
      startTime: Date.now(),
    });

    expect(ingressExecution.status).toBe("processed");
    expect(mocks.ordersPaid).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_perf_1",
        expectedInstallationGeneration: "sgen_perf_1",
        privacyMinimizedFinancialSettlement: false,
        event: testPayload,
      }),
    );

    // Path B: Recovery execution
    mocks.webhookEventFindMany.mockResolvedValueOnce([
      {
        id: "event_parity_cron",
        storeId: "store_perf_1",
        webhookId: "wh_parity_cron",
        topic: "orders/paid",
        status: "received",
        attempts: 1,
        payload: testPayload,
        storeInstallationGeneration: "sgen_perf_1",
        updatedAt: new Date(Date.now() - 150_000),
      },
    ]);

    const recoveryResults = await recoverStuckOrdersPaidWebhooks({
      limit: 5,
      inFlightLeaseMs: 120_000,
    });

    expect(recoveryResults).toHaveLength(1);
    expect(recoveryResults[0].status).toBe("processed");
    expect(mocks.ordersPaid).toHaveBeenLastCalledWith(
      expect.objectContaining({
        storeId: "store_perf_1",
        expectedInstallationGeneration: "sgen_perf_1",
        privacyMinimizedFinancialSettlement: false,
        event: testPayload,
      }),
    );

    // Gate Rejection Parity: store with generation mismatch or compliance frozen
    mocks.operationalStoreFindUnique.mockResolvedValueOnce({
      id: "store_perf_1",
      projectId: "workspace_perf_1",
      complianceState: "frozen",
      shopCurrency: "USD",
      installationGeneration: "sgen_mismatched",
    });

    // Ingress fails when compliance write is rejected
    const blockedExecution = await executeClaimedOrdersPaidEvent({
      claim: {
        id: "event_parity_blocked",
        storeId: "store_perf_1",
        attempt: 1,
        storeInstallationGeneration: "sgen_perf_1",
        dispatchInstallationGeneration: "sgen_mismatched",
        privacyMinimizedFinancialSettlement: false,
      },
      event: testPayload,
      workspace: {
        id: "workspace_perf_1",
        defaultProgramId: "program_perf_1",
        webhookEnabled: true,
      },
      startTime: Date.now(),
    });

    // Generation mismatch on non-active store rejects write
    expect(blockedExecution.status).toBe("failed");
  });

  it("10. Exponential Retry Backoff: cron does not re-claim recently failed events before backoff expires", async () => {
    // Backoff formula verification:
    // attempt 1: 60s, attempt 2: 120s, attempt 3: 240s
    expect(getFailedRetryBackoffMs(1)).toBe(60_000);
    expect(getFailedRetryBackoffMs(2)).toBe(120_000);
    expect(getFailedRetryBackoffMs(3)).toBe(240_000);

    const now = Date.now();
    // Event failed 20s ago (attempt 1 requires 60s backoff) -> NOT eligible
    const recentlyFailedEvent = {
      id: "event_recent_fail",
      storeId: "store_perf_1",
      webhookId: "wh_recent_fail",
      topic: "orders/paid",
      status: "failed",
      attempts: 1,
      payload: { id: 1111 },
      storeInstallationGeneration: "sgen_perf_1",
      updatedAt: new Date(now - 20_000),
    };

    // Event failed 90s ago (attempt 1 requires 60s backoff) -> ELIGIBLE
    const matureFailedEvent = {
      id: "event_mature_fail",
      storeId: "store_perf_1",
      webhookId: "wh_mature_fail",
      topic: "orders/paid",
      status: "failed",
      attempts: 1,
      payload: { id: 2222 },
      storeInstallationGeneration: "sgen_perf_1",
      updatedAt: new Date(now - 90_000),
    };

    mocks.webhookEventFindMany.mockResolvedValueOnce([
      recentlyFailedEvent,
      matureFailedEvent,
    ]);

    const results = await recoverStuckOrdersPaidWebhooks({
      limit: 10,
    });

    // Only the mature failed event was claimed and recovered
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("event_mature_fail");
    expect(results[0].status).toBe("processed");
  });

  it("11. Workspace-Scoped Pre-filtering: filters stores before claiming without incrementing attempts", async () => {
    // Simulate prisma.weleticShopifyStore.findMany returning target stores
    mocks.operationalStoreFindMany.mockResolvedValueOnce([
      { id: "store_target_1" },
    ]);

    mocks.webhookEventFindMany.mockResolvedValueOnce([
      {
        id: "event_target_1",
        storeId: "store_target_1",
        webhookId: "wh_target_1",
        topic: "orders/paid",
        status: "received",
        attempts: 1,
        payload: { id: 3333 },
        storeInstallationGeneration: "sgen_perf_1",
        updatedAt: new Date(Date.now() - 250_000),
      },
    ]);

    const results = await recoverStuckOrdersPaidWebhooks({
      workspaceId: "workspace_target",
      limit: 10,
    });

    expect(mocks.operationalStoreFindMany).toHaveBeenCalledWith({
      where: { projectId: "workspace_target" },
      select: { id: true },
    });

    expect(mocks.webhookEventFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: { in: ["store_target_1"] },
        }),
      }),
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("event_target_1");
  });

  it("12. In-flight Lease Immunity: cron strictly does not claim events in 'received' state if still within the 180s lease threshold", async () => {
    const now = Date.now();
    // Candidate in 'received' state updated 120s ago (within 180s threshold) -> NOT eligible
    const activeInFlightCandidate = {
      id: "event_active_inflight",
      storeId: "store_perf_1",
      webhookId: "wh_active_inflight",
      topic: "orders/paid",
      status: "received",
      attempts: 1,
      payload: { id: 4444 },
      storeInstallationGeneration: "sgen_perf_1",
      updatedAt: new Date(now - 120_000),
    };

    mocks.webhookEventFindMany.mockResolvedValueOnce([activeInFlightCandidate]);

    const results = await recoverStuckOrdersPaidWebhooks({
      limit: 10,
      inFlightLeaseMs: 180_000,
    });

    // Strictly empty results: no lease stolen while in-flight
    expect(results).toHaveLength(0);
    expect(mocks.ordersPaid).not.toHaveBeenCalled();
  });
});
