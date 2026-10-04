import { Prisma } from "@prisma/client";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Stateful in-memory database simulation to test true concurrency, row collision, and CAS leases
interface StoredWebhookEvent {
  id: string;
  storeId: string;
  webhookId: string;
  topic: string;
  status: "received" | "processed" | "failed";
  attempts: number;
  payload: any;
  authenticatedBodyDigest: string | null;
  storeInstallationGeneration: string | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  processedAt: Date | null;
}

class InMemoryWebhookDB {
  private eventsByWebhookId = new Map<string, StoredWebhookEvent>();
  private eventsById = new Map<string, StoredWebhookEvent>();

  clear() {
    this.eventsByWebhookId.clear();
    this.eventsById.clear();
  }

  async insert(data: {
    id: string;
    storeId: string;
    webhookId: string;
    topic: string;
    authenticatedBodyDigest?: string | null;
    storeInstallationGeneration?: string | null;
    payload?: any;
    attempts?: number;
  }): Promise<StoredWebhookEvent> {
    if (this.eventsByWebhookId.has(data.webhookId)) {
      throw new Prisma.PrismaClientKnownRequestError(
        `Unique constraint failed on the fields: (webhookId)`,
        { code: "P2002", clientVersion: "test" },
      );
    }
    const record: StoredWebhookEvent = {
      id: data.id,
      storeId: data.storeId,
      webhookId: data.webhookId,
      topic: data.topic,
      status: "received",
      attempts: data.attempts ?? 1,
      payload: data.payload ?? null,
      authenticatedBodyDigest: data.authenticatedBodyDigest ?? null,
      storeInstallationGeneration: data.storeInstallationGeneration ?? null,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      processedAt: null,
    };
    this.eventsByWebhookId.set(data.webhookId, record);
    this.eventsById.set(data.id, record);
    return { ...record };
  }

  async findUnique(where: { webhookId?: string; id?: string }): Promise<StoredWebhookEvent | null> {
    if (where.webhookId) {
      const rec = this.eventsByWebhookId.get(where.webhookId);
      return rec ? { ...rec } : null;
    }
    if (where.id) {
      const rec = this.eventsById.get(where.id);
      return rec ? { ...rec } : null;
    }
    return null;
  }

  async findMany(where: any): Promise<StoredWebhookEvent[]> {
    const all = Array.from(this.eventsById.values());
    return all
      .filter((rec) => {
        if (where.topic && rec.topic !== where.topic) return false;
        if (where.storeId?.in && !where.storeId.in.includes(rec.storeId)) return false;
        if (where.attempts?.lt && rec.attempts >= where.attempts.lt) return false;
        if (where.attempts?.gte && rec.attempts < where.attempts.gte) return false;

        if (where.OR) {
          const matchOr = where.OR.some((orClause: any) => {
            if (orClause.status && rec.status !== orClause.status) return false;
            if (orClause.updatedAt?.lt) {
              if (rec.updatedAt.getTime() >= orClause.updatedAt.lt.getTime()) return false;
            }
            return true;
          });
          if (!matchOr) return false;
        }

        return true;
      })
      .map((r) => ({ ...r }));
  }

  async updateMany(params: { where: any; data: any }): Promise<{ count: number }> {
    let count = 0;
    const { where, data } = params;

    for (const rec of this.eventsById.values()) {
      if (where.id && rec.id !== where.id) continue;
      if (where.storeId && rec.storeId !== where.storeId) continue;
      if (where.topic && rec.topic !== where.topic) continue;
      if (where.status && rec.status !== where.status) continue;
      if (where.attempts !== undefined && rec.attempts !== where.attempts) continue;
      if (
        where.storeInstallationGeneration !== undefined &&
        rec.storeInstallationGeneration !== where.storeInstallationGeneration
      ) {
        continue;
      }
      if (where.updatedAt?.lt && rec.updatedAt.getTime() >= where.updatedAt.lt.getTime()) {
        continue;
      }

      // Apply update
      if (data.status) rec.status = data.status;
      if (data.processedAt) rec.processedAt = data.processedAt;
      if (data.error !== undefined) rec.error = data.error;
      if (data.attempts?.increment) rec.attempts += data.attempts.increment;
      if (data.payload !== undefined) rec.payload = data.payload;
      rec.updatedAt = data.updatedAt ?? new Date();
      count++;
    }

    return { count };
  }

  // Forcefully set updatedAt for time travel testing
  setTimeTravel(webhookId: string, ageMs: number, status?: "received" | "failed" | "processed", attempts?: number) {
    const rec = this.eventsByWebhookId.get(webhookId);
    if (rec) {
      rec.updatedAt = new Date(Date.now() - ageMs);
      rec.createdAt = new Date(Date.now() - ageMs);
      if (status) rec.status = status;
      if (attempts !== undefined) rec.attempts = attempts;
    }
  }
}

const db = new InMemoryWebhookDB();

const mocks = vi.hoisted(() => ({
  localDev: true,
  resolveComplianceStore: vi.fn(),
  resolveOperationalStore: vi.fn(),
  operationalStoreFindUnique: vi.fn(),
  operationalStoreFindMany: vi.fn(),
  loyaltyProgramFindUnique: vi.fn(),
  projectFindUnique: vi.fn(),
  redisSet: vi.fn(),
  redisEval: vi.fn(),
  publishJSON: vi.fn(),
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
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
    weleticShopifyStore: {
      findUnique: mocks.operationalStoreFindUnique,
      findMany: mocks.operationalStoreFindMany,
    },
    weleticLoyaltyProgram: {
      findUnique: mocks.loyaltyProgramFindUnique,
    },
    weleticShopifyWebhookEvent: {
      create: (args: any) => db.insert(args.data),
      findUnique: (args: any) => db.findUnique(args.where),
      findMany: (args: any) => db.findMany(args.where),
      updateMany: (args: any) => db.updateMany(args),
    },
    $transaction: async (callback: any) => {
      const tx = {
        weleticShopifyStore: {
          findUnique: mocks.operationalStoreFindUnique,
        },
        weleticShopifyWebhookEvent: {
          create: (args: any) => db.insert(args.data),
          findUnique: (args: any) => db.findUnique(args.where),
          findMany: (args: any) => db.findMany(args.where),
          updateMany: (args: any) => db.updateMany(args),
        },
      };
      return callback(tx);
    },
  },
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
  getFailedRetryBackoffMs,
  IN_FLIGHT_LEASE_THRESHOLD_MS,
} from "../../lib/weletic/shopify/orders-paid-recovery";
import { GET as cronGET } from "../../app/(ee)/api/cron/weletic/shopify/orders-paid-recovery/route";
import { createAllShopifyWebhookBodyDigests } from "../../lib/weletic/shopify/privacy-identity";

const secret = "challenger-orders-paid-secret-key-32chars";

function buildSignedWebhookRequest({
  body,
  shop = "yamax-activewear.myshopify.com",
  topic = "orders/paid",
  webhookId,
}: {
  body: Record<string, unknown>;
  shop?: string;
  topic?: string;
  webhookId: string;
}) {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");

  return new Request("https://weletic.test/api/shopify/integration/webhook", {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": shop,
      "x-shopify-webhook-id": webhookId,
      "x-shopify-hmac-sha256": signature,
    },
  });
}

describe("Empirical Challenger M5: Concurrency, Idempotency & In-flight Lease Immunity", () => {
  let backgroundTasks: Promise<any>[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    db.clear();
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
      storeId: "store_yamax_01",
      workspaceId: "ws_yamax_01",
      programId: "prog_yamax_01",
      myshopifyDomain: "yamax-activewear.myshopify.com",
      accessToken: "shpat_mock_token_yamax",
    });
    mocks.operationalStoreFindUnique.mockResolvedValue({
      id: "store_yamax_01",
      projectId: "ws_yamax_01",
      complianceState: "active",
      shopCurrency: "USD",
      installationGeneration: "sgen_yamax_01",
    });
    mocks.operationalStoreFindMany.mockResolvedValue([
      { id: "store_yamax_01" },
    ]);
    mocks.projectFindUnique.mockResolvedValue({
      id: "ws_yamax_01",
      defaultProgramId: "prog_yamax_01",
      webhookEnabled: true,
    });
    mocks.loyaltyProgramFindUnique.mockResolvedValue(null);
    mocks.ordersPaid.mockResolvedValue("ordersPaid settled successfully");
    mocks.log.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("CHALLENGE 1: Concurrent Webhook Burst (N=5 simultaneous requests with identical webhookId) guarantees exactly 1 execution and < 100ms response time", async () => {
    const ordersPaidExecutionLog: Array<{ timestamp: number; payloadId: number }> = [];

    // Simulate heavy downstream processing (120ms settlement time)
    mocks.ordersPaid.mockImplementation(async (args: any) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      ordersPaidExecutionLog.push({
        timestamp: Date.now(),
        payloadId: args.event.id,
      });
      return "[Shopify] Order event processed successfully";
    });

    const orderPayload = {
      id: 888001,
      name: "#YAMAX-888001",
      total_price: "249.00",
      customer: { id: 77701, email: "vip@yamax.test" },
      line_items: [
        { id: 991, title: "Yamax Agile High Support Leggings", price: "129.00" },
        { id: 992, title: "Yamax Flow Cropped Tank Top", price: "120.00" },
      ],
      discount_codes: [{ code: "YAMAXVIP", amount: "24.90" }],
    };

    const webhookId = "wh_concurrent_burst_001";

    // Create 5 identical webhook requests
    const concurrentRequests = Array.from({ length: 5 }, () =>
      buildSignedWebhookRequest({
        body: orderPayload,
        webhookId,
      }),
    );

    const burstStartTime = performance.now();

    // Fire all 5 requests simultaneously in parallel
    const responses = await Promise.all(
      concurrentRequests.map(async (req, index) => {
        const start = performance.now();
        const res = await POST(req);
        const duration = performance.now() - start;
        return { index, res, duration };
      }),
    );

    const burstTotalDuration = performance.now() - burstStartTime;

    // EMPIRICAL ASSERTION 1: ALL requests must receive HTTP 200 within < 100ms
    for (const { index, res, duration } of responses) {
      expect(res.status).toBe(200);
      expect(
        duration,
        `Request #${index} took ${duration}ms, exceeding 100ms fast-ingress budget`,
      ).toBeLessThan(100);
    }
    expect(burstTotalDuration).toBeLessThan(150);

    // EMPIRICAL ASSERTION 2: Exactly ONE request claimed the queue; 4 requests were deduplicated
    const responseBodies = await Promise.all(
      responses.map(({ res }) => res.json()),
    );

    const queuedResponses = responseBodies.filter((b) => b.queued === true);
    const duplicateResponses = responseBodies.filter((b) => b.duplicate === true);

    expect(queuedResponses).toHaveLength(1);
    expect(duplicateResponses).toHaveLength(4);

    expect(queuedResponses[0]).toEqual({
      received: true,
      queued: true,
      webhookId,
    });

    for (const dup of duplicateResponses) {
      expect(dup).toEqual({
        received: true,
        duplicate: true,
        webhookId,
        status: "received",
      });
    }

    // At this moment, ordersPaid is STILL executing asynchronously in background waitUntil!
    // No commission should be double-calculated.
    expect(backgroundTasks.length).toBeGreaterThanOrEqual(1);

    // EMPIRICAL ASSERTION 3: Wait for all background tasks to complete
    await Promise.all(backgroundTasks);

    // CRITICAL INVARIANT: Exactly ONE invocation of ordersPaid occurred
    expect(mocks.ordersPaid).toHaveBeenCalledTimes(1);
    expect(ordersPaidExecutionLog).toHaveLength(1);
    expect(ordersPaidExecutionLog[0].payloadId).toBe(888001);

    // In-memory DB state check: Event status is now 'processed' with attempts = 1
    const storedEvent = await db.findUnique({ webhookId });
    expect(storedEvent).not.toBeNull();
    expect(storedEvent!.status).toBe("processed");
    expect(storedEvent!.attempts).toBe(1);
    expect(storedEvent!.payload).toEqual(orderPayload);
    expect(storedEvent!.processedAt).not.toBeNull();
  });

  it("CHALLENGE 2: Subsequent Duplicate Webhook Delivery after background completion immediately acknowledges HTTP 200 without re-invoking ordersPaid", async () => {
    const orderPayload = {
      id: 888002,
      name: "#YAMAX-888002",
      total_price: "150.00",
      customer: { id: 77702 },
    };
    const webhookId = "wh_completed_duplicate_002";

    // Initial delivery
    const initialReq = buildSignedWebhookRequest({
      body: orderPayload,
      webhookId,
    });
    const initialRes = await POST(initialReq);
    expect(initialRes.status).toBe(200);

    // Complete background execution
    await Promise.all(backgroundTasks);
    expect(mocks.ordersPaid).toHaveBeenCalledTimes(1);

    const storedBefore = await db.findUnique({ webhookId });
    expect(storedBefore!.status).toBe("processed");

    // Later delivery arrives (e.g. Shopify retry or network re-send 2 minutes later)
    const retryReq = buildSignedWebhookRequest({
      body: orderPayload,
      webhookId,
    });
    const retryStart = performance.now();
    const retryRes = await POST(retryReq);
    const retryLatency = performance.now() - retryStart;

    expect(retryRes.status).toBe(200);
    expect(retryLatency).toBeLessThan(50);

    const retryBody = await retryRes.json();
    expect(retryBody).toEqual({
      received: true,
      duplicate: true,
      webhookId,
      status: "processed",
    });

    // Verify ordersPaid was NOT called again
    expect(mocks.ordersPaid).toHaveBeenCalledTimes(1);
  });

  it("CHALLENGE 3: In-flight Lease Immunity — Race condition between background waitUntil (< 180s) and Cron Recovery Sweep guarantees cron NEVER claims the in-flight event", async () => {
    const orderPayload = {
      id: 888003,
      name: "#YAMAX-888003",
      total_price: "320.00",
      customer: { id: 77703 },
    };
    const webhookId = "wh_inflight_race_003";

    // 1. Ingress receives webhook and persists event in DB with status: 'received'
    const ingressReq = buildSignedWebhookRequest({
      body: orderPayload,
      webhookId,
    });

    let completeBackgroundOrdersPaid!: () => void;
    const backgroundGate = new Promise<void>((resolve) => {
      completeBackgroundOrdersPaid = resolve;
    });

    // Make ordersPaid block until we test the cron race
    mocks.ordersPaid.mockImplementationOnce(async () => {
      await backgroundGate;
      return "background ordersPaid complete";
    });

    const ingressRes = await POST(ingressReq);
    expect(ingressRes.status).toBe(200);

    // Verify event is in DB with status 'received' and attempts = 1
    const eventInFlight = await db.findUnique({ webhookId });
    expect(eventInFlight).not.toBeNull();
    expect(eventInFlight!.status).toBe("received");
    expect(eventInFlight!.attempts).toBe(1);

    // 2. Simulate 45 seconds elapsed (well within the 180s lease threshold)
    db.setTimeTravel(webhookId, 45_000, "received", 1);

    // 3. Cron recovery runs right now while the event is in-flight!
    const cronResults = await recoverStuckOrdersPaidWebhooks({
      limit: 10,
      inFlightLeaseMs: IN_FLIGHT_LEASE_THRESHOLD_MS, // 180,000 ms
    });

    // CRITICAL EMPIRICAL PROOF:
    // Cron recovery strictly returns EMPTY results. The in-flight event was NOT claimed!
    expect(cronResults).toHaveLength(0);

    // Event in DB must remain untouched: attempts = 1, status = 'received'
    const eventAfterCron = await db.findUnique({ webhookId });
    expect(eventAfterCron!.attempts).toBe(1);
    expect(eventAfterCron!.status).toBe("received");

    // 4. Now background task finishes
    completeBackgroundOrdersPaid();
    await Promise.all(backgroundTasks);

    // Verify background task finished cleanly and committed status 'processed'
    const eventFinal = await db.findUnique({ webhookId });
    expect(eventFinal!.status).toBe("processed");
    expect(eventFinal!.attempts).toBe(1);

    // Total ordersPaid execution across ingress and cron is strictly 1
    expect(mocks.ordersPaid).toHaveBeenCalledTimes(1);
  });

  it("CHALLENGE 4: Expired Lease Reclamation & Stale Completion Fence — When background execution exceeds 180s, cron reclaims via CAS, and late zombie background completion is safely rejected with conflict", async () => {
    const orderPayload = {
      id: 888004,
      name: "#YAMAX-888004",
      total_price: "450.00",
      customer: { id: 77704 },
    };
    const webhookId = "wh_lease_expired_004";

    // Insert an orphaned event that was received 240 seconds ago (> 180s lease threshold)
    await db.insert({
      id: "ev_expired_004",
      storeId: "store_yamax_01",
      webhookId,
      topic: "orders/paid",
      attempts: 1,
      payload: orderPayload,
      storeInstallationGeneration: "sgen_yamax_01",
    });
    db.setTimeTravel(webhookId, 240_000, "received", 1);

    // 1. Cron sweeps and finds the event because its lease (240s) > 180s threshold
    mocks.ordersPaid.mockResolvedValueOnce("cron recovery completed");

    const cronResults = await recoverStuckOrdersPaidWebhooks({
      limit: 10,
      inFlightLeaseMs: IN_FLIGHT_LEASE_THRESHOLD_MS,
    });

    expect(cronResults).toHaveLength(1);
    expect(cronResults[0]).toEqual({
      id: "ev_expired_004",
      webhookId,
      status: "processed",
    });

    // Event in DB now has attempts = 2 and status = 'processed'
    const eventAfterCron = await db.findUnique({ webhookId });
    expect(eventAfterCron!.attempts).toBe(2);
    expect(eventAfterCron!.status).toBe("processed");

    // 2. NOW simulate the original zombie background worker waking up with attempt = 1
    // and calling executeClaimedOrdersPaidEvent
    const zombieExecutionResult = await executeClaimedOrdersPaidEvent({
      claim: {
        id: "ev_expired_004",
        storeId: "store_yamax_01",
        attempt: 1, // Stale attempt!
        storeInstallationGeneration: "sgen_yamax_01",
        dispatchInstallationGeneration: "sgen_yamax_01",
        privacyMinimizedFinancialSettlement: false,
      },
      event: orderPayload,
      workspace: {
        id: "ws_yamax_01",
        defaultProgramId: "prog_yamax_01",
        webhookEnabled: true,
      },
    });

    // CRITICAL EMPIRICAL PROOF:
    // Stale completion is recognized as a conflict and cleanly discarded
    expect(zombieExecutionResult.status).toBe("conflict");
    expect(zombieExecutionResult.error).toContain(
      "Webhook lease was reclaimed; stale completion was discarded",
    );

    // DB state was NOT corrupted by the zombie worker
    const eventAfterZombie = await db.findUnique({ webhookId });
    expect(eventAfterZombie!.attempts).toBe(2);
    expect(eventAfterZombie!.status).toBe("processed");
  });

  it("CHALLENGE 5: Poison Pill Exhaustion & Zero Commission Loss — After 5 consecutive failures, event is terminally audited without data loss, and cron does not loop infinitely", async () => {
    const malformedPayload = {
      id: 888005,
      name: "#YAMAX-POISON",
      total_price: "9999.00",
    };
    const webhookId = "wh_poison_pill_005";

    const rawBytes = Buffer.from(JSON.stringify(malformedPayload));
    const digest = createAllShopifyWebhookBodyDigests({
      topic: "orders/paid",
      rawBodyBytes: rawBytes,
    })[0];

    // Event already failed 4 times, age 600s
    await db.insert({
      id: "ev_poison_005",
      storeId: "store_yamax_01",
      webhookId,
      topic: "orders/paid",
      attempts: 4,
      payload: malformedPayload,
      authenticatedBodyDigest: digest,
      storeInstallationGeneration: "sgen_yamax_01",
    });
    db.setTimeTravel(webhookId, 600_000, "failed", 4);

    mocks.ordersPaid.mockRejectedValueOnce(
      new Error("Fatal merchant discount calculation overflow"),
    );

    // Cron runs 5th attempt
    const cronResults = await recoverStuckOrdersPaidWebhooks({
      limit: 10,
      maxAttempts: 5,
    });

    expect(cronResults).toHaveLength(1);
    expect(cronResults[0]).toMatchObject({
      id: "ev_poison_005",
      webhookId,
      status: "failed",
      isTerminal: true,
      error: expect.stringContaining("[TERMINAL_ERROR_AUDIT]"),
    });

    // Verify DB state: attempts = 5, status = 'failed', payload preserved 100%
    const terminalRecord = await db.findUnique({ webhookId });
    expect(terminalRecord!.attempts).toBe(5);
    expect(terminalRecord!.status).toBe("failed");
    expect(terminalRecord!.payload).toEqual(malformedPayload);
    expect(terminalRecord!.error).toContain("[TERMINAL_ERROR_AUDIT]");

    // Verify audit helper finds it
    const auditRecords = await auditTerminalFailedOrdersPaidWebhooks({
      storeId: "store_yamax_01",
    });
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].webhookId).toBe(webhookId);
    expect(auditRecords[0].payload).toEqual(malformedPayload);

    // NEXT CRON RUN: Must strictly ignore this event (no infinite retry loop)
    const nextCronResults = await recoverStuckOrdersPaidWebhooks({
      limit: 10,
      maxAttempts: 5,
    });
    expect(nextCronResults).toHaveLength(0);

    // INGRESS DEDUPLICATION: If Shopify sends duplicate of this poison pill,
    // ingress returns HTTP 200 with terminal audit notice without executing ordersPaid
    const dupPoisonReq = buildSignedWebhookRequest({
      body: malformedPayload,
      webhookId,
    });
    const dupRes = await POST(dupPoisonReq);
    expect(dupRes.status).toBe(200);
    const dupJson = await dupRes.json();
    expect(dupJson).toMatchObject({
      duplicate: true,
      error: expect.stringContaining("[TERMINAL_ERROR_AUDIT]"),
    });
  });

  it("CHALLENGE 6: Exponential Backoff Precision — Cron strictly respects retry backoff per attempt tier", async () => {
    // Backoff validation:
    // Attempt 1: 60s
    // Attempt 2: 120s
    // Attempt 3: 240s
    // Attempt 4: 480s
    expect(getFailedRetryBackoffMs(1)).toBe(60_000);
    expect(getFailedRetryBackoffMs(2)).toBe(120_000);
    expect(getFailedRetryBackoffMs(3)).toBe(240_000);
    expect(getFailedRetryBackoffMs(4)).toBe(480_000);

    // Event 1: Failed on attempt 2, 80s ago (< 120s backoff) -> NOT eligible
    await db.insert({
      id: "ev_backoff_immature",
      storeId: "store_yamax_01",
      webhookId: "wh_backoff_immature",
      topic: "orders/paid",
      attempts: 2,
      payload: { id: 101 },
    });
    db.setTimeTravel("wh_backoff_immature", 80_000, "failed", 2);

    // Event 2: Failed on attempt 2, 150s ago (> 120s backoff) -> ELIGIBLE
    await db.insert({
      id: "ev_backoff_mature",
      storeId: "store_yamax_01",
      webhookId: "wh_backoff_mature",
      topic: "orders/paid",
      attempts: 2,
      payload: { id: 102 },
    });
    db.setTimeTravel("wh_backoff_mature", 150_000, "failed", 2);

    const cronResults = await recoverStuckOrdersPaidWebhooks({ limit: 10 });

    expect(cronResults).toHaveLength(1);
    expect(cronResults[0].webhookId).toBe("wh_backoff_mature");

    // Immature event remains untouched on attempt 2
    const immatureEvent = await db.findUnique({ webhookId: "wh_backoff_immature" });
    expect(immatureEvent!.attempts).toBe(2);
    expect(immatureEvent!.status).toBe("failed");
  });

  it("CHALLENGE 7: Multi-Tenant Zero-Hardcoding — Recovery cron queries dynamic store IDs without hardcoded domains", async () => {
    mocks.operationalStoreFindMany.mockResolvedValueOnce([
      { id: "store_tenant_a" },
      { id: "store_tenant_b" },
    ]);

    await db.insert({
      id: "ev_tenant_a",
      storeId: "store_tenant_a",
      webhookId: "wh_tenant_a",
      topic: "orders/paid",
      attempts: 1,
      payload: { id: 201 },
    });
    db.setTimeTravel("wh_tenant_a", 200_000, "received", 1);

    const cronResults = await recoverStuckOrdersPaidWebhooks({
      workspaceId: "ws_dynamic_tenant",
    });

    expect(mocks.operationalStoreFindMany).toHaveBeenCalledWith({
      where: { projectId: "ws_dynamic_tenant" },
      select: { id: true },
    });

    expect(cronResults).toHaveLength(1);
    expect(cronResults[0].webhookId).toBe("wh_tenant_a");
  });
});
