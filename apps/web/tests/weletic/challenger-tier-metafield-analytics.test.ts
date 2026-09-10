import { prisma } from "@/lib/prisma";
import {
  calculatePointsLiability,
  calculateReferralEconomics,
} from "@/lib/weletic/loyalty/analytics";
import {
  buildCustomerMetafieldUpdates,
  normalizeShopifyCustomerGid,
  WELETIC_LOYALTY_NAMESPACE,
} from "@/lib/weletic/loyalty/metafield-sync";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Accounting/projection fixtures do not model notification provenance.
// Actual promotion notification atomicity has separate SQL coverage.
vi.mock("@/lib/weletic/loyalty/vip-achievement-communication-producer", () => ({
  enqueueVipAchievementCommunication: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

// Mock prisma and ledger
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticOrder: {
      findMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      create: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findMany: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: vi.fn(async (params: any) => ({
    id: "wledger_mock_entry",
    balanceAfter: BigInt(1_000) + BigInt(params.pointsDelta),
    ...params,
  })),
}));

describe("Empirical Challenger 2: VIP Tier Lifecycle, Customer Metafields & Points Liability Stress Harness", () => {
  const storeId = "store_adversarial_test";

  const fourTiers = [
    {
      id: "tier_1_bronze",
      name: "Bronze",
      slug: "bronze",
      tierOrder: 1,
      minSpendThreshold: BigInt(0),
      minPointsThreshold: BigInt(0),
      pointsMultiplier: 1.0,
      entryBonusPoints: BigInt(0),
    },
    {
      id: "tier_2_silver",
      name: "Silver",
      slug: "silver",
      tierOrder: 2,
      minSpendThreshold: BigInt(20000), // ¥20,000 / $200.00
      minPointsThreshold: BigInt(200),
      pointsMultiplier: 1.25,
      entryBonusPoints: BigInt(100),
    },
    {
      id: "tier_3_gold",
      name: "Gold",
      slug: "gold",
      tierOrder: 3,
      minSpendThreshold: BigInt(50000), // ¥50,000 / $500.00
      minPointsThreshold: BigInt(500),
      pointsMultiplier: 1.5,
      entryBonusPoints: BigInt(250),
    },
    {
      id: "tier_4_platinum",
      name: "Platinum",
      slug: "platinum",
      tierOrder: 4,
      minSpendThreshold: BigInt(100000), // ¥100,000 / $1,000.00
      minPointsThreshold: BigInt(1000),
      pointsMultiplier: 2.0,
      entryBonusPoints: BigInt(500),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyOutboxJob.create).mockImplementation(
      ({ data }: any) => data as any,
    );
  });

  // =========================================================================
  // SCOPE 1: VIP Tier Lifecycle Maintenance & Grace Period Boundary Fuzzing
  // =========================================================================
  describe("Scope 1: VIP Tier Lifecycle Maintenance & Grace Period Boundary Fuzzing", () => {
    const t0 = new Date("2026-08-01T00:00:00.000Z");

    it("1.1 Grace Period Time Shifts: Day 0 Enters Grace -> Day 29 Retains Grace -> Day 30 Demotes -> Day 31 Demotes", async () => {
      const accountId = "acc_time_shift_user";

      // --- Step A: Day 0 (Evaluation misses threshold) -> Enters 30-day grace period
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_ts",
        currentTierId: "tier_3_gold",
        currentTier: fourTiers[2], // Gold
        tierExpiresAt: null,
        program: { tiers: fourTiers },
      } as any);

      // Spend is only ¥10,000 (below Gold ¥50k threshold)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(10000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(100) }] as any,
      );

      const day0Result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: t0,
        gracePeriodDays: 30,
      });

      expect(day0Result.status).toBe("IN_GRACE_PERIOD");
      expect(day0Result.tierChanged).toBe(false);
      expect(day0Result.newTierId).toBe("tier_3_gold");
      const expectedGraceEnd = new Date(
        t0.getTime() + 30 * 24 * 60 * 60 * 1000,
      ); // 2026-08-31T00:00:00.000Z
      expect(day0Result.gracePeriodExpiresAt?.toISOString()).toBe(
        expectedGraceEnd.toISOString(),
      );

      // --- Step B: Day 29 at 23:59:59 (Within active grace period) -> Retains Gold & IN_GRACE_PERIOD
      const day29Time = new Date(expectedGraceEnd.getTime() - 1000); // 1 second before expiration
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_ts",
        currentTierId: "tier_3_gold",
        currentTier: fourTiers[2],
        tierExpiresAt: expectedGraceEnd,
        program: { tiers: fourTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(10000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(100) }] as any,
      );

      const day29Result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: day29Time,
      });

      expect(day29Result.status).toBe("IN_GRACE_PERIOD");
      expect(day29Result.tierChanged).toBe(false);
      expect(day29Result.newTierId).toBe("tier_3_gold");
      expect(day29Result.gracePeriodExpiresAt?.toISOString()).toBe(
        expectedGraceEnd.toISOString(),
      );

      // --- Step C: Day 30 at exact expiration (now == expectedGraceEnd) -> Grace expired, DEMOTED to Silver
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_ts",
        currentTierId: "tier_3_gold",
        currentTier: fourTiers[2],
        tierExpiresAt: expectedGraceEnd,
        program: { tiers: fourTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(10000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(100) }] as any,
      );

      const day30Result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: expectedGraceEnd,
      });

      expect(day30Result.status).toBe("DEMOTED");
      expect(day30Result.tierChanged).toBe(true);
      expect(day30Result.previousTierId).toBe("tier_3_gold");
      expect(day30Result.newTierId).toBe("tier_2_silver");
      expect(day30Result.gracePeriodExpiresAt).toBeNull();

      // --- Step D: Day 31 (now > expectedGraceEnd) -> Also correctly DEMOTED to Silver
      const day31Time = new Date(
        expectedGraceEnd.getTime() + 24 * 60 * 60 * 1000,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_ts",
        currentTierId: "tier_3_gold",
        currentTier: fourTiers[2],
        tierExpiresAt: expectedGraceEnd,
        program: { tiers: fourTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(10000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(100) }] as any,
      );

      const day31Result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: day31Time,
      });

      expect(day31Result.status).toBe("DEMOTED");
      expect(day31Result.newTierId).toBe("tier_2_silver");
    });

    it("1.2 Multi-Tier Step-Down Demotion Sequence: Platinum -> Gold -> Silver -> Bronze under zero activity over 3 consecutive review cycles", async () => {
      const accountId = "acc_multi_step_user";

      // CYCLE 1: Starts at Platinum (Tier 4). Has expired grace period. Underperforms (0 spend).
      // Expectation: Demotes exactly 1 tier down to Gold (Tier 3), NOT directly to Bronze!
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_ms",
        currentTierId: "tier_4_platinum",
        currentTier: fourTiers[3], // Platinum
        tierExpiresAt: new Date("2026-08-01T00:00:00Z"), // Expired
        program: { tiers: fourTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const cycle1 = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-08-02T00:00:00Z"),
      });

      expect(cycle1.status).toBe("DEMOTED");
      expect(cycle1.previousTierName).toBe("Platinum");
      expect(cycle1.newTierName).toBe("Gold");
      expect(cycle1.newTierId).toBe("tier_3_gold");

      // CYCLE 2: Member is now Gold (Tier 3). Later review has expired grace period. Still 0 spend.
      // Expectation: Demotes to Silver (Tier 2).
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_ms",
        currentTierId: "tier_3_gold",
        currentTier: fourTiers[2], // Gold
        tierExpiresAt: new Date("2026-09-01T00:00:00Z"), // Expired
        program: { tiers: fourTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const cycle2 = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-09-02T00:00:00Z"),
      });

      expect(cycle2.status).toBe("DEMOTED");
      expect(cycle2.previousTierName).toBe("Gold");
      expect(cycle2.newTierName).toBe("Silver");
      expect(cycle2.newTierId).toBe("tier_2_silver");

      // CYCLE 3: Member is now Silver (Tier 2). Later review has expired grace period. Still 0 spend.
      // Expectation: Demotes to Bronze (Tier 1).
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_ms",
        currentTierId: "tier_2_silver",
        currentTier: fourTiers[1], // Silver
        tierExpiresAt: new Date("2026-10-01T00:00:00Z"), // Expired
        program: { tiers: fourTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const cycle3 = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-10-02T00:00:00Z"),
      });

      expect(cycle3.status).toBe("DEMOTED");
      expect(cycle3.previousTierName).toBe("Silver");
      expect(cycle3.newTierName).toBe("Bronze");
      expect(cycle3.newTierId).toBe("tier_1_bronze");

      // CYCLE 4: Member is at Bronze (Tier 1, lowest entry tier). Zero spend.
      // Expectation: Base tier floor prevents further demotion -> MAINTAINED without error.
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_ms",
        currentTierId: "tier_1_bronze",
        currentTier: fourTiers[0], // Bronze
        tierExpiresAt: null,
        program: { tiers: fourTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const cycle4 = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-11-01T00:00:00Z"),
      });

      expect(cycle4.status).toBe("MAINTAINED");
      expect(cycle4.tierChanged).toBe(false);
      expect(cycle4.newTierId).toBe("tier_1_bronze");
      expect(cycle4.newTierName).toBe("Bronze");
    });

    it("1.3 Non-Contiguous Tier Ranks: [1, 5, 10, 20] correctly steps down to immediately preceding rank (20 -> 10)", async () => {
      const customTiers = [
        {
          id: "t1",
          name: "Tier1",
          tierOrder: 1,
          minSpendThreshold: BigInt(0),
          minPointsThreshold: BigInt(0),
        },
        {
          id: "t5",
          name: "Tier5",
          tierOrder: 5,
          minSpendThreshold: BigInt(10000),
          minPointsThreshold: BigInt(100),
        },
        {
          id: "t10",
          name: "Tier10",
          tierOrder: 10,
          minSpendThreshold: BigInt(30000),
          minPointsThreshold: BigInt(300),
        },
        {
          id: "t20",
          name: "Tier20",
          tierOrder: 20,
          minSpendThreshold: BigInt(80000),
          minPointsThreshold: BigInt(800),
        },
      ];

      const accountId = "acc_custom_ranks";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_cr",
        currentTierId: "t20",
        currentTier: customTiers[3], // Rank 20
        tierExpiresAt: new Date("2026-08-01T00:00:00Z"), // Expired
        program: { tiers: customTiers },
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-08-15T00:00:00Z"),
      });

      expect(result.status).toBe("DEMOTED");
      expect(result.previousTierId).toBe("t20");
      expect(result.newTierId).toBe("t10"); // Steps down to rank 10
      expect(result.newTierName).toBe("Tier10");
    });

    it("1.4 Direct Promotion Leapfrogging: Member jumps directly from Bronze (1) to Platinum (4) when spend satisfies Platinum threshold", async () => {
      const accountId = "acc_leapfrog";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_lf",
        currentTierId: "tier_1_bronze",
        currentTier: fourTiers[0],
        tierExpiresAt: null,
        program: { tiers: fourTiers },
      } as any);

      // Huge customer spend ¥150,000 (exceeds Platinum ¥100,000)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(150000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(1500) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-08-18T00:00:00Z"),
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.tierChanged).toBe(true);
      expect(result.previousTierName).toBe("Bronze");
      expect(result.newTierName).toBe("Platinum");
      expect(result.newTierId).toBe("tier_4_platinum");
      expect(result.qualifyingSpend).toBe(BigInt(150000));
    });
  });

  // =========================================================================
  // SCOPE 2: Customer Metafields Sync Engine & Unicode / Schema Safety
  // =========================================================================
  describe("Scope 2: Customer Metafields Sync Engine & Unicode / Schema Safety", () => {
    it("2.1 Unicode, Emoji, and International Characters: generates valid Shopify Metafields without data loss or corruption", () => {
      const unicodePayload = {
        ownerId: "gid://shopify/Customer/778899",
        vipTierName: "プラチナ VIP 👑 (上位1%)",
        vipTierOrder: 4,
        pointsBalance: BigInt(88888),
        pendingPoints: BigInt(500),
        lifetimePoints: BigInt(125000),
        referralCode: "PROMO_💎_2026/VIP+10%",
        referralLink: "https://yamax.store?ref=PROMO_%F0%9F%92%8E_2026",
        tierMultiplier: 2.0,
        memberStatus: "active",
        birthDate: "1990-12-31",
      };

      const metafields = buildCustomerMetafieldUpdates(unicodePayload);

      expect(metafields).toHaveLength(10);
      const tierMeta = metafields.find((m) => m.key === "vip_tier");
      expect(tierMeta?.value).toBe("プラチナ VIP 👑 (上位1%)");
      expect(tierMeta?.type).toBe("single_line_text_field");
      expect(tierMeta?.namespace).toBe(WELETIC_LOYALTY_NAMESPACE);

      const refCodeMeta = metafields.find((m) => m.key === "referral_code");
      expect(refCodeMeta?.value).toBe("PROMO_💎_2026/VIP+10%");
    });

    it("2.2 Large Integers and Decimal Precision Bounds in Metafields: handles extreme numeric values safely", () => {
      const extremePayload = {
        ownerId: "gid://shopify/Customer/1",
        vipTierName: "Whale Tier",
        vipTierOrder: 99,
        pointsBalance: BigInt("9007199254740991"), // Number.MAX_SAFE_INTEGER
        pendingPoints: BigInt("1000000000000000"),
        lifetimePoints: BigInt("9999999999999999"),
        tierMultiplier: 1.3333333333333333, // Repeating float
      };

      const metafields = buildCustomerMetafieldUpdates(extremePayload);
      const map = new Map(metafields.map((m) => [m.key, m]));

      expect(map.get("points_balance")?.value).toBe("9007199254740991");
      expect(map.get("pending_points")?.value).toBe("1000000000000000");
      expect(map.get("lifetime_points")?.value).toBe("9999999999999999");
      // Multiplier should be safely rounded / formatted to 2 decimals
      expect(map.get("tier_multiplier")?.value).toBe("1.33");
      expect(map.get("tier_multiplier")?.type).toBe("number_decimal");
    });

    it("2.3 normalizeShopifyCustomerGid: handles all input variants correctly", () => {
      expect(normalizeShopifyCustomerGid("123456789")).toBe(
        "gid://shopify/Customer/123456789",
      );
      expect(normalizeShopifyCustomerGid("Customer/123456789")).toBe(
        "gid://shopify/Customer/123456789",
      );
      expect(
        normalizeShopifyCustomerGid("gid://shopify/Customer/123456789"),
      ).toBe("gid://shopify/Customer/123456789");
      expect(normalizeShopifyCustomerGid("0")).toBe("gid://shopify/Customer/0");
      expect(normalizeShopifyCustomerGid("")).toBe("");
      expect(normalizeShopifyCustomerGid(null as any)).toBe("");
      expect(normalizeShopifyCustomerGid(undefined as any)).toBe("");
    });

    it("2.4 Empty & Undefined Payloads: generates empty array without throwing runtime errors", () => {
      const empty = buildCustomerMetafieldUpdates({});
      expect(empty).toEqual([]);

      const nullish = buildCustomerMetafieldUpdates({
        vipTierName: null,
        vipTierOrder: null,
        pointsBalance: null,
        birthDate: null,
      });
      expect(nullish).toEqual([]);
    });

    it("2.5 Date Parsing Edge Cases: ignores invalid date strings safely", () => {
      const badDate = buildCustomerMetafieldUpdates({
        birthDate: "invalid-date-string",
      });
      expect(badDate).toEqual([]);

      const invalidIso = buildCustomerMetafieldUpdates({
        birthDate: "2026/08/18", // Slash format doesn't match YYYY-MM-DD regex
      });
      expect(invalidIso).toEqual([]);

      const validDate = buildCustomerMetafieldUpdates({
        birthDate: new Date(Date.UTC(2000, 0, 15)),
      });
      expect(validDate).toHaveLength(1);
      expect(validDate[0].value).toBe("2000-01-15");
    });
  });

  // =========================================================================
  // SCOPE 3: Multi-Currency Zero-Decimal Scaling & Points Liability Math
  // =========================================================================
  describe("Scope 3: Multi-Currency Zero-Decimal Scaling & Points Liability Math", () => {
    it("3.1 Zero-Decimal Currency Scaling: JPY, VND, KRW liability calculations guarantee zero precision loss", async () => {
      // 3 active accounts in Tokyo store with 10,000, 25,000, and 65,000 points
      // Total circulating: 100,000 points
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(10000),
          cachedPendingPoints: BigInt(2000),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(25000),
          cachedPendingPoints: BigInt(3000),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(65000),
          cachedPendingPoints: BigInt(5000),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      // JPY ¥1 per point
      const jpyResult = await calculatePointsLiability({
        storeId: "store_tokyo_stress",
        currency: "JPY",
        valuationPerPointMinorUnits: 1,
      });

      expect(jpyResult.currency).toBe("JPY");
      expect(jpyResult.isZeroDecimal).toBe(true);
      expect(jpyResult.totalCirculatingPoints).toBe(BigInt(100000));
      expect(jpyResult.totalPendingPoints).toBe(BigInt(10000));
      expect(jpyResult.totalPotentialPoints).toBe(BigInt(110000));
      expect(jpyResult.totalLiabilityMinorUnits).toBe(BigInt(100000));
      expect(jpyResult.totalPendingLiabilityMinorUnits).toBe(BigInt(10000));
      expect(jpyResult.totalPotentialLiabilityMinorUnits).toBe(BigInt(110000));
      expect(jpyResult.totalLiabilityDecimal).toBe("100000"); // Zero-decimal: NO .00
      expect(jpyResult.totalPendingLiabilityDecimal).toBe("10000");
      expect(jpyResult.totalPotentialLiabilityDecimal).toBe("110000");
      expect(jpyResult.averagePointsPerMember).toBeCloseTo(33333.33, 1);
      expect(jpyResult.averageLiabilityPerMemberMinorUnits).toBe(BigInt(33333));
    });

    it("3.2 2-Decimal Currency Scaling: USD and EUR calculations produce exact cent scaling", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(750),
          cachedPendingPoints: BigInt(250),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      // 750 points at $0.01 per point (1 cent) = 750 cents = $7.50
      const usdResult = await calculatePointsLiability({
        storeId: "store_usd_stress",
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(usdResult.currency).toBe("USD");
      expect(usdResult.isZeroDecimal).toBe(false);
      expect(usdResult.totalLiabilityMinorUnits).toBe(BigInt(750));
      expect(usdResult.totalLiabilityDecimal).toBe("7.50");
      expect(usdResult.totalPendingLiabilityDecimal).toBe("2.50");
      expect(usdResult.totalPotentialLiabilityDecimal).toBe("10.00");
    });

    it("3.3 Zero-Division Safety: Empty store and zero-point stores evaluate safely without NaN or crash", async () => {
      // Empty store (0 members)
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
        [],
      );

      const emptyLiability = await calculatePointsLiability({
        storeId: "store_empty",
        currency: "USD",
      });

      expect(emptyLiability.totalMembersCount).toBe(0);
      expect(emptyLiability.activeMembersCount).toBe(0);
      expect(emptyLiability.totalCirculatingPoints).toBe(BigInt(0));
      expect(emptyLiability.totalLiabilityMinorUnits).toBe(BigInt(0));
      expect(emptyLiability.totalLiabilityDecimal).toBe("0.00");
      expect(emptyLiability.averagePointsPerMember).toBe(0);
      expect(emptyLiability.averageLiabilityPerMemberMinorUnits).toBe(
        BigInt(0),
      );

      // Referral economics pure helper zero-division
      const zeroReferrals = calculateReferralEconomics({
        totalReferrals: 0,
        successfulReferrals: 0,
        totalRewardPoints: 0,
        revenueMinorUnits: 0,
        currency: "USD",
      });

      expect(zeroReferrals.referralConversionRate).toBe(0);
      expect(zeroReferrals.referralCAC).toBeNull();
      expect(zeroReferrals.referralROI).toBeNull();
      expect(zeroReferrals.referralROIMultiplier).toBeNull();
      expect(zeroReferrals.referralROIReason).toMatch(/cost is zero/);
    });

    it("3.4 Negative Balance Debt Segregation: Correctly segregates clawback debt from circulating liability", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          cachedPointsBalance: BigInt(5000),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(3000),
          status: "active",
          updatedAt: new Date(),
        },
        {
          cachedPointsBalance: BigInt(-1200),
          status: "active",
          updatedAt: new Date(),
        }, // Negative debt
        {
          cachedPointsBalance: BigInt(-800),
          status: "active",
          updatedAt: new Date(),
        }, // Negative debt
        {
          cachedPointsBalance: BigInt(0),
          status: "active",
          updatedAt: new Date(),
        },
      ] as any);

      const result = await calculatePointsLiability({
        storeId: "store_debt_stress",
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      // Positive circulating claims: 5000 + 3000 = 8,000 points ($80.00)
      expect(result.totalCirculatingPoints).toBe(BigInt(8000));
      expect(result.totalLiabilityMinorUnits).toBe(BigInt(8000));
      expect(result.totalLiabilityDecimal).toBe("80.00");

      // Negative points debt: 1200 + 800 = 2,000 points across 2 accounts
      expect(result.negativeBalancePointsDebt).toBe(BigInt(2000));
      expect(result.negativeBalanceAccountsCount).toBe(2);

      // Net circulating points = 8000 - 2000 = 6,000 points
      expect(result.netCirculatingPoints).toBe(BigInt(6000));
      expect(result.totalMembersCount).toBe(5);
    });

    it("3.5 Referral CAC & ROI Extreme Multipliers: Calculates exact high-volume marketing ROI", () => {
      // 5,000 referrals, 1,250 converted (25% conversion)
      // Total reward points awarded: 125,000 pts ($1,250.00 cost = 125,000 cents)
      // Total referral revenue generated: $125,000.00 (12,500,000 cents)
      const econ = calculateReferralEconomics({
        totalReferrals: 5000,
        successfulReferrals: 1250,
        totalRewardPoints: BigInt(125000),
        revenueMinorUnits: BigInt(12500000),
        currency: "USD",
        valuationPerPointMinorUnits: 1,
      });

      expect(econ.totalReferrals).toBe(5000);
      expect(econ.successfulReferrals).toBe(1250);
      expect(econ.referralConversionRate).toBe(25.0);
      expect(econ.referralRewardCostMinorUnits).toBe(BigInt(125000));
      expect(econ.referralRevenueMinorUnits).toBe(BigInt(12500000));
      expect(econ.referralCACMinorUnits).toBe(BigInt(100)); // 125,000 / 1250 = 100 cents = $1.00
      expect(econ.referralCAC).toBe(1.0);
      // ROI: ((12,500,000 - 125,000) / 125,000) * 100 = 9900.0%
      expect(econ.referralROI).toBe(9900.0);
      expect(econ.referralROIMultiplier).toBe(100.0); // 100x return
    });
  });
});
