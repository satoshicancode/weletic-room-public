import { prisma } from "@/lib/prisma";
import { processOrderPointsEarn } from "@/lib/weletic/loyalty/earn";
import { buildLoyaltyEarnPolicySnapshot } from "@/lib/weletic/loyalty/earn-policy-revision";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const domainMocks = vi.hoisted(() => ({
  appendPointsLedgerEntry: vi.fn(),
  assertOperationalWrites: vi.fn(),
  calculateNextPointsExpiryDate: vi.fn(),
  enqueueOutboxJob: vi.fn(),
  scheduleTierReview: vi.fn(),
  enqueuePurchaseCommunication: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const client: any = {
    weleticCommerceOrder: { findUnique: vi.fn() },
    weleticLoyaltyAccount: { update: vi.fn(), updateMany: vi.fn() },
    weleticLoyaltyEarnGrant: { create: vi.fn(), findUnique: vi.fn() },
    weleticLoyaltyOrderLineEarn: { createMany: vi.fn() },
    weleticLoyaltyProgram: { findUnique: vi.fn() },
    weleticLoyaltyEarnPolicyRevision: { findFirst: vi.fn() },
    weleticLoyaltyTierHistory: { findFirst: vi.fn() },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticReconciliationIssue: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  client.$transaction = vi.fn(
    async (callback: (tx: typeof client) => unknown) => callback(client),
  );
  return { prisma: client };
});

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: domainMocks.appendPointsLedgerEntry,
  appendPointsLedgerEntryWithReceipt: async (params: unknown) => ({
    entry: await domainMocks.appendPointsLedgerEntry(params),
    created: true,
  }),
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
}));
vi.mock("@/lib/weletic/loyalty/points-communication-producer", () => ({
  enqueuePurchasePointsCommunication: domainMocks.enqueuePurchaseCommunication,
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: domainMocks.enqueueOutboxJob,
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/loyalty/points-expiry-policy", () => ({
  calculateNextPointsExpiryDate: domainMocks.calculateNextPointsExpiryDate,
}));

vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: domainMocks.scheduleTierReview,
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites:
    domainMocks.assertOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration: vi.fn(),
}));

const STORE_ID = "store_policy_revision";
const PROGRAM_ID = "program_policy_revision";
const ACCOUNT_ID = "account_policy_revision";
const SHOPPER_ID = "shopper_policy_revision";
const ORDER_ID = "order_policy_revision";
const REVISION_ID = "wpolicy_historical";
const OCCURRED_AT = new Date("2026-09-01T12:00:00.000Z");

function historicalRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule_historical_order_paid",
    triggerCode: "order_paid",
    ruleType: "multiplier",
    priority: 100,
    multiplier: new Prisma.Decimal(2),
    fixedPoints: null,
    minOrderSubtotal: null,
    maxPointsPerEvent: null,
    maxEventsPerCustomer: null,
    limitInterval: null,
    eligibleTierIds: [],
    conditions: null,
    excludeDiscountedItems: false,
    excludeTaxesAndShipping: true,
    startAt: null,
    endAt: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function historicalCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "campaign_historical_bonus",
    multiplier: new Prisma.Decimal(3),
    startAt: new Date("2026-01-01T00:00:00.000Z"),
    endAt: new Date("2027-01-01T00:00:00.000Z"),
    isActive: true,
    eligibleTierIds: [],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
    ...overrides,
  };
}

function historicalTier({
  id,
  tierOrder,
  multiplier,
}: {
  id: string;
  tierOrder: number;
  multiplier: number;
}) {
  return {
    id,
    tierOrder,
    minSpendThreshold: BigInt(0),
    minPointsThreshold: BigInt(0),
    pointsMultiplier: new Prisma.Decimal(multiplier),
    entryBonusPoints: BigInt(0),
    gracePeriodDays: null,
    criteria: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    deletedAt: null,
  };
}

function policyRevision({
  tiers = [],
  holdingPeriodDays = 0,
}: {
  tiers?: ReturnType<typeof historicalTier>[];
  holdingPeriodDays?: number;
} = {}) {
  const { snapshot, fingerprint } = buildLoyaltyEarnPolicySnapshot({
    id: PROGRAM_ID,
    storeId: STORE_ID,
    status: "active",
    pointsPerCurrencyUnit: new Prisma.Decimal(1),
    holdingPeriodDays,
    pointsExpiryMonths: 0,
    pointsExpiryDays: 0,
    pointsExpiryWarningDays: 30,
    pointsExpiryLastChanceDays: 3,
    pointsExpiryWarningEnabled: true,
    pointsExpiryLastChanceEnabled: true,
    pointsExpiryPolicyAnchorAt: null,
    pointsExpiryPolicyVersion: 1,
    vipMilestoneMode: "amount_spent",
    vipTimeframe: "rolling_12m",
    vipDowngradeGraceDays: 30,
    vipAutoDowngradeEnabled: true,
    earningRules: [historicalRule()],
    bonusCampaigns: [historicalCampaign()],
    tiers,
  });

  return {
    id: REVISION_ID,
    storeId: STORE_ID,
    programId: PROGRAM_ID,
    version: 7,
    effectiveAt: new Date("2026-08-01T00:00:00.000Z"),
    schemaVersion: 1,
    snapshot,
    fingerprint,
  };
}

function currentProgram(overrides: Record<string, unknown> = {}) {
  return {
    id: PROGRAM_ID,
    storeId: STORE_ID,
    status: "active",
    killSwitchActive: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    // These mutable rows deliberately disagree with the bound revision. The
    // production path must never use them to calculate a historical order.
    earningRules: [],
    bonusCampaigns: [],
    ...overrides,
  };
}

function commerceOrder({
  loyaltyPolicyRevisionId = REVISION_ID,
  currentTierId = null,
  currentTier = null,
}: {
  loyaltyPolicyRevisionId?: string | null;
  currentTierId?: string | null;
  currentTier?: Record<string, unknown> | null;
} = {}) {
  return {
    id: ORDER_ID,
    storeId: STORE_ID,
    externalId: "gid://shopify/Order/policy-revision",
    orderName: "#POLICY-REVISION",
    occurredAt: OCCURRED_AT,
    createdAt: OCCURRED_AT,
    loyaltyPolicyRevisionId,
    shopCurrency: "USD",
    presentmentCurrency: "USD",
    shopNet: BigInt(10_000),
    presentmentNet: BigInt(10_000),
    shopTotal: BigInt(10_000),
    presentmentTotal: BigInt(10_000),
    shopper: {
      id: SHOPPER_ID,
      storeId: STORE_ID,
      loyaltyAccount: {
        id: ACCOUNT_ID,
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        program: { id: PROGRAM_ID, storeId: STORE_ID },
        currentTierId,
        currentTier,
        // Included by the order query for old fixtures, but production
        // revision evaluation must use the dedicated event-time delegate.
        tierHistory: [],
      },
    },
    lines: [
      {
        id: "order_line_policy_revision",
        externalId: "gid://shopify/LineItem/policy-revision",
        productId: "gid://shopify/Product/policy-revision",
        variantId: "gid://shopify/ProductVariant/policy-revision",
        title: "Historical policy item",
        quantity: 1,
        shopGross: BigInt(10_000),
        shopDiscount: BigInt(0),
        shopNet: BigInt(10_000),
        presentmentNet: BigInt(10_000),
      },
    ],
    refunds: [],
  };
}

async function earn() {
  return processOrderPointsEarn({
    storeId: STORE_ID,
    orderId: ORDER_ID,
    tx: prisma as unknown as Prisma.TransactionClient,
  });
}

describe("processOrderPointsEarn immutable event-time policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    domainMocks.assertOperationalWrites.mockResolvedValue({
      id: STORE_ID,
      complianceState: "active",
    });
    domainMocks.calculateNextPointsExpiryDate.mockReturnValue(null);
    domainMocks.enqueueOutboxJob.mockResolvedValue({});
    domainMocks.scheduleTierReview.mockResolvedValue(null);
    domainMocks.appendPointsLedgerEntry.mockImplementation(async (input) => ({
      id: "ledger_policy_revision",
      balanceAfter: BigInt(1_000) + BigInt(input.pointsDelta),
      ...input,
    }));

    vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValue(
      commerceOrder() as never,
    );
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue(
      currentProgram() as never,
    );
    vi.mocked(
      prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
    ).mockResolvedValue(policyRevision() as never);
    vi.mocked(prisma.weleticLoyaltyTierHistory.findFirst).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyEarnGrant.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyEarnGrant.create).mockImplementation(
      (async ({ data }: any) => ({
        id: "grant_policy_revision",
        ...data,
      })) as never,
    );
    vi.mocked(prisma.weleticLoyaltyOrderLineEarn.createMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticReconciliationIssue.upsert).mockResolvedValue(
      {} as never,
    );
    vi.mocked(prisma.weleticReconciliationIssue.updateMany).mockResolvedValue({
      count: 0,
    });
  });

  it("passes fresh immediate receipt and the caller transaction to communications", async () => {
    await earn();
    expect(domainMocks.enqueuePurchaseCommunication).toHaveBeenCalledTimes(1);
    expect(domainMocks.enqueuePurchaseCommunication).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: prisma,
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        receipt: {
          created: true,
          entry: expect.objectContaining({ id: "ledger_policy_revision" }),
        },
      }),
    );
  });
  it("does not enqueue a notice for existing-grant replay", async () => {
    vi.mocked(prisma.weleticLoyaltyEarnGrant.findUnique).mockResolvedValueOnce({
      id: "existing",
      storeId: STORE_ID,
      orderId: ORDER_ID,
      accountId: ACCOUNT_ID,
      shopperId: SHOPPER_ID,
      programId: PROGRAM_ID,
    } as never);
    await earn();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(domainMocks.enqueuePurchaseCommunication).not.toHaveBeenCalled();
  });
  it("does not turn a legacy EARN_ORDER adoption into a fresh notice", async () => {
    vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mockResolvedValueOnce(
      {
        id: "legacy_earn",
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(100),
        pendingDelta: BigInt(0),
        balanceAfter: BigInt(100),
        referenceType: "COMMERCE_ORDER",
        referenceId: ORDER_ID,
        grantId: null,
        metadata: null,
        createdAt: OCCURRED_AT,
      } as never,
    );
    await earn();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(domainMocks.enqueuePurchaseCommunication).not.toHaveBeenCalled();
  });
  it("does not announce still-pending purchase points", async () => {
    vi.mocked(
      prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
    ).mockResolvedValueOnce(policyRevision({ holdingPeriodDays: 30 }) as never);
    await earn();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(domainMocks.enqueuePurchaseCommunication).not.toHaveBeenCalled();
  });
  it("propagates communication enqueue failure out of the financial transaction", async () => {
    domainMocks.enqueuePurchaseCommunication.mockRejectedValueOnce(
      new Error("Synthetic enqueue failure"),
    );
    await expect(earn()).rejects.toThrow("Synthetic enqueue failure");
  });

  it("uses the bound historical rule and campaign after current rows are mutated or soft-deleted", async () => {
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce(
      currentProgram({
        earningRules: [
          historicalRule({
            multiplier: new Prisma.Decimal(99),
            isActive: false,
            deletedAt: new Date("2026-09-02T00:00:00.000Z"),
          }),
        ],
        bonusCampaigns: [],
      }) as never,
    );

    await earn();

    expect(
      prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
    ).toHaveBeenCalledWith({
      where: {
        id: REVISION_ID,
        storeId: STORE_ID,
        programId: PROGRAM_ID,
      },
    });
    expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        grossPoints: BigInt(600),
        selectedRuleId: "rule_historical_order_paid",
        selectedCampaignId: "campaign_historical_bonus",
        policyRevisionId: REVISION_ID,
        ruleMultiplier: expect.objectContaining({}),
        campaignMultiplier: expect.objectContaining({}),
      }),
    });
    const grantData = vi.mocked(prisma.weleticLoyaltyEarnGrant.create).mock
      .calls[0][0].data as any;
    expect(grantData.ruleMultiplier.toString()).toBe("2");
    expect(grantData.campaignMultiplier.toString()).toBe("3");
    expect(grantData.calculationSnapshot.policyRevision).toEqual({
      id: REVISION_ID,
      version: 7,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaVersion: 1,
    });
  });

  it("uses the latest tier history at or before the event instead of the current tier", async () => {
    const historicalBronze = historicalTier({
      id: "tier_bronze_at_event",
      tierOrder: 1,
      multiplier: 1.5,
    });
    const currentPlatinum = historicalTier({
      id: "tier_platinum_current",
      tierOrder: 2,
      multiplier: 10,
    });
    vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValueOnce(
      commerceOrder({
        currentTierId: currentPlatinum.id,
        currentTier: {
          ...currentPlatinum,
          programId: PROGRAM_ID,
        },
      }) as never,
    );
    vi.mocked(
      prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
    ).mockResolvedValueOnce(
      policyRevision({ tiers: [historicalBronze, currentPlatinum] }) as never,
    );
    vi.mocked(prisma.weleticLoyaltyTierHistory.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "tier_history_bronze",
        accountId: ACCOUNT_ID,
        fromTierId: null,
        toTierId: historicalBronze.id,
        effectiveAt: new Date("2026-08-15T00:00:00.000Z"),
        sequenceNumber: 3,
      } as never);

    await earn();

    expect(prisma.weleticLoyaltyTierHistory.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: ACCOUNT_ID,
        effectiveAt: { lte: OCCURRED_AT },
        sequenceNumber: { not: null },
      },
      orderBy: [{ effectiveAt: "desc" }, { sequenceNumber: "desc" }],
      select: {
        id: true,
        accountId: true,
        fromTierId: true,
        toTierId: true,
        effectiveAt: true,
        sequenceNumber: true,
      },
    });
    const grantData = vi.mocked(prisma.weleticLoyaltyEarnGrant.create).mock
      .calls[0][0].data as any;
    expect(grantData).toMatchObject({
      grossPoints: BigInt(900),
      tierId: historicalBronze.id,
    });
    expect(grantData.tierMultiplier.toString()).toBe("1.5");
    expect(grantData.grossPoints).not.toBe(BigInt(6_000));
  });

  it("uses the first later transition's from-tier for an out-of-order order event", async () => {
    const historicalBronze = historicalTier({
      id: "tier_bronze_before_promotion",
      tierOrder: 1,
      multiplier: 1.5,
    });
    const currentPlatinum = historicalTier({
      id: "tier_platinum_after_promotion",
      tierOrder: 2,
      multiplier: 10,
    });
    vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValueOnce(
      commerceOrder({
        currentTierId: currentPlatinum.id,
        currentTier: { ...currentPlatinum, programId: PROGRAM_ID },
      }) as never,
    );
    vi.mocked(
      prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
    ).mockResolvedValueOnce(
      policyRevision({ tiers: [historicalBronze, currentPlatinum] }) as never,
    );
    vi.mocked(prisma.weleticLoyaltyTierHistory.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "tier_history_later_promotion",
        accountId: ACCOUNT_ID,
        fromTierId: historicalBronze.id,
        toTierId: currentPlatinum.id,
        effectiveAt: new Date("2026-09-01T12:05:00.000Z"),
        sequenceNumber: 4,
      } as never);

    await earn();

    expect(prisma.weleticLoyaltyTierHistory.findFirst).toHaveBeenNthCalledWith(
      3,
      {
        where: {
          accountId: ACCOUNT_ID,
          effectiveAt: { gt: OCCURRED_AT },
          sequenceNumber: { not: null },
        },
        orderBy: [{ effectiveAt: "asc" }, { sequenceNumber: "asc" }],
        select: {
          id: true,
          accountId: true,
          fromTierId: true,
          toTierId: true,
          effectiveAt: true,
          sequenceNumber: true,
        },
      },
    );
    const grantData = vi.mocked(prisma.weleticLoyaltyEarnGrant.create).mock
      .calls[0][0].data as any;
    expect(grantData).toMatchObject({
      grossPoints: BigInt(900),
      tierId: historicalBronze.id,
    });
    expect(grantData.tierMultiplier.toString()).toBe("1.5");
    expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
  });

  it("keeps an order replayable while any tier history remains unsequenced", async () => {
    const currentPlatinum = historicalTier({
      id: "tier_platinum_unsequenced",
      tierOrder: 2,
      multiplier: 10,
    });
    vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValueOnce(
      commerceOrder({
        currentTierId: currentPlatinum.id,
        currentTier: { ...currentPlatinum, programId: PROGRAM_ID },
      }) as never,
    );
    vi.mocked(
      prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
    ).mockResolvedValueOnce(
      policyRevision({ tiers: [currentPlatinum] }) as never,
    );
    vi.mocked(prisma.weleticLoyaltyTierHistory.findFirst).mockResolvedValueOnce(
      {
        id: "tier_history_unsequenced",
        accountId: ACCOUNT_ID,
        fromTierId: null,
        toTierId: currentPlatinum.id,
        effectiveAt: new Date("2026-08-15T00:00:00.000Z"),
        sequenceNumber: null,
      } as never,
    );

    const result = await earn();

    expect(result).toBeNull();
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "loyalty_tier_history_unavailable",
          severity: "critical",
          details: expect.objectContaining({
            reason: "unsequenced_tier_history",
          }),
        }),
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
  });

  it("keeps the order replayable when no authoritative event-time tier can be reconstructed", async () => {
    const currentPlatinum = historicalTier({
      id: "tier_platinum_without_history",
      tierOrder: 2,
      multiplier: 10,
    });
    vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValueOnce(
      commerceOrder({
        currentTierId: currentPlatinum.id,
        currentTier: { ...currentPlatinum, programId: PROGRAM_ID },
      }) as never,
    );
    vi.mocked(
      prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
    ).mockResolvedValueOnce(
      policyRevision({ tiers: [currentPlatinum] }) as never,
    );
    vi.mocked(prisma.weleticLoyaltyTierHistory.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await earn();

    expect(result).toBeNull();
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "loyalty_tier_history_unavailable",
          severity: "critical",
          details: expect.objectContaining({
            orderId: ORDER_ID,
            accountId: ACCOUNT_ID,
            reason: "no_tier_history_at_or_after_order_event",
          }),
        }),
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["missing bound revision", REVISION_ID],
    ["pre-cutover event", null],
  ])(
    "keeps a %s replayable and creates a critical reconciliation issue",
    async (_scenario, loyaltyPolicyRevisionId) => {
      vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValueOnce(
        commerceOrder({ loyaltyPolicyRevisionId }) as never,
      );
      vi.mocked(
        prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
      ).mockResolvedValueOnce(null);

      const result = await earn();

      expect(result).toBeNull();
      expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            storeId: STORE_ID,
            kind: "loyalty_policy_revision_unavailable",
            severity: "critical",
            status: "open",
            details: expect.objectContaining({
              orderId: ORDER_ID,
              preferredRevisionId: loyaltyPolicyRevisionId,
            }),
          }),
        }),
      );
      expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it("rethrows an operational revision read failure so the webhook can retry", async () => {
    vi.mocked(
      prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
    ).mockRejectedValueOnce(new Error("database connection reset"));

    await expect(earn()).rejects.toThrow("database connection reset");

    expect(prisma.weleticReconciliationIssue.upsert).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled status", { status: "disabled" }],
    ["active kill switch", { killSwitchActive: true }],
  ])(
    "blocks on the current %s without persisting a historical no-award",
    async (_scenario, currentOverrides) => {
      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce(
        currentProgram(currentOverrides) as never,
      );

      await expect(earn()).rejects.toThrow(
        `Loyalty earn processing for store ${STORE_ID} is paused by the current program operational gate`,
      );

      expect(
        prisma.weleticLoyaltyEarnPolicyRevision.findFirst,
      ).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );
});
