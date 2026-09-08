import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  DEFAULT_REFERRAL_RULE_CONFIG,
  parseMaxReferralsPerAdvocate,
} from "@/lib/weletic/loyalty/referral-rule-config";
import {
  bindShopperReferral,
  cancelReferralByMerchant,
  ensureAccountReferralLink,
  evaluateReferralQualification,
  generateReferralCode,
  getCanonicalReferralRule,
  getOrCreateReferralRule,
  hashAbuseSignal,
  reverseReferralPointsOnRefund,
  unblockReferralAfterReview,
} from "@/lib/weletic/loyalty/referrals";
import {
  Prisma,
  WeleticLoyaltyReferralStatus,
  WeleticRedemptionStatus,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const complianceMocks = vi.hoisted(() => ({
  assertInstallationGeneration: vi.fn(),
  assertOperationalWrites: vi.fn(),
}));

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyReferral: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyProgram: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticRewardDefinition: {
      findFirst: vi.fn(),
    },
    weleticRewardRedemption: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    link: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    tag: {
      upsert: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    }),
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
  appendPointsLedgerEntry: vi.fn().mockImplementation(async (params) => {
    return {
      id: `wpledger_mock_${Date.now()}`,
      sequenceNumber: 1,
      pointsDelta: params.pointsDelta,
      balanceAfter: BigInt(500) + BigInt(params.pointsDelta),
      ...params,
    };
  }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn().mockImplementation(async (params) => {
    return {
      id: `woutbox_mock_${Date.now()}`,
      ...params,
    };
  }),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreMatchesInstallationGeneration:
    complianceMocks.assertInstallationGeneration,
  assertShopifyStoreAcceptsOperationalWrites:
    complianceMocks.assertOperationalWrites,
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Dub-Backed Shopper Referrals Engine (Milestone 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    complianceMocks.assertInstallationGeneration.mockResolvedValue({
      id: "store_test_1",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration: null,
    });
    complianceMocks.assertOperationalWrites.mockResolvedValue({
      id: "store_test_1",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration: null,
    });
    vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockImplementation(
      (async ({ where }: any) => ({
        count: Array.isArray(where?.id?.in) ? where.id.in.length : 1,
      })) as any,
    );
    vi.mocked(prisma.weleticLoyaltyProgram.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(prisma.tag.upsert).mockImplementation((async ({
      where,
    }: any) => ({
      id: `tag_${where.name_projectId.name}`,
    })) as any);
    vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValue({
      id: "wreward_advocate",
      storeId: "store_test_1",
      name: "$10 referral reward",
      description: null,
      rewardType: "amount_off",
      salesChannel: "online_store",
      exchangeType: "fixed",
      status: "active",
      discountValue: 1000,
      maxDiscountValue: null,
      minOrderAmount: null,
      appliesToResource: "entire_order",
      entitledCollectionIds: [],
      entitledProductIds: [],
      entitledVariantIds: [],
      combinesWithProductDiscounts: false,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: false,
      usageLimit: 1,
      usageLimitPerCustomer: 1,
      expiresInDays: 30,
    } as any);
  });

  describe("1. Code Generation & Signal Hashing", () => {
    it("generates uppercase referral code with custom prefix or default REF", () => {
      const codeWithPrefix = generateReferralCode("ALICE");
      expect(codeWithPrefix).toMatch(/^ALICE-[A-Z0-9]{4}$/);

      const defaultCode = generateReferralCode();
      expect(defaultCode).toMatch(/^REF-[A-Z0-9]{4}$/);
    });

    it("computes a deterministic keyed, store-scoped digest for abuse signals", () => {
      const ip = "192.168.1.100";
      const hash1 = hashAbuseSignal({
        storeId: "store_test_1",
        kind: "ip",
        signal: ip,
      });
      const hash2 = hashAbuseSignal({
        storeId: "store_test_1",
        kind: "ip",
        signal: ip,
      });
      const otherStoreHash = hashAbuseSignal({
        storeId: "store_other",
        kind: "ip",
        signal: ip,
      });

      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^hmac:v1:[A-Za-z0-9._-]+:[A-F0-9]{64}$/);
      expect(otherStoreHash).not.toBe(hash1);
    });
  });

  describe("Referral rule configuration invariants", () => {
    it("uses one merchant-visible default for lazy runtime rule creation", async () => {
      const created = { id: "rule_default", isActive: true } as any;
      vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyReferralRule.create).mockResolvedValueOnce(
        created,
      );

      await expect(getOrCreateReferralRule("program_default")).resolves.toBe(
        created,
      );
      expect(DEFAULT_REFERRAL_RULE_CONFIG).toMatchObject({
        advocatePointsReward: "500",
        refereePointsReward: "50",
        minQualifyingOrderSubtotal: "30",
        fraudCheckSameIp: true,
        isActive: true,
      });
      expect(prisma.weleticLoyaltyReferralRule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          programId: "program_default",
          advocatePointsReward: BigInt(500),
          refereePointsReward: BigInt(50),
          minQualifyingOrderSubtotal: expect.objectContaining({}),
          maxReferralsPerAdvocate: null,
          fraudCheckSameIp: true,
          isActive: true,
        }),
      });
      const createData = vi.mocked(prisma.weleticLoyaltyReferralRule.create)
        .mock.calls[0][0].data as any;
      expect(createData.minQualifyingOrderSubtotal.toString()).toBe("30");
    });

    it("validates a bounded advocate referral cap and treats empty as unlimited", () => {
      expect(parseMaxReferralsPerAdvocate(25)).toBe(25);
      expect(parseMaxReferralsPerAdvocate("25")).toBe(25);
      expect(parseMaxReferralsPerAdvocate("")).toBeNull();
      expect(parseMaxReferralsPerAdvocate(null)).toBeNull();
      expect(() => parseMaxReferralsPerAdvocate(0)).toThrow();
      expect(() => parseMaxReferralsPerAdvocate(1.5)).toThrow();
      expect(() => parseMaxReferralsPerAdvocate("1e2")).toThrow();
      expect(() => parseMaxReferralsPerAdvocate(1_000_001)).toThrow();
    });

    it("uses one deterministic canonical rule read with active rules first", async () => {
      const canonical = { id: "rule_canonical", isActive: true } as any;
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce(canonical);

      await expect(getCanonicalReferralRule("program_1")).resolves.toBe(
        canonical,
      );
      expect(prisma.weleticLoyaltyReferralRule.findFirst).toHaveBeenCalledWith({
        where: { programId: "program_1" },
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      });
    });

    it("preserves an intentionally inactive canonical rule", async () => {
      const inactive = { id: "rule_disabled", isActive: false } as any;
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce(inactive);

      await expect(getOrCreateReferralRule("program_1")).resolves.toBe(
        inactive,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyReferralRule.create).not.toHaveBeenCalled();
    });

    it("serializes first-rule creation on the parent program and rechecks", async () => {
      const created = { id: "rule_created", isActive: true } as any;
      vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyReferralRule.create).mockResolvedValueOnce(
        created,
      );

      await expect(getOrCreateReferralRule("program_1")).resolves.toBe(created);
      expect(prisma.weleticLoyaltyProgram.updateMany).toHaveBeenCalledWith({
        where: { id: "program_1" },
        data: { updatedAt: expect.any(Date) },
      });
      expect(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).toHaveBeenLastCalledWith({
        where: { programId: "program_1" },
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      });
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: "Serializable" }),
      );
    });
  });

  describe("2. Branded Dub Shortlink Creation (Zero-Partner Identity Invariant)", () => {
    it("falls back to the canonical Shopify URL when no branded redirect domain exists", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_direct_1",
        storeId: "store_direct_1",
        status: "active",
        metadata: null,
        referralCode: "HIRO + FRIEND",
        programId: "prog_direct_1",
        shopper: {
          firstName: "Hiro",
          shopifyCustomerId: "customer_direct_1",
        },
        store: {
          shopDomain: "n0pvef-cs.myshopify.com",
          projectId: "proj_direct_1",
          project: { domains: [] },
        },
      } as any);

      await expect(
        ensureAccountReferralLink({
          storeId: "store_direct_1",
          accountId: "acc_direct_1",
        }),
      ).resolves.toEqual({
        referralCode: "HIRO + FRIEND",
        referralLink: "https://n0pvef-cs.myshopify.com?ref=HIRO%20%2B%20FRIEND",
        dubLinkId: null,
      });

      expect(prisma.link.findFirst).not.toHaveBeenCalled();
      expect(prisma.link.create).not.toHaveBeenCalled();
      expect(prisma.tag.upsert).not.toHaveBeenCalled();
    });

    it("creates a Dub Link with partnerId: null preserving the Zero-Partner invariant", async () => {
      const storeId = "store_yamax_1";
      const accountId = "acc_advocate_1";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId,
        status: "active",
        metadata: null,
        referralCode: "ALICE-8888",
        programId: "prog_1",
        shopper: {
          firstName: "Alice",
          shopifyCustomerId: "customer_1",
        },
        store: {
          shopDomain: "yamaxpro.myshopify.com",
          projectId: "proj_yamax_1",
          programId: "core_program_yamax_1",
          project: {
            domains: [
              {
                slug: "yamax.link",
                primary: true,
                verified: true,
                archived: false,
              },
            ],
          },
        },
      } as any);

      vi.mocked(prisma.link.findFirst).mockResolvedValueOnce(null);

      vi.mocked(prisma.link.create).mockResolvedValueOnce({
        id: "link_dub_123",
        shortLink: "https://yamax.link/ref-alice-8888",
        domain: "yamax.link",
        key: "ref-alice-8888",
        url: "https://yamaxpro.myshopify.com?ref=ALICE-8888",
        archived: false,
        disabledAt: null,
        expiresAt: null,
        partnerId: null,
      } as any);

      const result = await ensureAccountReferralLink({
        storeId,
        accountId,
      });

      expect(result.referralCode).toBe("ALICE-8888");
      expect(result.referralLink).toBe("https://yamax.link/ref-alice-8888");
      expect(result.dubLinkId).toBe("link_dub_123");

      expect(prisma.link.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            projectId: "proj_yamax_1",
            programId: "core_program_yamax_1",
            partnerId: null, // STRICT INVARIANT: ZERO PARTNER
            partnerGroupDefaultLinkId: null,
            externalId: `loyalty_referral:${accountId}`,
            url: "https://yamaxpro.myshopify.com?ref=ALICE-8888",
            tags: {
              createMany: {
                data: [
                  expect.objectContaining({ tagId: "tag_loyalty" }),
                  expect.objectContaining({
                    tagId: "tag_shopper-referral",
                  }),
                ],
              },
            },
          }),
        }),
      );
      expect(prisma.tag.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.weleticLoyaltyAccount.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            store: {
              include: {
                project: {
                  include: {
                    domains: {
                      where: {
                        primary: true,
                        verified: true,
                        archived: false,
                      },
                      take: 1,
                    },
                  },
                },
              },
            },
          }),
        }),
      );
    });

    it("falls back to Shopify when the stored branded link is stale", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_stale_1",
        storeId: "store_stale_1",
        status: "active",
        metadata: null,
        referralCode: "STALE-1234",
        programId: "prog_stale_1",
        shopper: { firstName: "Hiro" },
        store: {
          shopDomain: "n0pvef-cs.myshopify.com",
          projectId: "proj_stale_1",
          project: {
            domains: [
              {
                slug: "ref.yamax.example",
                primary: true,
                verified: true,
                archived: false,
              },
            ],
          },
        },
      } as any);
      vi.mocked(prisma.link.findFirst).mockResolvedValueOnce({
        id: "link_stale_1",
        domain: "dub.sh",
        key: "ref-stale-1234",
        url: "https://n0pvef-cs.myshopify.com?ref=STALE-1234",
        shortLink: "https://dub.sh/ref-stale-1234",
        archived: false,
        disabledAt: null,
        expiresAt: null,
      } as any);

      await expect(
        ensureAccountReferralLink({
          storeId: "store_stale_1",
          accountId: "acc_stale_1",
        }),
      ).resolves.toEqual({
        referralCode: "STALE-1234",
        referralLink: "https://n0pvef-cs.myshopify.com?ref=STALE-1234",
        dubLinkId: null,
      });

      expect(prisma.link.create).not.toHaveBeenCalled();
      expect(prisma.tag.upsert).not.toHaveBeenCalled();
    });

    it("hashes malformed legacy codes when creating a branded link key", async () => {
      const referralCode = "HIRO + FRIEND";
      const key = `ref-${createHash("sha256")
        .update(referralCode, "utf8")
        .digest("hex")
        .slice(0, 24)}`;
      const destinationUrl =
        "https://n0pvef-cs.myshopify.com?ref=HIRO%20%2B%20FRIEND";
      const shortLink = `https://ref.yamax.example/${key}`;

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_legacy_1",
        storeId: "store_legacy_1",
        status: "active",
        metadata: null,
        referralCode,
        programId: "prog_legacy_1",
        shopper: { firstName: "Hiro" },
        store: {
          shopDomain: "n0pvef-cs.myshopify.com",
          projectId: "proj_legacy_1",
          project: {
            domains: [
              {
                slug: "ref.yamax.example",
                primary: true,
                verified: true,
                archived: false,
              },
            ],
          },
        },
      } as any);
      vi.mocked(prisma.link.findFirst).mockResolvedValue(null);
      vi.mocked(prisma.link.create).mockResolvedValueOnce({
        id: "link_legacy_1",
        domain: "ref.yamax.example",
        key,
        url: destinationUrl,
        shortLink,
        archived: false,
        disabledAt: null,
        expiresAt: null,
      } as any);

      await expect(
        ensureAccountReferralLink({
          storeId: "store_legacy_1",
          accountId: "acc_legacy_1",
        }),
      ).resolves.toEqual({
        referralCode,
        referralLink: shortLink,
        dubLinkId: "link_legacy_1",
      });

      expect(prisma.link.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            key,
            url: destinationUrl,
            shortLink,
          }),
        }),
      );
    });

    it("does not recreate referral identity for a tombstoned account", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_redacted",
        storeId: "store_redacted",
        status: "active",
        referralCode: null,
        metadata: {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: "2026-08-29T00:00:00.000Z",
            source: "shopify_customers_redact",
          },
        },
        shopper: { shopifyCustomerId: "customer_redacted" },
        store: { projectId: "workspace_redacted" },
      } as any);

      await expect(
        ensureAccountReferralLink({
          storeId: "store_redacted",
          accountId: "acc_redacted",
        }),
      ).rejects.toThrow("Loyalty account acc_redacted is not active.");
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
      expect(prisma.link.create).not.toHaveBeenCalled();
    });
  });

  describe("3. 6-Layer Anti-Abuse & Anti-Self-Referral Validation", () => {
    const storeId = "store_test_1";

    it("Check 1: Blocks self-referral when advocateAccount.id === refereeAccountId", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_same_id",
        referralCode: "SAME-1234",
        status: "active",
        shopper: { id: "shopper_1", email: "alice@example.com" },
        advocateReferrals: [],
      } as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_same_id",
          referralCode: "SAME-1234",
        }),
      ).rejects.toThrow("Self-referral is strictly prohibited.");
    });

    it("Check 2: Blocks self-referral when advocateAccount.shopperId === refereeAccount.shopperId", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_1",
        shopperId: "shopper_shared",
        referralCode: "ADV-1234",
        status: "active",
        shopper: { email: "alice@example.com" },
        advocateReferrals: [],
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_1",
        storeId,
        status: "active",
        shopperId: "shopper_shared",
        shopper: { email: "alice2@example.com" },
      } as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_1",
          referralCode: "ADV-1234",
        }),
      ).rejects.toThrow("Self-referral is strictly prohibited.");
    });

    it("Check 3: Blocks self-referral when advocate and referee have identical emails", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_1",
        shopperId: "shopper_1",
        referralCode: "ADV-1234",
        status: "active",
        shopper: { email: "SAME.EMAIL@example.com" },
        advocateReferrals: [],
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_2",
        storeId,
        status: "active",
        shopperId: "shopper_2",
        shopper: { email: "same.email@example.com" },
      } as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_2",
          referralCode: "ADV-1234",
        }),
      ).rejects.toThrow(
        "Advocate and referee cannot share the same email address.",
      );
    });

    it("Check 4: Blocks binding when referee account was already referred", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_1",
        shopperId: "shopper_1",
        referralCode: "ADV-1234",
        status: "active",
        shopper: { email: "adv@example.com" },
        advocateReferrals: [],
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_3",
        storeId,
        status: "active",
        shopperId: "shopper_3",
        referredById: "acc_previous_advocate",
        shopper: { email: "ref@example.com" },
      } as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_3",
          referralCode: "ADV-1234",
        }),
      ).rejects.toThrow("Account has already been referred by another member.");
    });

    it("returns the original referral when the same successful bind is repeated", async () => {
      const existingReferral = {
        id: "wreferral_existing",
        storeId,
        advocateAccountId: "acc_adv_existing",
        refereeAccountId: "acc_ref_existing",
        status: WeleticLoyaltyReferralStatus.pending,
      } as any;
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_existing",
        shopperId: "shopper_adv_existing",
        referralCode: "EXIST-1234",
        referralCount: 0,
        programId: "prog_existing",
        status: "active",
        metadata: null,
        shopper: { email: "advocate@example.com" },
        advocateReferrals: [],
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_existing",
        storeId,
        shopperId: "shopper_ref_existing",
        referredById: "acc_adv_existing",
        status: "active",
        metadata: null,
        shopper: { email: "referee@example.com" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValueOnce(
        existingReferral,
      );

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_existing",
          referralCode: "EXIST-1234",
        }),
      ).resolves.toBe(existingReferral);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyReferral.create).not.toHaveBeenCalled();
    });

    it("returns the concurrently-created referral after a unique-create retry", async () => {
      const committedReferral = {
        id: "wreferral_race_winner",
        storeId,
        advocateAccountId: "acc_adv_race",
        refereeAccountId: "acc_ref_race",
        status: WeleticLoyaltyReferralStatus.pending,
      } as any;
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_race",
        shopperId: "shopper_adv_race",
        referralCode: "RACE-1234",
        referralCount: 0,
        programId: "prog_race",
        status: "active",
        metadata: null,
        shopper: { email: "advocate-race@example.com" },
        advocateReferrals: [],
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_race",
        storeId,
        shopperId: "shopper_ref_race",
        referredById: null,
        status: "active",
        metadata: null,
        shopper: { email: "referee-race@example.com" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findUnique)
        .mockResolvedValueOnce(null) // optimistic fast path
        .mockResolvedValueOnce(null) // first serializable attempt
        .mockResolvedValueOnce(committedReferral); // retry after P2002
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_race",
        programId: "prog_race",
        maxReferralsPerAdvocate: null,
        fraudCheckSameIp: true,
        isActive: true,
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.create).mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          "Unique referral bind already committed",
          { code: "P2002", clientVersion: "test" },
        ),
      );

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_race",
          referralCode: "RACE-1234",
        }),
      ).resolves.toBe(committedReferral);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(prisma.weleticLoyaltyReferral.create).toHaveBeenCalledTimes(1);
    });

    it("does not bind a referral after the referee account is closed", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_active",
        shopperId: "shopper_adv_active",
        referralCode: "ACTIVE-1234",
        status: "active",
        shopper: { email: "advocate@example.com" },
        advocateReferrals: [],
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_closed",
        storeId,
        shopperId: "shopper_ref_closed",
        status: "closed",
        metadata: {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: "2026-08-29T00:00:00.000Z",
            source: "shopify_customers_redact",
          },
        },
        shopper: { email: null },
      } as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_closed",
          referralCode: "ACTIVE-1234",
        }),
      ).rejects.toThrow("Loyalty account acc_ref_closed is not active.");
      expect(prisma.weleticLoyaltyReferral.create).not.toHaveBeenCalled();
    });

    it("Check 5: Blocks binding when advocate has reached max referrals limit", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_max",
        shopperId: "shopper_1",
        referralCode: "MAX-1234",
        referralCount: 10,
        programId: "prog_1",
        status: "active",
        shopper: { email: "adv@example.com" },
        advocateReferrals: [],
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_4",
        storeId,
        status: "active",
        shopperId: "shopper_4",
        referredById: null,
        shopper: { email: "ref@example.com" },
      } as any);

      vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValueOnce(
        null,
      );

      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_1",
        programId: "prog_1",
        maxReferralsPerAdvocate: 10,
        isActive: true,
      } as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_4",
          referralCode: "MAX-1234",
        }),
      ).rejects.toThrow("Advocate has reached the maximum allowed referrals.");
    });

    it("rechecks the advocate cap after locking when a qualification consumed the last slot", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_cap_race",
        storeId,
        shopperId: "shopper_adv_cap_race",
        referralCode: "CAPRACE-1234",
        referralCount: 9,
        programId: "prog_cap_race",
        status: "active",
        metadata: null,
        shopper: { email: "adv-cap-race@example.com" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_cap_race",
        storeId,
        shopperId: "shopper_ref_cap_race",
        referredById: null,
        status: "active",
        metadata: null,
        shopper: { email: "ref-cap-race@example.com" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValue(
        null,
      );
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_cap_race",
        programId: "prog_cap_race",
        maxReferralsPerAdvocate: 10,
        fraudCheckSameIp: false,
        isActive: true,
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockImplementation(
        (async ({ where }: any) => {
          if (Array.isArray(where?.id?.in)) {
            return { count: where.id.in.length };
          }
          if (where?.id === "acc_adv_cap_race" && where?.referralCount) {
            expect(where.referralCount).toEqual({ lt: 10 });
            return { count: 0 };
          }
          return { count: 1 };
        }) as any,
      );

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_cap_race",
          referralCode: "CAPRACE-1234",
        }),
      ).rejects.toThrow("Advocate has reached the maximum allowed referrals.");

      expect(prisma.weleticLoyaltyReferral.create).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { referredById: "acc_adv_cap_race" },
        }),
      );
    });

    it("observes a concurrent referral-rule disable under the store/program lock before creating a pending bind", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_disable_race",
        storeId,
        shopperId: "shopper_adv_disable_race",
        referralCode: "DISABLE-1234",
        referralCount: 0,
        programId: "prog_disable_race",
        status: "active",
        metadata: null,
        shopper: { email: "adv-disable@example.com" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_disable_race",
        storeId,
        shopperId: "shopper_ref_disable_race",
        referredById: null,
        status: "active",
        metadata: null,
        shopper: { email: "ref-disable@example.com" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValueOnce(
        null,
      );
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockImplementationOnce((async () => {
        expect(prisma.weleticLoyaltyProgram.updateMany).toHaveBeenCalledWith({
          where: {
            id: "prog_disable_race",
            storeId,
            status: "active",
            killSwitchActive: false,
          },
          data: { updatedAt: expect.any(Date) },
        });
        return {
          id: "rule_disable_race",
          programId: "prog_disable_race",
          isActive: false,
          maxReferralsPerAdvocate: null,
          fraudCheckSameIp: true,
        } as any;
      }) as any);

      await expect(
        bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_disable_race",
          referralCode: "DISABLE-1234",
          clientIp: "203.0.113.210",
        }),
      ).rejects.toThrow("Customer referral program is currently inactive.");

      expect(
        vi.mocked(prisma.weleticLoyaltyProgram.updateMany).mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst).mock
          .invocationCallOrder[0]!,
      );
      expect(prisma.weleticLoyaltyReferral.findFirst).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyReferral.create).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { referredById: "acc_adv_disable_race" },
        }),
      );
    });

    it("Check 6: checks exact IP history after the account claim and fraud-blocks a later referral", async () => {
      const clientIp = "203.0.113.195";
      const ipHash = hashAbuseSignal({
        storeId,
        kind: "ip",
        signal: clientIp,
      });

      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_ip",
        shopperId: "shopper_1",
        referralCode: "IP-1234",
        referralCount: 2,
        programId: "prog_1",
        status: "active",
        shopper: { email: "adv@example.com" },
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_ref_5",
        storeId,
        status: "active",
        shopperId: "shopper_5",
        referredById: null,
        shopper: { email: "ref5@example.com" },
      } as any);

      vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValueOnce(
        null,
      );

      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_1",
        programId: "prog_1",
        fraudCheckSameIp: true,
        isActive: true,
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_older_than_the_previous_take_10_window",
      } as any);

      (prisma.weleticLoyaltyReferral.create as any).mockImplementationOnce(
        async (args: any) => args.data,
      );

      const referral = await bindShopperReferral({
        storeId,
        refereeAccountId: "acc_ref_5",
        referralCode: "IP-1234",
        clientIp,
      });

      expect(referral.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect(referral.fraudReason).toContain("Same IP address detected");
      expect(prisma.weleticLoyaltyReferral.findFirst).toHaveBeenCalledWith({
        where: {
          storeId,
          advocateAccountId: "acc_adv_ip",
          ipHash: { in: expect.arrayContaining([ipHash]) },
        },
        select: { id: true },
      });
      expect(
        vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mock
          .invocationCallOrder[0],
      );
    });
  });

  describe("4. Double-Sided Points Fulfillment on Qualifying Order", () => {
    it("awards advocate points and referee welcome bonus on referee's first paid order", async () => {
      const storeId = "store_test_1";
      const orderId = "order_qual_101";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_101",
        storeId,
        status: "active",
        shopperId: "shopper_ref_101",
      } as any);

      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_101",
        advocateAccountId: "acc_advocate_101",
        refereeAccountId: "acc_referee_101",
        status: WeleticLoyaltyReferralStatus.pending,
        advocateAccount: {
          id: "acc_advocate_101",
          storeId,
          status: "active",
          programId: "prog_1",
        },
      } as any);

      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_1",
        programId: "prog_1",
        advocatePointsReward: BigInt(200),
        refereePointsReward: BigInt(100),
        minQualifyingOrderSubtotal: 50.0, // $50 minimum
        isActive: true,
      } as any);

      const result = await evaluateReferralQualification({
        storeId,
        orderId,
        refereeShopperId: "shopper_ref_101",
        orderSubtotal: BigInt(6500), // $65.00 in minor units
        currency: "USD",
      });

      expect(result.qualified).toBe(true);
      expect(result.advocatePointsAwarded).toBe(BigInt(200));
      expect(result.refereePointsAwarded).toBe(BigInt(100));

      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "wreferral_101" }),
          data: expect.objectContaining({
            status: WeleticLoyaltyReferralStatus.rewarded,
            qualifyingOrderId: orderId,
            advocatePointsAwarded: BigInt(200),
            refereePointsAwarded: BigInt(100),
          }),
        }),
      );
    });

    it("atomically admits only one of two concurrent referrals at the advocate cap", async () => {
      const storeId = "store_cap";
      const accounts = new Map([
        [
          "shopper_cap_a",
          {
            id: "acc_referee_cap_a",
            storeId,
            shopperId: "shopper_cap_a",
            status: "active",
          },
        ],
        [
          "shopper_cap_b",
          {
            id: "acc_referee_cap_b",
            storeId,
            shopperId: "shopper_cap_b",
            status: "active",
          },
        ],
      ]);
      const referrals = new Map([
        [
          "acc_referee_cap_a",
          {
            id: "referral_cap_a",
            advocateAccountId: "acc_advocate_cap",
            refereeAccountId: "acc_referee_cap_a",
            status: WeleticLoyaltyReferralStatus.pending,
            metadata: {},
            advocateAccount: {
              id: "acc_advocate_cap",
              storeId,
              status: "active",
              programId: "program_cap",
            },
          },
        ],
        [
          "acc_referee_cap_b",
          {
            id: "referral_cap_b",
            advocateAccountId: "acc_advocate_cap",
            refereeAccountId: "acc_referee_cap_b",
            status: WeleticLoyaltyReferralStatus.pending,
            metadata: {},
            advocateAccount: {
              id: "acc_advocate_cap",
              storeId,
              status: "active",
              programId: "program_cap",
            },
          },
        ],
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockImplementation(
        (async ({ where }: any) => accounts.get(where.shopperId) as any) as any,
      );
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockImplementation(
        (async ({ where }: any) =>
          referrals.get(where.refereeAccountId) as any) as any,
      );
      vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst).mockResolvedValue({
        id: "rule_cap",
        programId: "program_cap",
        advocateRewardKind: "points",
        refereeRewardKind: "points",
        advocatePointsReward: BigInt(0),
        refereePointsReward: BigInt(0),
        minQualifyingOrderSubtotal: null,
        maxReferralsPerAdvocate: 1,
        isActive: true,
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValue({
        count: 1,
      });
      let reservedSlots = 0;
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockImplementation(
        (async ({ where }: any) => {
          if (where.id?.in) return { count: where.id.in.length };
          expect(where).toMatchObject({
            id: "acc_advocate_cap",
            storeId,
            referralCount: { lt: 1 },
          });
          if (reservedSlots >= where.referralCount.lt) return { count: 0 };
          reservedSlots += 1;
          return { count: 1 };
        }) as any,
      );

      const results = await Promise.all([
        evaluateReferralQualification({
          storeId,
          orderId: "order_cap_a",
          refereeShopperId: "shopper_cap_a",
          orderSubtotal: BigInt(1000),
          currency: "USD",
        }),
        evaluateReferralQualification({
          storeId,
          orderId: "order_cap_b",
          refereeShopperId: "shopper_cap_b",
          orderSubtotal: BigInt(1000),
          currency: "USD",
        }),
      ]);

      expect(results.filter((result) => result.qualified)).toHaveLength(1);
      expect(results.filter((result) => !result.qualified)).toEqual([
        expect.objectContaining({
          reason: "Advocate has reached the maximum allowed referrals.",
        }),
      ]);
      expect(reservedSlots).toBe(1);
    });

    it("creates a serialized default rule for an imported pending referral with no rule", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_legacy",
        storeId: "store_legacy",
        status: "active",
        shopperId: "shopper_referee_legacy",
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "referral_legacy",
        advocateAccountId: "acc_advocate_legacy",
        refereeAccountId: "acc_referee_legacy",
        status: WeleticLoyaltyReferralStatus.pending,
        metadata: {},
        advocateAccount: {
          id: "acc_advocate_legacy",
          storeId: "store_legacy",
          status: "active",
          programId: "program_legacy",
        },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyReferralRule.create).mockResolvedValueOnce(
        {
          id: "rule_default_legacy",
          programId: "program_legacy",
          advocateRewardKind: "points",
          refereeRewardKind: "points",
          advocateRewardDefinitionId: null,
          refereeRewardDefinitionId: null,
          advocatePointsReward: BigInt(100),
          refereePointsReward: BigInt(50),
          minQualifyingOrderSubtotal: null,
          maxReferralsPerAdvocate: null,
          fraudCheckSameIp: true,
          isActive: true,
        } as any,
      );

      await expect(
        evaluateReferralQualification({
          storeId: "store_legacy",
          orderId: "order_legacy",
          refereeShopperId: "shopper_referee_legacy",
          orderSubtotal: BigInt(5_000),
          currency: "USD",
        }),
      ).resolves.toMatchObject({ qualified: true });

      expect(prisma.weleticLoyaltyProgram.updateMany).toHaveBeenCalledWith({
        where: { id: "program_legacy", storeId: "store_legacy" },
        data: { updatedAt: expect.any(Date) },
      });
      expect(prisma.weleticLoyaltyReferralRule.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          programId: "program_legacy",
          isActive: true,
        }),
      });
    });

    it("rejects an unprovisionable coupon before claiming the referral or cap slot", async () => {
      const storeId = "store_invalid_reward";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_invalid_reward",
        storeId,
        status: "active",
        shopperId: "shopper_invalid_reward",
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "referral_invalid_reward",
        advocateAccountId: "acc_advocate_invalid_reward",
        refereeAccountId: "acc_referee_invalid_reward",
        status: WeleticLoyaltyReferralStatus.pending,
        metadata: {},
        advocateAccount: {
          id: "acc_advocate_invalid_reward",
          storeId,
          status: "active",
          programId: "program_invalid_reward",
        },
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_invalid_reward",
        programId: "program_invalid_reward",
        advocateRewardKind: "coupon",
        refereeRewardKind: "points",
        advocateRewardDefinitionId: "reward_invalid",
        refereeRewardDefinitionId: null,
        advocatePointsReward: BigInt(0),
        refereePointsReward: BigInt(0),
        minQualifyingOrderSubtotal: null,
        maxReferralsPerAdvocate: 1,
        isActive: true,
      } as any);
      vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValueOnce(
        {
          id: "reward_invalid",
          storeId,
          status: "active",
          exchangeType: "fixed",
          name: "Broken amount reward",
          description: null,
          rewardType: "amount_off",
          discountValue: null,
          maxDiscountValue: null,
          minOrderAmount: null,
          appliesToResource: "entire_order",
          entitledCollectionIds: [],
          entitledProductIds: [],
          entitledVariantIds: [],
          combinesWithProductDiscounts: false,
          combinesWithOrderDiscounts: false,
          combinesWithShippingDiscounts: false,
          usageLimit: 1,
          usageLimitPerCustomer: 1,
          expiresInDays: 30,
        } as any,
      );

      await expect(
        evaluateReferralQualification({
          storeId,
          orderId: "order_invalid_reward",
          refereeShopperId: "shopper_invalid_reward",
          orderSubtotal: BigInt(5_000),
          currency: "USD",
        }),
      ).rejects.toThrow(
        "Referral coupon reward reward_invalid cannot be provisioned in Shopify.",
      );
      expect(prisma.weleticLoyaltyReferral.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    });

    it("queues a coupon for one side while awarding points to the other", async () => {
      const storeId = "store_test_1";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_coupon",
        storeId,
        status: "active",
        shopperId: "shopper_ref_coupon",
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        shopper: { shopifyCustomerId: "customer_advocate_coupon" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_coupon",
        advocateAccountId: "acc_advocate_coupon",
        refereeAccountId: "acc_referee_coupon",
        status: WeleticLoyaltyReferralStatus.pending,
        metadata: {},
        advocateAccount: {
          id: "acc_advocate_coupon",
          storeId,
          status: "active",
          programId: "prog_1",
        },
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_coupon",
        programId: "prog_1",
        advocateRewardKind: "coupon",
        advocateRewardDefinitionId: "wreward_advocate",
        advocatePointsReward: BigInt(500),
        refereeRewardKind: "points",
        refereeRewardDefinitionId: null,
        refereePointsReward: BigInt(100),
        minQualifyingOrderSubtotal: null,
        isActive: true,
      } as any);

      const result = await evaluateReferralQualification({
        storeId,
        orderId: "order_coupon",
        refereeShopperId: "shopper_ref_coupon",
        orderSubtotal: BigInt(10_000),
        currency: "USD",
      });

      expect(result).toMatchObject({
        qualified: true,
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(100),
        couponProvisioning: true,
      });
      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeleticLoyaltyReferralStatus.qualified,
            advocatePointsAwarded: BigInt(0),
            refereePointsAwarded: BigInt(100),
          }),
        }),
      );
      expect(enqueueOutboxJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "REFERRAL_REWARD_PROVISION",
          payload: expect.objectContaining({
            referralId: "wreferral_coupon",
            qualificationOrderId: "order_coupon",
            accountId: "acc_advocate_coupon",
            rewardDefinitionId: "wreward_advocate",
            side: "advocate",
            rewardSnapshot: expect.objectContaining({
              version: 1,
              name: "$10 referral reward",
              discountValue: "1000",
              shopCurrency: "USD",
              customerSelectionDigest: expect.stringMatching(
                /^hmac:v1:[A-Za-z0-9._-]+:[A-F0-9]{64}$/,
              ),
              startsAt: expect.any(String),
              ownershipFingerprint: expect.stringMatching(/^[A-F0-9]{24}$/),
              expectedTitle: expect.stringContaining("$10 referral reward"),
            }),
          }),
        }),
      );
    });

    it("does not double-award when another webhook already claimed the referral", async () => {
      const storeId = "store_test_1";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_race",
        storeId,
        status: "active",
        shopperId: "shopper_ref_race",
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_race",
        advocateAccountId: "acc_advocate_race",
        refereeAccountId: "acc_referee_race",
        status: WeleticLoyaltyReferralStatus.pending,
        advocateAccount: {
          id: "acc_advocate_race",
          storeId,
          status: "active",
          programId: "prog_1",
        },
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_1",
        programId: "prog_1",
        advocatePointsReward: BigInt(200),
        refereePointsReward: BigInt(100),
        minQualifyingOrderSubtotal: null,
        isActive: true,
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValueOnce(
        {
          count: 0,
        },
      );

      const result = await evaluateReferralQualification({
        storeId,
        orderId: "order_race_loser",
        refereeShopperId: "shopper_ref_race",
        orderSubtotal: BigInt(6500),
        currency: "USD",
      });

      expect(result).toEqual({
        qualified: false,
        reason: "Referral was already qualified by another order",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
      });
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });

    it("rolls back qualification when redaction closes either account before the transactional claim", async () => {
      const storeId = "store_redaction_race";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_redaction_race",
        storeId,
        shopperId: "shopper_redaction_race",
        status: "active",
        metadata: null,
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "referral_redaction_race",
        advocateAccountId: "acc_advocate_redaction_race",
        refereeAccountId: "acc_referee_redaction_race",
        status: WeleticLoyaltyReferralStatus.pending,
        metadata: {},
        advocateAccount: {
          id: "acc_advocate_redaction_race",
          storeId,
          programId: "program_redaction_race",
          status: "active",
          metadata: null,
        },
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_redaction_race",
        programId: "program_redaction_race",
        advocateRewardKind: "points",
        refereeRewardKind: "points",
        advocatePointsReward: BigInt(100),
        refereePointsReward: BigInt(50),
        minQualifyingOrderSubtotal: null,
        maxReferralsPerAdvocate: null,
        isActive: true,
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 1,
      });

      await expect(
        evaluateReferralQualification({
          storeId,
          orderId: "order_redaction_race",
          refereeShopperId: "shopper_redaction_race",
          orderSubtotal: BigInt(10_000),
          currency: "USD",
        }),
      ).resolves.toMatchObject({
        qualified: false,
        reason: "Referral account is no longer active.",
      });
      expect(prisma.weleticLoyaltyReferral.updateMany).not.toHaveBeenCalled();
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
      expect(enqueueOutboxJob).not.toHaveBeenCalled();
    });

    it("does not inflate counters when this order already has a persisted award", async () => {
      const storeId = "store_test_1";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_existing_award",
        storeId,
        status: "active",
        shopperId: "shopper_ref_existing_award",
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_existing_award",
        advocateAccountId: "acc_advocate_existing_award",
        refereeAccountId: "acc_referee_existing_award",
        status: WeleticLoyaltyReferralStatus.pending,
        metadata: {},
        advocateAccount: {
          id: "acc_advocate_existing_award",
          storeId,
          status: "active",
          programId: "prog_1",
        },
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_existing_award",
        programId: "prog_1",
        advocateRewardKind: "points",
        refereeRewardKind: "points",
        advocatePointsReward: BigInt(200),
        refereePointsReward: BigInt(100),
        minQualifyingOrderSubtotal: null,
        isActive: true,
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce({ id: "wpledger_existing_award" } as any);

      const result = await evaluateReferralQualification({
        storeId,
        orderId: "order_existing_award",
        refereeShopperId: "shopper_ref_existing_award",
        orderSubtotal: BigInt(6500),
        currency: "USD",
      });

      expect(result).toEqual({
        qualified: false,
        reason: "Referral award already exists for this order",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
      });
      expect(prisma.weleticLoyaltyReferral.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
    });

    it("rejects replay of a refunded qualifying order without incrementing counters", async () => {
      const storeId = "store_test_1";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_replay",
        storeId,
        status: "active",
        shopperId: "shopper_ref_replay",
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_replay",
        advocateAccountId: "acc_advocate_replay",
        refereeAccountId: "acc_referee_replay",
        status: WeleticLoyaltyReferralStatus.pending,
        metadata: {
          invalidatedQualificationOrderIds: ["order_refunded"],
        },
        advocateAccount: {
          id: "acc_advocate_replay",
          storeId,
          status: "active",
          programId: "prog_1",
        },
      } as any);

      const result = await evaluateReferralQualification({
        storeId,
        orderId: "order_refunded",
        refereeShopperId: "shopper_ref_replay",
        orderSubtotal: BigInt(6500),
        currency: "USD",
      });

      expect(result).toEqual({
        qualified: false,
        reason: "Refunded order cannot qualify the referral again",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
      });
      expect(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyReferral.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: "Serializable" }),
      );
    });

    it("does not requalify a terminal referral after the first order was fully refunded", async () => {
      const storeId = "store_test_1";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_referee_new_order",
        storeId,
        status: "active",
        shopperId: "shopper_ref_new_order",
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce(
        null,
      );

      const result = await evaluateReferralQualification({
        storeId,
        orderId: "order_new",
        refereeShopperId: "shopper_ref_new_order",
        orderSubtotal: BigInt(6500),
        currency: "USD",
      });

      expect(result).toEqual({
        qualified: false,
        reason: "No pending referral found",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
      });
      expect(prisma.weleticLoyaltyReferral.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("5. Points Clawback on Order Refund (reverseReferralPointsOnRefund)", () => {
    it("rechecks active-store maintenance before privacy-minimized settlement", async () => {
      const blocked = new Error("loyalty maintenance is active");
      complianceMocks.assertOperationalWrites.mockRejectedValueOnce(blocked);

      await expect(
        reverseReferralPointsOnRefund({
          storeId: "store_test_1",
          orderId: "order_maintenance_blocked",
          refundId: "refund_maintenance_blocked",
          privacyMinimized: true,
          expectedInstallationGeneration: "generation_1",
        }),
      ).rejects.toBe(blocked);

      expect(complianceMocks.assertInstallationGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store_test_1",
          action: "referral_refund_financial_settlement",
          expectedInstallationGeneration: "generation_1",
          tx: prisma,
        }),
      );
      expect(complianceMocks.assertOperationalWrites).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store_test_1",
          action: "referral_refund_financial_settlement",
          expectedInstallationGeneration: "generation_1",
          tx: prisma,
        }),
      );
      expect(prisma.weleticLoyaltyReferral.findFirst).not.toHaveBeenCalled();
    });

    it("reverses advocate and referee points when qualifying order is refunded", async () => {
      const storeId = "store_test_1";
      const orderId = "order_qual_101";
      const refundId = "refund_999";

      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_101",
        advocateAccountId: "acc_advocate_101",
        refereeAccountId: "acc_referee_101",
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: orderId,
        advocatePointsAwarded: BigInt(200),
        refereePointsAwarded: BigInt(100),
      } as any);

      const result = await reverseReferralPointsOnRefund({
        storeId,
        orderId,
        refundId,
      });

      expect(result.reversed).toBe(true);
      expect(result.advocateReversed).toBe(BigInt(200));
      expect(result.refereeReversed).toBe(BigInt(100));

      // Smile auto-cancels the completed referral on a full refund.
      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "wreferral_101" }),
          data: expect.objectContaining({
            status: WeleticLoyaltyReferralStatus.cancelled,
            advocatePointsAwarded: BigInt(0),
            refereePointsAwarded: BigInt(0),
            metadata: expect.objectContaining({
              invalidatedQualificationOrderIds: [orderId],
              requalificationBlocked: true,
              requalificationBlockedReason: "qualifying_order_fully_refunded",
            }),
          }),
        }),
      );
    });

    it("keeps post-redaction referral clawbacks privacy-safe", async () => {
      const storeId = "store_test_1";
      const orderId = "order_redacted_referee";
      const refundId = "refund_after_redaction";

      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_redacted_referee",
        advocateAccountId: "acc_advocate_active",
        refereeAccountId: "acc_referee_redacted",
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: orderId,
        advocatePointsAwarded: BigInt(200),
        refereePointsAwarded: BigInt(100),
        metadata: {
          qualificationOrderId: orderId,
          requiredCouponSides: [],
        },
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          id: "acc_advocate_active",
          metadata: null,
        },
        {
          id: "acc_referee_redacted",
          metadata: {
            shopifyCustomerRedaction: {
              status: "redacted",
              redactedAt: "2026-08-29T00:00:00.000Z",
              source: "shopify_customers_redact",
            },
          },
        },
      ] as any);

      const result = await reverseReferralPointsOnRefund({
        storeId,
        orderId,
        refundId,
      });

      expect(result).toEqual({
        reversed: true,
        advocateReversed: BigInt(200),
        refereeReversed: BigInt(100),
      });
      const referralUpdate = vi.mocked(prisma.weleticLoyaltyReferral.updateMany)
        .mock.calls[0]?.[0];
      expect(referralUpdate?.data?.metadata).toEqual(
        expect.objectContaining({
          requalificationBlocked: true,
          requalificationBlockedReason: "customer_privacy_redacted",
        }),
      );
      expect(referralUpdate?.data?.metadata).not.toHaveProperty("refundId");
      expect(referralUpdate?.data?.metadata).not.toHaveProperty(
        "invalidatedQualificationOrderIds",
      );

      const ledgerCalls = vi.mocked(appendPointsLedgerEntry).mock.calls;
      expect(ledgerCalls).toHaveLength(2);
      expect(ledgerCalls.map(([input]) => input.reason)).toEqual([
        "Referral reward adjusted after customer redaction.",
        "Referral welcome reward adjusted after customer redaction.",
      ]);
      expect(ledgerCalls.every(([input]) => input.metadata == null)).toBe(true);
      expect(
        ledgerCalls.every(([input]) => !input.reason?.includes(orderId)),
      ).toBe(true);
      expect(
        ledgerCalls.every(([input]) => !input.reason?.includes(refundId)),
      ).toBe(true);
      expect(enqueueOutboxJob).not.toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "METAFIELD_SYNC",
          payload: expect.objectContaining({
            accountId: "acc_referee_redacted",
          }),
        }),
      );
    });

    it("does not double-clawback when another refund already claimed the referral", async () => {
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_race",
        advocateAccountId: "acc_advocate_101",
        refereeAccountId: "acc_referee_101",
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_qual_101",
        advocatePointsAwarded: BigInt(200),
        refereePointsAwarded: BigInt(100),
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValueOnce(
        {
          count: 0,
        },
      );

      const result = await reverseReferralPointsOnRefund({
        storeId: "store_test_1",
        orderId: "order_qual_101",
        refundId: "refund_race_loser",
      });

      expect(result).toEqual({
        reversed: false,
        advocateReversed: BigInt(0),
        refereeReversed: BigInt(0),
      });
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });

    it("decrements referral count for a coupon-only referral", async () => {
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_coupon_only",
        advocateAccountId: "acc_advocate_coupon",
        refereeAccountId: "acc_referee_coupon",
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_coupon_only",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
        metadata: {
          requiredCouponSides: ["advocate", "referee"],
          qualificationOrderId: "order_coupon_only",
        },
      } as any);

      const result = await reverseReferralPointsOnRefund({
        storeId: "store_test_1",
        orderId: "order_coupon_only",
        refundId: "refund_coupon_only",
      });

      expect(result.reversed).toBe(true);
      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith({
        where: {
          id: "acc_advocate_coupon",
          storeId: "store_test_1",
          referralCount: { gt: 0 },
        },
        data: { referralCount: { decrement: 1 } },
      });
    });

    it("preserves provisioning metadata when refund cancellation succeeds", async () => {
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_coupon_marker",
        advocateAccountId: "acc_advocate_marker",
        refereeAccountId: "acc_referee_marker",
        status: WeleticLoyaltyReferralStatus.qualified,
        qualifyingOrderId: "order_coupon_marker",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
        metadata: {
          requiredCouponSides: ["advocate"],
          qualificationOrderId: "order_coupon_marker",
        },
      } as any);
      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        {
          id: "wredemp_coupon_marker",
          storeId: "store_test_1",
          accountId: "acc_advocate_marker",
          rewardDefinitionId: "reward_marker",
          shopifyDiscountCode: "WLR-MARKER",
          status: WeleticRedemptionStatus.provisioning,
          metadata: {
            referralId: "wreferral_coupon_marker",
            remoteProvisionAttemptedAt: "2026-08-29T01:02:03.000Z",
          },
        } as any,
      ]);

      const result = await reverseReferralPointsOnRefund({
        storeId: "store_test_1",
        orderId: "order_coupon_marker",
        refundId: "refund_coupon_marker",
      });

      expect(result.reversed).toBe(true);
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "wredemp_coupon_marker",
            status: WeleticRedemptionStatus.provisioning,
          }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.cancelled,
            metadata: expect.objectContaining({
              referralId: "wreferral_coupon_marker",
              remoteProvisionAttemptedAt: "2026-08-29T01:02:03.000Z",
              refundId: "refund_coupon_marker",
            }),
          }),
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: "Serializable" }),
      );
    });

    it("makes a refunded referral terminal after a coupon was consumed", async () => {
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "wreferral_coupon_used",
        advocateAccountId: "acc_advocate_used",
        refereeAccountId: "acc_referee_used",
        status: WeleticLoyaltyReferralStatus.rewarded,
        qualifyingOrderId: "order_coupon_used",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
        metadata: {
          qualificationOrderId: "order_coupon_used",
        },
      } as any);
      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        {
          id: "wredemp_coupon_used",
          status: WeleticRedemptionStatus.used,
        } as any,
      ]);

      await reverseReferralPointsOnRefund({
        storeId: "store_test_1",
        orderId: "order_coupon_used",
        refundId: "refund_coupon_used",
      });

      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeleticLoyaltyReferralStatus.cancelled,
            metadata: expect.objectContaining({
              requalificationBlocked: true,
              requalificationBlockedReason: "referral_coupon_used",
            }),
          }),
        }),
      );
      expect(prisma.weleticRewardRedemption.update).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { referralCount: { decrement: 1 } },
        }),
      );
    });

    it("terminalizes the referral when cancellation loses to issued-to-used settlement", async () => {
      const referral = {
        id: "wreferral_coupon_race",
        advocateAccountId: "acc_advocate_race",
        refereeAccountId: "acc_referee_race",
        status: WeleticLoyaltyReferralStatus.qualified,
        qualifyingOrderId: "order_coupon_race",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
        metadata: {
          requiredCouponSides: ["advocate"],
          qualificationOrderId: "order_coupon_race",
        },
      } as any;
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst)
        .mockResolvedValueOnce(referral)
        .mockResolvedValueOnce(referral);
      vi.mocked(prisma.weleticRewardRedemption.findMany)
        .mockResolvedValueOnce([
          {
            id: "wredemp_coupon_race",
            storeId: "store_test_1",
            accountId: "acc_advocate_race",
            rewardDefinitionId: "reward_race",
            shopifyDiscountCode: "WLR-RACE",
            status: WeleticRedemptionStatus.issued,
            metadata: {},
          } as any,
        ])
        .mockResolvedValueOnce([
          {
            id: "wredemp_coupon_race",
            storeId: "store_test_1",
            accountId: "acc_advocate_race",
            rewardDefinitionId: "reward_race",
            shopifyDiscountCode: "WLR-RACE",
            status: WeleticRedemptionStatus.used,
            metadata: {},
          } as any,
        ]);
      vi.mocked(
        prisma.weleticRewardRedemption.updateMany,
      ).mockResolvedValueOnce({ count: 0 } as any);

      const result = await reverseReferralPointsOnRefund({
        storeId: "store_test_1",
        orderId: "order_coupon_race",
        refundId: "refund_coupon_race",
      });

      expect(result.reversed).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "wredemp_coupon_race",
            status: WeleticRedemptionStatus.issued,
          }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.cancelled,
          }),
        }),
      );
      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "wreferral_coupon_race",
          }),
          data: expect.objectContaining({
            status: WeleticLoyaltyReferralStatus.cancelled,
            metadata: expect.objectContaining({
              invalidatedQualificationOrderIds: ["order_coupon_race"],
              requalificationBlocked: true,
              requalificationBlockedReason: "referral_coupon_used",
            }),
          }),
        }),
      );
      expect(enqueueOutboxJob).not.toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: "discount_deactivate:wredemp_coupon_race",
        }),
      );
    });
  });

  describe("Smile-compatible fraud review lifecycle", () => {
    it("fraud-blocks materially similar advocate and friend emails for review", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "acc_adv_similar",
        storeId: "store_test_1",
        programId: "program_similar",
        shopperId: "shopper_adv_similar",
        referralCode: "SIMILAR-1",
        referralCount: 0,
        status: "active",
        metadata: null,
        shopper: {
          email: "hiro.nguyen+shop@gmail.com",
          firstName: "Hiro",
          lastName: "Nguyen",
        },
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_friend_similar",
        storeId: "store_test_1",
        shopperId: "shopper_friend_similar",
        referredById: null,
        status: "active",
        metadata: null,
        shopper: {
          email: "hironguyen@gmail.com",
          firstName: "Friend",
          lastName: "One",
          ordersCount: 0,
        },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValue(
        null,
      );
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_similar",
        programId: "program_similar",
        maxReferralsPerAdvocate: null,
        fraudCheckSameIp: true,
        isActive: true,
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce(
        null,
      );
      vi.mocked(prisma.weleticLoyaltyReferral.create).mockImplementationOnce(
        (async ({ data }: any) => ({ ...data })) as any,
      );

      const result = await bindShopperReferral({
        storeId: "store_test_1",
        refereeAccountId: "acc_friend_similar",
        referralCode: "SIMILAR-1",
      });

      expect(result.status).toBe(WeleticLoyaltyReferralStatus.fraud_blocked);
      expect(prisma.weleticLoyaltyReferral.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: WeleticLoyaltyReferralStatus.fraud_blocked,
          fraudReason: expect.stringContaining("similar email"),
          fraudSignals: expect.objectContaining({ similarEmail: true }),
        }),
      });
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { referredById: "acc_adv_similar" },
        }),
      );
    });

    it("blocks qualification when the purchase is not the friend's first order", async () => {
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockReset();
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_repeat_friend",
        storeId: "store_test_1",
        shopperId: "shopper_repeat_friend",
        status: "active",
        metadata: null,
        shopper: { ordersCount: 2 },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
        id: "referral_repeat_friend",
        storeId: "store_test_1",
        advocateAccountId: "acc_repeat_advocate",
        refereeAccountId: "acc_repeat_friend",
        status: WeleticLoyaltyReferralStatus.pending,
        metadata: {},
        fraudSignals: null,
        advocateAccount: {
          id: "acc_repeat_advocate",
          storeId: "store_test_1",
          programId: "program_repeat",
          status: "active",
          metadata: null,
        },
      } as any);

      const result = await evaluateReferralQualification({
        storeId: "store_test_1",
        orderId: "order_second",
        refereeShopperId: "shopper_repeat_friend",
        orderSubtotal: BigInt(5000),
        currency: "USD",
      });

      expect(result).toEqual({
        qualified: false,
        reason: "Referral requires the friend's first real order",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
      });
      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeleticLoyaltyReferralStatus.fraud_blocked,
            fraudSignals: expect.objectContaining({
              nonFirstOrder: true,
              observedOrdersCount: 2,
            }),
          }),
        }),
      );
      expect(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).not.toHaveBeenCalled();
    });

    it("lets a merchant unblock a reviewed referral without paying rewards early", async () => {
      const blocked = {
        id: "referral_review",
        storeId: "store_test_1",
        advocateAccountId: "acc_review_advocate",
        refereeAccountId: "acc_review_friend",
        status: WeleticLoyaltyReferralStatus.fraud_blocked,
        metadata: {},
        fraudSignals: { sameIp: true },
        advocateAccount: {
          id: "acc_review_advocate",
          programId: "program_review",
          storeId: "store_test_1",
          status: "active",
          metadata: null,
          referralCount: 0,
        },
        refereeAccount: {
          id: "acc_review_friend",
          storeId: "store_test_1",
          status: "active",
          metadata: null,
          referredById: null,
        },
      } as any;
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce(
        blocked,
      );
      vi.mocked(
        prisma.weleticLoyaltyReferralRule.findFirst,
      ).mockResolvedValueOnce({
        id: "rule_review",
        isActive: true,
        maxReferralsPerAdvocate: 10,
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyReferral.findFirstOrThrow,
      ).mockResolvedValueOnce({
        ...blocked,
        status: WeleticLoyaltyReferralStatus.pending,
      } as any);

      const result = await unblockReferralAfterReview({
        storeId: "store_test_1",
        referralId: "referral_review",
        reviewNote: "Verified as two household members",
      });

      expect(result.status).toBe(WeleticLoyaltyReferralStatus.pending);
      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { referredById: "acc_review_advocate" },
        }),
      );
      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeleticLoyaltyReferralStatus.pending,
            fraudReason: null,
            fraudSignals: expect.objectContaining({
              merchantReview: "unblocked",
            }),
          }),
        }),
      );
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
    });

    it("cancels a completed referral and claws back both point rewards", async () => {
      const completed = {
        id: "referral_cancelled_by_merchant",
        storeId: "store_test_1",
        advocateAccountId: "acc_cancel_advocate",
        refereeAccountId: "acc_cancel_friend",
        qualifyingOrderId: "order_cancelled_by_merchant",
        status: WeleticLoyaltyReferralStatus.rewarded,
        advocatePointsAwarded: BigInt(200),
        refereePointsAwarded: BigInt(100),
        metadata: { qualificationOrderId: "order_cancelled_by_merchant" },
      } as any;
      vi.mocked(prisma.weleticLoyaltyReferral.findFirst)
        .mockResolvedValueOnce(completed)
        .mockResolvedValueOnce(completed);
      vi.mocked(
        prisma.weleticLoyaltyReferral.findFirstOrThrow,
      ).mockResolvedValueOnce({
        ...completed,
        status: WeleticLoyaltyReferralStatus.cancelled,
      } as any);

      const result = await cancelReferralByMerchant({
        storeId: "store_test_1",
        referralId: completed.id,
        reason: "Confirmed self-referral",
      });

      expect(result.status).toBe(WeleticLoyaltyReferralStatus.cancelled);
      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeleticLoyaltyReferralStatus.cancelled,
            metadata: expect.objectContaining({
              cancellationReason: "Confirmed self-referral",
              requalificationBlockedReason: "merchant_cancelled",
            }),
          }),
        }),
      );
      expect(appendPointsLedgerEntry).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(appendPointsLedgerEntry)
          .mock.calls.every(([input]) =>
            input.reason?.includes("cancelled by merchant"),
          ),
      ).toBe(true);
    });
  });
});
