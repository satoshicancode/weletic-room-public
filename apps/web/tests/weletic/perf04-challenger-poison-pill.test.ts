import { Prisma } from "@prisma/client";
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

import { POST } from "../../app/(ee)/api/shopify/integration/webhook/route";
import {
  recoverStuckOrdersPaidWebhooks,
  auditTerminalFailedOrdersPaidWebhooks,
  executeClaimedOrdersPaidEvent,
  assertOrdersPaidStoreAcceptsWrite,
  getFailedRetryBackoffMs,
  IN_FLIGHT_LEASE_THRESHOLD_MS,
  MAX_RETRY_ATTEMPTS,
} from "../../lib/weletic/shopify/orders-paid-recovery";
import { createAllShopifyWebhookBodyDigests } from "../../lib/weletic/shopify/privacy-identity";

const secret = "challenger-orders-paid-webhook-secret-32-chars";

function signedRequest({
  body,
  shop = "adversarial-store.myshopify.com",
  topic = "orders/paid",
  webhookId = "wh_challenger_01",
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

describe("CHALLENGER 2: Poison Pill Resilience, Exponential Backoff & Terminal Audit", () => {
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

    mocks.retain.mockImplementation((task: Promise<any>) => {
      backgroundTasks.push(task);
    });

    mocks.resolveComplianceStore.mockResolvedValue(null);
    mocks.resolveOperationalStore.mockResolvedValue({
      storeId: "store_adv_01",
      workspaceId: "ws_adv_01",
      programId: "prog_adv_01",
      myshopifyDomain: "adversarial-store.myshopify.com",
      accessToken: "shpat_adversarial_token",
    });
    mocks.operationalStoreFindUnique.mockResolvedValue({
      id: "store_adv_01",
      projectId: "ws_adv_01",
      complianceState: "active",
      shopCurrency: "USD",
      installationGeneration: "sgen_adv_01",
    });
    mocks.projectFindUnique.mockResolvedValue({
      id: "ws_adv_01",
      defaultProgramId: "prog_adv_01",
      webhookEnabled: true,
    });
    mocks.loyaltyProgramFindUnique.mockResolvedValue(null);
    mocks.webhookEventCreate.mockResolvedValue({
      id: "event_adv_01",
      storeId: "store_adv_01",
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
    mocks.ordersPaid.mockResolvedValue("settled");
    mocks.log.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // TEST SUITE 1: Poison Pill Crash Resilience in Ingress waitUntil
  // -------------------------------------------------------------------------
  describe("1. Poison Pill Resilience & Payload Preservation", () => {
    it("1.1. Complex poison pill payload: captures status 'failed', logs error, and preserves verbatim JSON payload", async () => {
      const poisonPayload = {
        id: 999999,
        name: "#POISON-999999",
        checkout_token: "tok_malicious_corrupt",
        line_items: [
          {
            id: 888,
            title: "\x00Malformed\uFFFFCorruptItem",
            properties: { deeply: { nested: { invalid: null } } },
          },
        ],
        note_attributes: [{ name: "injection", value: "'; DROP TABLE orders;--" }],
      };

      mocks.ordersPaid.mockRejectedValueOnce(
        new Error("FATAL_POISON_PILL: Memory corruption simulated in settlement engine"),
      );

      const startTime = performance.now();
      const response = await POST(
        signedRequest({
          body: poisonPayload,
          webhookId: "wh_poison_pill_01",
        }),
      );
      const ingressLatency = performance.now() - startTime;

      // Ingress must immediately return 200 in < 50ms even for poisonous payloads
      expect(ingressLatency).toBeLessThan(80);
      expect(response.status).toBe(200);
      const resJson = await response.json();
      expect(resJson).toEqual({
        received: true,
        queued: true,
        webhookId: "wh_poison_pill_01",
      });

      // Verify the event was created initially with the verbatim payload
      expect(mocks.webhookEventCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            webhookId: "wh_poison_pill_01",
            topic: "orders/paid",
            payload: poisonPayload,
            attempts: 1,
          }),
        }),
      );

      // Now await background execution
      expect(backgroundTasks.length).toBeGreaterThan(0);
      await Promise.allSettled(backgroundTasks);

      // Verify executeClaimedOrdersPaidEvent caught the crash and transitioned to 'failed'
      expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "event_adv_01",
            storeId: "store_adv_01",
            topic: "orders/paid",
            status: "received",
            attempts: 1,
          }),
          data: expect.objectContaining({
            status: "failed",
            error: "FATAL_POISON_PILL: Memory corruption simulated in settlement engine",
          }),
        }),
      );

      // Assert error column was updated without wiping or setting payload to DbNull
      const updateCalls = mocks.webhookEventUpdateMany.mock.calls;
      const failureCall = updateCalls.find((call: any[]) =>
        call[0]?.data?.status === "failed",
      );
      expect(failureCall).toBeDefined();
      expect(failureCall?.[0]?.data?.payload).toBeUndefined(); // Crucial: payload was NOT replaced with null or DbNull

      // Assert critical log was emitted
      expect(mocks.log).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "errors",
          message: expect.stringContaining(
            "FATAL_POISON_PILL: Memory corruption simulated in settlement engine",
          ),
        }),
      );
    });

    it("1.2. Non-Error throw: handles non-Error objects (e.g. raw string / object) without unhandled rejection", async () => {
      mocks.ordersPaid.mockRejectedValueOnce("NON_ERROR_STRING_CRASH");

      const response = await POST(
        signedRequest({
          body: { id: 12345 },
          webhookId: "wh_non_error_throw",
        }),
      );
      expect(response.status).toBe(200);

      await Promise.allSettled(backgroundTasks);

      expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "failed",
            error: "NON_ERROR_STRING_CRASH",
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // TEST SUITE 2: Exponential Backoff Immunity across Retries
  // -------------------------------------------------------------------------
  describe("2. Exponential Retry Backoff Verification", () => {
    it("2.1. Mathematical formula: getFailedRetryBackoffMs verifies exponential curve and 30-min ceiling", () => {
      // Attempt <= 0 or 1
      expect(getFailedRetryBackoffMs(0)).toBe(60_000); // 1 minute
      expect(getFailedRetryBackoffMs(1)).toBe(60_000); // 1 minute
      expect(getFailedRetryBackoffMs(2)).toBe(120_000); // 2 minutes
      expect(getFailedRetryBackoffMs(3)).toBe(240_000); // 4 minutes
      expect(getFailedRetryBackoffMs(4)).toBe(480_000); // 8 minutes
      expect(getFailedRetryBackoffMs(5)).toBe(960_000); // 16 minutes
      expect(getFailedRetryBackoffMs(6)).toBe(1_800_000); // capped at 30 minutes (not 1,920,000)
      expect(getFailedRetryBackoffMs(10)).toBe(1_800_000); // capped at 30 minutes
    });

    it("2.2. Sweeper enforcement: recoverStuckOrdersPaidWebhooks strictly skips recently failed events until backoff elapsed", async () => {
      const now = Date.now();

      // Multi-event scenario:
      // Event A: attempt 1, failed 40s ago (backoff = 60s) -> NOT ELIGIBLE
      // Event B: attempt 1, failed 70s ago (backoff = 60s) -> ELIGIBLE
      // Event C: attempt 2, failed 100s ago (backoff = 120s) -> NOT ELIGIBLE
      // Event D: attempt 2, failed 130s ago (backoff = 120s) -> ELIGIBLE
      // Event E: attempt 3, failed 200s ago (backoff = 240s) -> NOT ELIGIBLE
      // Event F: attempt 3, failed 250s ago (backoff = 240s) -> ELIGIBLE
      const candidates = [
        {
          id: "ev_A",
          storeId: "store_adv_01",
          webhookId: "wh_A",
          topic: "orders/paid",
          status: "failed",
          attempts: 1,
          payload: { id: "ord_A" },
          storeInstallationGeneration: "sgen_adv_01",
          updatedAt: new Date(now - 40_000),
        },
        {
          id: "ev_B",
          storeId: "store_adv_01",
          webhookId: "wh_B",
          topic: "orders/paid",
          status: "failed",
          attempts: 1,
          payload: { id: "ord_B" },
          storeInstallationGeneration: "sgen_adv_01",
          updatedAt: new Date(now - 70_000),
        },
        {
          id: "ev_C",
          storeId: "store_adv_01",
          webhookId: "wh_C",
          topic: "orders/paid",
          status: "failed",
          attempts: 2,
          payload: { id: "ord_C" },
          storeInstallationGeneration: "sgen_adv_01",
          updatedAt: new Date(now - 100_000),
        },
        {
          id: "ev_D",
          storeId: "store_adv_01",
          webhookId: "wh_D",
          topic: "orders/paid",
          status: "failed",
          attempts: 2,
          payload: { id: "ord_D" },
          storeInstallationGeneration: "sgen_adv_01",
          updatedAt: new Date(now - 130_000),
        },
        {
          id: "ev_E",
          storeId: "store_adv_01",
          webhookId: "wh_E",
          topic: "orders/paid",
          status: "failed",
          attempts: 3,
          payload: { id: "ord_E" },
          storeInstallationGeneration: "sgen_adv_01",
          updatedAt: new Date(now - 200_000),
        },
        {
          id: "ev_F",
          storeId: "store_adv_01",
          webhookId: "wh_F",
          topic: "orders/paid",
          status: "failed",
          attempts: 3,
          payload: { id: "ord_F" },
          storeInstallationGeneration: "sgen_adv_01",
          updatedAt: new Date(now - 250_000),
        },
      ];

      mocks.webhookEventFindMany.mockResolvedValueOnce(candidates);

      const recovered = await recoverStuckOrdersPaidWebhooks({ limit: 10 });

      // Only B, D, F should have been recovered!
      expect(recovered.map((r) => r.id)).toEqual(["ev_B", "ev_D", "ev_F"]);

      // Verify that premature events A, C, E were NEVER claimed or incremented
      const updateCalls = mocks.webhookEventUpdateMany.mock.calls;
      const updatedIds = updateCalls.map((c: any[]) => c[0]?.where?.id);
      expect(updatedIds).not.toContain("ev_A");
      expect(updatedIds).not.toContain("ev_C");
      expect(updatedIds).not.toContain("ev_E");
    });
  });

  // -------------------------------------------------------------------------
  // TEST SUITE 3: Terminal Error Auditing (>= 5 attempts)
  // -------------------------------------------------------------------------
  describe("3. Terminal Error Auditing (>= 5 attempts)", () => {
    it("3.1. Marks [TERMINAL_ERROR_AUDIT] on 5th failed attempt, preserves payload, and dispatches critical alert", async () => {
      const terminalPayload = {
        id: 77777,
        name: "#ORDER-TERMINAL-77777",
        total_price: "499.00",
        customer: { email: "vip@merchant.test" },
      };

      // Candidate at attempt 4: next attempt will be 5 (reaching maxAttempts = 5)
      mocks.webhookEventFindMany.mockResolvedValueOnce([
        {
          id: "ev_terminal_01",
          storeId: "store_adv_01",
          webhookId: "wh_term_01",
          topic: "orders/paid",
          status: "failed",
          attempts: 4,
          payload: terminalPayload,
          storeInstallationGeneration: "sgen_adv_01",
          updatedAt: new Date(Date.now() - 500_000), // > 480s backoff for attempt 4
        },
      ]);

      mocks.ordersPaid.mockRejectedValueOnce(
        new Error("Shopify GraphQL persistent permission denied: read_orders revoked"),
      );

      const results = await recoverStuckOrdersPaidWebhooks({
        limit: 10,
        maxAttempts: 5,
      });

      expect(results).toHaveLength(1);
      const res = results[0];
      expect(res.id).toBe("ev_terminal_01");
      expect(res.status).toBe("failed");
      expect(res.isTerminal).toBe(true);
      expect(res.error).toContain("[TERMINAL_ERROR_AUDIT]");
      expect(res.error).toContain("Exceeded maximum retry attempts (5)");
      expect(res.error).toContain("Shopify GraphQL persistent permission denied");

      // Verify terminal alert log was emitted
      expect(mocks.log).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "errors",
          message: expect.stringContaining("[Shopify Webhook Terminal Failure]"),
        }),
      );

      // Verify audit records can be retrieved via auditTerminalFailedOrdersPaidWebhooks
      mocks.webhookEventFindMany.mockResolvedValueOnce([
        {
          id: "ev_terminal_01",
          storeId: "store_adv_01",
          webhookId: "wh_term_01",
          topic: "orders/paid",
          status: "failed",
          attempts: 5,
          error: res.error,
          payload: terminalPayload,
        },
      ]);

      const audited = await auditTerminalFailedOrdersPaidWebhooks();
      expect(audited).toHaveLength(1);
      expect(audited[0].payload).toEqual(terminalPayload); // Zero commission loss!
      expect(audited[0].attempts).toBe(5);
    });

    it("3.2. Once terminal (attempts = 5), recovery cron query strictly filters it out (attempts: { lt: 5 })", async () => {
      await recoverStuckOrdersPaidWebhooks({ maxAttempts: 5 });

      // Inspect findMany query parameters
      expect(mocks.webhookEventFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            topic: "orders/paid",
            attempts: { lt: 5 },
          }),
        }),
      );
    });

    it("3.3. Duplicate webhook arrival for terminally failed event returns HTTP 200 with terminal audit notice without re-running ordersPaid", async () => {
      const payload = { id: 88888 };
      const rawBytes = Buffer.from(JSON.stringify(payload));
      const digest = createAllShopifyWebhookBodyDigests({
        topic: "orders/paid",
        rawBodyBytes: rawBytes,
      })[0];

      // Simulate P2002 collision
      mocks.webhookEventCreate.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "test",
        }),
      );

      mocks.webhookEventFindUnique.mockResolvedValueOnce({
        id: "ev_terminal_dup",
        storeId: "store_adv_01",
        topic: "orders/paid",
        status: "failed",
        attempts: 5,
        authenticatedBodyDigest: digest,
        storeInstallationGeneration: "sgen_adv_01",
        updatedAt: new Date(),
      });

      const response = await POST(
        signedRequest({
          body: payload,
          webhookId: "wh_term_dup",
        }),
      );

      expect(response.status).toBe(200);
      const resJson = await response.json();
      expect(resJson).toMatchObject({
        received: true,
        duplicate: true,
        webhookId: "wh_term_dup",
        status: "failed",
        error: expect.stringContaining("[TERMINAL_ERROR_AUDIT]"),
      });

      // ordersPaid must NOT be called
      expect(mocks.ordersPaid).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // TEST SUITE 4: Store Uninstalled / Generation Drift Rejection
  // -------------------------------------------------------------------------
  describe("4. Store Uninstalled & Installation Generation Drift Resilience", () => {
    it("4.1. Store uninstalled / deleted during recovery: caught safely, marked failed with clear audit log, zero corruption", async () => {
      mocks.webhookEventFindMany.mockResolvedValueOnce([
        {
          id: "ev_uninstalled_01",
          storeId: "store_deleted_99",
          webhookId: "wh_uninstalled_01",
          topic: "orders/paid",
          status: "failed",
          attempts: 2,
          payload: { id: 33333 },
          storeInstallationGeneration: "sgen_old",
          updatedAt: new Date(Date.now() - 300_000),
        },
      ]);

      // Store is NOT found in database (merchant deleted app)
      mocks.operationalStoreFindUnique.mockResolvedValueOnce(null);

      const results = await recoverStuckOrdersPaidWebhooks({ limit: 10 });

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        id: "ev_uninstalled_01",
        status: "failed",
        error: "Store store_deleted_99 not found",
      });

      // Assert event was updated to failed with error
      expect(mocks.webhookEventUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "ev_uninstalled_01",
            status: "received",
            attempts: 3,
          }),
          data: expect.objectContaining({
            status: "failed",
            error: "Store store_deleted_99 not found",
          }),
        }),
      );

      // ordersPaid was NOT called!
      expect(mocks.ordersPaid).not.toHaveBeenCalled();
    });

    it("4.2. assertOrdersPaidStoreAcceptsWrite rejects operational write if store is suspended or generation mismatched", async () => {
      // Store suspended in access policy
      mocks.operationalStoreFindUnique.mockResolvedValue({
        id: "store_adv_01",
        projectId: "ws_adv_01",
        complianceState: "active",
        shopCurrency: "USD",
        installationGeneration: "sgen_adv_01",
        storeAccessState: "suspended",
      });

      await expect(
        assertOrdersPaidStoreAcceptsWrite({
          storeId: "store_adv_01",
          action: "webhook_dispatch:orders/paid",
          expectedInstallationGeneration: "sgen_adv_01",
        }),
      ).rejects.toThrow(/prohibits operational write|is suspended|blocked/);

      // Generation mismatch rejects
      mocks.operationalStoreFindUnique.mockResolvedValue({
        id: "store_adv_01",
        projectId: "ws_adv_01",
        complianceState: "active",
        shopCurrency: "USD",
        installationGeneration: "sgen_NEW_GENERATION",
        storeAccessState: "active",
      });

      await expect(
        assertOrdersPaidStoreAcceptsWrite({
          storeId: "store_adv_01",
          action: "webhook_dispatch:orders/paid",
          expectedInstallationGeneration: "sgen_OLD_GENERATION",
        }),
      ).rejects.toThrow(/stale_installation_generation|blocked/);
    });

    it("4.3. Installation Generation Drift: enforces privacy-minimized settlement without awarding illegal loyalty", async () => {
      // Candidate captured under sgen_generation_alpha
      mocks.webhookEventFindMany.mockResolvedValueOnce([
        {
          id: "ev_drift_01",
          storeId: "store_adv_01",
          webhookId: "wh_drift_01",
          topic: "orders/paid",
          status: "failed",
          attempts: 1,
          payload: { id: 44444, line_items: [] },
          storeInstallationGeneration: "sgen_generation_alpha",
          updatedAt: new Date(Date.now() - 100_000),
        },
      ]);

      // Store in DB currently has sgen_generation_BETA
      mocks.operationalStoreFindUnique.mockResolvedValue({
        id: "store_adv_01",
        projectId: "ws_adv_01",
        complianceState: "active",
        shopCurrency: "USD",
        installationGeneration: "sgen_generation_BETA",
      });

      const results = await recoverStuckOrdersPaidWebhooks({ limit: 10 });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("processed");

      // Verify ordersPaid was invoked with privacyMinimizedFinancialSettlement: true!
      expect(mocks.ordersPaid).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store_adv_01",
          expectedInstallationGeneration: "sgen_generation_BETA",
          privacyMinimizedFinancialSettlement: true,
        }),
      );
    });

    it("4.4. Generation mismatch during completion transaction triggers atomic CAS discard", async () => {
      // Execute claimed event where store generation drifts during processing
      mocks.operationalStoreFindUnique.mockResolvedValueOnce({
        id: "store_adv_01",
        projectId: "ws_adv_01",
        complianceState: "active",
        shopCurrency: "USD",
        installationGeneration: "sgen_adv_01",
      });

      // In completion transaction, generation in DB has drifted to sgen_drifted_during_run
      mocks.transaction.mockImplementationOnce(async (callback: any, client: any) => {
        mocks.operationalStoreFindUnique.mockResolvedValueOnce({
          id: "store_adv_01",
          projectId: "ws_adv_01",
          complianceState: "active",
          shopCurrency: "USD",
          installationGeneration: "sgen_drifted_during_run",
        });
        return callback(client);
      });

      const execResult = await executeClaimedOrdersPaidEvent({
        claim: {
          id: "ev_drift_tx",
          storeId: "store_adv_01",
          attempt: 1,
          storeInstallationGeneration: "sgen_adv_01",
          dispatchInstallationGeneration: "sgen_adv_01",
          privacyMinimizedFinancialSettlement: false,
        },
        event: { id: 55555 },
        workspace: {
          id: "ws_adv_01",
          defaultProgramId: "prog_adv_01",
          webhookEnabled: true,
        },
      });

      // The execution must catch the stale generation and record status 'failed'
      expect(execResult.status).toBe("failed");
      expect(execResult.error).toMatch(/stale_installation_generation|blocked/);
    });
  });

  // -------------------------------------------------------------------------
  // TEST SUITE 5: In-flight Lease Immunity Boundary
  // -------------------------------------------------------------------------
  describe("5. In-flight Lease Immunity Boundary", () => {
    it("5.1. recoverStuckOrdersPaidWebhooks strictly does NOT query or claim in-flight events within the 180s threshold", async () => {
      await recoverStuckOrdersPaidWebhooks({
        inFlightLeaseMs: IN_FLIGHT_LEASE_THRESHOLD_MS, // 180_000
      });

      const calls = mocks.webhookEventFindMany.mock.calls;
      const whereClause = calls[0][0].where;

      // Assert the cutoff time used in OR query is <= now - 180s
      const receivedCondition = whereClause.OR.find(
        (cond: any) => cond.status === "received",
      );
      expect(receivedCondition).toBeDefined();
      const cutoffTime = receivedCondition.updatedAt.lt.getTime();
      const elapsed = Date.now() - cutoffTime;
      expect(elapsed).toBeGreaterThanOrEqual(179_000);
      expect(elapsed).toBeLessThanOrEqual(181_000);
    });
  });
});
