import { prisma } from "@/lib/prisma";
import { calculatePointsLiability } from "@/lib/weletic/loyalty/analytics";
import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import {
  appendPointsLedgerEntry,
  getAccountPointsBalance,
} from "@/lib/weletic/loyalty/ledger";
import { checkBirthdayEligibility } from "@/lib/weletic/loyalty/non-purchase-earn";
import { redeemReward } from "@/lib/weletic/loyalty/rewards";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import {
  currencyMinorUnits,
  decimalToMinorUnits,
  discountPercent,
  formatCompareAtPrice,
  getCatalogPricing,
  hasDiscount,
  minorUnitsToDecimal,
  normalizeCurrency,
} from "@/lib/weletic/money";
import {
  readWeleticShopifyRequestBody,
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_MAX_BODY_BYTES,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import {
  WeleticPointsLedgerEntryType,
  WeleticRewardStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticPointsLedgerEntry: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
    },
    weleticRewardRedemption: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyReferral: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) => data),
    },
    weleticLoyaltyTierHistory: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => {
      if (typeof cb === "function") return cb(prisma);
      return Promise.all(cb);
    }),
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Tier 2: Boundary & Corner Cases (Weletic Loyalty Production-Core)", () => {
  const TEST_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
  const TEST_STORE_ID = "store_boundary_e2e";
  const TEST_ACCOUNT_ID = "wlacc_boundary_001";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WELETIC_SHOPIFY_SERVICE_SECRET = TEST_SECRET;
  });

  // =========================================================================
  // Boundary 1: Zero-Decimal Currencies (JPY, VND, KRW vs USD, EUR)
  // =========================================================================
  describe("Boundary 1: Zero-Decimal Currencies & Minor Unit Conversions", () => {
    it("identifies 0-decimal currencies and handles currencyMinorUnits accurately", () => {
      expect(currencyMinorUnits("JPY")).toBe(0);
      expect(currencyMinorUnits("VND")).toBe(0);
      expect(currencyMinorUnits("KRW")).toBe(0);
      expect(currencyMinorUnits("USD")).toBe(2);
      expect(currencyMinorUnits("EUR")).toBe(2);
      expect(currencyMinorUnits("GBP")).toBe(2);
    });

    it("converts decimal strings to minor units without floating point loss", () => {
      // Zero-decimal JPY: "10000" -> 10000n
      expect(decimalToMinorUnits("10000", "JPY")).toBe(BigInt(10000));
      // 2-decimal USD: "0.01" -> 1n, "0.005" -> 1n (rounds up at half)
      expect(decimalToMinorUnits("0.01", "USD")).toBe(BigInt(1));
      expect(decimalToMinorUnits("0.005", "USD")).toBe(BigInt(1));
      expect(decimalToMinorUnits("0.004", "USD")).toBe(BigInt(0));
      // Extreme number conversion
      expect(decimalToMinorUnits("999999999.99", "USD")).toBe(
        BigInt(99999999999),
      );
    });

    it("serializes minor units back to decimal string formatted correctly", () => {
      expect(minorUnitsToDecimal(BigInt(10000), "JPY")).toBe("10000");
      expect(minorUnitsToDecimal(BigInt(500000), "VND")).toBe("500000");
      expect(minorUnitsToDecimal(BigInt(10000), "USD")).toBe("100.00");
      expect(minorUnitsToDecimal(BigInt(5), "USD")).toBe("0.05");
      expect(minorUnitsToDecimal(BigInt(-4550), "USD")).toBe("-45.50");
      expect(minorUnitsToDecimal(BigInt(-1000), "JPY")).toBe("-1000");
    });

    it("calculates order points for zero-decimal JPY/VND at fractional points-per-unit rates", () => {
      // ¥15,000 JPY at 1 pt per ¥100 (0.01 rate) -> 150 points
      const pointsJPY = calculateEligibleOrderPoints({
        netAmountCents: BigInt(15000),
        currency: "JPY",
        pointsPerCurrencyUnit: 0.01,
        multiplier: 1.0,
      });
      expect(pointsJPY).toBe(BigInt(150));

      // 1,250,000 VND at 1 pt per 1,000 VND (0.001 rate) with 2x multiplier -> 2500 points
      const pointsVND = calculateEligibleOrderPoints({
        netAmountCents: BigInt(1250000),
        currency: "VND",
        pointsPerCurrencyUnit: 0.001,
        multiplier: 2.0,
      });
      expect(pointsVND).toBe(BigInt(2500));
    });

    it("formats catalog prices and compare-at prices for zero-decimal currencies without decimals", () => {
      const jpyPricing = getCatalogPricing({
        amount: BigInt(6000),
        compareAtAmount: BigInt(8000),
        currency: "JPY",
        locale: "ja",
      });
      expect(jpyPricing.hasDiscount).toBe(true);
      expect(jpyPricing.discountPercent).toBe(25);
      expect(jpyPricing.formattedPrice).toContain("6,000");
      expect(jpyPricing.formattedCompareAtPrice).toContain("8,000");
    });
  });

  // =========================================================================
  // Boundary 2: Negative Available Points Balances Allowance
  // =========================================================================
  describe("Boundary 2: Negative Available Points Balances & Ledger Debt Tracking", () => {
    it("allows negative points delta resulting in negative cached balance", async () => {
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(20),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(80),
        ledgerVersion: 5,
      });
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValueOnce({
        sequenceNumber: 5,
        balanceAfter: BigInt(20),
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementationOnce(
        ({ data }: any) => ({
          ...data,
        }),
      );
      (prisma.weleticLoyaltyAccount.update as any).mockResolvedValueOnce({});

      // Refund of 50 points when only 20 points available -> balance drops to -30
      const entry = await appendPointsLedgerEntry({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(-50),
        idempotencyKey: "refund_rev:ord_boundary_1",
      });

      expect(entry.pointsDelta).toBe(BigInt(-50));
      expect(entry.balanceAfter).toBe(BigInt(-30));
    });

    it("correctly identifies negative balance debt in account summary", async () => {
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        status: "active",
        cachedPointsBalance: BigInt(-75),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(100),
      });

      const summary = await getAccountPointsBalance(TEST_ACCOUNT_ID);
      expect(summary?.isNegative).toBe(true);
      expect(summary?.canRedeem).toBe(false);
      expect(summary?.pointsBalance).toBe(BigInt(-75));
    });

    it("tracks negative balance accounts and debt in merchant liability calculations", async () => {
      (prisma.weleticLoyaltyAccount.findMany as any).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(500),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(-120),
          cachedPendingPoints: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ]);

      const liability = await calculatePointsLiability({
        storeId: TEST_STORE_ID,
        currency: "USD",
        valuationPerPointMinorUnits: BigInt(1),
      });

      expect(liability.totalCirculatingPoints).toBe(BigInt(500));
      expect(liability.negativeBalancePointsDebt).toBe(BigInt(120));
      expect(liability.negativeBalanceAccountsCount).toBe(1);
      expect(liability.netCirculatingPoints).toBe(BigInt(380));
    });

    it("blocks reward redemptions when balance is negative or below cost", async () => {
      (prisma.weleticLoyaltyAccount.findFirst as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        shopper: { shopifyCustomerId: "gid://shopify/Customer/boundary" },
        store: { projectId: "workspace_boundary_e2e" },
      });
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        status: "active",
        cachedPointsBalance: BigInt(-20),
        program: { status: "active", killSwitchActive: false },
      });

      (prisma.weleticRewardDefinition.findUnique as any).mockResolvedValueOnce({
        id: "wrew_5off",
        storeId: TEST_STORE_ID,
        pointsCost: BigInt(100),
        status: WeleticRewardStatus.active,
      });

      await expect(
        redeemReward({
          storeId: TEST_STORE_ID,
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wrew_5off",
          idempotencyKey: "tier2-boundary-redemption-1",
        }),
      ).rejects.toThrow("Insufficient points balance");
    });
  });

  // =========================================================================
  // Boundary 3: Empty, Malformed, Overflow & Extreme Inputs
  // =========================================================================
  describe("Boundary 3: Empty, Malformed & Boundary Input Handling", () => {
    it("handles zero and negative amounts in calculateEligibleOrderPoints gracefully", () => {
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(0),
          currency: "USD",
        }),
      ).toBe(BigInt(0));

      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(-500),
          currency: "USD",
        }),
      ).toBe(BigInt(0));
    });

    it("throws on invalid ISO 4217 currency codes", () => {
      expect(() => normalizeCurrency("")).toThrow("Invalid ISO 4217");
      expect(() => normalizeCurrency("US")).toThrow("Invalid ISO 4217");
      expect(() => normalizeCurrency("USDD")).toThrow("Invalid ISO 4217");
      expect(() => normalizeCurrency("123")).toThrow("Invalid ISO 4217");
    });

    it("handles extreme discount percentages and non-discount scenarios", () => {
      expect(hasDiscount(1000, 1000)).toBe(false); // Same price -> no discount
      expect(hasDiscount(1000, 500)).toBe(false); // Compare at lower -> no discount
      expect(hasDiscount(0, 5000)).toBe(true); // 100% free product discount
      expect(discountPercent(0, 5000)).toBe(100);

      expect(formatCompareAtPrice(null, "USD")).toBeNull();
      expect(formatCompareAtPrice("", "USD")).toBeNull();
    });
  });

  // =========================================================================
  // Boundary 4: Invalid Tokens, Expired HMAC Signatures & Header Tampering
  // =========================================================================
  describe("Boundary 4: Invalid HMAC Tokens, Skew & Body Limit Protections", () => {
    it("enforces max request body size limit of 256KB", async () => {
      // Over 256KB declared in content-length header
      const oversizedReq = new Request("https://api.weletic.com/api/internal", {
        method: "POST",
        headers: {
          "content-length": String(WELETIC_SHOPIFY_MAX_BODY_BYTES + 1),
        },
        body: "x".repeat(100),
      });

      const bodyResult = await readWeleticShopifyRequestBody(oversizedReq);
      expect(bodyResult).toBeNull();
    });

    it("rejects request if signature header is missing or non-hex string", () => {
      const req = new Request("https://api.weletic.com/api/internal", {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(Date.now()),
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: "invalid-non-hex-sig",
        },
      });
      expect(verifyWeleticShopifyRequest({ request: req, body: "" })).toBe(
        false,
      );
    });

    it("rejects request when timestamp is outside 5-minute clock skew window", () => {
      const now = Date.now();
      const futureTimestamp = String(
        now + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 5000,
      );
      const signature = signWeleticShopifyRequest({
        timestamp: futureTimestamp,
        method: "GET",
        path: "/test",
        body: "",
        secret: TEST_SECRET,
      });

      const req = new Request("https://api.weletic.com/test", {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: futureTimestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
        },
      });

      expect(verifyWeleticShopifyRequest({ request: req, body: "", now })).toBe(
        false,
      );
    });
  });

  // =========================================================================
  // Boundary 5: 30-Day Birthday Lockout & Leap Year Boundaries
  // =========================================================================
  describe("Boundary 5: 30-Day Birthday Anti-Gaming Lockout & Leap Year Handling", () => {
    it("accurately handles exactly 30 days lead time (eligible threshold)", () => {
      const now = new Date("2026-08-01T00:00:00Z");
      const registrationDate = new Date("2026-07-02T00:00:00Z");
      const birthday = new Date("1990-08-01T00:00:00Z"); // Exactly 30 days from July 2 to Aug 1

      const check = checkBirthdayEligibility(birthday, registrationDate, now);
      expect(check.leadTimeDays).toBe(30);
      expect(check.isEligible).toBe(true);
      expect(check.isLockedOut).toBe(false);
      expect(check.calendarYear).toBe(2026);
    });

    it("accurately locks out at 29 days lead time (1 day short of requirement)", () => {
      const now = new Date("2026-08-01T00:00:00Z");
      const registrationDate = new Date("2026-07-03T00:00:00Z"); // 29 days lead time
      const birthday = new Date("1990-08-01T00:00:00Z");

      const check = checkBirthdayEligibility(birthday, registrationDate, now);
      expect(check.leadTimeDays).toBe(29);
      expect(check.isEligible).toBe(false);
      expect(check.isLockedOut).toBe(true);
      expect(check.nextEligibleYear).toBe(2027);
    });

    it("handles Feb 29 leap year birthdays gracefully across leap and non-leap years", () => {
      const feb29Birthday = new Date("2000-02-29T00:00:00Z");
      const earlyRegistration = new Date("2025-01-01T00:00:00Z");

      // In non-leap year 2025, clamps to Feb 28
      const check2025 = checkBirthdayEligibility(
        feb29Birthday,
        earlyRegistration,
        new Date("2025-02-28T00:00:00Z"),
      );
      expect(check2025.isEligible).toBe(true);
      expect(check2025.birthdayThisYear.getUTCDate()).toBe(28);

      // In leap year 2028, uses Feb 29
      const check2028 = checkBirthdayEligibility(
        feb29Birthday,
        earlyRegistration,
        new Date("2028-02-29T00:00:00Z"),
      );
      expect(check2028.isEligible).toBe(true);
      expect(check2028.birthdayThisYear.getUTCDate()).toBe(29);
    });
  });

  // =========================================================================
  // Boundary 6: 30-Day VIP Soft-Downgrade Grace Periods & Demotions
  // =========================================================================
  describe("Boundary 6: VIP Soft-Downgrade Grace Periods & Demotion Boundaries", () => {
    it("demotes by exactly single-tier step-down when grace period expires", async () => {
      const now = new Date("2026-09-01T00:00:00Z");
      const expiredGrace = new Date("2026-08-31T00:00:00Z"); // Grace period ended yesterday

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        currentTierId: "wtier_gold", // Gold (Rank 3)
        tierExpiresAt: expiredGrace,
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
      );
      (prisma.weleticLoyaltyAccount.update as any).mockResolvedValueOnce({});

      const result = await evaluateTierMaintenanceCycle({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        now,
      });

      expect(result.status).toBe("DEMOTED");
      expect(result.previousTierId).toBe("wtier_gold");
      expect(result.newTierId).toBe("wtier_silver"); // Single-tier step down to Silver, not directly to Bronze!
    });

    it("does not demote below the lowest base tier", async () => {
      const now = new Date("2026-09-01T00:00:00Z");

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        currentTierId: "wtier_bronze",
        currentTier: {
          id: "wtier_bronze",
          name: "Bronze",
          tierOrder: 1,
          minSpendThreshold: BigInt(0),
          minPointsThreshold: BigInt(0),
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
          ],
        },
      });

      (prisma.weleticCommerceOrder.findMany as any).mockResolvedValueOnce([]);
      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce(
        [],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        now,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.newTierId).toBe("wtier_bronze");
      expect(result.tierChanged).toBe(false);
    });

    it("clears grace period when member spends enough to re-qualify", async () => {
      const now = new Date("2026-08-15T00:00:00Z");
      const activeGrace = new Date("2026-08-31T00:00:00Z");

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        currentTierId: "wtier_silver",
        tierExpiresAt: activeGrace,
        currentTier: {
          id: "wtier_silver",
          name: "Silver",
          tierOrder: 2,
          minSpendThreshold: BigInt(20000),
          minPointsThreshold: BigInt(200),
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
          ],
        },
      });

      // Member completed a $250 order qualifying for Silver!
      (prisma.weleticCommerceOrder.findMany as any).mockResolvedValueOnce([
        { presentmentNet: BigInt(25000) },
      ]);
      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce([
        { pointsDelta: BigInt(250) },
      ]);
      (prisma.weleticLoyaltyAccount.update as any).mockResolvedValueOnce({});

      const result = await evaluateTierMaintenanceCycle({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        now,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.newTierId).toBe("wtier_silver");
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tierExpiresAt: null }),
        }),
      );
    });
  });
});
