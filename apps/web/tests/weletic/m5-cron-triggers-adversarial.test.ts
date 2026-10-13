import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  addCustomHostnameToCloudflare,
  CloudflareSaaSError,
  deleteCustomHostnameFromCloudflare,
  extractSslValidationRecords,
  getCustomHostnameFromCloudflare,
  verifyCustomHostname,
} from "../../lib/api/domains/cloudflare-saas";
import { prisma } from "../../lib/prisma";
import * as outboxModule from "../../lib/weletic/loyalty/outbox";
import * as pointsExpirySchedulerModule from "../../lib/weletic/loyalty/points-expiry-scheduler";
import * as rewardExpirySchedulerModule from "../../lib/weletic/loyalty/reward-expiry-scheduler";
import * as storeCreditReconciliationModule from "../../lib/weletic/loyalty/store-credit-reconciliation";
import * as catalogSyncModule from "../../lib/weletic/shopify/catalog-sync";
import * as ordersPaidRecoveryModule from "../../lib/weletic/shopify/orders-paid-recovery";
import * as sessionRenewalModule from "../../lib/weletic/shopify/session-renewal";
import * as storeResolverModule from "../../lib/weletic/shopify/store-resolver";
import {
  CRON_SCHEDULE_5_MIN,
  CRON_SCHEDULE_HOURLY,
  executeIsolatedJob,
  handleHttpTrigger,
  scheduledHandler,
  syncMultiTenantCatalogJob,
  type CronWorkerEnv,
} from "../../workers/cron-triggers/src/index";

describe("Milestone 5 Adversarial Stress Testing & Error Cascading Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLOUDFLARE_ZONE_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;

    const mockStoreDelegate = {
      findMany: vi.fn().mockResolvedValue([]),
    };
    const mockAccountDelegate = {
      findMany: vi.fn().mockResolvedValue([]),
    };

    Object.defineProperty(prisma, "weleticShopifyStore", {
      value: mockStoreDelegate,
      writable: true,
      configurable: true,
    });

    Object.defineProperty(prisma, "weleticLoyaltyAccount", {
      value: mockAccountDelegate,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // =========================================================================
  // 1. Cron Scheduled Execution & Error Cascading Stress Tests
  // =========================================================================
  describe("1. Error Cascading & Job Isolation Stress Tests", () => {
    it("isolates Store Credit Sweep failure: remaining jobs in 5-min cycle execute successfully", async () => {
      vi.spyOn(
        storeCreditReconciliationModule,
        "reconcilePendingStoreCreditRedemptionsSweep",
      ).mockRejectedValue(
        new Error("Shopify GraphQL Timeout (ETIMEDOUT: 504 Gateway Timeout)"),
      );

      const outboxSpy = vi
        .spyOn(outboxModule, "processOutboxJobsBatch")
        .mockResolvedValue({ processed: 14 } as any);

      const webhookRecoverySpy = vi
        .spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks")
        .mockResolvedValue([
          { id: "wh_recov_1", webhookId: "wh_1", status: "completed" },
        ]);

      const report = await scheduledHandler(
        { cron: CRON_SCHEDULE_5_MIN, scheduledTime: Date.now() },
        {},
      );

      expect(outboxSpy).toHaveBeenCalled();
      expect(webhookRecoverySpy).toHaveBeenCalled();
      expect(report.cron).toBe(CRON_SCHEDULE_5_MIN);
      expect(report.jobs).toHaveLength(3);
      expect(report.successCount).toBe(2);
      expect(report.errorCount).toBe(1);

      const failedJob = report.jobs.find(
        (j) => j.name === "store-credit-reconciliation",
      );
      expect(failedJob?.status).toBe("error");
      expect(failedJob?.error).toContain("Shopify GraphQL Timeout");

      const okJob1 = report.jobs.find((j) => j.name === "loyalty-outbox");
      expect(okJob1?.status).toBe("success");

      const okJob2 = report.jobs.find(
        (j) => j.name === "stalled-webhooks-recovery",
      );
      expect(okJob2?.status).toBe("success");
    });

    it("isolates Outbox Flush failure: credit sweep and webhook recovery succeed", async () => {
      vi.spyOn(
        storeCreditReconciliationModule,
        "reconcilePendingStoreCreditRedemptionsSweep",
      ).mockResolvedValue({
        scanned: 5,
        confirmed: 5,
        refunded: 0,
        deferred: 0,
        errors: 0,
        details: [],
      });

      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockRejectedValue(
        new Error("D1 locked: SQLITE_BUSY: database is locked"),
      );

      vi.spyOn(
        ordersPaidRecoveryModule,
        "recoverStuckOrdersPaidWebhooks",
      ).mockResolvedValue([]);

      const report = await scheduledHandler(
        { cron: CRON_SCHEDULE_5_MIN, scheduledTime: Date.now() },
        {},
      );

      expect(report.successCount).toBe(2);
      expect(report.errorCount).toBe(1);

      const failedJob = report.jobs.find((j) => j.name === "loyalty-outbox");
      expect(failedJob?.status).toBe("error");
      expect(failedJob?.error).toContain("SQLITE_BUSY");
    });

    it("survives total sub-task crash (3 out of 3 fail) without crashing the Worker isolate", async () => {
      vi.spyOn(
        storeCreditReconciliationModule,
        "reconcilePendingStoreCreditRedemptionsSweep",
      ).mockRejectedValue(new Error("Downstream service unreachable"));

      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockRejectedValue(
        new Error("Worker out of memory"),
      );

      vi.spyOn(
        ordersPaidRecoveryModule,
        "recoverStuckOrdersPaidWebhooks",
      ).mockRejectedValue(new Error("Corrupted webhook buffer"));

      const report = await scheduledHandler(
        { cron: CRON_SCHEDULE_5_MIN, scheduledTime: Date.now() },
        {},
      );

      expect(report.successCount).toBe(0);
      expect(report.errorCount).toBe(3);
      expect(report.jobs).toHaveLength(3);
      expect(report.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(report.jobs.every((j) => j.status === "error")).toBe(true);
    });

    it("isolates session renewal crash in hourly cycle: points expiration still executes", async () => {
      const pointsSpy = vi
        .spyOn(pointsExpirySchedulerModule, "enqueuePointsExpiryLifecycleJobs")
        .mockResolvedValue({
          programsScanned: 2,
          programsSkipped: 0,
          accountsReconciled: 4,
          accountsScheduled: 1,
          jobsEnqueued: 1,
        });
      vi.spyOn(
        rewardExpirySchedulerModule,
        "enqueueRewardExpiryReminderJobs",
      ).mockResolvedValue({
        programsScanned: 1,
        rewardsScanned: 1,
        jobsEnqueued: 0,
        alreadyQueued: 0,
        ineligible: 0,
        programFailures: [],
      });

      vi.spyOn(
        sessionRenewalModule,
        "listDueShopifySessionRenewals",
      ).mockRejectedValue(
        new Error("Shopify Admin App uninstalled or invalid client secret"),
      );

      const report = await scheduledHandler(
        { cron: CRON_SCHEDULE_HOURLY, scheduledTime: Date.now() },
        { SHOPIFY_API_KEY: "active_api_key_test" },
      );

      expect(pointsSpy).toHaveBeenCalled();
      expect(report.successCount).toBe(2);
      expect(report.errorCount).toBe(1);

      const failed = report.jobs.find(
        (j) => j.name === "shopify-session-renewal",
      );
      expect(failed?.status).toBe("error");
      expect(failed?.error).toContain("Shopify Admin App uninstalled");

      const success = report.jobs.find(
        (j) => j.name === "loyalty-points-expiration",
      );
      expect(success?.status).toBe("success");
    });

    it("multi-tenant catalog sync sweep isolates individual tenant failures", async () => {
      const mockStores = [
        {
          id: "store_good_1",
          projectId: "ws_good_1",
          shopDomain: "brand-alpha.myshopify.com",
        },
        {
          id: "store_bad_2",
          projectId: "ws_bad_2",
          shopDomain: "brand-beta.myshopify.com",
        },
        {
          id: "store_good_3",
          projectId: "ws_good_3",
          shopDomain: "brand-gamma.myshopify.com",
        },
      ];

      vi.spyOn(prisma.weleticShopifyStore, "findMany").mockResolvedValue(
        mockStores as any,
      );
      vi.spyOn(
        storeResolverModule,
        "resolveShopifyStoreByDomain",
      ).mockImplementation(async (domain) => {
        const store = mockStores.find((s) => s.shopDomain === domain);
        return store ? (store as any) : null;
      });

      const catalogSyncSpy = vi
        .spyOn(catalogSyncModule, "syncWeleticShopifyCatalog")
        .mockImplementation((async ({ workspaceId }: any) => {
          if (workspaceId === "ws_bad_2") {
            throw new Error(
              "Shopify 429 Too Many Requests: API rate limit exceeded",
            );
          }
          return {
            runId: "mock_run",
            stats: { products: 1, variants: 0, markets: 0, marketPrices: 0 },
          } as any;
        }) as any);

      const result = await syncMultiTenantCatalogJob({});

      expect(result.storesScanned).toBe(3);
      expect(result.syncedWorkspaces).toEqual(["ws_good_1", "ws_good_3"]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].storeId).toBe("store_bad_2");
      expect(result.errors[0].error).toContain("Shopify 429 Too Many Requests");
      expect(catalogSyncSpy).toHaveBeenCalledTimes(3);
    });

    it("Invariant 1: skips store and records error when resolveShopifyStoreByDomain returns null", async () => {
      vi.spyOn(prisma.weleticShopifyStore, "findMany").mockResolvedValue([
        {
          id: "store_orphan",
          projectId: "ws_orphan",
          shopDomain: "unresolvable-store.myshopify.com",
        } as any,
      ]);

      vi.spyOn(
        storeResolverModule,
        "resolveShopifyStoreByDomain",
      ).mockResolvedValue(null);
      const catalogSyncSpy = vi.spyOn(
        catalogSyncModule,
        "syncWeleticShopifyCatalog",
      );

      const result = await syncMultiTenantCatalogJob({});

      expect(catalogSyncSpy).not.toHaveBeenCalled();
      expect(result.syncedWorkspaces).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].error).toContain(
        "Unable to canonically resolve store for domain: unresolvable-store.myshopify.com",
      );
    });

    it("handles unusual thrown types (string, non-error object, synchronous throw)", async () => {
      // 1. Throws string
      const strRes = await executeIsolatedJob("str-throw", async () => {
        throw "Raw database panic string";
      });
      expect(strRes.status).toBe("error");
      expect(strRes.error).toBe("Raw database panic string");

      // 2. Throws plain object
      const objRes = await executeIsolatedJob("obj-throw", async () => {
        throw { code: 502, reason: "Bad Gateway" };
      });
      expect(objRes.status).toBe("error");
      expect(objRes.error).toContain("502");

      // 3. Throws synchronously (non-async throw inside executor)
      const syncRes = await executeIsolatedJob("sync-throw", () => {
        throw new Error("Immediate synchronous crash");
      });
      expect(syncRes.status).toBe("error");
      expect(syncRes.error).toBe("Immediate synchronous crash");
    });
  });

  // =========================================================================
  // 2. Cron Schedule String Parsing & Unknown Schedules Degradation
  // =========================================================================
  describe("2. Cron Schedule Degradation & Sanitization", () => {
    it("handles unhandled cron schedules cleanly without uncaught exceptions", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const unhandledCrons = [
        "*/13 * * * *",
        "* * * * *",
        "0 0 1 1 *",
        "invalid cron syntax",
        "'; DROP TABLE WeleticShopifyStore; --",
      ];

      for (const cronStr of unhandledCrons) {
        const report = await scheduledHandler(
          { cron: cronStr, scheduledTime: Date.now() },
          {},
        );
        expect(report.cron).toBe(cronStr);
        expect(report.jobs).toHaveLength(1);
        expect(report.jobs[0].status).toBe("skipped");
        expect(report.jobs[0].name).toBe("unrecognized-trigger");
        expect(report.successCount).toBe(0);
        expect(report.errorCount).toBe(0);
      }

      expect(warnSpy).toHaveBeenCalledTimes(unhandledCrons.length);
    });

    it("handles whitespace-padded cron schedules by trimming correctly", async () => {
      vi.spyOn(
        storeCreditReconciliationModule,
        "reconcilePendingStoreCreditRedemptionsSweep",
      ).mockResolvedValue({
        scanned: 0,
        confirmed: 0,
        refunded: 0,
        deferred: 0,
        errors: 0,
        details: [],
      });
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({
        processed: 0,
      } as any);
      vi.spyOn(
        ordersPaidRecoveryModule,
        "recoverStuckOrdersPaidWebhooks",
      ).mockResolvedValue([]);

      const report = await scheduledHandler(
        { cron: "   */5 * * * *   ", scheduledTime: Date.now() },
        {},
      );

      expect(report.cron).toBe(CRON_SCHEDULE_5_MIN);
      expect(report.jobs).toHaveLength(3);
      expect(report.successCount).toBe(3);
    });
  });

  // =========================================================================
  // 3. Manual HTTP Trigger Security & Resilience
  // =========================================================================
  describe("3. Manual HTTP Trigger Security & Robustness", () => {
    const SECRET = "wltc_cron_ultra_secure_token_xyz89";
    const securedEnv: CronWorkerEnv = { CRON_SECRET: SECRET };

    it("rejects unauthorized trigger requests with 401 across adversarial auth headers", async () => {
      const adversarialHeaders = [
        undefined, // Missing header
        "", // Empty header
        "Bearer", // Missing token
        "Bearer ", // Empty token with space
        `bearer ${SECRET}`, // Lowercase scheme
        `Basic ${SECRET}`, // Basic auth scheme
        `Token ${SECRET}`, // Token scheme
        `Bearer ${SECRET}_extra`, // Suffix attack
        `Bearer invalid_token`, // Invalid token
        `Bearer ' OR '1'='1' --`, // SQL injection token
        `Bearer  ${SECRET}`, // Double whitespace between scheme and token
      ];

      for (const authHeader of adversarialHeaders) {
        const headers: Record<string, string> = {};
        if (authHeader !== undefined) {
          headers["Authorization"] = authHeader;
        }

        const req = new Request("http://localhost/trigger?cron=5min", {
          headers,
        });
        const res = await handleHttpTrigger(req, securedEnv);

        expect(res.status).toBe(401);
        const body = await res.json();
        expect(body.error).toBe("Unauthorized");
      }
    });

    it("accepts valid bearer authorization on /trigger", async () => {
      vi.spyOn(
        storeCreditReconciliationModule,
        "reconcilePendingStoreCreditRedemptionsSweep",
      ).mockResolvedValue({
        scanned: 0,
        confirmed: 0,
        refunded: 0,
        deferred: 0,
        errors: 0,
        details: [],
      });
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({
        processed: 0,
      } as any);
      vi.spyOn(
        ordersPaidRecoveryModule,
        "recoverStuckOrdersPaidWebhooks",
      ).mockResolvedValue([]);

      const req = new Request("http://localhost/trigger?cron=5min", {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      const res = await handleHttpTrigger(req, securedEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cron).toBe(CRON_SCHEDULE_5_MIN);
      expect(body.successCount).toBe(3);
    });

    it("returns HTTP 207 Multi-Status on /trigger when one or more jobs fail", async () => {
      vi.spyOn(
        storeCreditReconciliationModule,
        "reconcilePendingStoreCreditRedemptionsSweep",
      ).mockRejectedValue(new Error("Simulated credit reconciliation failure"));
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({
        processed: 0,
      } as any);
      vi.spyOn(
        ordersPaidRecoveryModule,
        "recoverStuckOrdersPaidWebhooks",
      ).mockResolvedValue([]);

      const req = new Request("http://localhost/trigger?cron=5min", {
        headers: { Authorization: `Bearer ${SECRET}` },
      });
      const res = await handleHttpTrigger(req, securedEnv);

      expect(res.status).toBe(207);
      const body = await res.json();
      expect(body.errorCount).toBe(1);
      expect(body.successCount).toBe(2);
    });

    it("handles corrupt or non-JSON POST body gracefully and falls back to default 5-min cron", async () => {
      vi.spyOn(
        storeCreditReconciliationModule,
        "reconcilePendingStoreCreditRedemptionsSweep",
      ).mockResolvedValue({
        scanned: 0,
        confirmed: 0,
        refunded: 0,
        deferred: 0,
        errors: 0,
        details: [],
      });
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({
        processed: 0,
      } as any);
      vi.spyOn(
        ordersPaidRecoveryModule,
        "recoverStuckOrdersPaidWebhooks",
      ).mockResolvedValue([]);

      // 1. Malformed JSON string
      const corruptReq = new Request("http://localhost/trigger", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SECRET}`,
        },
        body: "{malformed_json: true,",
      });
      const corruptRes = await handleHttpTrigger(corruptReq, securedEnv);
      expect(corruptRes.status).toBe(200);
      const corruptBody = await corruptRes.json();
      expect(corruptBody.cron).toBe(CRON_SCHEDULE_5_MIN);

      // 2. POST with non-string cron field
      const invalidTypeReq = new Request("http://localhost/trigger", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify({ cron: 12345 }),
      });
      const invalidTypeRes = await handleHttpTrigger(
        invalidTypeReq,
        securedEnv,
      );
      expect(invalidTypeRes.status).toBe(200);
      const invalidTypeBody = await invalidTypeRes.json();
      expect(invalidTypeBody.cron).toBe(CRON_SCHEDULE_5_MIN);
    });

    it("provides health check endpoint on /health and /", async () => {
      for (const path of ["/health", "/"]) {
        const req = new Request(`http://localhost${path}`);
        const res = await handleHttpTrigger(req, {});
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.status).toBe("healthy");
        expect(data.service).toBe("weletic-cron-scheduler");
        expect(Array.isArray(data.supportedCrons)).toBe(true);
      }
    });

    it("returns 404 for arbitrary endpoints", async () => {
      for (const path of ["/admin", "/webhook", "/api/crons", "/trigger/all"]) {
        const req = new Request(`http://localhost${path}`);
        const res = await handleHttpTrigger(req, {});
        expect(res.status).toBe(404);
        const data = await res.json();
        expect(data.error).toBe("Not Found");
      }
    });
  });

  // =========================================================================
  // 4. Cloudflare for SaaS: Adversarial Domain Input Handling
  // =========================================================================
  describe("4. Cloudflare for SaaS: Hostile Domain Inputs", () => {
    it("normalizes uppercase and trimmed domains in dev fallback mode", async () => {
      const hostileInput = "   AFFILIATE.CREATORBRAND.COM   ";
      const result = await addCustomHostnameToCloudflare(hostileInput);

      expect(result.hostname).toBe("affiliate.creatorbrand.com");
      expect(result.id).toContain("affiliate_creatorbrand_com");
    });

    it("rejects empty or whitespace-only domain names", async () => {
      await expect(addCustomHostnameToCloudflare("")).rejects.toThrow(
        "Domain name must not be empty",
      );
      await expect(addCustomHostnameToCloudflare("   ")).rejects.toThrow(
        "Domain name must not be empty",
      );
    });

    it("rejects empty or whitespace-only hostnameOrId in queries and deletions", async () => {
      await expect(getCustomHostnameFromCloudflare("")).rejects.toThrow(
        "hostnameOrId must not be empty",
      );
      await expect(getCustomHostnameFromCloudflare("   ")).rejects.toThrow(
        "hostnameOrId must not be empty",
      );

      await expect(deleteCustomHostnameFromCloudflare("")).rejects.toThrow(
        "hostnameOrId must not be empty",
      );
      await expect(deleteCustomHostnameFromCloudflare("   ")).rejects.toThrow(
        "hostnameOrId must not be empty",
      );
    });

    it("handles punycode / internationalized domain names (IDN)", async () => {
      const punycodeDomain = "xn--mnchen-fitness-gsb.de";
      const result = await addCustomHostnameToCloudflare(punycodeDomain);

      expect(result.hostname).toBe(punycodeDomain);
    });

    it("handles long domain names (up to RFC maximums)", async () => {
      const sub = "a".repeat(60);
      const longDomain = `${sub}.${sub}.example.com`;
      const result = await addCustomHostnameToCloudflare(longDomain);

      expect(result.hostname).toBe(longDomain);
    });
  });

  // =========================================================================
  // 5. SSL Validation Record Parsing Edge Cases & Robustness
  // =========================================================================
  describe("5. SSL Validation Record Parsing Stress Tests", () => {
    it("safely handles custom hostname with missing, null, or empty validation records", () => {
      // 1. Missing validation_records
      const noRecordsHost: any = {
        id: "h_1",
        hostname: "brand.com",
        status: "pending",
        ssl: { status: "pending_validation" },
      };
      expect(extractSslValidationRecords(noRecordsHost)).toEqual([]);

      // 2. Empty validation_records
      const emptyRecordsHost: any = {
        id: "h_2",
        hostname: "brand.com",
        status: "pending",
        ssl: { status: "pending_validation", validation_records: [] },
      };
      expect(extractSslValidationRecords(emptyRecordsHost)).toEqual([]);

      // 3. Null validation_records
      const nullRecordsHost: any = {
        id: "h_3",
        hostname: "brand.com",
        status: "pending",
        ssl: { status: "pending_validation", validation_records: null },
      };
      expect(extractSslValidationRecords(nullRecordsHost)).toEqual([]);
    });

    it("skips incomplete / malformed validation records without throwing", () => {
      const malformedHost: any = {
        id: "h_malformed",
        hostname: "test.com",
        status: "pending",
        ssl: {
          status: "pending_validation",
          validation_records: [
            { txt_name: "valid.name", txt_value: null }, // Missing value
            { txt_name: null, txt_value: "valid.value" }, // Missing name
            { cname: "alias.com", cname_target: null }, // Missing target
            { cname: null, cname_target: "target.com" }, // Missing cname
            { http_url: "http://test.com", http_body: null }, // Missing body
            { http_url: null, http_body: "body" }, // Missing url
            { txt_name: "_valid.txt", txt_value: "valid_val" }, // Fully valid TXT
          ],
        },
      };

      const records = extractSslValidationRecords(malformedHost);
      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({
        type: "TXT",
        name: "_valid.txt",
        value: "valid_val",
        status: undefined,
      });
    });

    it("deduplicates identical records across SSL validation and ownership verification", () => {
      const duplicateHost: any = {
        id: "h_dup",
        hostname: "dup.com",
        status: "pending",
        ssl: {
          status: "pending_validation",
          validation_records: [
            { txt_name: "_cf-token.dup.com", txt_value: "token_123" },
            { txt_name: "_cf-token.dup.com", txt_value: "token_123" }, // Exact duplicate
          ],
        },
        ownership_verification: {
          type: "txt",
          name: "_cf-token.dup.com",
          value: "token_123", // Duplicate with SSL validation
        },
      };

      const records = extractSslValidationRecords(duplicateHost);
      expect(records).toHaveLength(1);
      expect(records[0].name).toBe("_cf-token.dup.com");
      expect(records[0].value).toBe("token_123");
    });

    it("verifyCustomHostname handles not_found status cleanly", async () => {
      process.env.CLOUDFLARE_ZONE_ID = "zone_123";
      process.env.CLOUDFLARE_API_TOKEN = "token_123";

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({
          success: false,
          errors: [{ code: 1001, message: "Custom hostname not found" }],
        }),
      });
      global.fetch = fetchSpy;

      const verification = await verifyCustomHostname(
        "non-existent-domain.com",
      );
      expect(verification.verified).toBe(false);
      expect(verification.status).toBe("not_found");
      expect(verification.sslStatus).toBe("not_found");
      expect(verification.validationRecords).toEqual([]);
    });
  });

  // =========================================================================
  // 6. Cloudflare API Error Handling (4xx, 5xx, Bad Gateways)
  // =========================================================================
  describe("6. Cloudflare API Error Response Handling", () => {
    const ZONE_ID = "zone_cf_test_err";
    const API_TOKEN = "cf_token_err";

    beforeEach(() => {
      process.env.CLOUDFLARE_ZONE_ID = ZONE_ID;
      process.env.CLOUDFLARE_API_TOKEN = API_TOKEN;
    });

    it("throws CloudflareSaaSError with status 401 when API token is invalid", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        json: async () => ({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
      });

      await expect(
        addCustomHostnameToCloudflare("shop.brand.com"),
      ).rejects.toThrow(CloudflareSaaSError);

      try {
        await addCustomHostnameToCloudflare("shop.brand.com");
      } catch (err: any) {
        expect(err.statusCode).toBe(401);
        expect(err.errors).toEqual([
          { code: 10000, message: "Authentication error" },
        ]);
      }
    });

    it("throws CloudflareSaaSError with status 500 when Cloudflare edge is down", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: async () => ({
          success: false,
          errors: [
            {
              code: 9999,
              message: "Internal server error in custom hostnames service",
            },
          ],
        }),
      });

      await expect(
        getCustomHostnameFromCloudflare("shop.brand.com"),
      ).rejects.toThrow(CloudflareSaaSError);
    });

    it("handles 404 in deleteCustomHostnameFromCloudflare by checking existence first for domain names", async () => {
      // When deleting by domain name (contains '.'), it first searches for hostname
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ success: false, errors: [] }),
      });

      const res = await deleteCustomHostnameFromCloudflare(
        "nonexistent.brand.com",
      );
      expect(res.deleted).toBe(false);
      expect(res.id).toBe("nonexistent.brand.com");
    });
  });
});
