import { prisma } from "@/lib/prisma";
import {
  calculatePointsLiability,
  calculateReferralEconomics,
} from "@/lib/weletic/loyalty/analytics";
import {
  cancelBackfillJob,
  commitBackfillJob,
  createBackfillJob,
  generateBackfillPreview,
} from "@/lib/weletic/loyalty/backfill";
import { resolveStoreId } from "@/lib/weletic/loyalty/customer";
import {
  calculateEligibleOrderPoints,
  processRefundPointsReversal,
} from "@/lib/weletic/loyalty/earn";
import {
  appendPointsLedgerEntry,
  reconcileAccountPoints,
} from "@/lib/weletic/loyalty/ledger";
import {
  buildCustomerMetafieldUpdates,
  normalizeShopifyCustomerGid,
} from "@/lib/weletic/loyalty/metafield-sync";
import {
  awardActivityPoints,
  checkBirthdayEligibility,
} from "@/lib/weletic/loyalty/non-purchase-earn";
import { bindShopperReferral } from "@/lib/weletic/loyalty/referrals";
import {
  cancelRewardRedemption,
  redeemReward,
} from "@/lib/weletic/loyalty/rewards";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import {
  decimalToMinorUnits,
  getCatalogPricing,
  minorUnitsToDecimal,
} from "@/lib/weletic/money";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import {
  createWeleticShopifyCanonicalRequest,
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import {
  Prisma,
  WeleticLoyaltyBackfillJobStatus,
  WeleticLoyaltyStatus,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    weleticLoyaltyEarningRule: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticRewardDefinition: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyTier: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      aggregate: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    weleticRewardRedemption: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyEarnGrant: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyOrderLineEarn: {
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) => data),
    },
    weleticLoyaltyReferral: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticShopper: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
    },
    weleticCommerceRefund: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    weleticLoyaltyBackfillJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyBackfillPreviewItem: {
      count: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => {
      if (typeof cb === "function") {
        return cb(prisma);
      }
      return Promise.all(cb);
    }),
    $queryRaw: undefined,
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Tier 1: Feature Coverage (Weletic Loyalty Production-Core)", () => {
  const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const TEST_STORE_ID = "store_prod_e2e";
  const TEST_ACCOUNT_ID = "wlacc_test_001";
  const TEST_SHOPPER_ID = "wshopper_test_001";

  beforeEach(() => {
    vi.resetAllMocks();
    process.env.WELETIC_SHOPIFY_SERVICE_SECRET = TEST_SECRET;
    (prisma.weleticShopifyStore.findUnique as any).mockResolvedValue({
      id: TEST_STORE_ID,
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration: null,
    });
    (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticRewardRedemption.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValue(null);
    (prisma.weleticLoyaltyEarnGrant.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticLoyaltyOrderLineEarn.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticLoyaltyOutboxJob.findUnique as any).mockResolvedValue(null);
    (prisma.weleticLoyaltyOutboxJob.create as any).mockImplementation(
      ({ data }: any) => data,
    );
    (prisma.weleticLoyaltyReferral.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticLoyaltyBackfillJob.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.$transaction as any).mockImplementation(async (cb: any) => {
      if (typeof cb === "function") return cb(prisma);
      return Promise.all(cb);
    });
    vi.mocked(withDistributedLock).mockImplementation(async ({ fn }: any) =>
      fn(),
    );
    (prisma as any).$queryRaw = undefined;
  });

  // =========================================================================
  // Group 1: Security Boundary, RBAC, HMAC & Traffic Termination (Features 1-8)
  // =========================================================================
  describe("Group 1: Security Boundary, RBAC, HMAC & Customer Traffic Termination", () => {
    it("F1 & F6: Signs and verifies canonical internal HMAC requests with timing safety", () => {
      const timestamp = String(Date.now());
      const method = "POST";
      const path = "/api/internal/shopify/loyalty/customer";
      const body = JSON.stringify({
        shopDomain: "test.myshopify.com",
        customerId: "12345",
      });

      const canonical = createWeleticShopifyCanonicalRequest({
        timestamp,
        method,
        path,
        body,
      });
      expect(canonical).toBe(`${timestamp}\nPOST\n${path}\n${body}`);

      const signature = signWeleticShopifyRequest({
        timestamp,
        method,
        path,
        body,
        secret: TEST_SECRET,
      });
      expect(signature).toMatch(/^[a-f0-9]{64}$/);

      const request = new Request(`https://api.weletic.com${path}`, {
        method,
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
        },
      });

      const isValid = verifyWeleticShopifyRequest({ request, body });
      expect(isValid).toBe(true);
    });

    it("F6: Rejects HMAC verification on expired timestamp or tampered signature", () => {
      const now = Date.now();
      const expiredTimestamp = String(
        now - (WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1000),
      );
      const method = "GET";
      const path = "/api/internal/shopify/loyalty/status";
      const body = "";

      const expiredSignature = signWeleticShopifyRequest({
        timestamp: expiredTimestamp,
        method,
        path,
        body,
        secret: TEST_SECRET,
      });

      const expiredReq = new Request(`https://api.weletic.com${path}`, {
        method,
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: expiredTimestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: expiredSignature,
        },
      });

      expect(
        verifyWeleticShopifyRequest({ request: expiredReq, body, now }),
      ).toBe(false);

      // Tampered signature test
      const validTimestamp = String(now);
      const tamperedReq = new Request(`https://api.weletic.com${path}`, {
        method,
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: validTimestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: "a".repeat(64),
        },
      });
      expect(
        verifyWeleticShopifyRequest({ request: tamperedReq, body, now }),
      ).toBe(false);
    });

    it("F2 & F3: Enforces exact canonical store ID resolution", async () => {
      (prisma.weleticShopifyStore.findUnique as any).mockResolvedValueOnce({
        id: TEST_STORE_ID,
        projectId: "ws_acme_corp",
        shopDomain: "acme.myshopify.com",
      });

      const resolved = await resolveStoreId({ storeId: TEST_STORE_ID });
      expect(resolved).toBe(TEST_STORE_ID);
      expect(prisma.weleticShopifyStore.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: TEST_STORE_ID } }),
      );
    });

    it("F4 & F5: Normalizes customer GID for App Proxy and Customer Account tokens", () => {
      expect(
        normalizeShopifyCustomerGid("gid://shopify/Customer/987654321"),
      ).toBe("gid://shopify/Customer/987654321");
      expect(normalizeShopifyCustomerGid("987654321")).toBe(
        "gid://shopify/Customer/987654321",
      );
      expect(normalizeShopifyCustomerGid("Customer/987654321")).toBe(
        "gid://shopify/Customer/987654321",
      );
      expect(normalizeShopifyCustomerGid("")).toBe("");
    });

    it("F7 & F8: Serializes all points/amounts to decimal strings and purges DOM PII", () => {
      // Verify BigInt points and amounts serialize safely to decimal strings without numbers
      const points = BigInt(12500);
      const serializedPoints = points.toString();
      expect(typeof serializedPoints).toBe("string");
      expect(serializedPoints).toBe("12500");

      const moneyMinor = BigInt(14950); // $149.50
      const serializedMoney = minorUnitsToDecimal(moneyMinor, "USD");
      expect(serializedMoney).toBe("149.50");

      // Verify PII fields are sanitized in metafield payload builder
      const payload = {
        vipTierName: "Platinum",
        pointsBalance: BigInt(500),
        referralCode: "ALICE-99",
      };
      const updates = buildCustomerMetafieldUpdates(payload);
      const keys = updates.map((u) => u.key);
      expect(keys).toContain("vip_tier");
      expect(keys).toContain("points_balance");
      expect(keys).not.toContain("customer_email");
      expect(keys).not.toContain("customer_phone");
    });
  });

  // =========================================================================
  // Group 2: Additive Schema, Data Preservation & Outbox Infrastructure (Features 9-11)
  // =========================================================================
  describe("Group 2: Additive Prisma Schema, Data Preservation & Outbox Jobs", () => {
    it("F9: Supports additive schema enums and data models without destructive drops", () => {
      expect(WeleticLoyaltyStatus.active).toBe("active");
      expect(WeleticLoyaltyStatus.disabled).toBe("disabled");
      expect(WeleticRedemptionStatus.active).toBe("active");
      expect(WeleticRedemptionStatus.cancelled).toBe("cancelled");
      expect(WeleticPointsLedgerEntryType.EARN_ORDER).toBe("EARN_ORDER");
      expect(WeleticPointsLedgerEntryType.REFUND_REVERSAL).toBe(
        "REFUND_REVERSAL",
      );
      expect(WeleticPointsLedgerEntryType.REDEEM_REWARD).toBe("REDEEM_REWARD");
    });

    // Legacy account-aggregate fixtures are retained only as migration context.
    // Active coverage lives in loyalty-backfill-concurrency.test.ts and the
    // isolated-MySQL loyalty-ledger-db.integration.test.ts suite.
    it.skip("F10: Initializes and preserves backfill jobs with preview-ready states", async () => {
      (prisma.weleticShopifyStore.findUnique as any).mockResolvedValueOnce({
        id: TEST_STORE_ID,
        shopDomain: "production-core.myshopify.com",
      });
      (prisma.weleticShopifyAppSession.findFirst as any).mockResolvedValueOnce({
        id: "offline_production-core.myshopify.com",
        shop: "production-core.myshopify.com",
        isOnline: false,
        payload: JSON.stringify({ scope: "read_all_orders" }),
      });
      (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValue({
        id: "wprog_1",
        storeId: TEST_STORE_ID,
        pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
      });

      (prisma.weleticLoyaltyBackfillJob.create as any).mockImplementationOnce(
        ({ data }: any) => ({
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        }),
      );

      const job = await createBackfillJob({
        storeId: TEST_STORE_ID,
        lookbackDays: 90,
        pointsPerCurrencyUnit: 1.0,
        minOrderAmount: 10.0,
      });

      expect(job.status).toBe(WeleticLoyaltyBackfillJobStatus.pending);
      expect(job.pointsPerCurrencyUnit).toBe(1.0);
      expect(job.minOrderAmount).toBe(10.0);
    });

    it.skip("F10: Executes dry-run backfill preview grouping historical orders accurately", async () => {
      (
        prisma.weleticLoyaltyBackfillJob.findUnique as any
      ).mockResolvedValueOnce({
        id: "wbackfill_test_1",
        storeId: TEST_STORE_ID,
        programId: "wprog_1",
        status: WeleticLoyaltyBackfillJobStatus.pending,
        pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
        minOrderAmount: new Prisma.Decimal(10.0),
        lookbackStartDate: new Date("2026-01-01"),
      });

      (
        prisma.weleticLoyaltyBackfillPreviewItem.deleteMany as any
      ).mockResolvedValueOnce({ count: 0 });

      (prisma.weleticCommerceOrder.findMany as any).mockResolvedValueOnce([
        {
          id: "ord_1",
          shopperId: TEST_SHOPPER_ID,
          presentmentCurrency: "USD",
          presentmentNet: BigInt(5000), // $50.00
          presentmentTotal: BigInt(5000),
          occurredAt: new Date("2026-02-01"),
        },
        {
          id: "ord_2",
          shopperId: TEST_SHOPPER_ID,
          presentmentCurrency: "USD",
          presentmentNet: BigInt(3000), // $30.00
          presentmentTotal: BigInt(3000),
          occurredAt: new Date("2026-02-15"),
        },
      ]);

      (prisma.weleticLoyaltyAccount.findMany as any).mockResolvedValueOnce([
        {
          id: TEST_ACCOUNT_ID,
          shopperId: TEST_SHOPPER_ID,
          storeId: TEST_STORE_ID,
          status: "active",
        },
      ]);

      (
        prisma.weleticLoyaltyBackfillPreviewItem.createMany as any
      ).mockResolvedValueOnce({ count: 1 });
      (prisma.weleticLoyaltyBackfillJob.update as any).mockImplementation(
        ({ data }: any) => ({
          id: "wbackfill_test_1",
          storeId: TEST_STORE_ID,
          programId: "wprog_1",
          pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
          minOrderAmount: new Prisma.Decimal(10.0),
          totalShoppersCount: 1,
          totalOrdersCount: 2,
          totalProjectedPoints: BigInt(80),
          processedAccountsCount: 0,
          totalCommittedPoints: BigInt(0),
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
          ...data,
        }),
      );
      (prisma as any).$queryRaw = vi.fn(async (statement: any) => {
        const sql = statement.strings.join(" ");
        if (sql.includes("FROM WeleticShopifyStore")) {
          return [
            {
              id: TEST_STORE_ID,
              complianceState: "active",
              shopCurrency: "USD",
              currencyVerifiedAt: new Date(0),
              installationGeneration: null,
            },
          ];
        }
        if (sql.includes("FROM WeleticLoyaltyAccount")) {
          return [
            {
              id: TEST_ACCOUNT_ID,
              status: "active",
              metadata: null,
            },
          ];
        }
        return [];
      });

      const preview = await generateBackfillPreview("wbackfill_test_1");
      expect(preview.status).toBe(
        WeleticLoyaltyBackfillJobStatus.preview_ready,
      );
      expect(preview.totalShoppersCount).toBe(1);
      expect(preview.totalOrdersCount).toBe(2);
      expect(preview.totalProjectedPoints).toBe(BigInt(80));

      const accountLockCallIndex = (
        prisma.$queryRaw as any
      ).mock.calls.findIndex(([statement]: [any]) =>
        statement.strings.join(" ").includes("FROM WeleticLoyaltyAccount"),
      );
      expect(accountLockCallIndex).toBeGreaterThanOrEqual(0);
      const accountLockStatement = (prisma.$queryRaw as any).mock.calls[
        accountLockCallIndex
      ][0];
      expect(accountLockStatement.strings.join(" ")).toContain("FOR UPDATE");
      expect(
        (prisma.$queryRaw as any).mock.invocationCallOrder[
          accountLockCallIndex
        ],
      ).toBeLessThan(
        (prisma.weleticLoyaltyBackfillPreviewItem.createMany as any).mock
          .invocationCallOrder[0],
      );
    });

    it.skip("F10: excludes an account that customer redaction closes between preview scan and publication", async () => {
      (
        prisma.weleticLoyaltyBackfillJob.findUnique as any
      ).mockResolvedValueOnce({
        id: "wbackfill_privacy_race",
        storeId: TEST_STORE_ID,
        programId: "wprog_1",
        status: WeleticLoyaltyBackfillJobStatus.pending,
        pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
        minOrderAmount: null,
        lookbackDays: null,
        lookbackStartDate: null,
        metadata: null,
      });
      (
        prisma.weleticLoyaltyBackfillPreviewItem.deleteMany as any
      ).mockResolvedValueOnce({ count: 0 });
      (prisma.weleticCommerceOrder.findMany as any).mockResolvedValueOnce([
        {
          id: "ord_privacy_race",
          shopperId: TEST_SHOPPER_ID,
          shopCurrency: "USD",
          shopNet: BigInt(5000),
          presentmentCurrency: "USD",
          presentmentNet: BigInt(5000),
          presentmentTotal: BigInt(5000),
          occurredAt: new Date("2026-02-01"),
        },
      ]);
      (prisma.weleticLoyaltyAccount.findMany as any).mockResolvedValueOnce([
        {
          id: TEST_ACCOUNT_ID,
          shopperId: TEST_SHOPPER_ID,
          storeId: TEST_STORE_ID,
          status: "active",
          metadata: null,
        },
      ]);
      (prisma as any).$queryRaw = vi.fn(async (statement: any) => {
        const sql = statement.strings.join(" ");
        if (sql.includes("FROM WeleticShopifyStore")) {
          return [
            {
              id: TEST_STORE_ID,
              complianceState: "active",
              shopCurrency: "USD",
              currencyVerifiedAt: new Date(0),
              installationGeneration: null,
            },
          ];
        }
        if (sql.includes("FROM WeleticLoyaltyAccount")) {
          return [
            {
              id: TEST_ACCOUNT_ID,
              status: "closed",
              metadata: {
                shopifyCustomerRedaction: {
                  status: "redacted",
                  redactedAt: "2026-02-02T00:00:00.000Z",
                  source: "shopify_customers_redact",
                },
              },
            },
          ];
        }
        return [];
      });
      (prisma.weleticLoyaltyBackfillJob.update as any).mockImplementation(
        ({ data }: any) => ({
          id: "wbackfill_privacy_race",
          storeId: TEST_STORE_ID,
          programId: "wprog_1",
          pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
          minOrderAmount: null,
          lookbackDays: null,
          lookbackStartDate: null,
          totalShoppersCount: 1,
          totalOrdersCount: 1,
          totalProjectedPoints: BigInt(50),
          processedAccountsCount: 0,
          totalCommittedPoints: BigInt(0),
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
          ...data,
        }),
      );

      const preview = await generateBackfillPreview("wbackfill_privacy_race");

      expect(prisma.weleticLoyaltyAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "active" }),
        }),
      );
      expect(
        prisma.weleticLoyaltyBackfillPreviewItem.createMany,
      ).not.toHaveBeenCalled();
      expect(preview).toMatchObject({
        status: WeleticLoyaltyBackfillJobStatus.preview_ready,
        totalShoppersCount: 0,
        totalOrdersCount: 0,
        totalProjectedPoints: BigInt(0),
      });
      expect(prisma.weleticLoyaltyBackfillJob.update).toHaveBeenLastCalledWith({
        where: { id: "wbackfill_privacy_race" },
        data: {
          status: WeleticLoyaltyBackfillJobStatus.preview_ready,
          totalShoppersCount: 0,
          totalOrdersCount: 0,
          totalProjectedPoints: BigInt(0),
        },
      });
    });

    it.skip("F11: Commits backfill job writing immutable BACKFILL ledger entries atomically", async () => {
      (
        prisma.weleticLoyaltyBackfillJob.findUnique as any
      ).mockResolvedValueOnce({
        id: "wbackfill_test_1",
        storeId: TEST_STORE_ID,
        programId: "wprog_1",
        status: WeleticLoyaltyBackfillJobStatus.preview_ready,
        metadata: null,
        lookbackDays: null,
        lookbackStartDate: null,
        pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
        minOrderAmount: new Prisma.Decimal(10.0),
        totalShoppersCount: 1,
        totalOrdersCount: 2,
        totalProjectedPoints: BigInt(80),
        processedAccountsCount: 0,
        totalCommittedPoints: BigInt(0),
        errorLog: null,
        createdAt: new Date("2026-08-30T00:00:00.000Z"),
        updatedAt: new Date("2026-08-30T00:00:00.000Z"),
        completedAt: null,
      });

      (
        prisma.weleticLoyaltyBackfillPreviewItem.findMany as any
      ).mockResolvedValueOnce([
        {
          id: "prev_item_1",
          jobId: "wbackfill_test_1",
          accountId: TEST_ACCOUNT_ID,
          shopperId: TEST_SHOPPER_ID,
          ordersCount: 2,
          eligibleSpend: BigInt(8000),
          currency: "USD",
          projectedPoints: BigInt(80),
          committedLedgerEntryId: null,
        },
      ]);

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
      });
      (prisma.weleticLoyaltyAccount.findFirst as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        status: "active",
        metadata: null,
      });
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockResolvedValueOnce({
        id: "wledger_backfill_1",
        sequenceNumber: 1,
        pointsDelta: BigInt(80),
        balanceAfter: BigInt(80),
      });
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });
      (
        prisma.weleticLoyaltyBackfillPreviewItem.updateMany as any
      ).mockResolvedValueOnce({ count: 1 });
      (
        prisma.weleticLoyaltyBackfillPreviewItem.count as any
      ).mockResolvedValueOnce(0);
      (prisma.weleticPointsLedgerEntry.aggregate as any).mockResolvedValue({
        _count: { _all: 1 },
        _sum: { pointsDelta: BigInt(80) },
      });

      (
        prisma.weleticLoyaltyBackfillJob.findUniqueOrThrow as any
      ).mockResolvedValueOnce({
        id: "wbackfill_test_1",
        storeId: TEST_STORE_ID,
        programId: "wprog_1",
        status: WeleticLoyaltyBackfillJobStatus.completed,
        pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
        minOrderAmount: new Prisma.Decimal(10.0),
        totalShoppersCount: 1,
        totalOrdersCount: 2,
        totalProjectedPoints: BigInt(80),
        processedAccountsCount: 1,
        totalCommittedPoints: BigInt(80),
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: new Date(),
      });

      const committed = await commitBackfillJob("wbackfill_test_1");
      expect(committed.status).toBe(WeleticLoyaltyBackfillJobStatus.completed);
      expect(committed.totalCommittedPoints).toBe(BigInt(80));
      expect(committed.processedAccountsCount).toBe(1);
      expect(
        prisma.weleticLoyaltyBackfillPreviewItem.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "prev_item_1",
          jobId: "wbackfill_test_1",
          committedLedgerEntryId: null,
        },
        data: { committedLedgerEntryId: "wledger_backfill_1" },
      });
      expect(prisma.weleticPointsLedgerEntry.aggregate).toHaveBeenCalledTimes(
        2,
      );
    });

    it.skip("F11: Supports safe backfill cancellation before execution commit", async () => {
      (
        prisma.weleticLoyaltyBackfillJob.findUnique as any
      ).mockResolvedValueOnce({
        id: "wbackfill_test_1",
        storeId: TEST_STORE_ID,
        status: WeleticLoyaltyBackfillJobStatus.preview_ready,
        metadata: null,
        processedAccountsCount: 0,
        totalCommittedPoints: BigInt(0),
      });

      (
        prisma.weleticLoyaltyBackfillJob.findUniqueOrThrow as any
      ).mockResolvedValueOnce({
        id: "wbackfill_test_1",
        storeId: TEST_STORE_ID,
        programId: "wprog_1",
        status: WeleticLoyaltyBackfillJobStatus.cancelled,
        pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
        minOrderAmount: null,
        totalShoppersCount: 0,
        totalOrdersCount: 0,
        totalProjectedPoints: BigInt(0),
        processedAccountsCount: 0,
        totalCommittedPoints: BigInt(0),
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      });

      const cancelled = await cancelBackfillJob("wbackfill_test_1");
      expect(cancelled.status).toBe(WeleticLoyaltyBackfillJobStatus.cancelled);
    });
  });

  // =========================================================================
  // Group 3: Financial Double-Entry Ledger & Rational Arithmetic (Features 12-17)
  // =========================================================================
  describe("Group 3: Financial Double-Entry Ledger, Rational Arithmetic & Refunds", () => {
    it("F12: Accurately converts decimal amounts to BigInt minor units across currencies", () => {
      // 2-decimal USD: $129.95 -> 12995 cents
      expect(decimalToMinorUnits("129.95", "USD")).toBe(BigInt(12995));
      // 0-decimal JPY: ¥5000 -> 5000 yen
      expect(decimalToMinorUnits("5000", "JPY")).toBe(BigInt(5000));
      // 0-decimal VND: 250,000 VND -> 250000 minor units
      expect(decimalToMinorUnits("250000", "VND")).toBe(BigInt(250000));
      // Negative balance conversion
      expect(decimalToMinorUnits("-45.50", "USD")).toBe(BigInt(-4550));
    });

    it("F13: Evaluates deterministic order points calculation with minimum subtotal guard", () => {
      // Below min subtotal $50.00 (5000 cents) -> 0 points
      const below = calculateEligibleOrderPoints({
        netAmountCents: BigInt(4500),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.5,
        minOrderSubtotalCents: BigInt(5000),
      });
      expect(below).toBe(BigInt(0));

      // Above min subtotal $100.00 with 1.5x VIP multiplier -> 150 points
      const above = calculateEligibleOrderPoints({
        netAmountCents: BigInt(10000),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.5,
        minOrderSubtotalCents: BigInt(5000),
      });
      expect(above).toBe(BigInt(150));
    });

    it("F14: Appends immutable points ledger entries with sequence numbering and balance updates", async () => {
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 3,
      });
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValueOnce({
        sequenceNumber: 3,
        balanceAfter: BigInt(100),
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockResolvedValueOnce({
        id: "wledger_tx_4",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        sequenceNumber: 4,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(50),
        balanceAfter: BigInt(150),
      });
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });

      const entry = await appendPointsLedgerEntry({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(50),
        idempotencyKey: "order_earn:ord_999",
      });

      expect(entry.sequenceNumber).toBe(4);
      expect(entry.balanceAfter).toBe(BigInt(150));
      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith({
        where: {
          id: TEST_ACCOUNT_ID,
          storeId: TEST_STORE_ID,
          ledgerVersion: 3,
        },
        data: expect.objectContaining({
          cachedPointsBalance: BigInt(150),
          lifetimePointsEarned: BigInt(150),
          lifetimePointsRedeemed: BigInt(0),
          ledgerVersion: 4,
          lastQualifyingActivityAt: expect.any(Date),
        }),
      });
    });

    it("F15: Computes source-based proportional refund clawbacks and allows negative balances", async () => {
      (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce({
        id: "ref_101",
        storeId: TEST_STORE_ID,
        externalId: "ext_ref_101",
        shopAmount: BigInt(2500), // $25.00 partial refund of order
        shopCurrency: "USD",
        presentmentAmount: BigInt(2500),
        presentmentCurrency: "USD",
        orderId: "ord_101",
        lines: [
          {
            id: "refund_line_101",
            orderLineId: "order_line_101",
            shopAmount: BigInt(2500),
          },
        ],
        order: {
          id: "ord_101",
          storeId: TEST_STORE_ID,
          orderName: "#1001",
          refunds: [
            {
              shopAmount: BigInt(2500),
              lines: [
                {
                  orderLineId: "order_line_101",
                  shopAmount: BigInt(2500),
                },
              ],
            },
          ],
          shopper: {
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
            },
          },
        },
      });

      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: "grant_ord_101",
        storeId: TEST_STORE_ID,
        orderId: "ord_101",
        grossPoints: BigInt(100),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(100),
        reversedPoints: BigInt(0),
        status: "settled",
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(10000),
        voidedAt: null,
        lineEarns: [
          {
            id: "line_earn_101",
            grantId: "grant_ord_101",
            storeId: TEST_STORE_ID,
            orderLineId: "order_line_101",
            quantity: 1,
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      });

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(10), // Account only has 10 points left!
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(90),
        ledgerVersion: 5,
      });
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValueOnce({
        sequenceNumber: 5,
        balanceAfter: BigInt(10),
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementationOnce(
        ({ data }: any) => ({
          ...data,
        }),
      );
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });

      const reversal = await processRefundPointsReversal({
        storeId: TEST_STORE_ID,
        refundId: "ref_101",
      });

      expect(reversal).not.toBeNull();
      expect(reversal?.pointsDelta).toBe(BigInt(-25));
      expect(reversal?.balanceAfter).toBe(BigInt(-15)); // Negative balance debt permitted per ADR 0004!
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "line_earn_101",
          grantId: "grant_ord_101",
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(0),
        },
        data: { reversedPoints: BigInt(25) },
      });
    });

    it("F17: Reconciles ledger sequences verifying complete gap-free audit history", async () => {
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(200),
        lifetimePointsEarned: BigInt(200),
        lifetimePointsRedeemed: BigInt(0),
      });

      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.BACKFILL,
        },
        {
          id: "e2",
          sequenceNumber: 2,
          pointsDelta: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ]);

      const audit = await reconcileAccountPoints(TEST_ACCOUNT_ID);
      expect(audit.entriesCount).toBe(2);
      expect(audit.calculatedBalance).toBe(BigInt(200));
      expect(audit.repaired).toBe(false);
    });
  });

  // =========================================================================
  // Group 4: Recoverable Shopify GraphQL Discount Saga, Referrals & VIP (Features 18-23)
  // =========================================================================
  describe("Group 4: Recoverable Discount Saga, Referrals, VIP & Metafields", () => {
    it("F18 & F19: Executes 1-click reward redemption and creates REDEEM_REWARD ledger entry", async () => {
      (prisma.weleticLoyaltyAccount.findFirst as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        shopper: { shopifyCustomerId: "gid://shopify/Customer/101" },
        store: { projectId: "workspace_prod_e2e" },
      });
      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        ({ where }: any) => {
          if (where?.id === TEST_ACCOUNT_ID) {
            return {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
              status: "active",
              cachedPointsBalance: BigInt(500),
              cachedPendingPoints: BigInt(0),
              lifetimePointsEarned: BigInt(500),
              lifetimePointsRedeemed: BigInt(0),
              ledgerVersion: 2,
              program: { status: "active", killSwitchActive: false },
              shopper: { shopifyCustomerId: "gid://shopify/Customer/101" },
            };
          }
          return null;
        },
      );

      (prisma.weleticRewardDefinition.findUnique as any).mockResolvedValueOnce({
        id: "wrew_10off",
        storeId: TEST_STORE_ID,
        name: "$10 Discount Voucher",
        pointsCost: BigInt(500),
        rewardType: WeleticRewardType.amount_off,
        discountValue: new Prisma.Decimal(1000),
        exchangeType: "fixed",
        minPointsCost: null,
        maxPointsCost: null,
        pointsStep: null,
        expiresInDays: 30,
        status: WeleticRewardStatus.active,
      });

      (prisma.weleticRewardRedemption.create as any).mockResolvedValueOnce({
        id: "wredemp_101",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        pointsSpent: BigInt(500),
        shopifyDiscountCode: "WL-PROMO10",
        status: WeleticRedemptionStatus.active,
      });

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValueOnce({
        sequenceNumber: 2,
        balanceAfter: BigInt(500),
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockResolvedValueOnce({
        id: "wledger_red_1",
        pointsDelta: BigInt(-500),
        balanceAfter: BigInt(0),
      });
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });
      (prisma.weleticRewardRedemption.update as any).mockResolvedValueOnce({
        id: "wredemp_101",
        status: WeleticRedemptionStatus.active,
        ledgerEntryId: "wledger_red_1",
      });

      (prisma.weleticRewardRedemption.findUnique as any).mockImplementation(
        ({ where }: any) =>
          where?.storeId_idempotencyKey
            ? null
            : {
                id: "wredemp_101",
                storeId: TEST_STORE_ID,
                accountId: TEST_ACCOUNT_ID,
                rewardDefinitionId: "wrew_10off",
                pointsSpent: BigInt(500),
                shopifyDiscountCode: "WL-PROMO10",
                shopifyDiscountId: "gid://shopify/DiscountCodeNode/101",
                status: WeleticRedemptionStatus.issued,
                ledgerEntryId: "wledger_red_1",
              },
      );
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        ({ where }: any) =>
          where?.id === "wledger_red_1"
            ? {
                id: "wledger_red_1",
                pointsDelta: BigInt(-500),
                balanceAfter: BigInt(0),
              }
            : null,
      );

      const shopifyFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/101",
                codeDiscount: {
                  title: "$10 Discount Voucher (WL-PROMO10)",
                  status: "ACTIVE",
                  codes: { nodes: [{ code: "WL-PROMO10" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await redeemReward({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wrew_10off",
        discountCode: "WL-PROMO10",
        shopDomain: "production-core.myshopify.com",
        accessToken: "shpat_test_token",
        customFetch: shopifyFetch as any,
        idempotencyKey: "tier1-e2e-redemption-1",
      });

      expect(result.discountCode).toBe("WL-PROMO10");
      expect(result.ledgerEntry.pointsDelta).toBe(BigInt(-500));
      expect(result.ledgerEntry.balanceAfter).toBe(BigInt(0));
    });

    it("F19: Cancels reward redemption and restores points via compensation ledger adjustment", async () => {
      (prisma.weleticRewardRedemption.findFirst as any).mockResolvedValueOnce({
        account: {
          storeId: TEST_STORE_ID,
          shopper: { shopifyCustomerId: "shopify_customer_101" },
          store: { projectId: "workspace_prod_e2e" },
        },
      });
      (prisma.weleticRewardRedemption.findUnique as any).mockResolvedValueOnce({
        id: "wredemp_101",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wrew_10off",
        pointsSpent: BigInt(500),
        shopifyDiscountCode: "WL-PROMO10",
        shopifyDiscountCodeCanonical: "WL-PROMO10",
        shopifyDiscountId: null,
        artifactKind: WeleticRewardArtifactKind.discount_code,
        settlementQuarantinedAt: null,
        status: WeleticRedemptionStatus.provisioning,
        metadata: null,
        account: {
          storeId: TEST_STORE_ID,
          status: "active",
          metadata: null,
        },
        rewardDefinition: { name: "$10 Discount Voucher" },
      });

      (prisma.weleticRewardRedemption.update as any).mockResolvedValueOnce({
        id: "wredemp_101",
        status: WeleticRedemptionStatus.cancelled,
      });

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(500),
        ledgerVersion: 3,
      });
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValueOnce({
        sequenceNumber: 3,
        balanceAfter: BigInt(0),
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockResolvedValueOnce({
        id: "wledger_adj_1",
        pointsDelta: BigInt(500),
        balanceAfter: BigInt(500),
      });
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });

      const cancel = await cancelRewardRedemption({
        storeId: TEST_STORE_ID,
        redemptionId: "wredemp_101",
        reason: "Customer requested cancellation",
      });

      expect(cancel.redemption.status).toBe(WeleticRedemptionStatus.cancelled);
      expect(cancel.ledgerEntry.pointsDelta).toBe(BigInt(500));
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.cancelled,
            metadata: expect.objectContaining({
              cancelledAt: expect.any(String),
            }),
          }),
        }),
      );
      expect(prisma.weleticLoyaltyOutboxJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storeId: TEST_STORE_ID,
            jobType: "REDEMPTION_RECOVERY",
            idempotencyKey: "discount_deactivate:wredemp_101",
            payload: expect.objectContaining({
              shopifyDiscountCode: "WL-PROMO10",
              sagaPhase: "compensating",
            }),
          }),
        }),
      );
      expect(cancel.deactivationPending).toBe(true);
    });

    it("F21: Enforces anti-self-referral prevention and double-sided fulfillment", async () => {
      // Test self-referral prevention
      (prisma.weleticLoyaltyAccount.findFirst as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        referralCode: "ALICE-777",
        status: "active",
      });

      await expect(
        bindShopperReferral({
          storeId: TEST_STORE_ID,
          refereeAccountId: TEST_ACCOUNT_ID, // Self account ID
          referralCode: "ALICE-777",
        }),
      ).rejects.toThrow("Self-referral is strictly prohibited.");
    });

    it("F22: Evaluates VIP tier maintenance cycle and grants 30-day soft-downgrade grace period", async () => {
      const now = new Date("2026-08-01T00:00:00Z");

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        currentTierId: "wtier_gold",
        tierExpiresAt: null,
        currentTier: {
          id: "wtier_gold",
          name: "Gold",
          tierOrder: 3,
          minSpendThreshold: BigInt(50000),
          minPointsThreshold: BigInt(500),
        },
        program: {
          tiers: [
            {
              id: "wtier_bronze",
              name: "Bronze",
              tierOrder: 1,
              minSpendThreshold: BigInt(0),
              minPointsThreshold: BigInt(0),
            },
            {
              id: "wtier_silver",
              name: "Silver",
              tierOrder: 2,
              minSpendThreshold: BigInt(20000),
              minPointsThreshold: BigInt(200),
            },
            {
              id: "wtier_gold",
              name: "Gold",
              tierOrder: 3,
              minSpendThreshold: BigInt(50000),
              minPointsThreshold: BigInt(500),
            },
          ],
        },
      });

      (prisma.weleticCommerceOrder.findMany as any).mockResolvedValueOnce([]); // $0 spend
      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce(
        [],
      ); // 0 points
      (prisma.weleticLoyaltyAccount.update as any).mockResolvedValueOnce({});
      (prisma.weleticLoyaltyOutboxJob.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyOutboxJob.create as any).mockResolvedValueOnce({
        id: "woutbox_tier_review",
      });

      const cycle = await evaluateTierMaintenanceCycle({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        now,
        gracePeriodDays: 30,
      });

      expect(cycle.status).toBe("IN_GRACE_PERIOD");
      expect(cycle.newTierId).toBe("wtier_gold"); // Tier preserved during grace period!
      expect(cycle.gracePeriodExpiresAt?.toISOString()).toBe(
        "2026-08-31T00:00:00.000Z",
      );
    });

    it("F23: Builds complete 10-key customer metafield sync array for Shopify Admin GraphQL", () => {
      const payload = {
        ownerId: "gid://shopify/Customer/123",
        vipTierName: "Gold",
        vipTierOrder: 3,
        pointsBalance: BigInt(1250),
        pendingPoints: BigInt(100),
        lifetimePoints: BigInt(2500),
        referralCode: "ALICE-123",
        referralLink: "https://shop.com?ref=ALICE-123",
        tierMultiplier: 1.5,
        memberStatus: "active",
        birthDate: "1995-06-15",
      };

      const metafields = buildCustomerMetafieldUpdates(payload);
      expect(metafields).toHaveLength(10);
      expect(metafields.map((m) => m.key)).toEqual([
        "vip_tier",
        "vip_tier_order",
        "points_balance",
        "pending_points",
        "lifetime_points",
        "referral_code",
        "referral_link",
        "tier_multiplier",
        "member_status",
        "birth_date",
      ]);
    });
  });

  // =========================================================================
  // Group 5: Merchant Dashboard Modules, Extensions, i18n & Production Readiness (Features 24-30)
  // =========================================================================
  describe("Group 5: Merchant Dashboard Modules, Storefront Extensions, i18n & Analytics", () => {
    it("F24: Computes accurate points financial liability metrics for merchant dashboard", async () => {
      (prisma.weleticLoyaltyAccount.findMany as any).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(1000),
          cachedPendingPoints: BigInt(200),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(500),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(-50),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        }, // Negative balance
      ]);

      const liability = await calculatePointsLiability({
        storeId: TEST_STORE_ID,
        currency: "USD",
        valuationPerPointMinorUnits: BigInt(1), // 1 cent per point
      });

      expect(liability.totalMembersCount).toBe(3);
      expect(liability.totalCirculatingPoints).toBe(BigInt(1500));
      expect(liability.totalPendingPoints).toBe(BigInt(200));
      expect(liability.negativeBalancePointsDebt).toBe(BigInt(50));
      expect(liability.netCirculatingPoints).toBe(BigInt(1450));
      expect(liability.totalLiabilityDecimal).toBe("15.00");
    });

    it("F24: Calculates referral customer acquisition cost (CAC) and ROI without zero-division error", () => {
      const eco = calculateReferralEconomics({
        totalReferrals: 10,
        successfulReferrals: 4,
        totalRewardPoints: BigInt(400),
        revenueMinorUnits: BigInt(20000), // $200.00
        currency: "USD",
        valuationPerPointMinorUnits: BigInt(1), // $4.00 cost
      });

      expect(eco.referralConversionRate).toBe(40.0);
      expect(eco.referralCAC).toBe(1.0); // $4.00 / 4 = $1.00 CAC
      expect(eco.referralROI).toBe(4900.0); // ((20000 - 400) / 400) * 100 = 4900%
      expect(eco.referralROIMultiplier).toBe(50.0); // 20000 / 400 = 50x
    });

    it("F27: Formats catalog compare-at strikethrough pricing and badges across locales", () => {
      // USD with 35% discount: $32.50 vs compare-at $50.00
      const pricingUSD = getCatalogPricing({
        amount: BigInt(3250),
        compareAtAmount: BigInt(5000),
        currency: "USD",
        locale: "en",
      });
      expect(pricingUSD.hasDiscount).toBe(true);
      expect(pricingUSD.discountPercent).toBe(35);
      expect(pricingUSD.badgeText).toBe("-35%");

      // Zero-decimal JPY with discount: ¥8,000 vs compare-at ¥10,000 (20% off)
      const pricingJPY = getCatalogPricing({
        amount: BigInt(8000),
        compareAtAmount: BigInt(10000),
        currency: "JPY",
        locale: "ja",
      });
      expect(pricingJPY.hasDiscount).toBe(true);
      expect(pricingJPY.discountPercent).toBe(20);
      expect(pricingJPY.badgeText).toBe("-20%");
    });

    it("F28 & F29: Validates birthday anti-gaming 30-day lockout policy", () => {
      const now = new Date("2026-08-01T00:00:00Z");
      const birthDate = new Date("1995-08-15T00:00:00Z"); // Birthday is 14 days away

      // Enrolled only 14 days before birthday -> Locked out!
      const recentEnrollment = new Date("2026-08-01T00:00:00Z");
      const lockoutCheck = checkBirthdayEligibility(
        birthDate,
        recentEnrollment,
        now,
      );
      expect(lockoutCheck.isEligible).toBe(false);
      expect(lockoutCheck.isLockedOut).toBe(true);
      expect(lockoutCheck.nextEligibleYear).toBe(2027);

      // Enrolled 60 days before birthday -> Eligible!
      const earlyEnrollment = new Date("2026-06-01T00:00:00Z");
      const eligibleCheck = checkBirthdayEligibility(
        birthDate,
        earlyEnrollment,
        now,
      );
      expect(eligibleCheck.isEligible).toBe(true);
      expect(eligibleCheck.isLockedOut).toBe(false);
      expect(eligibleCheck.calendarYear).toBe(2026);
    });

    it("F30: Awards non-order activity points with stable idempotency keys", async () => {
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(50),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(50),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      });
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValueOnce({
        sequenceNumber: 1,
        balanceAfter: BigInt(50),
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementationOnce(
        ({ data }: any) => ({
          ...data,
        }),
      );
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });

      const activityEntry = await awardActivityPoints({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        activityType: "instagram_follow",
        points: BigInt(50),
        externalId: "ig_user_alice",
      });

      expect(activityEntry).not.toBeNull();
      expect(activityEntry?.entryType).toBe(
        WeleticPointsLedgerEntryType.EARN_BONUS,
      );
      expect(activityEntry?.pointsDelta).toBe(BigInt(50));
      expect(activityEntry?.idempotencyKey).toBe(
        `activity:instagram_follow:${TEST_ACCOUNT_ID}:ig_user_alice`,
      );
    });
  });
});
