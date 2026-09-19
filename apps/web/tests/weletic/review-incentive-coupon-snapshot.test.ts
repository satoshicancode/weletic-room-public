import {
  DEFAULT_REWARD_PURCHASE_POLICY,
  getShopifyDiscountPurchaseFields,
} from "@/lib/weletic/loyalty/purchase-policy";
import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getRewardDefinitionFromProvisioningSnapshot,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { captureReviewCouponCatalogLabels } from "@/lib/weletic/reviews/coupon-catalog-labels";
import {
  createReviewIncentivePolicyRevision,
  reviewIncentivePolicyDigest,
  reviewIncentivePolicySnapshotSchema,
} from "@/lib/weletic/reviews/incentive-policy";
import { withReviewMutation } from "@/lib/weletic/reviews/transaction";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));
vi.mock("@/lib/weletic/reviews/coupon-catalog-labels", () => ({
  captureReviewCouponCatalogLabels: vi.fn(),
}));

const reward = () => ({
  id: "reward",
  storeId: "store",
  name: "Participation coupon",
  description: null,
  rewardType: "amount_off",
  exchangeType: "fixed",
  salesChannel: "online_store",
  discountValue: "500",
  maxDiscountValue: null,
  minOrderAmount: "1000",
  appliesToResource: "specific_items",
  updatedAt: new Date("2026-09-20T00:00:00Z"),
  entitledProductIds: ["gid://shopify/Product/123"],
  entitledCollectionIds: [],
  entitledVariantIds: [],
  combinesWithProductDiscounts: false,
  combinesWithOrderDiscounts: false,
  combinesWithShippingDiscounts: true,
  usageLimit: 1,
  usageLimitPerCustomer: 1,
  expiresInDays: 30,
  purchasePolicy: {
    purchaseType: "subscription",
    subscriptionCadence: "first_n_payments",
    subscriptionPaymentLimit: 3,
  },
});

function setup(purchasePolicy: unknown = reward().purchasePolicy) {
  vi.mocked(captureReviewCouponCatalogLabels).mockResolvedValue([
    { id: "gid://shopify/Product/123", name: "Test product" },
  ]);
  const catalog = { ...reward(), purchasePolicy };
  const tx = {
    weleticRewardDefinition: { findFirst: vi.fn().mockResolvedValue(catalog) },
    weleticShopifyStore: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        projectId: "workspace",
        shopDomain: "test.myshopify.com",
        installationGeneration: "generation",
        shopCurrency: "JPY",
        currencyVerifiedAt: new Date("2026-09-20T00:00:00Z"),
      }),
    },
    weleticReviewSettings: {
      findUnique: vi.fn().mockResolvedValue({ incentivePolicyRevision: 7 }),
      upsert: vi.fn().mockResolvedValue({ incentivePolicyRevision: 8 }),
    },
    weleticReviewIncentivePolicy: {
      create: vi.fn().mockImplementation(({ data }) => Promise.resolve(data)),
    },
  };
  vi.mocked(withReviewMutation).mockImplementation(
    async (_storeId, operation) =>
      operation(tx as unknown as Prisma.TransactionClient, "generation"),
  );
  return { tx, catalog };
}

async function draft() {
  return createReviewIncentivePolicyRevision("store", {
    kind: "coupon",
    rewardDefinitionId: "reward",
  });
}

describe("review coupon immutable purchase terms", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      purchaseType: "one_time",
      subscriptionCadence: "first_payment",
      subscriptionPaymentLimit: null,
    },
    {
      purchaseType: "subscription",
      subscriptionCadence: "first_payment",
      subscriptionPaymentLimit: null,
    },
    {
      purchaseType: "subscription",
      subscriptionCadence: "first_n_payments",
      subscriptionPaymentLimit: 3,
    },
    {
      purchaseType: "both",
      subscriptionCadence: "every_payment",
      subscriptionPaymentLimit: null,
    },
  ])(
    "preserves $purchaseType / $subscriptionCadence through provisioning",
    async (purchasePolicy) => {
      const { tx, catalog } = setup(purchasePolicy);
      const created = await draft();
      const snapshot = reviewIncentivePolicySnapshotSchema.parse(
        created.snapshot,
      );
      expect(snapshot.award.kind).toBe("coupon");
      if (snapshot.award.kind !== "coupon") throw new Error("Expected coupon");
      const terms = snapshot.award.terms;
      expect(terms.purchasePolicy).toEqual(purchasePolicy);
      expect(terms.exchangeType).toBe("fixed");
      expect(terms.entitledProductIds).toEqual(catalog.entitledProductIds);
      expect(terms.minOrderAmount).toBe("1000");
      expect(created.contentDigest).toBe(reviewIncentivePolicyDigest(snapshot));
      // A later catalog edit cannot change an already issued promise.
      catalog.purchasePolicy = DEFAULT_REWARD_PURCHASE_POLICY;
      const provisioned = createLoyaltyRedemptionProvisioningSnapshot({
        reward: { ...terms, id: terms.rewardDefinitionId },
        pointsCost: BigInt(0),
        discountValue: terms.discountValue,
        expiresInDays: terms.expiresInDays,
        shopCurrency: terms.shopCurrency,
        currencyVerifiedAt: new Date("2026-09-20T00:00:00Z"),
        customerSelectionDigest: "A".repeat(64),
        startsAt: new Date("2026-09-20T00:00:00Z"),
        expiresAt: new Date("2026-10-20T00:00:00Z"),
      });
      const providerReward = getRewardDefinitionFromProvisioningSnapshot({
        snapshot: provisioned,
        provisioningName: "opaque-coupon",
      });
      expect(providerReward.purchasePolicy).toEqual(purchasePolicy);
      expect(
        getShopifyDiscountPurchaseFields(providerReward.purchasePolicy),
      ).toEqual(getShopifyDiscountPurchaseFields(terms.purchasePolicy!));
      expect(tx.weleticRewardDefinition.findFirst).toHaveBeenCalledWith({
        where: {
          id: "reward",
          storeId: "store",
          status: "active",
          exchangeType: "fixed",
          salesChannel: "online_store",
        },
      });
      expect(tx.weleticReviewSettings.upsert).toHaveBeenCalledWith({
        where: { storeId: "store" },
        create: { storeId: "store", incentivePolicyRevision: 1 },
        update: { incentivePolicyRevision: { increment: 1 } },
      });
    },
  );

  it("uses the established one-time default only for an absent catalog policy", async () => {
    setup(null);
    const result = reviewIncentivePolicySnapshotSchema.parse(
      (await draft()).snapshot,
    );
    expect(result.award).toMatchObject({
      terms: { purchasePolicy: DEFAULT_REWARD_PURCHASE_POLICY },
    });
  });

  it.each([
    {},
    {
      purchaseType: "subscription",
      subscriptionCadence: "first_n_payments",
      subscriptionPaymentLimit: null,
    },
  ])(
    "rejects malformed catalog terms before allocating a revision",
    async (invalid) => {
      const { tx } = setup(invalid);
      await expect(draft()).rejects.toThrow();
      expect(tx.weleticReviewSettings.upsert).not.toHaveBeenCalled();
      expect(tx.weleticReviewIncentivePolicy.create).not.toHaveBeenCalled();
    },
  );

  it("does not add new fields while reading historical coupon snapshots", async () => {
    setup();
    const current = reviewIncentivePolicySnapshotSchema.parse(
      (await draft()).snapshot,
    );
    if (current.award.kind !== "coupon") throw new Error("Expected coupon");
    const { purchasePolicy, exchangeType, ...historicalTerms } =
      current.award.terms;
    void purchasePolicy;
    void exchangeType;
    const historical = {
      version: 1,
      award: { kind: "coupon", terms: historicalTerms },
    };
    expect(reviewIncentivePolicySnapshotSchema.parse(historical)).toEqual(
      historical,
    );
    expect(reviewIncentivePolicyDigest(historical)).not.toBe(
      reviewIncentivePolicyDigest(current),
    );
  });

  it.each(["reward", "settings", "store"])(
    "rejects changed %s after catalog capture without allocating",
    async (change) => {
      const { tx, catalog } = setup();
      vi.mocked(captureReviewCouponCatalogLabels).mockImplementationOnce(
        async () => {
          if (change === "reward") catalog.discountValue = "600";
          if (change === "settings")
            tx.weleticReviewSettings.findUnique.mockResolvedValue({
              incentivePolicyRevision: 8,
            });
          if (change === "store")
            tx.weleticShopifyStore.findUniqueOrThrow.mockResolvedValue({
              projectId: "other",
              shopDomain: "test.myshopify.com",
              installationGeneration: "generation",
              shopCurrency: "JPY",
              currencyVerifiedAt: new Date("2026-09-20T00:00:00Z"),
            });
          return [{ id: "gid://shopify/Product/123", name: "Test product" }];
        },
      );
      await expect(draft()).rejects.toThrow(
        "changed during catalog verification",
      );
      expect(tx.weleticReviewSettings.upsert).not.toHaveBeenCalled();
    },
  );

  it("fences the second transaction and binds captured labels into the digest", async () => {
    setup();
    const created = await draft();
    expect(withReviewMutation).toHaveBeenLastCalledWith(
      "store",
      expect.any(Function),
      "generation",
    );
    expect(captureReviewCouponCatalogLabels).toHaveBeenCalledWith(
      {
        storeId: "store",
        workspaceId: "workspace",
        shop: "test.myshopify.com",
        installationGeneration: "generation",
      },
      ["gid://shopify/Product/123"],
    );
    expect(created.snapshot).toMatchObject({
      award: {
        displayTargets: [
          { id: "gid://shopify/Product/123", name: "Test product" },
        ],
      },
    });
  });

  it("does not allocate when catalog verification fails", async () => {
    const { tx } = setup();
    vi.mocked(captureReviewCouponCatalogLabels).mockRejectedValueOnce(
      new Error("Unavailable"),
    );
    await expect(draft()).rejects.toThrow();
    expect(tx.weleticReviewSettings.upsert).not.toHaveBeenCalled();
  });

  it("captures outside transactions and rejects a stale generation at commit", async () => {
    const { tx } = setup();
    let inTransaction = false;
    let generation = "generation";
    vi.mocked(withReviewMutation).mockImplementation(
      async (_id, operation, expected) => {
        if (expected !== undefined && expected !== generation)
          throw new Error("stale generation");
        inTransaction = true;
        try {
          return await operation(
            tx as unknown as Prisma.TransactionClient,
            generation,
          );
        } finally {
          inTransaction = false;
        }
      },
    );
    vi.mocked(captureReviewCouponCatalogLabels).mockImplementationOnce(
      async () => {
        expect(inTransaction).toBe(false);
        generation = "reinstalled";
        return [{ id: "gid://shopify/Product/123", name: "Test product" }];
      },
    );
    await expect(draft()).rejects.toThrow("stale generation");
    expect(tx.weleticReviewSettings.upsert).not.toHaveBeenCalled();
  });

  it("checks merchant revision and authorization before catalog access", async () => {
    const { tx } = setup();
    const authorize = vi.fn().mockResolvedValue(undefined);
    await expect(
      createReviewIncentivePolicyRevision(
        "store",
        { kind: "coupon", rewardDefinitionId: "reward" },
        {
          expectedRevision: 6,
          expectedInstallationGeneration: "generation",
          authorize,
        },
      ),
    ).rejects.toThrow("policy changed");
    expect(authorize).toHaveBeenCalledWith(tx, "preflight");
    expect(captureReviewCouponCatalogLabels).not.toHaveBeenCalled();
    expect(tx.weleticReviewSettings.upsert).not.toHaveBeenCalled();
  });

  it("rechecks revoked merchant access after catalog capture before allocation", async () => {
    const { tx } = setup();
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("access revoked"));
    await expect(
      createReviewIncentivePolicyRevision(
        "store",
        { kind: "coupon", rewardDefinitionId: "reward" },
        {
          expectedRevision: 7,
          expectedInstallationGeneration: "generation",
          authorize,
        },
      ),
    ).rejects.toThrow("access revoked");
    expect(authorize).toHaveBeenLastCalledWith(tx, "commit");
    expect(tx.weleticReviewSettings.upsert).not.toHaveBeenCalled();
  });
});
