import { prisma } from "@/lib/prisma";
import {
  processOrderPointsEarn,
  processRefundPointsReversal,
} from "@/lib/weletic/loyalty/earn";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const domainMocks = vi.hoisted(() => ({
  appendPointsLedgerEntry: vi.fn(),
  assertOperationalWrites: vi.fn(),
  assertInstallationGeneration: vi.fn(),
  calculateNextPointsExpiryDate: vi.fn(),
  enqueueOutboxJob: vi.fn(),
  hasCustomerRedactionTombstone: vi.fn(),
  scheduleTierReview: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const client: any = {
    weleticCommerceOrder: { findUnique: vi.fn() },
    weleticCommerceRefund: { findUnique: vi.fn() },
    weleticLoyaltyAccount: { update: vi.fn(), updateMany: vi.fn() },
    weleticLoyaltyEarnGrant: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyOrderLineEarn: {
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyProgram: { findUnique: vi.fn() },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
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
  enqueuePurchasePointsCommunication: vi.fn().mockResolvedValue(null),
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
  hasShopifyCustomerRedactionTombstone:
    domainMocks.hasCustomerRedactionTombstone,
}));

vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: domainMocks.scheduleTierReview,
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites:
    domainMocks.assertOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration:
    domainMocks.assertInstallationGeneration,
}));

const STORE_ID = "store_earn_guard";
const ACCOUNT_ID = "account_earn_guard";
const SHOPPER_ID = "shopper_earn_guard";
const ORDER_ID = "order_earn_guard";
const OCCURRED_AT = new Date("2026-09-01T00:00:00.000Z");

function orderPaidRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule_order_paid",
    triggerCode: "order_paid",
    isActive: true,
    priority: 100,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    startAt: null,
    endAt: null,
    eligibleTierIds: [],
    excludeDiscountedItems: false,
    excludeTaxesAndShipping: true,
    minOrderSubtotal: null,
    ruleType: "multiplier",
    fixedPoints: null,
    maxPointsPerEvent: null,
    multiplier: new Prisma.Decimal(1),
    ...overrides,
  };
}

function commerceOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_ID,
    storeId: STORE_ID,
    externalId: "gid://shopify/Order/earn-guard",
    orderName: "#EARN-GUARD",
    occurredAt: OCCURRED_AT,
    createdAt: OCCURRED_AT,
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
        programId: "program_earn_guard",
        program: { id: "program_earn_guard", storeId: STORE_ID },
        currentTierId: "tier_gold",
        currentTier: {
          id: "tier_gold",
          programId: "program_earn_guard",
          pointsMultiplier: new Prisma.Decimal(1),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        tierHistory: [],
      },
    },
    lines: [
      {
        id: "order_line_earn_guard",
        externalId: "gid://shopify/LineItem/earn-guard",
        productId: "gid://shopify/Product/earn-guard",
        variantId: "gid://shopify/ProductVariant/earn-guard",
        title: "Earn guard item",
        quantity: 1,
        shopGross: BigInt(10_000),
        shopDiscount: BigInt(0),
        shopNet: BigInt(10_000),
        presentmentNet: BigInt(10_000),
      },
    ],
    refunds: [],
    ...overrides,
  };
}

function loyaltyProgram(overrides: Record<string, unknown> = {}) {
  return {
    id: "program_earn_guard",
    storeId: STORE_ID,
    status: "active",
    killSwitchActive: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    pointsPerCurrencyUnit: new Prisma.Decimal(1),
    holdingPeriodDays: 0,
    pointsExpiryPolicyVersion: 1,
    earningRules: [orderPaidRule()],
    bonusCampaigns: [],
    ...overrides,
  };
}

function refundWithAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: "refund_earn_guard",
    storeId: STORE_ID,
    externalId: "gid://shopify/Refund/earn-guard",
    orderId: ORDER_ID,
    shopAmount: BigInt(5_000),
    presentmentAmount: BigInt(5_000),
    shopCurrency: "USD",
    presentmentCurrency: "USD",
    order: {
      id: ORDER_ID,
      storeId: STORE_ID,
      externalId: "gid://shopify/Order/earn-guard",
      orderName: "#EARN-GUARD",
      refunds: [
        {
          id: "refund_earn_guard",
          occurredAt: OCCURRED_AT,
          shopAmount: BigInt(5_000),
          lines: [
            {
              orderLineId: "order_line_earn_guard",
              shopAmount: BigInt(5_000),
              quantity: 1,
            },
          ],
        },
      ],
      shopper: {
        id: SHOPPER_ID,
        storeId: STORE_ID,
        loyaltyAccount: {
          id: ACCOUNT_ID,
          storeId: STORE_ID,
          programId: "program_earn_guard",
          program: { id: "program_earn_guard", storeId: STORE_ID },
          metadata: null,
        },
      },
    },
    lines: [
      {
        id: "refund_line_earn_guard",
        orderLineId: "order_line_earn_guard",
        shopAmount: BigInt(5_000),
        quantity: 1,
      },
    ],
    ...overrides,
  };
}

function earnGrantSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "grant_earn_guard",
    storeId: STORE_ID,
    programId: "program_earn_guard",
    program: { id: "program_earn_guard", storeId: STORE_ID },
    accountId: ACCOUNT_ID,
    shopperId: SHOPPER_ID,
    orderId: ORDER_ID,
    grossPoints: BigInt(100),
    pendingPoints: BigInt(0),
    settledPoints: BigInt(100),
    reversedPoints: BigInt(0),
    status: "settled",
    eligibleSubtotalAmount: BigInt(10_000),
    orderTotalAmount: BigInt(10_000),
    voidedAt: null,
    lineEarns: [
      {
        id: "line_earn_guard",
        grantId: "grant_earn_guard",
        storeId: STORE_ID,
        orderLineId: "order_line_earn_guard",
        lineNetAmount: BigInt(10_000),
        quantity: 2,
        awardedPoints: BigInt(100),
        reversedPoints: BigInt(0),
        isExcluded: false,
      },
    ],
    ...overrides,
  };
}

function legacyOrderEarnLedger(overrides: Record<string, unknown> = {}) {
  return {
    id: "ledger_legacy_order_earn",
    storeId: STORE_ID,
    accountId: ACCOUNT_ID,
    entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
    pointsDelta: BigInt(75),
    pendingDelta: BigInt(0),
    grantId: null,
    referenceType: "COMMERCE_ORDER",
    referenceId: ORDER_ID,
    idempotencyKey: `earn_order:${ORDER_ID}`,
    createdAt: new Date("2026-09-01T00:00:01.000Z"),
    ...overrides,
  };
}

function legacyRefundLedger(
  refundId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: `ledger_legacy_${refundId}`,
    storeId: STORE_ID,
    accountId: ACCOUNT_ID,
    entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
    pointsDelta: BigInt(-50),
    pendingDelta: BigInt(0),
    grantId: null,
    referenceType: "COMMERCE_REFUND",
    referenceId: refundId,
    idempotencyKey: `refund_reversal:${refundId}`,
    createdAt: OCCURRED_AT,
    ...overrides,
  };
}

function expectLegacyAdoptionLedgerKey(prefix: string) {
  const calls = domainMocks.appendPointsLedgerEntry.mock.calls;
  const input = calls[calls.length - 1]?.[0] as any;
  expect(input).toBeDefined();
  const fingerprint = input.metadata?.legacyAdoptionFingerprint;
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(input.metadata).toMatchObject({
    legacyGrantAdoption: true,
    legacyAdoptionFingerprint: fingerprint,
  });
  expect(input.idempotencyKey).toBe(`${prefix}:${fingerprint}`);
}

describe("loyalty earn-rule financial guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.$transaction as any).mockImplementation(
      async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
    );
    domainMocks.assertOperationalWrites.mockResolvedValue({
      id: STORE_ID,
      complianceState: "active",
    });
    domainMocks.assertInstallationGeneration.mockResolvedValue({
      id: STORE_ID,
      complianceState: "active",
    });
    domainMocks.calculateNextPointsExpiryDate.mockReturnValue(null);
    domainMocks.hasCustomerRedactionTombstone.mockReturnValue(false);
    domainMocks.enqueueOutboxJob.mockResolvedValue({});
    domainMocks.scheduleTierReview.mockResolvedValue(null);
    domainMocks.appendPointsLedgerEntry.mockImplementation(async (input) => ({
      id: "ledger_earn_guard",
      balanceAfter: BigInt(1_000) + BigInt(input.pointsDelta),
      ...input,
    }));

    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValue(
      commerceOrder(),
    );
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValue(null);
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValue(
      loyaltyProgram(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValue(null);
    (prisma.weleticLoyaltyEarnGrant.create as any).mockImplementation(
      ({ data }: any) => ({ ...data }),
    );
    (prisma.weleticLoyaltyEarnGrant.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticLoyaltyOrderLineEarn.createMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticLoyaltyOrderLineEarn.update as any).mockResolvedValue({});
    (prisma.weleticLoyaltyOrderLineEarn.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticLoyaltyAccount.update as any).mockResolvedValue({});
    (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(null);
    (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValue([]);
    (prisma.weleticPointsLedgerEntry.updateMany as any).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticReconciliationIssue.upsert as any).mockResolvedValue({});
    (prisma.weleticReconciliationIssue.updateMany as any).mockResolvedValue({
      count: 0,
    });
  });

  it.each([
    ["no order_paid rule", []],
    [
      "future order_paid rule",
      [orderPaidRule({ startAt: new Date("2026-09-02T00:00:00.000Z") })],
    ],
    [
      "expired order_paid rule",
      [orderPaidRule({ endAt: new Date("2026-09-01T00:00:00.000Z") })],
    ],
    [
      "tier-ineligible order_paid rule",
      [orderPaidRule({ eligibleTierIds: ["tier_platinum"] })],
    ],
    [
      "rule created after the order",
      [
        orderPaidRule({
          createdAt: new Date("2026-09-01T00:00:00.001Z"),
        }),
      ],
    ],
    [
      "malformed tier eligibility",
      [orderPaidRule({ eligibleTierIds: { tierId: "tier_gold" } })],
    ],
  ])("does not award points for %s", async (_scenario, earningRules) => {
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({ earningRules }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toMatchObject({
      grossPoints: BigInt(0),
      settledPoints: BigInt(0),
      calculationSnapshot: expect.objectContaining({
        outcome: "no_award",
      }),
    });
    expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledTimes(1);
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(domainMocks.enqueueOutboxJob).not.toHaveBeenCalled();
    expect(domainMocks.scheduleTierReview).not.toHaveBeenCalled();
  });

  it("keeps tax-and-shipping-inclusive earning replayable until its refund basis is supported", async () => {
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({
        earningRules: [orderPaidRule({ excludeTaxesAndShipping: false })],
      }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toBeNull();
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "loyalty_earn_rule_unsupported_financial_basis",
          severity: "critical",
          details: expect.objectContaining({
            ruleId: "rule_order_paid",
          }),
        }),
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("quarantines conditioned order earning until captured lines are evaluated against the condition", async () => {
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({
        earningRules: [
          orderPaidRule({
            conditions: { productTags: ["loyalty-exclusive"] },
          }),
        ],
      }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toBeNull();
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "loyalty_earn_rule_unsupported_conditions",
          severity: "critical",
          details: expect.objectContaining({
            ruleId: "rule_order_paid",
          }),
        }),
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive program", { status: "inactive" }],
    ["active kill switch", { killSwitchActive: true }],
  ])(
    "pauses an %s without persisting a permanent order outcome",
    async (_scenario, overrides) => {
      (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
        loyaltyProgram(overrides),
      );

      await expect(
        processOrderPointsEarn({
          storeId: STORE_ID,
          orderId: ORDER_ID,
        }),
      ).rejects.toThrow("paused by the current program operational gate");

      expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it("persists a no-award marker when the mutable test program was created after the order", async () => {
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({
        createdAt: new Date("2026-09-01T00:00:00.001Z"),
      }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toMatchObject({
      grossPoints: BigInt(0),
      calculationSnapshot: expect.objectContaining({
        outcome: "no_award",
        reason: "program_configuration_not_event_time_safe",
      }),
    });
    expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledTimes(1);
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("does not treat unrelated program or tier updatedAt timestamps as financial revisions", async () => {
    const baseOrder = commerceOrder();
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        shopper: {
          ...baseOrder.shopper,
          loyaltyAccount: {
            ...baseOrder.shopper.loyaltyAccount,
            currentTier: {
              ...baseOrder.shopper.loyaltyAccount.currentTier,
              updatedAt: new Date("2026-09-01T00:00:00.001Z"),
            },
          },
        },
      }),
    );
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({
        updatedAt: new Date("2026-09-01T00:00:00.001Z"),
        earningRules: [orderPaidRule()],
      }),
    );

    await processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID });

    expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        grossPoints: BigInt(100),
        selectedRuleId: "rule_order_paid",
      }),
    });
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", []],
    [
      "incomplete",
      [
        {
          ...commerceOrder().lines[0],
          shopGross: BigInt(9_000),
          shopNet: BigInt(9_000),
        },
      ],
    ],
  ])(
    "keeps a positive order replayable when its line snapshot is %s",
    async (_scenario, lines) => {
      (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
        commerceOrder({ lines }),
      );

      const result = await processOrderPointsEarn({
        storeId: STORE_ID,
        orderId: ORDER_ID,
      });

      expect(result).toBeNull();
      expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            kind: "loyalty_order_line_snapshot_unavailable",
            severity: "critical",
            details: expect.objectContaining({
              orderId: ORDER_ID,
              capturedOrderNet: "10000",
            }),
          }),
        }),
      );
      expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it("does not regress the account expiry clock when an older holding-period order arrives late", async () => {
    const laterActivityAt = new Date("2026-09-03T00:00:00.000Z");
    const expectedExpiryAt = new Date("2027-09-03T00:00:00.000Z");
    const baseOrder = commerceOrder();
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        shopper: {
          ...baseOrder.shopper,
          loyaltyAccount: {
            ...baseOrder.shopper.loyaltyAccount,
            lastQualifyingActivityAt: laterActivityAt,
          },
        },
      }),
    );
    const currentProgram = loyaltyProgram({
      holdingPeriodDays: 14,
      pointsExpiryPolicyVersion: 9,
    });
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      currentProgram,
    );
    domainMocks.calculateNextPointsExpiryDate.mockReturnValueOnce(
      expectedExpiryAt,
    );

    await processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID });

    expect(domainMocks.calculateNextPointsExpiryDate).toHaveBeenCalledWith({
      policy: currentProgram,
      lastActivityAt: laterActivityAt,
      fallbackAt: laterActivityAt,
    });
    expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: expect.objectContaining({
        cachedPendingPoints: { increment: BigInt(100) },
        lastQualifyingActivityAt: laterActivityAt,
        nextExpiryDate: expectedExpiryAt,
        pointsExpiryPolicyVersion: 9,
        pointsExpiryJobsScheduledAt: null,
      }),
    });
  });

  it("fails closed when a loyalty account has no store program", async () => {
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      null,
    );

    await expect(
      processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID }),
    ).rejects.toThrow("missing its store program");

    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("rejects an existing grant owned by a different loyalty account", async () => {
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot({ accountId: "account_other" }),
    );

    await expect(
      processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID }),
    ).rejects.toThrow("does not match order");

    expect(prisma.weleticLoyaltyProgram.findUnique).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("recovers a grant from the authoritative legacy earn ledger without re-crediting the account", async () => {
    const legacyLedger = legacyOrderEarnLedger();
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      legacyLedger,
    );
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({ earningRules: [] }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toMatchObject({
      grossPoints: BigInt(75),
      settledPoints: BigInt(75),
      pendingPoints: BigInt(0),
      calculationSnapshot: expect.objectContaining({
        outcome: "legacy_earn_ledger_adopted",
        sourceLedgerEntryId: legacyLedger.id,
      }),
    });
    expect(prisma.weleticLoyaltyOrderLineEarn.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          storeId: STORE_ID,
          orderLineId: "order_line_earn_guard",
          awardedPoints: BigInt(75),
          reversedPoints: BigInt(0),
        }),
      ],
    });
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: legacyLedger.id,
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        pointsDelta: BigInt(75),
        pendingDelta: BigInt(0),
        grantId: null,
      }),
      data: { grantId: expect.stringMatching(/^wgrant_/) },
    });
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    expect(domainMocks.enqueueOutboxJob).toHaveBeenCalledTimes(1);
    expect(domainMocks.scheduleTierReview).toHaveBeenCalledTimes(1);
  });

  it("retains a critical reconciliation issue instead of inventing a grant when legacy allocation is unavailable", async () => {
    const legacyLedger = legacyOrderEarnLedger();
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({ lines: [] }),
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      legacyLedger,
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toBe(legacyLedger);
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          storeId: STORE_ID,
          kind: "loyalty_earn_grant_recovery_required",
          severity: "critical",
          status: "open",
        }),
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("does not invent a refundable line allocation for a multi-line legacy ledger", async () => {
    const legacyLedger = legacyOrderEarnLedger();
    const firstLine = commerceOrder().lines[0];
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        lines: [
          { ...firstLine, shopNet: BigInt(6_000) },
          {
            ...firstLine,
            id: "order_line_earn_guard_discounted",
            externalId: "gid://shopify/LineItem/earn-guard-discounted",
            shopGross: BigInt(8_000),
            shopDiscount: BigInt(4_000),
            shopNet: BigInt(4_000),
          },
        ],
      }),
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      legacyLedger,
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toBe(legacyLedger);
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "loyalty_earn_grant_recovery_required",
          details: expect.objectContaining({
            reason: "ambiguous_multi_line_allocation",
          }),
        }),
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.createMany,
    ).not.toHaveBeenCalled();
    expect(prisma.weleticPointsLedgerEntry.updateMany).not.toHaveBeenCalled();
  });

  it("rolls back legacy earn recovery when the ledger provenance CAS is lost", async () => {
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      legacyOrderEarnLedger(),
    );
    (prisma.weleticPointsLedgerEntry.updateMany as any).mockResolvedValueOnce({
      count: 0,
    });

    await expect(
      processOrderPointsEarn({
        storeId: STORE_ID,
        orderId: ORDER_ID,
        tx: prisma as unknown as Prisma.TransactionClient,
      }),
    ).rejects.toThrow("Historical order earn ledger adoption conflict");

    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(domainMocks.enqueueOutboxJob).not.toHaveBeenCalled();
  });

  it.each([
    [
      "account",
      {
        programId: "program_other",
        program: { id: "program_other", storeId: STORE_ID },
      },
    ],
    [
      "tier",
      {
        currentTier: {
          ...commerceOrder().shopper.loyaltyAccount.currentTier,
          programId: "program_other",
        },
      },
    ],
  ])(
    "rejects a cross-program %s relationship",
    async (_scenario, overrides) => {
      const baseOrder = commerceOrder();
      (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
        commerceOrder({
          shopper: {
            ...baseOrder.shopper,
            loyaltyAccount: {
              ...baseOrder.shopper.loyaltyAccount,
              ...overrides,
            },
          },
        }),
      );

      await expect(
        processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID }),
      ).rejects.toThrow("cross-program relationship");

      expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "tier membership changed after the order",
      {
        tierHistory: [{ effectiveAt: new Date("2026-09-01T00:00:00.001Z") }],
      },
    ],
    [
      "current tier relation is missing",
      {
        currentTier: null,
      },
    ],
  ])("fails closed when the %s", async (_scenario, accountOverrides) => {
    const baseOrder = commerceOrder();
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        shopper: {
          ...baseOrder.shopper,
          loyaltyAccount: {
            ...baseOrder.shopper.loyaltyAccount,
            ...accountOverrides,
          },
        },
      }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toBeNull();
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "loyalty_tier_history_unavailable",
          severity: "critical",
          status: "open",
        }),
      }),
    );
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["non-order rule", orderPaidRule({ triggerCode: "account_created" })],
    ["inactive order_paid rule", orderPaidRule({ isActive: false })],
  ])(
    "does not award points when runtime eligibility excludes the %s",
    async (_scenario, rule) => {
      (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
        loyaltyProgram({ earningRules: [rule] }),
      );

      const result = await processOrderPointsEarn({
        storeId: STORE_ID,
        orderId: ORDER_ID,
      });

      expect(result).toMatchObject({
        grossPoints: BigInt(0),
        calculationSnapshot: expect.objectContaining({
          outcome: "no_award",
          reason: "no_eligible_order_paid_rule",
        }),
      });
      expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledTimes(1);
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it("loads every pre-event earning rule so retagging or deactivation cannot fall through", async () => {
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({ earningRules: [] }),
    );

    await processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID });

    expect(prisma.weleticLoyaltyProgram.findUnique).toHaveBeenCalledWith({
      where: { storeId: STORE_ID },
      include: expect.objectContaining({
        earningRules: expect.objectContaining({
          where: {
            createdAt: { lte: OCCURRED_AT },
            deletedAt: null,
          },
        }),
      }),
    });
  });

  it.each([
    [
      "deactivated",
      {
        isActive: false,
        updatedAt: new Date("2026-09-01T00:00:00.001Z"),
      },
    ],
    [
      "retagged",
      {
        triggerCode: "account_created",
        updatedAt: new Date("2026-09-01T00:00:00.001Z"),
      },
    ],
  ])(
    "fails closed instead of falling through when a higher-priority pre-event rule was later %s",
    async (_scenario, highPriorityOverrides) => {
      const lowerPriorityRule = orderPaidRule({
        id: "rule_lower_priority",
        priority: 100,
        multiplier: new Prisma.Decimal(1),
      });
      const mutatedHigherPriorityRule = orderPaidRule({
        id: "rule_higher_priority_mutated",
        priority: 200,
        multiplier: new Prisma.Decimal(10),
        ...highPriorityOverrides,
      });
      (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
        loyaltyProgram({
          earningRules: [mutatedHigherPriorityRule, lowerPriorityRule],
        }),
      );

      const result = await processOrderPointsEarn({
        storeId: STORE_ID,
        orderId: ORDER_ID,
      });

      expect(result).toMatchObject({
        grossPoints: BigInt(0),
        calculationSnapshot: expect.objectContaining({
          outcome: "no_award",
        }),
      });
      expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          grossPoints: BigInt(0),
        }),
      });
      expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalledWith({
        data: expect.objectContaining({
          selectedRuleId: lowerPriorityRule.id,
          grossPoints: BigInt(100),
        }),
      });
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it("does not let campaign or tier multipliers resurrect an award without an eligible rule", async () => {
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        shopper: {
          id: SHOPPER_ID,
          storeId: STORE_ID,
          loyaltyAccount: {
            id: ACCOUNT_ID,
            storeId: STORE_ID,
            currentTierId: "tier_gold",
            currentTier: {
              id: "tier_gold",
              pointsMultiplier: new Prisma.Decimal(5),
            },
          },
        },
      }),
    );
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({
        earningRules: [],
        bonusCampaigns: [
          {
            id: "campaign_10x",
            isActive: true,
            multiplier: new Prisma.Decimal(10),
            eligibleTierIds: ["tier_gold"],
            createdAt: OCCURRED_AT,
          },
        ],
      }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });
    expect(result).toMatchObject({ grossPoints: BigInt(0) });
    expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledTimes(1);
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("ignores a campaign created after the order", async () => {
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({
        bonusCampaigns: [
          {
            id: "campaign_ineligible",
            isActive: true,
            multiplier: new Prisma.Decimal(10),
            startAt: new Date("2026-01-01T00:00:00.000Z"),
            endAt: new Date("2027-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date("2026-09-01T00:00:00.001Z"),
            eligibleTierIds: ["tier_gold"],
          },
        ],
      }),
    );

    await processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID });

    expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        grossPoints: BigInt(100),
        selectedCampaignId: null,
      }),
    });
  });

  it.each([
    [
      "malformed tier eligibility",
      {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        eligibleTierIds: { tierId: "tier_gold" },
      },
      "invalid_bonus_campaign_configuration",
    ],
  ])(
    "fails closed for a campaign with %s",
    async (_scenario, campaignOverrides, expectedReason) => {
      (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
        loyaltyProgram({
          bonusCampaigns: [
            {
              id: "campaign_unsafe",
              isActive: true,
              multiplier: new Prisma.Decimal(10),
              startAt: new Date("2026-01-01T00:00:00.000Z"),
              endAt: new Date("2027-01-01T00:00:00.000Z"),
              ...campaignOverrides,
            },
          ],
        }),
      );

      const result = await processOrderPointsEarn({
        storeId: STORE_ID,
        orderId: ORDER_ID,
      });

      expect(result).toMatchObject({
        grossPoints: BigInt(0),
        selectedRuleId: "rule_order_paid",
        calculationSnapshot: expect.objectContaining({
          outcome: "no_award",
          reason: expectedReason,
        }),
      });
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it("persists a no-award decision so a replay cannot earn after rule activation", async () => {
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({ earningRules: [] }),
    );

    const noAwardMarker = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });
    expect(noAwardMarker).toMatchObject({
      grossPoints: BigInt(0),
      selectedRuleId: null,
      calculationSnapshot: expect.objectContaining({
        reason: "no_eligible_order_paid_rule",
      }),
    });

    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      noAwardMarker,
    );
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValue(
      loyaltyProgram({
        earningRules: [orderPaidRule({ id: "rule_activated_later" })],
      }),
    );

    await expect(
      processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID }),
    ).resolves.toBe(noAwardMarker);
    expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledTimes(1);
    expect(prisma.weleticLoyaltyProgram.findUnique).toHaveBeenCalledTimes(1);
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("uses a paid-order replay to adopt a historical refund into an existing grant", async () => {
    const existingGrant = earnGrantSnapshot();
    const legacyReversal = legacyRefundLedger("refund_earn_guard", {
      id: "ledger_existing_grant_legacy_refund",
    });
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        refunds: [
          {
            id: "refund_earn_guard",
            lines: [{ id: "refund_line_earn_guard" }],
          },
        ],
      }),
    );
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any)
      .mockResolvedValueOnce(existingGrant)
      .mockResolvedValueOnce(existingGrant);
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      legacyReversal,
    );

    await expect(
      processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID }),
    ).resolves.toBe(existingGrant);

    expect(prisma.weleticLoyaltyProgram.findUnique).not.toHaveBeenCalled();
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: legacyReversal.id,
          grantId: null,
        }),
        data: { grantId: existingGrant.id },
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settledPoints: BigInt(50),
          reversedPoints: BigInt(50),
          status: "partially_reversed",
        }),
      }),
    );
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("uses a paid-order replay to adopt a legacy line-less refund without opening new adjustment clawbacks", async () => {
    const existingGrant = earnGrantSnapshot();
    const legacyReversal = legacyRefundLedger("refund_earn_guard", {
      id: "ledger_existing_grant_line_less_legacy_refund",
      pointsDelta: BigInt(-10),
    });
    const lineLessRefund = refundWithAccount({
      lines: [],
      order: {
        ...refundWithAccount().order,
        refunds: [
          {
            id: "refund_earn_guard",
            occurredAt: OCCURRED_AT,
            shopAmount: BigInt(5_000),
            lines: [],
          },
        ],
      },
    });
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        refunds: [{ id: "refund_earn_guard", lines: [] }],
      }),
    );
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      lineLessRefund,
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any)
      .mockResolvedValueOnce(existingGrant)
      .mockResolvedValueOnce(existingGrant);
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
      legacyReversal,
    );
    (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce([
      legacyReversal,
    ]);

    await expect(
      processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID }),
    ).resolves.toBe(existingGrant);

    expect(prisma.weleticCommerceRefund.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: legacyReversal.id,
          grantId: null,
        }),
        data: { grantId: existingGrant.id },
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settledPoints: BigInt(90),
          reversedPoints: BigInt(10),
        }),
      }),
    );
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("persists the selected eligible order_paid rule on the immutable grant", async () => {
    const rule = orderPaidRule({ id: "rule_selected_order_paid" });
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({ earningRules: [rule] }),
    );

    await processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID });

    expect(prisma.weleticLoyaltyEarnGrant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        selectedRuleId: rule.id,
        grossPoints: BigInt(100),
      }),
    });
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(100),
      }),
    );
  });

  it("treats an explicit zero max-points cap as a zero-point outcome", async () => {
    const rule = orderPaidRule({ maxPointsPerEvent: BigInt(0) });
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({ earningRules: [rule] }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toMatchObject({
      grossPoints: BigInt(0),
      selectedRuleId: rule.id,
      calculationSnapshot: expect.objectContaining({
        reason: "non_positive_points_calculation",
      }),
    });
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["zero", BigInt(0)],
  ])(
    "fails closed for a fixed-points rule with a %s value",
    async (_scenario, fixedPoints) => {
      const rule = orderPaidRule({
        ruleType: "fixed_points",
        fixedPoints,
        multiplier: new Prisma.Decimal(10),
      });
      (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
        loyaltyProgram({ earningRules: [rule] }),
      );

      const result = await processOrderPointsEarn({
        storeId: STORE_ID,
        orderId: ORDER_ID,
      });

      expect(result).toMatchObject({
        grossPoints: BigInt(0),
        selectedRuleId: rule.id,
        calculationSnapshot: expect.objectContaining({
          reason: "non_positive_points_calculation",
        }),
      });
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it("earns zero when Shopify records a fully discounted line with shopNet zero", async () => {
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        shopNet: BigInt(0),
        lines: [
          {
            id: "order_line_free",
            externalId: "gid://shopify/LineItem/free",
            productId: "gid://shopify/Product/free",
            variantId: "gid://shopify/ProductVariant/free",
            title: "Fully discounted item",
            quantity: 1,
            shopGross: BigInt(10_000),
            shopDiscount: BigInt(10_000),
            shopNet: BigInt(0),
            presentmentNet: BigInt(10_000),
          },
        ],
      }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });
    expect(result).toMatchObject({
      grossPoints: BigInt(0),
      calculationSnapshot: expect.objectContaining({
        reason: "non_positive_eligible_subtotal",
      }),
    });
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("does not fall back to a positive presentment amount when a line-less order has shopNet zero", async () => {
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        shopNet: BigInt(0),
        presentmentNet: BigInt(10_000),
        lines: [],
      }),
    );

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });
    expect(result).toMatchObject({
      grossPoints: BigInt(0),
      calculationSnapshot: expect.objectContaining({
        reason: "non_positive_eligible_subtotal",
      }),
    });
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("keeps a positive line-less order replayable so a later refund cannot reverse an unverifiable source", async () => {
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        shopNet: BigInt(10_000),
        presentmentNet: BigInt(10_000),
        lines: [],
      }),
    );
    const earnResult = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(earnResult).toBeNull();
    expect(prisma.weleticLoyaltyEarnGrant.create).not.toHaveBeenCalled();
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          kind: "loyalty_order_line_snapshot_unavailable",
          severity: "critical",
        }),
      }),
    );
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();

    const lineLessRefund = refundWithAccount({
      lines: [],
      order: {
        ...refundWithAccount().order,
        refunds: [
          {
            id: "refund_earn_guard",
            occurredAt: OCCURRED_AT,
            shopAmount: BigInt(5_000),
            lines: [],
          },
        ],
      },
    });
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      lineLessRefund,
    );
    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).resolves.toBeNull();
    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("reconciles an authoritative refund that was persisted before the earn grant", async () => {
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        refunds: [
          {
            id: "refund_earn_guard",
            lines: [{ id: "refund_line_earn_guard" }],
          },
        ],
      }),
    );
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "grant_earn_guard",
        storeId: STORE_ID,
        orderId: ORDER_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(100),
        reversedPoints: BigInt(0),
        status: "settled",
        eligibleSubtotalAmount: BigInt(10_000),
        orderTotalAmount: BigInt(10_000),
        voidedAt: null,
        lineEarns: [
          {
            id: "line_earn_guard",
            grantId: "grant_earn_guard",
            storeId: STORE_ID,
            orderLineId: "order_line_earn_guard",
            lineNetAmount: BigInt(10_000),
            quantity: 2,
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      });

    await processOrderPointsEarn({ storeId: STORE_ID, orderId: ORDER_ID });

    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(100),
      }),
    );
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(-50),
        referenceId: "refund_earn_guard",
      }),
    );
  });

  it("undoes a legacy grantless refund debit when the immutable order outcome is no award", async () => {
    const noAwardGrant = earnGrantSnapshot({
      id: "grant_no_award",
      grossPoints: BigInt(0),
      pendingPoints: BigInt(0),
      settledPoints: BigInt(0),
      reversedPoints: BigInt(0),
      calculationSnapshot: {
        outcome: "no_award",
        reason: "no_eligible_order_paid_rule",
      },
      lineEarns: [],
    });
    const legacyReversal = legacyRefundLedger("refund_earn_guard", {
      id: "ledger_legacy_no_award_refund",
    });
    (prisma.weleticCommerceOrder.findUnique as any).mockResolvedValueOnce(
      commerceOrder({
        refunds: [
          {
            id: "refund_earn_guard",
            lines: [{ id: "refund_line_earn_guard" }],
          },
        ],
      }),
    );
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValueOnce(
      loyaltyProgram({ earningRules: [] }),
    );
    (prisma.weleticLoyaltyEarnGrant.create as any).mockImplementationOnce(
      ({ data }: any) => ({ ...data, id: "grant_no_award" }),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(noAwardGrant);
    (prisma.weleticPointsLedgerEntry.findUnique as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(legacyReversal);

    const result = await processOrderPointsEarn({
      storeId: STORE_ID,
      orderId: ORDER_ID,
    });

    expect(result).toMatchObject({
      id: "grant_no_award",
      grossPoints: BigInt(0),
      calculationSnapshot: expect.objectContaining({
        reason: "no_eligible_order_paid_rule",
      }),
    });
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(1);
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(50),
        pendingDelta: BigInt(0),
        grantId: "grant_no_award",
      }),
    );
    expectLegacyAdoptionLedgerKey(
      "refund_reversal:refund_earn_guard:adopt_grant:grant_no_award",
    );
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: legacyReversal.id,
          grantId: null,
        }),
        data: { grantId: "grant_no_award" },
      }),
    );
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
  });

  it("fails closed without a source grant and makes no account or ledger mutation", async () => {
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );

    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).resolves.toBeNull();

    expect(prisma.weleticLoyaltyProgram.findUnique).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(domainMocks.enqueueOutboxJob).not.toHaveBeenCalled();
    expect(domainMocks.scheduleTierReview).not.toHaveBeenCalled();
  });

  it("rejects a refund grant owned by a different loyalty account", async () => {
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot({ accountId: "account_other" }),
    );

    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).rejects.toThrow("does not match refund");

    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(prisma.weleticPointsLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("rejects a canonical refund reversal linked to a different grant", async () => {
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot(),
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce({
      id: "ledger_wrong_grant",
      storeId: STORE_ID,
      accountId: ACCOUNT_ID,
      grantId: "grant_other",
      pointsDelta: BigInt(-50),
      pendingDelta: BigInt(0),
    });

    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).rejects.toThrow("does not match refund");

    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("rejects a refund grant with a cross-store line allocation", async () => {
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot({
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            storeId: "store_other",
          },
        ],
      }),
    );

    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).rejects.toThrow("cross-tenant line allocation");

    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it.each([
    [
      "negative awarded points",
      {
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            awardedPoints: BigInt(-1),
          },
        ],
      },
      "Line reversal invariant failed",
    ],
    [
      "negative reversed points",
      {
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            reversedPoints: BigInt(-1),
          },
        ],
      },
      "Line reversal invariant failed",
    ],
    [
      "over-reversed points",
      {
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            reversedPoints: BigInt(101),
          },
        ],
      },
      "Line reversal invariant failed",
    ],
    [
      "gross allocation mismatch",
      {
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            awardedPoints: BigInt(99),
          },
        ],
      },
      "Source allocation invariant failed",
    ],
    [
      "reversed allocation mismatch",
      {
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            reversedPoints: BigInt(25),
          },
        ],
      },
      "Source allocation invariant failed",
    ],
  ])(
    "rejects a refund grant with %s",
    async (_scenario, grantOverrides, expectedError) => {
      (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
        refundWithAccount(),
      );
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
        earnGrantSnapshot(grantOverrides),
      );

      await expect(
        processRefundPointsReversal({
          storeId: STORE_ID,
          refundId: "refund_earn_guard",
        }),
      ).rejects.toThrow(expectedError);

      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
      expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    },
  );

  it("fails closed when a refund line snapshot loses its optimistic claim", async () => {
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValue(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValue(
      earnGrantSnapshot(),
    );
    (prisma.weleticLoyaltyOrderLineEarn.updateMany as any).mockResolvedValue({
      count: 0,
    });

    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).rejects.toThrow("Refund line conflict");

    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("fails closed when an order-level refund line allocation loses its optimistic claim", async () => {
    const orderLevelRefund = refundWithAccount({
      lines: [],
      order: {
        ...refundWithAccount().order,
        refunds: [
          {
            id: "refund_earn_guard",
            occurredAt: OCCURRED_AT,
            shopAmount: BigInt(5_000),
            lines: [],
          },
        ],
      },
    });
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValue(
      orderLevelRefund,
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValue(
      earnGrantSnapshot(),
    );
    (prisma.weleticLoyaltyOrderLineEarn.updateMany as any).mockResolvedValue({
      count: 0,
    });

    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).rejects.toThrow("Order-level refund line conflict");

    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("fails closed when the refund grant loses its optimistic claim", async () => {
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValue(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValue(
      earnGrantSnapshot(),
    );
    (prisma.weleticLoyaltyEarnGrant.updateMany as any).mockResolvedValue({
      count: 0,
    });

    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).rejects.toThrow("Refund grant conflict");

    expect(prisma.weleticLoyaltyOrderLineEarn.updateMany).toHaveBeenCalled();
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("adopts a legacy grantless reversal once before processing a later refund", async () => {
    const legacyReversal = legacyRefundLedger("refund_earn_guard", {
      id: "ledger_legacy_refund",
    });
    const secondRefund = refundWithAccount({
      id: "refund_earn_guard_second",
      externalId: "gid://shopify/Refund/earn-guard-second",
      order: {
        ...refundWithAccount().order,
        refunds: [
          ...refundWithAccount().order.refunds,
          {
            shopAmount: BigInt(5_000),
            lines: [
              {
                orderLineId: "order_line_earn_guard",
                shopAmount: BigInt(5_000),
                quantity: 1,
              },
            ],
          },
        ],
      },
      lines: [
        {
          id: "refund_line_earn_guard_second",
          orderLineId: "order_line_earn_guard",
          shopAmount: BigInt(5_000),
          quantity: 1,
        },
      ],
    });

    (prisma.weleticCommerceRefund.findUnique as any)
      .mockResolvedValueOnce(refundWithAccount())
      .mockResolvedValueOnce(secondRefund);
    (prisma.weleticPointsLedgerEntry.findUnique as any)
      .mockResolvedValueOnce(legacyReversal)
      .mockResolvedValueOnce(null);
    (prisma.weleticPointsLedgerEntry.findMany as any)
      .mockResolvedValueOnce([legacyReversal])
      .mockResolvedValueOnce([]);
    (prisma.weleticLoyaltyEarnGrant.findUnique as any)
      .mockResolvedValueOnce(earnGrantSnapshot())
      .mockResolvedValueOnce(
        earnGrantSnapshot({
          settledPoints: BigInt(50),
          reversedPoints: BigInt(50),
          status: "partially_reversed",
          lineEarns: [
            {
              ...earnGrantSnapshot().lineEarns[0],
              reversedPoints: BigInt(50),
            },
          ],
        }),
      );

    await expect(
      processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "refund_earn_guard",
      }),
    ).resolves.toBe(legacyReversal);

    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        id: legacyReversal.id,
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        grantId: null,
      },
      data: { grantId: "grant_earn_guard" },
    });
    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();

    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: "refund_earn_guard_second",
    });

    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(1);
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(-50),
        pendingDelta: BigInt(0),
        idempotencyKey: "refund_reversal:refund_earn_guard_second",
      }),
    );
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).toHaveBeenNthCalledWith(1, {
      where: {
        id: "line_earn_guard",
        grantId: "grant_earn_guard",
        storeId: STORE_ID,
        reversedPoints: BigInt(0),
      },
      data: { reversedPoints: BigInt(50) },
    });
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).toHaveBeenNthCalledWith(2, {
      where: {
        id: "line_earn_guard",
        grantId: "grant_earn_guard",
        storeId: STORE_ID,
        reversedPoints: BigInt(50),
      },
      data: { reversedPoints: BigInt(100) },
    });
  });

  it("adopts multiple historical grantless reversals even when replayed out of order", async () => {
    const firstOccurredAt = new Date("2026-09-01T01:00:00.000Z");
    const secondOccurredAt = new Date("2026-09-01T02:00:00.000Z");
    const firstPersistedRefund = {
      id: "refund_earn_guard_first_legacy",
      occurredAt: firstOccurredAt,
      shopAmount: BigInt(5_000),
      lines: [
        {
          orderLineId: "order_line_earn_guard",
          shopAmount: BigInt(5_000),
          quantity: 1,
        },
      ],
    };
    const secondPersistedRefund = {
      id: "refund_earn_guard_second_legacy",
      occurredAt: secondOccurredAt,
      shopAmount: BigInt(5_000),
      lines: [
        {
          orderLineId: "order_line_earn_guard",
          shopAmount: BigInt(5_000),
          quantity: 1,
        },
      ],
    };
    const baseRefund = refundWithAccount();
    const secondRefund = refundWithAccount({
      id: secondPersistedRefund.id,
      occurredAt: secondOccurredAt,
      order: {
        ...baseRefund.order,
        refunds: [firstPersistedRefund, secondPersistedRefund],
      },
      lines: [
        {
          id: "refund_line_earn_guard_second_legacy",
          orderLineId: "order_line_earn_guard",
          shopAmount: BigInt(5_000),
          quantity: 1,
        },
      ],
    });
    const firstLegacyReversal = legacyRefundLedger(
      "refund_earn_guard_first_legacy",
      {
        id: "ledger_first_legacy_refund",
      },
    );
    const secondLegacyReversal = legacyRefundLedger(
      "refund_earn_guard_second_legacy",
      {
        id: "ledger_second_legacy_refund",
      },
    );

    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      secondRefund,
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      secondLegacyReversal,
    );
    (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce([
      firstLegacyReversal,
      secondLegacyReversal,
    ]);
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot(),
    );

    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: secondPersistedRefund.id,
    });

    expect(domainMocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ id: firstLegacyReversal.id }),
        data: { grantId: "grant_earn_guard" },
      }),
    );
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: secondLegacyReversal.id }),
        data: { grantId: "grant_earn_guard" },
      }),
    );
    expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settledPoints: BigInt(0),
          reversedPoints: BigInt(100),
          status: "reversed",
        }),
      }),
    );
    expect(prisma.weleticLoyaltyOrderLineEarn.updateMany).toHaveBeenCalledWith({
      where: {
        id: "line_earn_guard",
        grantId: "grant_earn_guard",
        storeId: STORE_ID,
        reversedPoints: BigInt(0),
      },
      data: { reversedPoints: BigInt(100) },
    });
  });

  it("uses distinct financial identities for disjoint legacy adoption waves", async () => {
    const firstLegacyRefund = {
      id: "refund_legacy_wave_one",
      occurredAt: new Date("2026-09-01T01:00:00.000Z"),
      shopAmount: BigInt(1_000),
      lines: [],
    };
    const secondLegacyRefund = {
      id: "refund_legacy_wave_two",
      occurredAt: new Date("2026-09-01T02:00:00.000Z"),
      shopAmount: BigInt(1_000),
      lines: [],
    };
    const triggerRefund = {
      id: "refund_legacy_wave_trigger",
      occurredAt: new Date("2026-09-01T03:00:00.000Z"),
      shopAmount: BigInt(8_000),
      lines: [],
    };
    const triggerLedger = {
      id: "ledger_trigger_grant_backed",
      storeId: STORE_ID,
      accountId: ACCOUNT_ID,
      grantId: "grant_earn_guard",
      pointsDelta: BigInt(-80),
      pendingDelta: BigInt(0),
    };
    const firstLegacyLedger = legacyRefundLedger(firstLegacyRefund.id, {
      id: "ledger_legacy_wave_one",
      pointsDelta: BigInt(-10),
    });
    const secondLegacyLedger = legacyRefundLedger(secondLegacyRefund.id, {
      id: "ledger_legacy_wave_two",
      pointsDelta: BigInt(-10),
    });
    const fullyReversedGrant = earnGrantSnapshot({
      settledPoints: BigInt(0),
      reversedPoints: BigInt(100),
      status: "reversed",
      lineEarns: [
        {
          ...earnGrantSnapshot().lineEarns[0],
          reversedPoints: BigInt(100),
        },
      ],
    });
    const persistedTriggerRefund = refundWithAccount({
      id: triggerRefund.id,
      externalId: "gid://shopify/Refund/legacy-wave-trigger",
      shopAmount: triggerRefund.shopAmount,
      presentmentAmount: triggerRefund.shopAmount,
      occurredAt: triggerRefund.occurredAt,
      lines: [],
      order: {
        ...refundWithAccount().order,
        refunds: [firstLegacyRefund, secondLegacyRefund, triggerRefund],
      },
    });

    (prisma.weleticCommerceRefund.findUnique as any)
      .mockResolvedValueOnce(persistedTriggerRefund)
      .mockResolvedValueOnce(persistedTriggerRefund)
      .mockResolvedValueOnce(persistedTriggerRefund);
    (prisma.weleticPointsLedgerEntry.findUnique as any)
      .mockResolvedValueOnce(triggerLedger)
      .mockResolvedValueOnce(triggerLedger)
      .mockResolvedValueOnce(triggerLedger);
    (prisma.weleticPointsLedgerEntry.findMany as any)
      .mockResolvedValueOnce([firstLegacyLedger])
      .mockResolvedValueOnce([secondLegacyLedger])
      .mockResolvedValueOnce([]);
    (prisma.weleticLoyaltyEarnGrant.findUnique as any)
      .mockResolvedValueOnce(fullyReversedGrant)
      .mockResolvedValueOnce(fullyReversedGrant)
      .mockResolvedValueOnce(fullyReversedGrant);

    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: triggerRefund.id,
    });
    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: triggerRefund.id,
    });
    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: triggerRefund.id,
    });

    const correctionCalls = domainMocks.appendPointsLedgerEntry.mock.calls.map(
      ([input]) => input as any,
    );
    expect(correctionCalls).toHaveLength(2);
    expect(correctionCalls.map((input) => input.pointsDelta)).toEqual([
      BigInt(10),
      BigInt(10),
    ]);
    expect(correctionCalls[0].idempotencyKey).not.toBe(
      correctionCalls[1].idempotencyKey,
    );
    for (const correction of correctionCalls) {
      expect(correction.idempotencyKey).toMatch(
        /^refund_reversal:refund_legacy_wave_trigger:adopt_grant:grant_earn_guard:[a-f0-9]{64}$/,
      );
      expect(correction.metadata.legacyAdoptedLedgerEntryIds).toHaveLength(1);
    }
    expect(domainMocks.scheduleTierReview).toHaveBeenCalledTimes(2);
    const activityKeys = domainMocks.scheduleTierReview.mock.calls.map(
      ([input]) => (input as any).activityKey,
    );
    expect(activityKeys[0]).not.toBe(activityKeys[1]);
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(2);
  });

  it("compensates a legacy debit already included by a later cumulative refund", async () => {
    const firstPersistedRefund = {
      id: "refund_earn_guard_legacy_twenty",
      occurredAt: new Date("2026-09-01T01:00:00.000Z"),
      shopAmount: BigInt(2_000),
      lines: [],
    };
    const laterPersistedRefund = {
      id: "refund_earn_guard_normal_fifty",
      occurredAt: new Date("2026-09-01T02:00:00.000Z"),
      shopAmount: BigInt(5_000),
      lines: [],
    };
    const legacyReversal = legacyRefundLedger(
      "refund_earn_guard_legacy_twenty",
      {
        id: "ledger_legacy_twenty_already_in_target",
        pointsDelta: BigInt(-20),
      },
    );
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount({
        id: firstPersistedRefund.id,
        externalId: "gid://shopify/Refund/legacy-twenty",
        shopAmount: BigInt(2_000),
        presentmentAmount: BigInt(2_000),
        occurredAt: firstPersistedRefund.occurredAt,
        lines: [],
        order: {
          ...refundWithAccount().order,
          refunds: [firstPersistedRefund, laterPersistedRefund],
        },
      }),
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      legacyReversal,
    );
    (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce([
      legacyReversal,
    ]);
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot({
        settledPoints: BigInt(30),
        reversedPoints: BigInt(70),
        status: "partially_reversed",
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            reversedPoints: BigInt(70),
          },
        ],
      }),
    );

    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: firstPersistedRefund.id,
    });

    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: legacyReversal.id }),
        data: { grantId: "grant_earn_guard" },
      }),
    );
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        pointsDelta: BigInt(20),
        pendingDelta: BigInt(0),
      }),
    );
    expectLegacyAdoptionLedgerKey(
      "refund_reversal:refund_earn_guard_legacy_twenty:adopt_grant:grant_earn_guard",
    );
  });

  it("discovers and compensates an older legacy debit when only the later refund is replayed", async () => {
    const legacyRefund = {
      id: "refund_earn_guard_older_legacy",
      occurredAt: new Date("2026-09-01T01:00:00.000Z"),
      shopAmount: BigInt(2_000),
      lines: [],
    };
    const laterRefund = {
      id: "refund_earn_guard_later_normal",
      occurredAt: new Date("2026-09-01T02:00:00.000Z"),
      shopAmount: BigInt(5_000),
      lines: [],
    };
    const legacyReversal = legacyRefundLedger(
      "refund_earn_guard_older_legacy",
      {
        id: "ledger_older_legacy_refund",
        pointsDelta: BigInt(-20),
      },
    );
    const laterGrantBackedReversal = {
      id: "ledger_later_grant_backed_refund",
      storeId: STORE_ID,
      accountId: ACCOUNT_ID,
      grantId: "grant_earn_guard",
      pointsDelta: BigInt(-70),
      pendingDelta: BigInt(0),
    };
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount({
        id: laterRefund.id,
        externalId: "gid://shopify/Refund/later-normal",
        occurredAt: laterRefund.occurredAt,
        lines: [],
        order: {
          ...refundWithAccount().order,
          refunds: [legacyRefund, laterRefund],
        },
      }),
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      laterGrantBackedReversal,
    );
    (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce([
      legacyReversal,
    ]);
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot({
        settledPoints: BigInt(30),
        reversedPoints: BigInt(70),
        status: "partially_reversed",
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            reversedPoints: BigInt(70),
          },
        ],
      }),
    );

    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: laterRefund.id,
    });

    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: legacyReversal.id,
          grantId: null,
        }),
        data: { grantId: "grant_earn_guard" },
      }),
    );
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        pointsDelta: BigInt(20),
        pendingDelta: BigInt(0),
      }),
    );
    expectLegacyAdoptionLedgerKey(
      "refund_reversal:refund_earn_guard_later_normal:adopt_grant:grant_earn_guard",
    );
  });

  it("links and compensates a legacy reversal whose target is already fully represented", async () => {
    const legacyReversal = legacyRefundLedger("refund_earn_guard", {
      id: "ledger_legacy_already_represented",
    });
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      legacyReversal,
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot({
        settledPoints: BigInt(0),
        reversedPoints: BigInt(100),
        status: "reversed",
        lineEarns: [
          {
            ...earnGrantSnapshot().lineEarns[0],
            reversedPoints: BigInt(100),
          },
        ],
      }),
    );

    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: "refund_earn_guard",
    });

    expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
    expect(
      prisma.weleticLoyaltyOrderLineEarn.updateMany,
    ).not.toHaveBeenCalled();
    expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: legacyReversal.id }),
        data: { grantId: "grant_earn_guard" },
      }),
    );
    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        pointsDelta: BigInt(50),
        pendingDelta: BigInt(0),
      }),
    );
    expectLegacyAdoptionLedgerKey(
      "refund_reversal:refund_earn_guard:adopt_grant:grant_earn_guard",
    );
  });

  it("transfers a legacy settled debit into the pending bucket during adoption", async () => {
    const legacyReversal = legacyRefundLedger("refund_earn_guard", {
      id: "ledger_legacy_pending_refund",
    });
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      legacyReversal,
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
      earnGrantSnapshot({
        pendingPoints: BigInt(100),
        settledPoints: BigInt(0),
        status: "pending",
      }),
    );

    await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: "refund_earn_guard",
    });

    expect(domainMocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        pointsDelta: BigInt(50),
        pendingDelta: BigInt(-50),
      }),
    );
    expectLegacyAdoptionLedgerKey(
      "refund_reversal:refund_earn_guard:adopt_grant:grant_earn_guard",
    );
    expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          pendingPoints: BigInt(50),
          settledPoints: BigInt(0),
          reversedPoints: BigInt(50),
          status: "partially_reversed",
        }),
      }),
    );
  });

  it("keeps immutable grant-backed refund reversals valid", async () => {
    (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce(
      refundWithAccount(),
    );
    (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
      id: "grant_earn_guard",
      storeId: STORE_ID,
      orderId: ORDER_ID,
      grossPoints: BigInt(100),
      pendingPoints: BigInt(0),
      settledPoints: BigInt(100),
      reversedPoints: BigInt(0),
      status: "settled",
      eligibleSubtotalAmount: BigInt(10_000),
      orderTotalAmount: BigInt(10_000),
      voidedAt: null,
      lineEarns: [
        {
          id: "line_earn_guard",
          grantId: "grant_earn_guard",
          storeId: STORE_ID,
          orderLineId: "order_line_earn_guard",
          lineNetAmount: BigInt(10_000),
          quantity: 2,
          awardedPoints: BigInt(100),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
      ],
    });

    const result = await processRefundPointsReversal({
      storeId: STORE_ID,
      refundId: "refund_earn_guard",
    });

    expect(result).toMatchObject({
      entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
      pointsDelta: BigInt(-50),
      pendingDelta: BigInt(0),
    });
    expect(prisma.weleticLoyaltyOrderLineEarn.updateMany).toHaveBeenCalledWith({
      where: {
        id: "line_earn_guard",
        grantId: "grant_earn_guard",
        storeId: STORE_ID,
        reversedPoints: BigInt(0),
      },
      data: { reversedPoints: BigInt(50) },
    });
    expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          settledPoints: BigInt(50),
          reversedPoints: BigInt(50),
          status: "partially_reversed",
        }),
      }),
    );
  });
});
