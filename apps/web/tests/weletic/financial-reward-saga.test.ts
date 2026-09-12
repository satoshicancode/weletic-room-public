import {
  Prisma,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(),
  findUnique: vi.fn(),
  enqueue: vi.fn(),
  giftCreate: vi.fn(),
  giftLookup: vi.fn(),
  storeCreditCreate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticRewardRedemption: {
      updateMany: mocks.updateMany,
      findUnique: mocks.findUnique,
    },
  },
}));

vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  assertLockedLoyaltyProgramCurrencyGeneration: vi.fn(),
  withLoyaltyProgramRowLock: vi.fn(
    async ({ operation }: { operation: (tx: unknown) => Promise<unknown> }) =>
      operation({
        weleticRewardRedemption: {
          updateMany: mocks.updateMany,
          findUnique: mocks.findUnique,
        },
      }),
  ),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueue,
  enqueueOutboxJobFromProgramTransaction: mocks.enqueue,
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >("@/lib/weletic/loyalty/shopify-discounts");
  return {
    ...actual,
    resolveShopifyOfflineCredentials: vi.fn(async () => ({
      shopDomain: "financial-test.myshopify.com",
      accessToken: "offline-token",
      scope:
        "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
      source: "app_session",
    })),
  };
});

vi.mock("@/lib/weletic/loyalty/shopify-financial-rewards", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/loyalty/shopify-financial-rewards")
  >("@/lib/weletic/loyalty/shopify-financial-rewards");
  class ShopifyFinancialRewardError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "ShopifyFinancialRewardError";
    }
  }
  return {
    assertFinancialRewardScope: actual.assertFinancialRewardScope,
    ShopifyFinancialRewardError,
    createShopifyGiftCard: mocks.giftCreate,
    lookupShopifyGiftCard: mocks.giftLookup,
    createShopifyStoreCredit: mocks.storeCreditCreate,
  };
});

import { provisionFinancialRewardReservation } from "@/lib/weletic/loyalty/financial-reward-saga";
import { resolveShopifyOfflineCredentials } from "@/lib/weletic/loyalty/shopify-discounts";
import { ShopifyFinancialRewardError } from "@/lib/weletic/loyalty/shopify-financial-rewards";

function reservation(
  rewardType: "gift_card" | "store_credit",
  metadata: Prisma.JsonValue = {},
) {
  const artifactKind =
    rewardType === "gift_card"
      ? WeleticRewardArtifactKind.gift_card
      : WeleticRewardArtifactKind.store_credit;
  return {
    redemption: {
      id: "wredemp_financial_1",
      status: WeleticRedemptionStatus.provisioning,
      artifactKind,
      shopifyDiscountCode:
        rewardType === "gift_card" ? "WLGCABCD1234CD12" : "WLSCABCD1234CD12",
      shopifyGiftCardId: null,
      shopifyStoreCreditTransactionId: null,
      metadata,
    },
    account: { shopper: { shopifyCustomerId: "77" } },
    effectivePointsCost: BigInt(1000),
    balanceAfter: BigInt(9000),
    expiresAt: null,
    provisioningSnapshot: {
      version: 1 as const,
      rewardDefinitionId: "reward_financial_1",
      name: "Financial reward",
      description: null,
      rewardType,
      pointsCost: "1000",
      discountValue: "1000",
      maxDiscountValue: null,
      minOrderAmount: null,
      appliesToResource: "entire_order",
      entitledCollectionIds: [],
      entitledProductIds: [],
      entitledVariantIds: [],
      combinesWithProductDiscounts: false,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: false,
      usageLimit: null,
      usageLimitPerCustomer: null,
      expiresInDays: null,
      shopCurrency: "USD",
      currencyVerifiedAt: "2026-09-01T00:00:00.000Z",
      customerSelectionDigest: "A".repeat(64),
      startsAt: "2026-09-01T00:00:00.000Z",
      expiresAt: null,
      contentDigest: "B".repeat(64),
    },
  };
}

function provision(
  input: ReturnType<typeof reservation>,
  notifyStoreCreditOwner?: boolean,
) {
  return provisionFinancialRewardReservation({
    storeId: "store_1",
    accountId: "account_1",
    rewardDefinitionId: "reward_financial_1",
    reservation: input,
    notifyStoreCreditOwner,
  });
}

describe("financial reward saga dispatch safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.enqueue.mockResolvedValue({ id: "job_1" });
  });

  it.each(["gift_card", "store_credit"] as const)(
    "does not mark a fresh %s dispatch when scope evidence is missing",
    async (rewardType) => {
      vi.mocked(resolveShopifyOfflineCredentials).mockResolvedValueOnce({
        shopDomain: "financial-test.myshopify.com",
        accessToken: "offline-token",
        source: "app_session",
      });
      const input = reservation(rewardType);
      await expect(provision(input)).rejects.toMatchObject({
        code: "MISSING_SCOPE",
      });
      expect(input.redemption.metadata).toEqual({});
      expect(mocks.updateMany).not.toHaveBeenCalled();
      expect(mocks.giftCreate).not.toHaveBeenCalled();
      expect(mocks.giftLookup).not.toHaveBeenCalled();
      expect(mocks.storeCreditCreate).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    },
  );

  it("can retry untouched store credit after fresh credential scope evidence", async () => {
    vi.mocked(resolveShopifyOfflineCredentials).mockResolvedValueOnce({
      shopDomain: "financial-test.myshopify.com",
      accessToken: "offline-token",
      source: "app_session",
      scope: "read_customers",
    });
    const input = reservation("store_credit");
    await expect(provision(input)).rejects.toMatchObject({
      code: "MISSING_SCOPE",
    });
    expect(mocks.updateMany).not.toHaveBeenCalled();
    mocks.storeCreditCreate.mockResolvedValueOnce({
      transactionId: "gid://shopify/StoreCreditAccountTransaction/503",
      accountId: "gid://shopify/StoreCreditAccount/11",
      amount: "10.00",
      currencyCode: "USD",
    });
    await expect(provision(input)).resolves.toMatchObject({ success: true });
    expect(mocks.storeCreditCreate).toHaveBeenCalledTimes(1);
  });

  it("finalizes a store-credit transaction after one remote mutation", async () => {
    mocks.storeCreditCreate.mockResolvedValue({
      transactionId: "gid://shopify/StoreCreditAccountTransaction/501",
      accountId: "gid://shopify/StoreCreditAccount/9",
      amount: "10.00",
      currencyCode: "USD",
    });

    await expect(provision(reservation("store_credit"))).resolves.toMatchObject(
      {
        success: true,
        status: WeleticRedemptionStatus.issued,
      },
    );
    expect(mocks.storeCreditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.storeCreditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ notify: true }),
    );
    expect(mocks.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shopifyStoreCreditTransactionId:
            "gid://shopify/StoreCreditAccountTransaction/501",
        }),
      }),
    );
  });

  it("can suppress Store Credit notification for an email-free operator fixture", async () => {
    mocks.storeCreditCreate.mockResolvedValue({
      transactionId: "gid://shopify/StoreCreditAccountTransaction/502",
      accountId: "gid://shopify/StoreCreditAccount/10",
      amount: "10.00",
      currencyCode: "USD",
    });

    await expect(
      provision(reservation("store_credit"), false),
    ).resolves.toMatchObject({ success: true });
    expect(mocks.storeCreditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ notify: false }),
    );
  });

  it("does not dispatch store credit twice after an ambiguous response", async () => {
    mocks.storeCreditCreate.mockRejectedValueOnce(
      new ShopifyFinancialRewardError(
        "REMOTE_OUTCOME_UNKNOWN",
        "response lost after dispatch",
      ),
    );

    await expect(provision(reservation("store_credit"))).rejects.toMatchObject({
      code: "REMOTE_OUTCOME_UNKNOWN",
    });
    const persistedMetadata = mocks.updateMany.mock.calls[0][0].data.metadata;

    await expect(
      provision(reservation("store_credit", persistedMetadata)),
    ).rejects.toMatchObject({ code: "REMOTE_OUTCOME_UNKNOWN" });
    expect(mocks.storeCreditCreate).toHaveBeenCalledTimes(1);
  });

  it("adopts an exact gift card on recovery without creating another", async () => {
    mocks.giftLookup.mockResolvedValue({
      id: "gid://shopify/GiftCard/101",
      code: "WLGCABCD1234CD12",
    });

    await expect(
      provision(
        reservation("gift_card", {
          remoteProvisionAttemptedAt: "2026-09-01T00:00:00.000Z",
          remoteProvisionPreparationId: "frp_prior",
        }),
      ),
    ).resolves.toMatchObject({
      success: true,
      shopifyDiscountId: "gid://shopify/GiftCard/101",
    });
    expect(mocks.giftLookup).toHaveBeenCalledTimes(1);
    expect(mocks.giftCreate).not.toHaveBeenCalled();
  });
});
