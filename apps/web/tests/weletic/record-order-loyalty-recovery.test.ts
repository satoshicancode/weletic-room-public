import { prisma } from "@/lib/prisma";
import { beforeEach, describe, expect, it, vi } from "vitest";

type TestOrder = {
  id: string;
  storeId: string;
  programId: string;
  partnerId: string;
  shopperId: string | null;
  externalId: string;
  accountingNet: bigint;
  accountingCurrency: string;
  presentmentNet: bigint;
  presentmentCurrency: string;
  shopNet: bigint;
  shopCurrency: string;
  analyticsRecordedAt: Date | null;
  dubStatsRecordedAt: Date | null;
  lines: unknown[];
};

const state = vi.hoisted(() => ({
  order: null as TestOrder | null,
  candidateShopperId: "shopper_1" as string | null,
  privacyTombstoned: false,
  accountStatus: "active" as "active" | "closed",
  earnGrant: null as { id: string } | null,
  referralRewarded: false,
  tierEvaluated: false,
  earnEffects: 0,
  referralEffects: 0,
  tierEffects: 0,
  commerceTransactions: 0,
}));

const mocks = vi.hoisted(() => ({
  syncTotalCommissions: vi.fn().mockResolvedValue(undefined),
  processOrderPointsEarn: vi.fn(async () => {
    if (!state.order?.shopperId) return null;
    if (!state.earnGrant) {
      state.earnGrant = { id: "grant_recovered" };
      state.earnEffects += 1;
    }
    return state.earnGrant;
  }),
  resolveLoyaltyEarnPolicyRevisionAt: vi.fn(),
  evaluateReferralQualification: vi.fn(async () => {
    if (!state.referralRewarded) {
      state.referralRewarded = true;
      state.referralEffects += 1;
    }
    return { qualified: true };
  }),
  evaluateAccountTier: vi.fn(async () => {
    if (!state.tierEvaluated) {
      state.tierEvaluated = true;
      state.tierEffects += 1;
    }
    return { tierChanged: false };
  }),
  orderUpdateMany: vi.fn(async ({ where, data }) => {
    if (
      state.order &&
      state.order.id === where.id &&
      state.order.storeId === where.storeId &&
      state.order.shopperId === null
    ) {
      state.order.shopperId = data.shopperId;
      return { count: 1 };
    }
    return { count: 0 };
  }),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/api/partners/sync-total-commissions", () => ({
  syncTotalCommissions: mocks.syncTotalCommissions,
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) =>
    fn(),
  ),
}));

vi.mock("@/lib/weletic/loyalty/shopper", () => ({
  upsertWeleticShopper: vi.fn(async () => {
    if (state.privacyTombstoned && !state.candidateShopperId) {
      return { shopper: null, privacyTombstoned: true };
    }
    return state.candidateShopperId
      ? {
          shopper: { id: state.candidateShopperId },
          privacyTombstoned: state.privacyTombstoned,
        }
      : null;
  }),
}));

vi.mock("@/lib/weletic/loyalty/earn", () => ({
  processOrderPointsEarn: mocks.processOrderPointsEarn,
}));

vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  resolveLoyaltyEarnPolicyRevisionAt: mocks.resolveLoyaltyEarnPolicyRevisionAt,
}));

vi.mock("@/lib/weletic/loyalty/referrals", () => ({
  evaluateReferralQualification: mocks.evaluateReferralQualification,
}));

vi.mock("@/lib/weletic/loyalty/referral-friend-claim", () => ({
  evaluateReferralFriendClaimQualification: vi.fn().mockResolvedValue({
    qualified: false,
    reason: "No pending friend claim",
  }),
}));

vi.mock("@/lib/weletic/loyalty/tiers", () => ({
  evaluateAccountTier: mocks.evaluateAccountTier,
}));

vi.mock("@/lib/weletic/fx", () => ({
  getAccountingFxQuote: vi.fn(),
  persistFxQuote: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/customer-segments", () => ({
  getShopifyCustomerOrderHistory: vi.fn(),
  getShopifyCustomerSegmentIds: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/order-context", () => ({
  getShopifyOrderLineContext: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        shopifyStoreId: "test-shop.myshopify.com",
        defaultProgramId: "program_1",
      }),
    },
    program: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "program_1",
        accountingCurrency: "USD",
        workspaceId: "workspace_1",
      }),
    },
    weleticShopifyStore: {
      upsert: vi.fn().mockResolvedValue({
        id: "store_1",
        projectId: "workspace_1",
        programId: "program_1",
        shopDomain: "test-shop.myshopify.com",
        shopCurrency: "USD",
      }),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(async ({ where, select }) => {
        if (!state.order) return null;
        if (
          where.storeId_externalId &&
          (where.storeId_externalId.storeId !== state.order.storeId ||
            where.storeId_externalId.externalId !== state.order.externalId)
        ) {
          return null;
        }
        if (where.id && where.id !== state.order.id) return null;
        if (select) {
          return {
            storeId: state.order.storeId,
            shopperId: state.order.shopperId,
          };
        }
        return state.order;
      }),
      updateMany: mocks.orderUpdateMany,
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(async ({ where }) => {
        const order = state.order;
        if (!order || order.shopperId !== where.shopperId) return null;
        return {
          id: "account_1",
          storeId: order.storeId,
          status: state.accountStatus,
        };
      }),
    },
    $transaction: vi.fn(async () => {
      state.commerceTransactions += 1;
      throw new Error(
        "Duplicate recovery must not run the commerce transaction",
      );
    }),
  },
}));

import {
  recordWeleticOrder,
  resolveOrderLoyaltyPolicyRevisionId,
} from "@/lib/weletic/commerce/record-order";

const event = {
  id: 1001,
  name: "#1001",
  created_at: "2026-08-29T00:00:00.000Z",
  processed_at: "2026-08-29T00:00:01.000Z",
  financial_status: "paid",
  confirmation_number: "CONF-1001",
  checkout_token: "checkout-1001",
  customer: {
    id: 501,
    email: "customer@example.com",
    first_name: "Test",
    last_name: "Customer",
  },
  current_subtotal_price_set: {
    shop_money: { amount: "50.00", currency_code: "USD" },
    presentment_money: { amount: "50.00", currency_code: "USD" },
  },
  line_items: [],
  discount_codes: [],
};

function existingOrder(shopperId: string | null): TestOrder {
  return {
    id: "order_1",
    storeId: "store_1",
    programId: "program_1",
    partnerId: "partner_1",
    shopperId,
    externalId: "1001",
    accountingNet: BigInt(5000),
    accountingCurrency: "USD",
    presentmentNet: BigInt(5000),
    presentmentCurrency: "USD",
    shopNet: BigInt(5000),
    shopCurrency: "USD",
    analyticsRecordedAt: new Date("2026-08-29T00:00:02.000Z"),
    dubStatsRecordedAt: new Date("2026-08-29T00:00:03.000Z"),
    lines: [],
  };
}

async function replayOrder() {
  return recordWeleticOrder({
    event,
    workspaceId: "workspace_1",
    programId: "program_1",
    partnerId: "partner_1",
    linkId: "link_1",
    customerId: "customer_1",
  });
}

describe("recordWeleticOrder duplicate loyalty recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.order = existingOrder("shopper_1");
    state.candidateShopperId = "shopper_1";
    state.privacyTombstoned = false;
    state.accountStatus = "active";
    state.earnGrant = null;
    state.referralRewarded = false;
    state.tierEvaluated = false;
    state.earnEffects = 0;
    state.referralEffects = 0;
    state.tierEffects = 0;
    state.commerceTransactions = 0;
  });

  it("recovers a missing earn grant and referral award for an existing order", async () => {
    const result = await replayOrder();

    expect(result).toMatchObject({
      orderId: "order_1",
      shopperId: "shopper_1",
      loyaltyLedgerEntryId: "grant_recovered",
      duplicate: true,
    });
    expect(mocks.processOrderPointsEarn).toHaveBeenCalledWith({
      storeId: "store_1",
      orderId: "order_1",
    });
    expect(mocks.evaluateReferralQualification).toHaveBeenCalledWith({
      storeId: "store_1",
      orderId: "order_1",
      refereeShopperId: "shopper_1",
      orderSubtotal: BigInt(5000),
      currency: "USD",
    });
    expect(mocks.evaluateAccountTier).toHaveBeenCalledWith("account_1", {
      expectedInstallationGeneration: undefined,
    });
    expect(state.earnEffects).toBe(1);
    expect(state.referralEffects).toBe(1);
    expect(state.tierEffects).toBe(1);
    expect(state.commerceTransactions).toBe(0);
    expect(mocks.resolveLoyaltyEarnPolicyRevisionAt).not.toHaveBeenCalled();
  });

  it("evaluates the store-currency subtotal instead of buyer presentment money", async () => {
    state.order = {
      ...existingOrder("shopper_1"),
      presentmentNet: BigInt(18_000),
      presentmentCurrency: "JPY",
      shopNet: BigInt(12_345),
      shopCurrency: "USD",
    };

    await replayOrder();

    expect(mocks.evaluateReferralQualification).toHaveBeenCalledWith({
      storeId: "store_1",
      orderId: "order_1",
      refereeShopperId: "shopper_1",
      orderSubtotal: BigInt(12_345),
      currency: "USD",
    });
  });

  it("attaches a shopper discovered by a later webhook before recovering loyalty", async () => {
    state.order = existingOrder(null);
    state.candidateShopperId = "shopper_late";

    const result = await replayOrder();

    expect(mocks.orderUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "order_1",
        storeId: "store_1",
        shopperId: null,
      },
      data: { shopperId: "shopper_late" },
    });
    expect(state.order.shopperId).toBe("shopper_late");
    expect(
      mocks.processOrderPointsEarn.mock.invocationCallOrder[0],
    ).toBeGreaterThan(mocks.orderUpdateMany.mock.invocationCallOrder[0]);
    expect(result).toMatchObject({
      shopperId: "shopper_late",
      loyaltyLedgerEntryId: "grant_recovered",
      duplicate: true,
    });
  });

  it("keeps repeated duplicate recovery idempotent without replaying commerce writes", async () => {
    const first = await replayOrder();
    const second = await replayOrder();

    expect(first.loyaltyLedgerEntryId).toBe("grant_recovered");
    expect(second.loyaltyLedgerEntryId).toBe("grant_recovered");
    expect(mocks.processOrderPointsEarn).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateReferralQualification).toHaveBeenCalledTimes(2);
    expect(mocks.evaluateAccountTier).toHaveBeenCalledTimes(2);
    expect(state.earnEffects).toBe(1);
    expect(state.referralEffects).toBe(1);
    expect(state.tierEffects).toBe(1);
    expect(state.commerceTransactions).toBe(0);
    expect(mocks.orderUpdateMany).not.toHaveBeenCalled();
  });

  it("associates a tombstoned customer's replayed order without replaying commerce PII writes", async () => {
    state.order = existingOrder(null);
    state.candidateShopperId = "shopper_redacted";
    state.privacyTombstoned = true;
    state.accountStatus = "closed";

    const result = await replayOrder();

    expect(mocks.orderUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "order_1",
        storeId: "store_1",
        shopperId: null,
      },
      data: { shopperId: "shopper_redacted" },
    });
    expect(result).toMatchObject({
      orderId: "order_1",
      shopperId: "shopper_redacted",
      loyaltyLedgerEntryId: null,
      duplicate: true,
    });
    expect(mocks.processOrderPointsEarn).not.toHaveBeenCalled();
    expect(mocks.evaluateReferralQualification).not.toHaveBeenCalled();
    expect(mocks.evaluateAccountTier).not.toHaveBeenCalled();
    expect(state.commerceTransactions).toBe(0);
  });

  it("never rebinds a redacted store domain from stale order context", async () => {
    await replayOrder();

    expect(prisma.weleticShopifyStore.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { projectId: "workspace_1" },
        update: {},
      }),
    );
    const update = vi.mocked(prisma.weleticShopifyStore.upsert).mock.calls[0][0]
      .update;
    expect(update).not.toHaveProperty("shopDomain");
    expect(update).not.toHaveProperty("shopCurrency");
  });

  it("does not create or attach a loyalty identity when redaction predates the order", async () => {
    state.order = existingOrder(null);
    state.candidateShopperId = null;
    state.privacyTombstoned = true;

    const result = await replayOrder();

    expect(mocks.orderUpdateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      orderId: "order_1",
      shopperId: null,
      loyaltyLedgerEntryId: null,
      customerPrivacyTombstoned: true,
      duplicate: true,
    });
    expect(mocks.processOrderPointsEarn).not.toHaveBeenCalled();
    expect(mocks.evaluateReferralQualification).not.toHaveBeenCalled();
    expect(mocks.evaluateAccountTier).not.toHaveBeenCalled();
  });
});

describe("recordWeleticOrder immutable loyalty policy binding", () => {
  const occurredAt = new Date("2026-08-29T00:00:01.000Z");

  function policyTransaction(programId: string | null = "loyalty_program_1") {
    return {
      weleticLoyaltyProgram: {
        findUnique: vi.fn().mockResolvedValue(
          programId
            ? {
                id: programId,
              }
            : null,
        ),
      },
      weleticLoyaltyEarnPolicyRevision: {
        findFirst: vi.fn(),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the store loyalty program revision at the order event time", async () => {
    const tx = policyTransaction();
    mocks.resolveLoyaltyEarnPolicyRevisionAt.mockResolvedValue({
      revision: { id: "wpolicy_7" },
      policy: {},
    });

    const revisionId = await resolveOrderLoyaltyPolicyRevisionId({
      tx: tx as never,
      storeId: "store_1",
      occurredAt,
    });

    expect(tx.weleticLoyaltyProgram.findUnique).toHaveBeenCalledWith({
      where: { storeId: "store_1" },
      select: { id: true },
    });
    expect(mocks.resolveLoyaltyEarnPolicyRevisionAt).toHaveBeenCalledWith({
      tx,
      storeId: "store_1",
      programId: "loyalty_program_1",
      occurredAt,
    });
    expect(revisionId).toBe("wpolicy_7");
  });

  it("binds null when the store has no loyalty program", async () => {
    const tx = policyTransaction(null);

    await expect(
      resolveOrderLoyaltyPolicyRevisionId({
        tx: tx as never,
        storeId: "store_1",
        occurredAt,
      }),
    ).resolves.toBeNull();
    expect(mocks.resolveLoyaltyEarnPolicyRevisionAt).not.toHaveBeenCalled();
  });

  it("binds null for a pre-cutover event with no effective revision", async () => {
    const tx = policyTransaction();
    mocks.resolveLoyaltyEarnPolicyRevisionAt.mockResolvedValue(null);

    await expect(
      resolveOrderLoyaltyPolicyRevisionId({
        tx: tx as never,
        storeId: "store_1",
        occurredAt,
      }),
    ).resolves.toBeNull();
  });

  it("keeps legacy delegate-less mocks compatible only in tests", async () => {
    await expect(
      resolveOrderLoyaltyPolicyRevisionId({
        tx: {} as never,
        storeId: "store_1",
        occurredAt,
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when revision delegates are unavailable in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await expect(
        resolveOrderLoyaltyPolicyRevisionId({
          tx: {} as never,
          storeId: "store_1",
          occurredAt,
        }),
      ).rejects.toThrow("Loyalty policy revision binding is unavailable.");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
