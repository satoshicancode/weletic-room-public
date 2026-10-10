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
import worker from "../../workers/cron-triggers/src/index";
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

describe("Milestone 5 (R5): Cloudflare Cron Triggers & Cloudflare for SaaS Custom Hostnames", () => {
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
  // 1. Cloudflare for SaaS (Custom Hostnames API Client)
  // =========================================================================
  describe("1. Cloudflare for SaaS: Custom Hostnames Client & Automated SSL", () => {
    describe("1.1 Dev / Test Graceful Fallback (Unconfigured Environment)", () => {
      it("detects unconfigured environment properly", () => {
        expect(isCloudflareSaaSConfigured()).toBe(false);
        expect(getCloudflareSaaSConfig()).toBeNull();
      });

      it("adds custom hostname in dev fallback mode without throwing", async () => {
        const domain = "affiliate.creatorbrand.com";
        const result = await addCustomHostnameToCloudflare(domain, {
          customOriginServer: "cname.weletic.com",
        });

        expect(result.hostname).toBe(domain);
        expect(result.status).toBe("active");
        expect(result.ssl.status).toBe("active");
        expect(result.ssl.method).toBe("http");
        expect(result.ssl.type).toBe("dv");
        expect(result.custom_origin_server).toBe("cname.weletic.com");
        expect(result.id).toMatch(/^cf_dev_/);
        expect(result.ssl.validation_records?.length).toBeGreaterThan(0);
      });

      it("gets custom hostname in dev fallback mode", async () => {
        const domain = "partners.influencer.jp";
        const result = await getCustomHostnameFromCloudflare(domain);

        expect(result).not.toBeNull();
        expect(result?.hostname).toBe(domain);
        expect(result?.status).toBe("active");
      });

      it("deletes custom hostname in dev fallback mode", async () => {
        const domain = "old-partner.shop";
        const result = await deleteCustomHostnameFromCloudflare(domain);

        expect(result.deleted).toBe(true);
        expect(result.id).toBe(domain);
      });

      it("verifies custom hostname in dev fallback mode", async () => {
        const domain = "vip.creatorstore.com";
        const verification = await verifyCustomHostname(domain);

        expect(verification.verified).toBe(true);
        expect(verification.status).toBe("active");
        expect(verification.sslStatus).toBe("active");
        expect(verification.validationRecords.length).toBeGreaterThan(0);
      });

      it("fails closed with CloudflareSaaSError in production when credentials are unconfigured", async () => {
        process.env.NODE_ENV = "production";
        const domain = "production-domain.com";

        await expect(addCustomHostnameToCloudflare(domain)).rejects.toThrow(
          CloudflareSaaSError,
        );
        await expect(getCustomHostnameFromCloudflare(domain)).rejects.toThrow(
          CloudflareSaaSError,
        );
        await expect(deleteCustomHostnameFromCloudflare(domain)).rejects.toThrow(
          CloudflareSaaSError,
        );
      });
    });

    describe("1.2 Configured Cloudflare for SaaS Integration (API Calls)", () => {
      const ZONE_ID = "zone_cf_test_998877";
      const API_TOKEN = "cf_token_secret_123456789";

      beforeEach(() => {
        process.env.CLOUDFLARE_ZONE_ID = ZONE_ID;
        process.env.CLOUDFLARE_API_TOKEN = API_TOKEN;
      });

      it("detects configured environment properly", () => {
        expect(isCloudflareSaaSConfigured()).toBe(true);
        const config = getCloudflareSaaSConfig();
        expect(config?.zoneId).toBe(ZONE_ID);
        expect(config?.apiToken).toBe(API_TOKEN);
      });

      it("sends correct POST request to create custom hostname with automated SSL", async () => {
        const domain = "shop.fitnesspartner.com";
        const mockApiResponse = {
          success: true,
          result: {
            id: "24385a85-2a22-4ef6-9283-9b88950c4bb6",
            hostname: domain,
            status: "pending",
            ssl: {
              id: "ssl_rec_112233",
              type: "dv",
              method: "http",
              status: "pending_validation",
              validation_records: [
                {
                  status: "pending",
                  txt_name: `_cf-custom-hostname.${domain}`,
                  txt_value: "cf-token-verification-12345",
                },
              ],
            },
            ownership_verification: {
              type: "txt",
              name: `_cf-custom-hostname.${domain}`,
              value: "cf-token-verification-12345",
            },
            created_at: new Date().toISOString(),
          },
        };

        const fetchSpy = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockApiResponse,
        });
        global.fetch = fetchSpy;

        const result = await addCustomHostnameToCloudflare(domain, {
          customOriginServer: "cname.weletic.com",
        });

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/custom_hostnames`);
        expect(init.method).toBe("POST");
        expect(init.headers["Authorization"]).toBe(`Bearer ${API_TOKEN}`);

        const body = JSON.parse(init.body);
        expect(body.hostname).toBe(domain);
        expect(body.ssl.method).toBe("http");
        expect(body.ssl.type).toBe("dv");
        expect(body.ssl.settings.min_tls_version).toBe("1.2");
        expect(body.custom_origin_server).toBe("cname.weletic.com");

        expect(result.id).toBe("24385a85-2a22-4ef6-9283-9b88950c4bb6");
        expect(result.status).toBe("pending");
      });

      it("fetches custom hostname by UUID", async () => {
        const uuid = "24385a85-2a22-4ef6-9283-9b88950c4bb6";
        const mockApiResponse = {
          success: true,
          result: {
            id: uuid,
            hostname: "brand.influencer.co",
            status: "active",
            ssl: { status: "active", method: "http", type: "dv" },
          },
        };

        const fetchSpy = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockApiResponse,
        });
        global.fetch = fetchSpy;

        const result = await getCustomHostnameFromCloudflare(uuid);

        expect(fetchSpy).toHaveBeenCalledWith(
          `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/custom_hostnames/${uuid}`,
          expect.any(Object),
        );
        expect(result?.id).toBe(uuid);
        expect(result?.hostname).toBe("brand.influencer.co");
      });

      it("fetches custom hostname by domain query parameter", async () => {
        const domain = "affiliate.activewear.com";
        const mockApiResponse = {
          success: true,
          result: [
            {
              id: "host_887766",
              hostname: domain,
              status: "active",
              ssl: { status: "active", method: "http", type: "dv" },
            },
          ],
        };

        const fetchSpy = vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => mockApiResponse,
        });
        global.fetch = fetchSpy;

        const result = await getCustomHostnameFromCloudflare(domain);

        expect(fetchSpy).toHaveBeenCalledWith(
          `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/custom_hostnames?hostname=${encodeURIComponent(domain)}`,
          expect.any(Object),
        );
        expect(result?.id).toBe("host_887766");
      });

      it("deletes custom hostname by looking up ID when domain is provided", async () => {
        const domain = "store.runclub.org";
        const hostId = "host_runclub_123";

        const fetchSpy = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
          if (init?.method === "DELETE") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: async () => ({ success: true, result: { id: hostId } }),
            });
          }
          // GET lookup
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              result: [{ id: hostId, hostname: domain, status: "active", ssl: { status: "active" } }],
            }),
          });
        });
        global.fetch = fetchSpy;

        const result = await deleteCustomHostnameFromCloudflare(domain);

        expect(result.deleted).toBe(true);
        expect(result.id).toBe(hostId);
      });

      it("throws CloudflareSaaSError when Cloudflare API returns error", async () => {
        const domain = "invalid..domain..";
        const fetchSpy = vi.fn().mockResolvedValue({
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({
            success: false,
            errors: [{ code: 1004, message: "Invalid hostname" }],
          }),
        });
        global.fetch = fetchSpy;

        await expect(addCustomHostnameToCloudflare(domain)).rejects.toThrow(
          CloudflareSaaSError,
        );
      });
    });

    describe("1.3 DNS & SSL Validation Record Parsing", () => {
      it("extracts and normalizes TXT, CNAME, and HTTP validation records", () => {
        const mockHostname: any = {
          id: "host_123",
          hostname: "affiliate.yamax.com",
          status: "pending",
          ssl: {
            status: "pending_validation",
            validation_records: [
              {
                status: "pending",
                txt_name: "_cf-custom-hostname.affiliate.yamax.com",
                txt_value: "txt-token-abc-123",
              },
              {
                status: "pending",
                cname: "affiliate.yamax.com",
                cname_target: "fallback.weletic.com",
              },
              {
                status: "pending",
                http_url: "http://affiliate.yamax.com/.well-known/pki-validation/ca.txt",
                http_body: "body-token-xyz-987",
              },
            ],
          },
          ownership_verification: {
            type: "txt",
            name: "_cf-custom-hostname.affiliate.yamax.com",
            value: "txt-token-abc-123",
          },
        };

        const records = extractSslValidationRecords(mockHostname);

        expect(records).toHaveLength(3); // Deduplicated TXT + CNAME + HTTP
        const txtRecord = records.find((r) => r.type === "TXT");
        const cnameRecord = records.find((r) => r.type === "CNAME");
        const httpRecord = records.find((r) => r.type === "HTTP");

        expect(txtRecord).toBeDefined();
        expect(txtRecord?.name).toBe("_cf-custom-hostname.affiliate.yamax.com");
        expect(txtRecord?.value).toBe("txt-token-abc-123");

        expect(cnameRecord).toBeDefined();
        expect(cnameRecord?.name).toBe("affiliate.yamax.com");
        expect(cnameRecord?.value).toBe("fallback.weletic.com");

        expect(httpRecord).toBeDefined();
        expect(httpRecord?.name).toBe("http://affiliate.yamax.com/.well-known/pki-validation/ca.txt");
        expect(httpRecord?.value).toBe("body-token-xyz-987");
      });
    });
  });

  // =========================================================================
  // 2. Task Isolation Engine & Error Containment
  // =========================================================================
  describe("2. Task Isolation Engine: Error Containment & Resilience", () => {
    it("successfully runs healthy jobs and captures duration", async () => {
      const result = await executeIsolatedJob("sample-healthy-task", async () => {
        return { count: 42 };
      });

      expect(result.name).toBe("sample-healthy-task");
      expect(result.status).toBe("success");
      expect(result.data).toEqual({ count: 42 });
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it("safely catches unhandled job errors without aborting or throwing", async () => {
      const result = await executeIsolatedJob("failing-task", async () => {
        throw new Error("Simulated transient connection timeout");
      });

      expect(result.name).toBe("failing-task");
      expect(result.status).toBe("error");
      expect(result.error).toContain("Simulated transient connection timeout");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.data).toBeUndefined();
    });

    it("executes remaining tasks in batch even when preceding tasks fail", async () => {
      let task2Ran = false;
      let task3Ran = false;

      const [task1Result, task2Result, task3Result] = await Promise.all([
        executeIsolatedJob("task-1-failing", async () => {
          throw new Error("Task 1 crashed");
        }),
        executeIsolatedJob("task-2-healthy", async () => {
          task2Ran = true;
          return "task-2-ok";
        }),
        executeIsolatedJob("task-3-healthy", async () => {
          task3Ran = true;
          return "task-3-ok";
        }),
      ]);

      expect(task1Result.status).toBe("error");
      expect(task1Result.error).toContain("Task 1 crashed");

      expect(task2Ran).toBe(true);
      expect(task2Result.status).toBe("success");
      expect(task2Result.data).toBe("task-2-ok");

      expect(task3Ran).toBe(true);
      expect(task3Result.status).toBe("success");
      expect(task3Result.data).toBe("task-3-ok");
    });
  });

  // =========================================================================
  // 3. Scheduled Cron Routing Matrix
  // =========================================================================
  describe("3. Scheduled Cron Triggers Event Routing", () => {
    const mockEnv: CronWorkerEnv = {};

    it("routes '*/5 * * * *' to store credit sweep, outbox, and stalled webhooks recovery", async () => {
      const creditSpy = vi.spyOn(storeCreditReconciliationModule, "reconcilePendingStoreCreditRedemptionsSweep")
        .mockResolvedValue({ scanned: 10, confirmed: 5, refunded: 2, deferred: 3, errors: 0, details: [] });
      const outboxSpy = vi.spyOn(outboxModule, "processOutboxJobsBatch")
        .mockResolvedValue({ processed: 8 } as any);
      const webhookRecoverySpy = vi.spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks")
        .mockResolvedValue([{ id: "wh_1", webhookId: "wh_ev_1", status: "completed" }]);

      const report = await scheduledHandler(
        { cron: CRON_SCHEDULE_5_MIN, scheduledTime: Date.now() },
        mockEnv,
      );

      expect(creditSpy).toHaveBeenCalled();
      expect(outboxSpy).toHaveBeenCalled();
      expect(webhookRecoverySpy).toHaveBeenCalled();

      expect(report.cron).toBe(CRON_SCHEDULE_5_MIN);
      expect(report.jobs).toHaveLength(3);
      expect(report.successCount).toBe(3);
      expect(report.errorCount).toBe(0);
      expect(report.jobs.map((j) => j.name)).toEqual([
        "store-credit-reconciliation",
        "loyalty-outbox",
        "stalled-webhooks-recovery",
      ]);
    });

    it("routes '0 * * * *' to loyalty points expiration and expiring session renewal", async () => {
      const pointsExpirySpy = vi.spyOn(pointsExpirySchedulerModule, "enqueuePointsExpiryLifecycleJobs")
        .mockResolvedValue({ programsScanned: 3, programsSkipped: 0, accountsReconciled: 12, accountsScheduled: 5, jobsEnqueued: 5 });
      const rewardExpirySpy = vi.spyOn(rewardExpirySchedulerModule, "enqueueRewardExpiryReminderJobs")
        .mockResolvedValue({
          programsScanned: 2,
          rewardsScanned: 15,
          jobsEnqueued: 3,
          alreadyQueued: 0,
          ineligible: 0,
          programFailures: [],
        });
      const sessionRenewalSpy = vi.spyOn(sessionRenewalModule, "listDueShopifySessionRenewals")
        .mockResolvedValue({ jobs: [], nextCursor: null });

      const envWithKey: CronWorkerEnv = { SHOPIFY_API_KEY: "shopify_app_client_id_test" };

      const report = await scheduledHandler(
        { cron: CRON_SCHEDULE_HOURLY, scheduledTime: Date.now() },
        envWithKey,
      );

      expect(pointsExpirySpy).toHaveBeenCalled();
      expect(rewardExpirySpy).toHaveBeenCalled();
      expect(sessionRenewalSpy).toHaveBeenCalled();

      expect(report.cron).toBe(CRON_SCHEDULE_HOURLY);
      expect(report.jobs).toHaveLength(3);
      expect(report.successCount).toBe(3);
      expect(report.errorCount).toBe(0);
      expect(report.jobs.map((j) => j.name)).toEqual([
        "loyalty-points-expiration",
        "shopify-session-renewal",
        "purge-expired-nonces",
      ]);
      const expiryJob = report.jobs.find((j) => j.name === "loyalty-points-expiration");
      expect(expiryJob?.data).toEqual({
        pointsLifecycle: {
          programsScanned: 3,
          accountsReconciled: 12,
          jobsEnqueued: 5,
        },
        rewardReminders: {
          scanned: 15,
          enqueued: 3,
        },
      });
    });

    it("loyaltyPointsExpirationJob correctly binds real sweep result structures", async () => {
      vi.spyOn(pointsExpirySchedulerModule, "enqueuePointsExpiryLifecycleJobs")
        .mockResolvedValue({
          programsScanned: 5,
          programsSkipped: 1,
          accountsReconciled: 40,
          accountsScheduled: 10,
          jobsEnqueued: 10,
        });
      vi.spyOn(rewardExpirySchedulerModule, "enqueueRewardExpiryReminderJobs")
        .mockResolvedValue({
          programsScanned: 2,
          rewardsScanned: 25,
          jobsEnqueued: 7,
          alreadyQueued: 1,
          ineligible: 0,
          programFailures: [],
        });

      const result = await loyaltyPointsExpirationJob({});

      expect(result.pointsLifecycle).toEqual({
        programsScanned: 5,
        accountsReconciled: 40,
        jobsEnqueued: 10,
      });
      expect(result.rewardReminders).toEqual({
        scanned: 25,
        enqueued: 7,
      });
    });

    it("routes '0 2 * * *' to multi-tenant catalog sync sweep and double-entry ledger audit", async () => {
      // Mock prisma stores query
      vi.spyOn(prisma.weleticShopifyStore, "findMany").mockResolvedValue([
        { id: "store_tenant_1", projectId: "ws_tenant_1", shopDomain: "brand1.myshopify.com" } as any,
      ]);
      vi.spyOn(storeResolverModule, "resolveShopifyStoreByDomain").mockResolvedValue({
        id: "store_tenant_1",
        projectId: "ws_tenant_1",
        shopDomain: "brand1.myshopify.com",
      } as any);
      const catalogSyncSpy = vi.spyOn(catalogSyncModule, "syncWeleticShopifyCatalog").mockResolvedValue({
        created: 2,
        updated: 1,
        deleted: 0,
      } as any);

      // Mock prisma loyalty accounts
      vi.spyOn(prisma.weleticLoyaltyAccount, "findMany").mockResolvedValue([
        {
          id: "acc_1",
          cachedPointsBalance: 150n,
          ledgerEntries: [
            { sequenceNumber: 1, pointsDelta: 100n, balanceAfter: 100n },
            { sequenceNumber: 2, pointsDelta: 50n, balanceAfter: 150n },
          ],
        } as any,
      ]);

      const report = await scheduledHandler(
        { cron: CRON_SCHEDULE_DAILY, scheduledTime: Date.now() },
        mockEnv,
      );

      expect(catalogSyncSpy).toHaveBeenCalledWith({ workspaceId: "ws_tenant_1" });
      expect(report.cron).toBe(CRON_SCHEDULE_DAILY);
      expect(report.jobs).toHaveLength(2);
      expect(report.successCount).toBe(2);
      expect(report.errorCount).toBe(0);
      expect(report.jobs.map((j) => j.name)).toEqual([
        "multi-tenant-catalog-sync",
        "daily-double-entry-ledger-verify",
      ]);
    });

    it("gracefully logs and handles unrecognized cron triggers without failing", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const report = await scheduledHandler(
        { cron: "*/17 * * * *", scheduledTime: Date.now() },
        mockEnv,
      );

      expect(warnSpy).toHaveBeenCalled();
      expect(report.jobs).toHaveLength(1);
      expect(report.jobs[0].status).toBe("skipped");
      expect(report.jobs[0].name).toBe("unrecognized-trigger");
    });
  });

  // =========================================================================
  // 4. HTTP Manual Trigger Handler (/trigger?cron=...)
  // =========================================================================
  describe("4. HTTP Manual Trigger (/trigger?cron=...) & Health Interface", () => {
    const mockCronSecret = "cron_secret_mock_env_12345";
    const mockEnv: CronWorkerEnv = { CRON_SECRET: mockCronSecret };
    const authHeaders = { Authorization: `Bearer ${mockCronSecret}` };

    it("returns healthy status on GET /health", async () => {
      const req = new Request("http://localhost/health");
      const res = await handleHttpTrigger(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("healthy");
      expect(body.service).toBe("weletic-cron-scheduler");
      expect(body.supportedCrons).toContain(CRON_SCHEDULE_5_MIN);
    });

    it("executes 5-minute cycle on GET /trigger?cron=*/5 * * * *", async () => {
      vi.spyOn(storeCreditReconciliationModule, "reconcilePendingStoreCreditRedemptionsSweep")
        .mockResolvedValue({ scanned: 2, confirmed: 1, refunded: 0, deferred: 1, errors: 0, details: [] });
      vi.spyOn(outboxModule, "processOutboxJobsBatch")
        .mockResolvedValue({ processed: 0 } as any);
      vi.spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks")
        .mockResolvedValue([]);

      const req = new Request(`http://localhost/trigger?cron=${encodeURIComponent(CRON_SCHEDULE_5_MIN)}`, {
        headers: authHeaders,
      });
      const res = await handleHttpTrigger(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cron).toBe(CRON_SCHEDULE_5_MIN);
      expect(body.jobs.length).toBe(3);
      expect(body.successCount).toBe(3);
    });

    it("executes hourly cycle via POST /trigger with JSON body", async () => {
      vi.spyOn(pointsExpirySchedulerModule, "enqueuePointsExpiryLifecycleJobs")
        .mockResolvedValue({ programsScanned: 1, programsSkipped: 0, accountsReconciled: 0, accountsScheduled: 0, jobsEnqueued: 0 });
      vi.spyOn(rewardExpirySchedulerModule, "enqueueRewardExpiryReminderJobs")
        .mockResolvedValue({
          programsScanned: 0,
          rewardsScanned: 0,
          jobsEnqueued: 0,
          alreadyQueued: 0,
          ineligible: 0,
          programFailures: [],
        });

      const req = new Request("http://localhost/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ cron: CRON_SCHEDULE_HOURLY }),
      });
      const res = await handleHttpTrigger(req, mockEnv);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cron).toBe(CRON_SCHEDULE_HOURLY);
      expect(body.jobs.length).toBe(3);
    });

    it("enforces authentication when CRON_SECRET is configured", async () => {
      const securedEnv: CronWorkerEnv = { CRON_SECRET: "cron_secret_auth_token_999" };

      // Request without auth header
      const unauthReq = new Request("http://localhost/trigger?cron=5min");
      const unauthRes = await handleHttpTrigger(unauthReq, securedEnv);
      expect(unauthRes.status).toBe(401);

      // Request with wrong bearer token
      const wrongTokenReq = new Request("http://localhost/trigger?cron=5min", {
        headers: { Authorization: "Bearer wrong_token" },
      });
      const wrongRes = await handleHttpTrigger(wrongTokenReq, securedEnv);
      expect(wrongRes.status).toBe(401);

      // Request with valid bearer token
      const validReq = new Request("http://localhost/trigger?cron=5min", {
        headers: { Authorization: "Bearer cron_secret_auth_token_999" },
      });
      vi.spyOn(storeCreditReconciliationModule, "reconcilePendingStoreCreditRedemptionsSweep")
        .mockResolvedValue({ scanned: 0, confirmed: 0, refunded: 0, deferred: 0, errors: 0, details: [] });
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({ processed: 0 } as any);
      vi.spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks").mockResolvedValue([]);

      const validRes = await handleHttpTrigger(validReq, securedEnv);
      expect(validRes.status).toBe(200);
    });

    it("supports cron aliases 'hourly' and 'daily' via GET /trigger", async () => {
      vi.spyOn(pointsExpirySchedulerModule, "enqueuePointsExpiryLifecycleJobs")
        .mockResolvedValue({ programsScanned: 0, programsSkipped: 0, accountsReconciled: 0, accountsScheduled: 0, jobsEnqueued: 0 });
      vi.spyOn(rewardExpirySchedulerModule, "enqueueRewardExpiryReminderJobs")
        .mockResolvedValue({
          programsScanned: 0,
          rewardsScanned: 0,
          jobsEnqueued: 0,
          alreadyQueued: 0,
          ineligible: 0,
          programFailures: [],
        });

      const hourlyReq = new Request("http://localhost/trigger?cron=hourly", {
        headers: authHeaders,
      });
      const hourlyRes = await handleHttpTrigger(hourlyReq, mockEnv);
      expect(hourlyRes.status).toBe(200);
      const hourlyBody = await hourlyRes.json();
      expect(hourlyBody.cron).toBe(CRON_SCHEDULE_HOURLY);

      const dailyReq = new Request("http://localhost/trigger?cron=daily", {
        headers: authHeaders,
      });
      const dailyRes = await handleHttpTrigger(dailyReq, mockEnv);
      expect(dailyRes.status).toBe(200);
      const dailyBody = await dailyRes.json();
      expect(dailyBody.cron).toBe(CRON_SCHEDULE_DAILY);
    });

    it("returns 404 for unknown endpoints", async () => {
      const req = new Request("http://localhost/unknown-path");
      const res = await handleHttpTrigger(req, mockEnv);
      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // 5. Native D1 and Queues Integration
  // =========================================================================
  describe("5. Native D1 & Queues Producer Integration", () => {
    it("sweeps stalled webhooks directly through D1 and ORDER_WEBHOOK_QUEUE", async () => {
      const enqueuedMessages: any[] = [];
      const mockQueue: QueueSender = {
        async send(message) {
          enqueuedMessages.push(message);
        },
      };

      const executedUpdates: any[] = [];
      const mockD1: any = {
        prepare(query: string) {
          if (query.includes("SELECT") && query.includes("WeleticShopifyWebhookEvent")) {
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "row_stalled_1",
                      webhookId: "wh_shopify_stalled_1",
                      topic: "orders/paid",
                      storeId: "store_tenant_abc",
                      shopDomain: "store-tenant.myshopify.com",
                      attempts: 2,
                      payload: JSON.stringify({ id: 12345 }),
                    },
                  ],
                };
              },
            };
          }
          if (query.includes("UPDATE") && query.includes("WeleticShopifyWebhookEvent")) {
            return {
              bind(...args: any[]) {
                executedUpdates.push(args);
                return {
                  async run() {
                    return { success: true };
                  },
                };
              },
            };
          }
          return {
            async all() { return { results: [] }; },
            async run() { return { success: true }; },
          };
        },
      };

      vi.spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks").mockResolvedValue([]);

      const env: CronWorkerEnv = {
        DB: mockD1,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const result = await recoverStalledWebhooksJob(env);

      expect(result.reEnqueued).toBe(1);
      expect(enqueuedMessages).toHaveLength(1);
      expect(enqueuedMessages[0].webhookId).toBe("wh_shopify_stalled_1");
      expect(executedUpdates).toHaveLength(1);
      expect(executedUpdates[0]).toEqual(["row_stalled_1"]);
    });
  });

  // =========================================================================
  // 6. Double-Entry Ledger Verification Engine
  // =========================================================================
  describe("6. Double-Entry Ledger Integrity Audit", () => {
    it("verifies clean ledger entries with 0 discrepancies", async () => {
      vi.spyOn(prisma.weleticLoyaltyAccount, "findMany").mockResolvedValue([
        {
          id: "acc_healthy",
          cachedPointsBalance: 500n,
          ledgerEntries: [
            { sequenceNumber: 1, pointsDelta: 200n, balanceAfter: 200n },
            { sequenceNumber: 2, pointsDelta: 300n, balanceAfter: 500n },
          ],
        } as any,
      ]);

      const result = await verifyDoubleEntryLedgerJob({});

      expect(result.verified).toBe(true);
      expect(result.accountsAudited).toBe(1);
      expect(result.discrepanciesCount).toBe(0);
      expect(result.discrepancies).toEqual([]);
    });

    it("detects sequence gap in ledger entries", async () => {
      vi.spyOn(prisma.weleticLoyaltyAccount, "findMany").mockResolvedValue([
        {
          id: "acc_gap",
          cachedPointsBalance: 200n,
          ledgerEntries: [
            { sequenceNumber: 1, pointsDelta: 100n, balanceAfter: 100n },
            { sequenceNumber: 3, pointsDelta: 100n, balanceAfter: 200n }, // Missing sequence 2!
          ],
        } as any,
      ]);

      const result = await verifyDoubleEntryLedgerJob({});

      expect(result.verified).toBe(false);
      expect(result.discrepanciesCount).toBeGreaterThan(0);
      const gapDiscrepancy: any = result.discrepancies.find((d: any) => d.type === "sequence_gap");
      expect(gapDiscrepancy).toBeDefined();
      expect(gapDiscrepancy.expected).toBe(2);
      expect(gapDiscrepancy.found).toBe(3);
    });

    it("detects balance mismatch between pointsDelta and balanceAfter", async () => {
      vi.spyOn(prisma.weleticLoyaltyAccount, "findMany").mockResolvedValue([
        {
          id: "acc_bad_math",
          cachedPointsBalance: 999n,
          ledgerEntries: [
            { sequenceNumber: 1, pointsDelta: 100n, balanceAfter: 100n },
            { sequenceNumber: 2, pointsDelta: 50n, balanceAfter: 999n }, // 100 + 50 should be 150, not 999!
          ],
        } as any,
      ]);

      const result = await verifyDoubleEntryLedgerJob({});

      expect(result.verified).toBe(false);
      expect(result.discrepanciesCount).toBeGreaterThan(0);
      const mathDiscrepancy: any = result.discrepancies.find((d: any) => d.type === "balance_mismatch");
      expect(mathDiscrepancy).toBeDefined();
      expect(mathDiscrepancy.runningBalance).toBe("150");
      expect(mathDiscrepancy.recordedBalance).toBe("999");
    });

    it("detects account balance mismatch between cachedPointsBalance and ledger entries running balance", async () => {
      vi.spyOn(prisma.weleticLoyaltyAccount, "findMany").mockResolvedValue([
        {
          id: "acc_cached_drift",
          cachedPointsBalance: 900n, // Stale cache! Running balance is 500n.
          ledgerEntries: [
            { sequenceNumber: 1, pointsDelta: 200n, balanceAfter: 200n },
            { sequenceNumber: 2, pointsDelta: 300n, balanceAfter: 500n },
          ],
        } as any,
      ]);

      const result = await verifyDoubleEntryLedgerJob({});

      expect(result.verified).toBe(false);
      expect(result.discrepanciesCount).toBe(1);
      const mismatch: any = result.discrepancies.find(
        (d: any) => d.type === "account_balance_mismatch",
      );
      expect(mismatch).toBeDefined();
      expect(mismatch.accountBalance).toBe("900");
      expect(mismatch.computedBalance).toBe("500");
    });

    it("audits ledger via D1 SQL query and detects mismatch between totalDelta and lastBalance", async () => {
      const mockD1: any = {
        prepare(query: string) {
          if (query.includes("WeleticPointsLedgerEntry")) {
            return {
              async all() {
                return {
                  results: [
                    {
                      accountId: "acc_d1_mismatch",
                      entryCount: 2,
                      totalDelta: 150,
                      lastBalance: 200, // Mismatch!
                    },
                  ],
                };
              },
            };
          }
          return {
            async all() { return { results: [] }; },
          };
        },
      };

      const result = await verifyDoubleEntryLedgerJob({ DB: mockD1 });

      expect(result.verified).toBe(false);
      expect(result.accountsAudited).toBe(1);
      expect(result.discrepanciesCount).toBe(1);
      expect((result.discrepancies[0] as any).expectedBalance).toBe(150);
      expect((result.discrepancies[0] as any).actualBalance).toBe(200);
    });
  });

  // =========================================================================
  // 7. Invariants Compliance
  // =========================================================================
  describe("7. Invariants Compliance (Invariants 1 & 4)", () => {
    it("Invariant 1: dynamically resolves stores via resolveShopifyStoreByDomain during catalog reconciliation", async () => {
      vi.spyOn(prisma.weleticShopifyStore, "findMany").mockResolvedValue([
        { id: "store_aliased", projectId: "ws_tenant_alias", shopDomain: "yamaxdev.myshopify.com" } as any,
      ]);

      const resolverSpy = vi.spyOn(storeResolverModule, "resolveShopifyStoreByDomain")
        .mockResolvedValue({
          id: "store_aliased",
          projectId: "ws_tenant_alias",
          shopDomain: "yamaxdev.myshopify.com",
        } as any);

      vi.spyOn(catalogSyncModule, "syncWeleticShopifyCatalog").mockResolvedValue({
        created: 0,
        updated: 0,
        deleted: 0,
      } as any);

      const result = await syncMultiTenantCatalogJob({});

      expect(resolverSpy).toHaveBeenCalledWith("yamaxdev.myshopify.com");
      expect(result.syncedWorkspaces).toContain("ws_tenant_alias");
    });

    it("Invariant 4: iterates across all multi-tenant stores without hardcoding store names or workspace IDs", async () => {
      const mockStores = [
        { id: "store_1", projectId: "ws_1", shopDomain: "tenant-one.myshopify.com" },
        { id: "store_2", projectId: "ws_2", shopDomain: "tenant-two.myshopify.com" },
        { id: "store_3", projectId: "ws_3", shopDomain: "tenant-three.myshopify.com" },
      ];

      vi.spyOn(prisma.weleticShopifyStore, "findMany").mockResolvedValue(mockStores as any);
      vi.spyOn(storeResolverModule, "resolveShopifyStoreByDomain").mockImplementation(async (domain) => {
        const store = mockStores.find((s) => s.shopDomain === domain);
        return store ? (store as any) : null;
      });
      const catalogSyncSpy = vi.spyOn(catalogSyncModule, "syncWeleticShopifyCatalog").mockResolvedValue({
        created: 1,
        updated: 0,
        deleted: 0,
      } as any);

      const result = await syncMultiTenantCatalogJob({});

      expect(result.storesScanned).toBe(3);
      expect(result.syncedWorkspaces).toEqual(["ws_1", "ws_2", "ws_3"]);
      expect(catalogSyncSpy).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // 8. Default Worker scheduled & fetch Export
  // =========================================================================
  describe("8. Cloudflare Worker Default Export", () => {
    it("handles scheduled event through worker.scheduled with ExecutionContext", async () => {
      vi.spyOn(storeCreditReconciliationModule, "reconcilePendingStoreCreditRedemptionsSweep")
        .mockResolvedValue({ scanned: 0, confirmed: 0, refunded: 0, deferred: 0, errors: 0, details: [] });
      vi.spyOn(outboxModule, "processOutboxJobsBatch").mockResolvedValue({ processed: 0 } as any);
      vi.spyOn(ordersPaidRecoveryModule, "recoverStuckOrdersPaidWebhooks").mockResolvedValue([]);

      let waitedPromise: Promise<any> | null = null;
      const ctx = {
        waitUntil(p: Promise<any>) {
          waitedPromise = p;
        },
      };

      await worker.scheduled(
        { cron: CRON_SCHEDULE_5_MIN, scheduledTime: Date.now(), noRetry: () => {} },
        {},
        ctx,
      );

      expect(waitedPromise).not.toBeNull();
      const report = await waitedPromise;
      expect(report.cron).toBe(CRON_SCHEDULE_5_MIN);
      expect(report.successCount).toBe(3);
    });

    it("handles fetch request through worker.fetch", async () => {
      const req = new Request("http://localhost/health");
      const res = await worker.fetch(req, {});

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("healthy");
    });
  });
});
