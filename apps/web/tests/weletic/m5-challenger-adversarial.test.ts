import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  scheduledHandler,
  handleHttpTrigger,
  executeIsolatedJob,
  reconcileStoreCreditJob,
  processLoyaltyOutboxJob,
  recoverStalledWebhooksJob,
  loyaltyPointsExpirationJob,
  renewShopifySessionsJob,
  syncMultiTenantCatalogJob,
  verifyDoubleEntryLedgerJob,
  CRON_SCHEDULE_5_MIN,
  CRON_SCHEDULE_HOURLY,
  CRON_SCHEDULE_DAILY,
  type CronWorkerEnv,
  type QueueSender,
} from "../../workers/cron-triggers/src/index";
import {
  addCustomHostnameToCloudflare,
  getCustomHostnameFromCloudflare,
  deleteCustomHostnameFromCloudflare,
  verifyCustomHostname,
  extractSslValidationRecords,
  isCloudflareSaaSConfigured,
  getCloudflareSaaSConfig,
  CloudflareSaaSError,
} from "../../lib/api/domains/cloudflare-saas";
import * as storeCreditReconciliationModule from "../../lib/weletic/loyalty/store-credit-reconciliation";
import * as outboxModule from "../../lib/weletic/loyalty/outbox";
import * as ordersPaidRecoveryModule from "../../lib/weletic/shopify/orders-paid-recovery";
import * as pointsExpirySchedulerModule from "../../lib/weletic/loyalty/points-expiry-scheduler";
import * as rewardExpirySchedulerModule from "../../lib/weletic/loyalty/reward-expiry-scheduler";
import * as sessionRenewalModule from "../../lib/weletic/shopify/session-renewal";
import * as catalogSyncModule from "../../lib/weletic/shopify/catalog-sync";
import * as storeResolverModule from "../../lib/weletic/shopify/store-resolver";
import { prisma } from "../../lib/prisma";

describe("Milestone 5 Adversarial Stress & Edge Case Test Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.CLOUDFLARE_ZONE_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Adversarial Test 1: executeIsolatedJob non-standard throws", () => {
    it("handles throw with string", async () => {
      const res = await executeIsolatedJob("string-throw", async () => {
        throw "Raw string failure";
      });
      expect(res.status).toBe("error");
      expect(res.error).toBe("Raw string failure");
    });

    it("handles throw with non-Error object", async () => {
      const res = await executeIsolatedJob("obj-throw", async () => {
        throw { code: 503, reason: "Service Unavailable" };
      });
      expect(res.status).toBe("error");
      expect(res.error).toContain("Service Unavailable");
    });

    it("handles throw with null or undefined", async () => {
      const res = await executeIsolatedJob("null-throw", async () => {
        throw null;
      });
      expect(res.status).toBe("error");
      expect(res.error).toBe("null");
    });
  });

  describe("Adversarial Test 2: HTTP Trigger Malformed & Edge Requests", () => {
    const mockEnv: CronWorkerEnv = { CRON_SECRET: "test-auth-token-123" };
    const authHeaders = { Authorization: "Bearer test-auth-token-123" };

    it("handles POST /trigger with malformed JSON body gracefully", async () => {
      const req = new Request("http://localhost/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: "{ malformed json...",
      });
      vi.spyOn(storeCreditReconciliationModule, "reconcilePendingStoreCreditRedemptionsSweep")
        .mockResolvedValue({ scanned: 0, confirmed: 0, refunded: 0, deferred: 0, errors: 0, details: [] });
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({ processed: 0 } as any);
      vi.spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks").mockResolvedValue([]);

      const res = await handleHttpTrigger(req, mockEnv);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.cron).toBe(CRON_SCHEDULE_5_MIN); // falls back to 5min
    });

    it("handles POST /trigger with partial failure and returns status 207", async () => {
      vi.spyOn(storeCreditReconciliationModule, "reconcilePendingStoreCreditRedemptionsSweep")
        .mockRejectedValue(new Error("Shopify GraphQL Timeout"));
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({ processed: 2 } as any);
      vi.spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks").mockResolvedValue([]);

      const req = new Request("http://localhost/trigger?cron=5min", {
        headers: authHeaders,
      });
      const res = await handleHttpTrigger(req, mockEnv);
      expect(res.status).toBe(207); // Multi-status when errors occur!
      const json = await res.json();
      expect(json.errorCount).toBe(1);
      expect(json.successCount).toBe(2);
    });

    it("handles whitespace in cron parameter", async () => {
      vi.spyOn(storeCreditReconciliationModule, "reconcilePendingStoreCreditRedemptionsSweep")
        .mockResolvedValue({ scanned: 0, confirmed: 0, refunded: 0, deferred: 0, errors: 0, details: [] });
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({ processed: 0 } as any);
      vi.spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks").mockResolvedValue([]);

      const req = new Request(`http://localhost/trigger?cron=${encodeURIComponent("  */5 * * * *  ")}`, {
        headers: authHeaders,
      });
      const res = await handleHttpTrigger(req, mockEnv);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.cron).toBe(CRON_SCHEDULE_5_MIN);
    });
  });

  describe("Adversarial Test 3: Catalog Sync Sweep Multi-Store Isolation", () => {
    it("continues to sync subsequent stores even if first store fails resolution or sync", async () => {
      const mockStores = [
        { id: "store_fail_res", projectId: "ws_fail_res", shopDomain: "unresolvable.myshopify.com" },
        { id: "store_fail_sync", projectId: "ws_fail_sync", shopDomain: "syncerror.myshopify.com" },
        { id: "store_ok", projectId: "ws_ok", shopDomain: "healthy.myshopify.com" },
      ];

      const mockPrisma = {
        weleticShopifyStore: {
          findMany: vi.fn().mockResolvedValue(mockStores),
        },
      };

      vi.spyOn(storeResolverModule, "resolveShopifyStoreByDomain").mockImplementation(async (domain) => {
        if (domain === "unresolvable.myshopify.com") return null;
        return { shopDomain: domain } as any;
      });

      vi.spyOn(catalogSyncModule, "syncWeleticShopifyCatalog").mockImplementation(async ({ workspaceId }) => {
        if (workspaceId === "ws_fail_sync") {
          throw new Error("Fatal Shopify rate limit hit");
        }
        return { created: 5 } as any;
      });

      const result = await syncMultiTenantCatalogJob({ prisma: mockPrisma as any });

      expect(result.storesScanned).toBe(3);
      expect(result.syncedWorkspaces).toEqual(["ws_ok"]);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].storeId).toBe("store_fail_res");
      expect(result.errors[0].error).toContain("Unable to canonically resolve store");
      expect(result.errors[1].storeId).toBe("store_fail_sync");
      expect(result.errors[1].error).toContain("Fatal Shopify rate limit hit");
    });
  });

  describe("Adversarial Test 4: Cloudflare for SaaS Input Validation & Edge Cases", () => {
    it("rejects empty or whitespace-only domain names", async () => {
      await expect(addCustomHostnameToCloudflare("")).rejects.toThrow("Domain name must not be empty");
      await expect(addCustomHostnameToCloudflare("   ")).rejects.toThrow("Domain name must not be empty");
      await expect(getCustomHostnameFromCloudflare("")).rejects.toThrow("hostnameOrId must not be empty");
      await expect(deleteCustomHostnameFromCloudflare("   ")).rejects.toThrow("hostnameOrId must not be empty");
    });

    it("extracts validation records safely when ssl.validation_records is missing or null", () => {
      const mockObj: any = {
        id: "cf_empty_ssl",
        hostname: "example.com",
        status: "pending",
        ssl: { status: "pending", validation_records: null },
      };
      const records = extractSslValidationRecords(mockObj);
      expect(records).toEqual([]);
    });

    it("extracts validation records safely when ssl is undefined", () => {
      const mockObj: any = {
        id: "cf_empty",
        hostname: "example.com",
        status: "pending",
      };
      const records = extractSslValidationRecords(mockObj);
      expect(records).toEqual([]);
    });

    it("verifyCustomHostname returns not_found when hostname does not exist", async () => {
      process.env.CLOUDFLARE_ZONE_ID = "zone_123";
      process.env.CLOUDFLARE_API_TOKEN = "tok_123";

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ success: false, errors: [{ code: 1404, message: "Not found" }] }),
      });
      global.fetch = fetchSpy;

      const result = await verifyCustomHostname("non-existent.domain.com");
      expect(result.verified).toBe(false);
      expect(result.status).toBe("not_found");
      expect(result.sslStatus).toBe("not_found");
      expect(result.validationRecords).toEqual([]);
    });
  });

  describe("Adversarial Test 5: Double-Entry Ledger Negative Deltas and Inversions", () => {
    it("verifies negative pointsDelta (points deductions/spend) correctly", async () => {
      const mockPrisma = {
        weleticLoyaltyAccount: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "acc_deduction",
              cachedPointsBalance: 50n,
              ledgerEntries: [
                { sequenceNumber: 1, pointsDelta: 100n, balanceAfter: 100n },
                { sequenceNumber: 2, pointsDelta: -50n, balanceAfter: 50n }, // Points redemption spend!
              ],
            },
          ]),
        },
      };

      const result = await verifyDoubleEntryLedgerJob({ prisma: mockPrisma as any });
      expect(result.verified).toBe(true);
      expect(result.accountsAudited).toBe(1);
      expect(result.discrepanciesCount).toBe(0);
    });

    it("catches account balance mismatch when ledger sequence is correct but account.pointsBalance is out of sync", async () => {
      const mockPrisma = {
        weleticLoyaltyAccount: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "acc_desynced_cached_balance",
              cachedPointsBalance: 200n, // Stale cached balance!
              ledgerEntries: [
                { sequenceNumber: 1, pointsDelta: 100n, balanceAfter: 100n },
                { sequenceNumber: 2, pointsDelta: 50n, balanceAfter: 150n },
              ],
            },
          ]),
        },
      };

      const result = await verifyDoubleEntryLedgerJob({ prisma: mockPrisma as any });
      expect(result.verified).toBe(false);
      expect(result.discrepanciesCount).toBe(1);
      const disc: any = result.discrepancies[0];
      expect(disc.type).toBe("account_balance_mismatch");
      expect(disc.accountBalance).toBe("200");
      expect(disc.computedBalance).toBe("150");
    });
  });
});
