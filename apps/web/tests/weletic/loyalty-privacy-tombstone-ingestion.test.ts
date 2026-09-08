import { prisma } from "@/lib/prisma";
import { upsertWeleticShopper } from "@/lib/weletic/loyalty/shopper";
import { SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY } from "@/lib/weletic/loyalty/shopper-privacy";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sideEffects = vi.hoisted(() => ({
  awardSignupWelcomeBonus: vi.fn(),
  ensureAccountReferralLink: vi.fn(),
  publishPolicyRevision: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/non-purchase-earn", () => ({
  awardSignupWelcomeBonus: sideEffects.awardSignupWelcomeBonus,
}));

vi.mock("@/lib/weletic/loyalty/referrals", () => ({
  ensureAccountReferralLink: sideEffects.ensureAccountReferralLink,
}));

vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: sideEffects.publishPolicyRevision,
}));

vi.mock("@/lib/prisma", () => {
  const prismaMock = {
    weleticShopper: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyAccount: {
      upsert: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyEarningRule: {
      findFirst: vi.fn(),
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findFirst: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  };
  prismaMock.$transaction.mockImplementation(async (callback) =>
    callback(prismaMock),
  );
  return { prisma: prismaMock };
});

describe("durable Shopify customer-redaction tombstone ingestion", () => {
  const tombstonedShopper = {
    id: "shopper_redacted",
    storeId: "store_redacted",
    shopifyCustomerId: "customer_42",
    firstName: "Redacted",
    lastName: "Customer",
    email: "redacted_shopper_redacted@anonymous.local",
    phone: null,
    locale: "en",
    tags: null,
    segmentIds: null,
    acceptsMarketing: false,
    ordersCount: 3,
    totalSpent: BigInt(25000),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-29T00:00:00.000Z"),
    loyaltyAccount: {
      id: "account_redacted",
      storeId: "store_redacted",
      programId: "program_redacted",
      shopperId: "shopper_redacted",
      status: "closed",
      metadata: {
        retainedCampaign: "campaign_1",
        [SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY]: {
          status: "redacted",
          redactedAt: "2026-08-29T00:00:00.000Z",
          source: "shopify_customers_redact",
        },
      },
      program: {
        id: "program_redacted",
        storeId: "store_redacted",
        status: "active",
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValue(
      tombstonedShopper as any,
    );
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockResolvedValue(null);
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "store_redacted",
      complianceState: "active",
    } as any);
    sideEffects.publishPolicyRevision.mockResolvedValue({
      id: "wpolicy_initial",
    });
  });

  it.each(["frozen", "redacted"] as const)(
    "blocks shopper/customer resurrection when the whole store is %s",
    async (complianceState) => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_redacted",
        complianceState,
      } as any);

      await expect(
        upsertWeleticShopper({
          storeId: "store_redacted",
          customer: {
            id: "customer_delayed",
            email: "must-not-return@example.com",
          },
        }),
      ).rejects.toMatchObject({
        name: "ShopifyStoreOperationalWritesBlockedError",
        complianceState,
      });
      expect(
        prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
      ).not.toHaveBeenCalled();
      expect(prisma.weleticShopper.findUnique).not.toHaveBeenCalled();
      expect(prisma.weleticShopper.upsert).not.toHaveBeenCalled();
    },
  );

  it("blocks a claimed generation-one customer update after generation two reconnects", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_redacted",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      installationGeneration: "sgen_two",
    } as any);

    await expect(
      upsertWeleticShopper({
        storeId: "store_redacted",
        customer: {
          id: "customer_delayed",
          email: "stale@example.com",
        },
        expectedInstallationGeneration: "sgen_one",
      }),
    ).rejects.toMatchObject({
      name: "ShopifyStoreOperationalWritesBlockedError",
      complianceState: "stale_installation_generation",
    });
    expect(prisma.weleticShopper.upsert).not.toHaveBeenCalled();
  });

  it("blocks redact-before-create replay without creating a shopper or loyalty account", async () => {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(null);
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockResolvedValueOnce({ id: "independent_tombstone" } as any);

    const result = await upsertWeleticShopper({
      storeId: "store_redacted",
      customer: {
        id: "customer_not_created_yet",
        email: "redact-first@example.com",
        first_name: "Must Not",
        last_name: "Reappear",
      },
    });

    expect(result).toEqual({
      shopper: null,
      loyaltyAccount: null,
      loyaltyProgram: null,
      loyaltyAccountCreated: false,
      privacyTombstoned: true,
    });
    expect(prisma.weleticShopper.upsert).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyProgram.create).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.upsert).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
    expect(sideEffects.awardSignupWelcomeBonus).not.toHaveBeenCalled();
  });

  it.each(["customers/create", "customers/update", "orders/paid replay"])(
    "ignores delayed %s PII while preserving the financial shopper association",
    async () => {
      const result = await upsertWeleticShopper({
        storeId: "store_redacted",
        customer: {
          id: "customer_42",
          first_name: "PII Revived",
          last_name: "From Delayed Webhook",
          email: "revived@example.com",
          phone: "+81-00-0000-0000",
          locale: "ja",
          tags: ["high-value", "personal-segment"],
          accepts_marketing: true,
        },
      });

      expect(prisma.weleticShopper.findUnique).toHaveBeenCalledWith({
        where: {
          storeId_shopifyCustomerId: {
            storeId: "store_redacted",
            shopifyCustomerId: "customer_42",
          },
        },
        include: {
          loyaltyAccount: { include: { program: true } },
        },
      });
      expect(result).toMatchObject({
        shopper: {
          id: "shopper_redacted",
          firstName: "Redacted",
          email: "redacted_shopper_redacted@anonymous.local",
        },
        loyaltyAccount: { id: "account_redacted", status: "closed" },
        loyaltyAccountCreated: false,
        privacyTombstoned: true,
      });
      expect(prisma.weleticShopper.upsert).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.upsert).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
      expect(sideEffects.awardSignupWelcomeBonus).not.toHaveBeenCalled();
      expect(sideEffects.ensureAccountReferralLink).not.toHaveBeenCalled();
    },
  );

  it("does not let another store's tombstone suppress this tenant's customer", async () => {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.weleticShopper.upsert).mockResolvedValueOnce({
      id: "shopper_other_store",
      storeId: "store_other",
      shopifyCustomerId: "customer_42",
      email: "other-store@example.com",
    } as any);
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce({
      id: "program_other",
      storeId: "store_other",
      status: "active",
      killSwitchActive: false,
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.create).mockResolvedValueOnce({
      id: "account_other",
      storeId: "store_other",
      shopperId: "shopper_other_store",
      status: "active",
    } as any);
    vi.mocked(prisma.weleticLoyaltyEarningRule.findFirst).mockResolvedValueOnce(
      null,
    );
    sideEffects.ensureAccountReferralLink.mockResolvedValue(undefined);

    const result = await upsertWeleticShopper({
      storeId: "store_other",
      customer: {
        id: "customer_42",
        email: "other-store@example.com",
        first_name: "Other",
        last_name: "Tenant",
      },
    });

    expect(prisma.weleticShopper.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId_shopifyCustomerId: {
            storeId: "store_other",
            shopifyCustomerId: "customer_42",
          },
        },
      }),
    );
    expect(prisma.weleticShopper.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          storeId: "store_other",
          email: "other-store@example.com",
        }),
      }),
    );
    expect(result?.privacyTombstoned).toBe(false);
    expect(prisma.weleticLoyaltyAccount.create).toHaveBeenCalledTimes(1);
    expect(prisma.weleticLoyaltyAccount.upsert).not.toHaveBeenCalled();
    expect(sideEffects.ensureAccountReferralLink).not.toHaveBeenCalled();
  });

  it("keeps customer ingestion independent of an unconfigured loyalty program", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_initial",
      complianceState: "active",
    } as any);
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.weleticShopper.upsert).mockResolvedValueOnce({
      id: "shopper_initial",
      storeId: "store_initial",
      shopifyCustomerId: "customer_initial",
      email: "initial@example.com",
    } as any);
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce(
      null,
    );
    const result = await upsertWeleticShopper({
      storeId: "store_initial",
      customer: {
        id: "customer_initial",
        email: "initial@example.com",
        first_name: "Initial",
        last_name: "Member",
      },
    });

    expect(result).toMatchObject({
      loyaltyProgram: null,
      loyaltyAccount: null,
      loyaltyAccountCreated: false,
      privacyTombstoned: false,
    });
    expect(prisma.weleticLoyaltyProgram.create).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
    expect(sideEffects.publishPolicyRevision).not.toHaveBeenCalled();
  });

  it("reuses an existing loyalty account without issuing an empty-update upsert", async () => {
    const existingShopper = {
      ...tombstonedShopper,
      firstName: "Existing",
      lastName: "Customer",
      email: "existing@example.com",
      loyaltyAccount: {
        ...tombstonedShopper.loyaltyAccount,
        status: "active",
        metadata: null,
      },
    };
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(
      existingShopper as any,
    );
    vi.mocked(prisma.weleticShopper.upsert).mockResolvedValueOnce({
      id: existingShopper.id,
      storeId: existingShopper.storeId,
      shopifyCustomerId: existingShopper.shopifyCustomerId,
      email: existingShopper.email,
    } as any);
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce(
      existingShopper.loyaltyAccount.program as any,
    );

    const result = await upsertWeleticShopper({
      storeId: existingShopper.storeId,
      customer: {
        id: existingShopper.shopifyCustomerId,
        email: existingShopper.email,
        first_name: existingShopper.firstName,
        last_name: existingShopper.lastName,
        tags: ["member"],
      },
    });

    expect(result).toMatchObject({
      loyaltyAccount: {
        id: existingShopper.loyaltyAccount.id,
        status: "active",
      },
      loyaltyAccountCreated: false,
      privacyTombstoned: false,
    });
    expect(result?.loyaltyAccount).not.toHaveProperty("program");
    expect(prisma.weleticLoyaltyAccount.create).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.upsert).not.toHaveBeenCalled();
    expect(sideEffects.awardSignupWelcomeBonus).not.toHaveBeenCalled();
  });
});
