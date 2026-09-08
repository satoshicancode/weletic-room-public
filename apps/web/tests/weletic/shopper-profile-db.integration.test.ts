import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { PrismaClient, type Prisma } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = new PrismaClient();
const stores: string[] = [];
const integrations: string[] = [];
const couponTransport = vi.hoisted(() => ({
  credentials: vi.fn(),
  lookup: vi.fn(),
  create: vi.fn(),
  deactivate: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >()),
  resolveShopifyOfflineCredentials: couponTransport.credentials,
  lookupDiscountByCode: couponTransport.lookup,
  provisionLoyaltyRewardDiscount: couponTransport.create,
  deactivateDiscount: couponTransport.deactivate,
}));
// Remove Redis serialization: MySQL store locking + durable preparation must
// prevent duplicate coupon creates by themselves.
vi.mock(
  "@/lib/weletic/shopify/customer-settlement-lock",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/weletic/shopify/customer-settlement-lock")
    >()),
    withShopifyCustomerSettlementLocks: ({
      fn,
    }: {
      fn: () => Promise<unknown>;
    }) => fn(),
  }),
);
let safeToClean = false;
let afterDatabaseTransaction: (() => Promise<void>) | null = null;
let beforeDatabaseCommit:
  | ((tx: Prisma.TransactionClient) => Promise<void>)
  | null = null;
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(database, {
    get(target, property) {
      if (
        property === "$transaction" &&
        (afterDatabaseTransaction || beforeDatabaseCommit)
      ) {
        const hook = afterDatabaseTransaction;
        const beforeCommit = beforeDatabaseCommit;
        return async <T>(
          operation: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: Parameters<PrismaClient["$transaction"]>[1],
        ) => {
          const result = await target.$transaction(async (tx) => {
            const result = await operation(tx);
            await beforeCommit?.(tx);
            return result;
          }, options);
          await hook?.();
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }),
}));
// Profile reads never use the unrelated link-cache writer. Keep its client
// initialization out of this direct-MySQL test; privacy functions remain real.
vi.mock("@/lib/api/links/cache", () => ({ linkCache: {} }));

describe("shopper profile production queries on isolated MySQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      process.env.SHOPPER_PROFILE_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      url.username !== "loyalty_dev" ||
      url.pathname !== "/weletic_loyalty_dev"
    )
      throw new Error("Refusing non-isolated shopper profile database");
    expect(
      await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
    ).toEqual([{ name: "weletic_loyalty_dev", principal: "loyalty_dev@%" }]);
    safeToClean = true;
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `profile-test:${randomBytes(32).toString("base64")}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("External network forbidden in shopper database tests");
      }),
    );
  });
  afterAll(async () => {
    if (safeToClean && stores.length) {
      const where = { storeId: { in: stores } };
      await database.weleticShopifyCustomerPrivacyTombstone.deleteMany({
        where,
      });
      await database.weleticReviewIncentiveInvalidation.deleteMany({ where });
      await database.weleticReviewIncentiveClaim.deleteMany({ where });
      await database.weleticShopifyVoucherCleanupRequestLink.deleteMany({
        where,
      });
      await database.weleticShopifyVoucherCleanup.deleteMany({ where });
      await database.weleticShopifyComplianceRequest.deleteMany({ where });
      await database.installedIntegration.deleteMany({
        where: { id: { in: integrations } },
      });
      await database.weleticLoyaltyOutboxJob.deleteMany({ where });
      await database.weleticReviewMedia.deleteMany({ where });
      await database.weleticReviewModerationAudit.deleteMany({ where });
      await database.weleticProductReview.deleteMany({ where });
      await database.weleticReviewRequestLine.deleteMany({
        where: { request: where },
      });
      await database.weleticReviewRequest.deleteMany({ where });
      await database.weleticReviewSettings.deleteMany({ where });
      await database.weleticReviewIncentivePolicy.deleteMany({ where });
      await database.weleticReviewOrderCancellation.deleteMany({ where });
      await database.weleticCommerceOrderLine.deleteMany({
        where: { order: where },
      });
      await database.weleticCommerceOrder.deleteMany({ where });
      await database.weleticShopifyProduct.deleteMany({ where });
      await database.weleticPointsLedgerEntry.deleteMany({ where });
      await database.weleticRewardCouponUse.deleteMany({ where });
      await database.weleticReconciliationIssue.deleteMany({ where });
      await database.weleticRewardRedemption.deleteMany({ where });
      await database.weleticRewardDefinition.deleteMany({ where });
      await database.weleticLoyaltyTierHistory.deleteMany({
        where: { account: where },
      });
      await database.weleticLoyaltyAccount.deleteMany({ where });
      await database.weleticLoyaltyTier.deleteMany({
        where: { program: { storeId: { in: stores } } },
      });
      await database.weleticLoyaltyProgram.deleteMany({ where });
      await database.weleticShopper.deleteMany({ where });
      await database.weleticShopifyStore.deleteMany({
        where: { id: { in: stores } },
      });
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await database.$disconnect();
  });

  async function seed(enroll = true) {
    const id = randomUUID();
    const storeId = `profile-store-${id}`;
    const projectId = `profile-workspace-${id}`;
    const shopperId = `profile-shopper-${id}`;
    const accountId = `profile-account-${id}`;
    const programId = `profile-program-${id}`;
    stores.push(storeId);
    // relationMode=prisma permits scalar references to unused synthetic parent
    // IDs. No retained workspace, merchant, integration or token is reused.
    await database.weleticShopifyStore.create({
      data: {
        id: storeId,
        projectId,
        programId: `affiliate-${id}`,
        shopDomain: `profile-${id}.myshopify.com`,
        shopCurrency: "JPY",
        currencyVerifiedAt: new Date(),
        apiVersion: "2026-07",
        installationGeneration: "g1",
      },
    });
    await database.weleticShopper.create({
      data: {
        id: shopperId,
        storeId,
        shopifyCustomerId: "1234",
        email: `fixture-${id}@example.test`,
      },
    });
    if (enroll) {
      await database.weleticLoyaltyProgram.create({
        data: { id: programId, storeId, status: "disabled" },
      });
      await database.weleticLoyaltyAccount.create({
        data: {
          id: accountId,
          storeId,
          programId,
          shopperId,
          cachedPointsBalance: BigInt(-5),
          cachedPendingPoints: BigInt("9007199254740993"),
        },
      });
    }
    return { storeId, projectId, shopperId, accountId, programId };
  }
  async function read(
    fixture: Awaited<ReturnType<typeof seed>>,
    section = "overview",
    cursor?: string,
    limit = 20,
  ) {
    const { readMerchantShopperProfile } = await import(
      "../../lib/weletic/shoppers/profile"
    );
    return readMerchantShopperProfile(fixture.projectId, {
      shopperId: fixture.shopperId,
      section,
      cursor,
      limit,
    });
  }

  async function order(
    fixture: Awaited<ReturnType<typeof seed>>,
    status: "paid" | "partially_refunded" | "refunded" | "pending" | "voided",
    occurredAt = new Date("2026-09-06T00:00:00Z"),
    shopperId = fixture.shopperId,
  ) {
    const id = randomUUID();
    await database.weleticCommerceOrder.create({
      data: {
        id: `segment-order-${id}`,
        storeId: fixture.storeId,
        programId: `affiliate-${fixture.storeId}`,
        externalId: id,
        shopperId,
        status,
        occurredAt,
        presentmentCurrency: "JPY",
        presentmentSubtotal: 100,
        presentmentNet: 100,
        presentmentTotal: 100,
        shopCurrency: "JPY",
        shopSubtotal: 100,
        shopNet: 100,
        shopTotal: 100,
        accountingCurrency: "JPY",
        accountingNet: 100,
        accountingTotal: 100,
        accountingFxRate: 1,
      },
    });
    return `segment-order-${id}`;
  }

  async function incentiveFixture(
    coupon = false,
    promisedPoints = "100",
    multiUse = false,
  ) {
    const fixture = await seed(false);
    const { createReviewIncentivePolicyRevision } = await import(
      "../../lib/weletic/reviews/incentive-policy"
    );
    const reward = coupon
      ? await database.weleticRewardDefinition.create({
          data: {
            id: `coupon-${randomUUID()}`,
            storeId: fixture.storeId,
            name: "Participation coupon",
            rewardType: "amount_off",
            discountValue: 100,
            pointsCost: 500,
            ...(multiUse ? { usageLimit: 5, usageLimitPerCustomer: 0 } : {}),
          },
        })
      : null;
    const policy = await createReviewIncentivePolicyRevision(
      fixture.storeId,
      reward
        ? { kind: "coupon", rewardDefinitionId: reward.id }
        : {
            kind: "points",
            basePoints: promisedPoints,
            photoBonusPoints: "20",
            videoBonusPoints: "30",
            maxPoints:
              BigInt(promisedPoints) > BigInt(200) ? promisedPoints : "200",
          },
    );
    await database.weleticReviewSettings.update({
      where: { storeId: fixture.storeId },
      data: { enabled: true },
    });
    const orderId = await order(fixture, "partially_refunded");
    const addReview = async (rating = 1) => {
      const id = randomUUID();
      const productId = `claim-product-${id}`;
      await database.weleticShopifyProduct.create({
        data: {
          id: productId,
          storeId: fixture.storeId,
          programId: `affiliate-${fixture.storeId}`,
          externalId: id,
          handle: id,
          title: "Synthetic incentive product",
        },
      });
      const line = await database.weleticCommerceOrderLine.create({
        data: {
          id: `claim-line-${id}`,
          orderId,
          productId,
          externalId: id,
          title: "Synthetic incentive line",
          quantity: 2,
          presentmentGross: 100,
          presentmentNet: 100,
          shopGross: 100,
          shopNet: 100,
          accountingNet: 100,
          commissionableAccountingAmount: 100,
        },
      });
      const request = await database.weleticReviewRequest.create({
        data: {
          id: `claim-request-${id}`,
          storeId: fixture.storeId,
          orderId,
          productId,
          shopperId: fixture.shopperId,
          installationGeneration: "g1",
          incentivePolicyId: policy.id,
          status: "submitted",
          fulfilledAt: new Date(),
          sendAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          lines: {
            create: {
              id: `claim-request-line-${id}`,
              orderLineId: line.id,
              purchasedQuantity: 2,
            },
          },
        },
      });
      const review = await database.weleticProductReview.create({
        data: {
          id: `claim-review-${id}`,
          storeId: fixture.storeId,
          requestId: request.id,
          shopperId: fixture.shopperId,
          productId,
          rating,
          title: "Honest feedback",
          body: "The product did not meet my expectations.",
          displayName: "Synthetic shopper",
        },
      });
      const { reviewParticipationContentDigest } = await import(
        "../../lib/weletic/reviews/incentive-claims"
      );
      // Controlled durable-validator fixture, not proof of a live abuse validator.
      await database.weleticProductReview.update({
        where: { id: review.id },
        data: {
          participationStatus: "validated",
          participationValidatedAt: new Date(),
          participationValidationRevision: "purchase_abuse_v1",
          participationContentDigest: reviewParticipationContentDigest({
            ...review,
            mediaIds: [],
          }),
        },
      });
      return review;
    };
    const reserve = async (
      reviewId: string,
      expectedInstallationGeneration = "g1",
    ) => {
      const { reserveProductReviewIncentive } = await import(
        "../../lib/weletic/reviews/incentive-claims"
      );
      return reserveProductReviewIncentive({
        storeId: fixture.storeId,
        reviewId,
        expectedInstallationGeneration,
      });
    };
    return { ...fixture, orderId, policy, addReview, reserve };
  }

  async function enrollPointsAccount(
    fixture: Awaited<ReturnType<typeof incentiveFixture>>,
  ) {
    await database.weleticLoyaltyProgram.create({
      data: {
        id: fixture.programId,
        storeId: fixture.storeId,
        status: "active",
      },
    });
    await database.weleticLoyaltyAccount.create({
      data: {
        id: fixture.accountId,
        storeId: fixture.storeId,
        shopperId: fixture.shopperId,
        programId: fixture.programId,
        status: "active",
      },
    });
  }

  async function prepareParticipationSubmission(
    fixture: Awaited<ReturnType<typeof incentiveFixture>>,
  ) {
    const seedReview = await fixture.addReview(1);
    // Retain only the owned purchase invitation, not fixture-seeded validation.
    await database.weleticProductReview.delete({
      where: { id: seedReview.id },
    });
    const { generateReviewToken, hashReviewToken } = await import(
      "../../lib/weletic/reviews/contracts"
    );
    const token = generateReviewToken();
    await database.weleticReviewRequest.update({
      where: { id: seedReview.requestId },
      data: {
        status: "sent",
        tokenHash: hashReviewToken(token),
        submittedAt: null,
      },
    });
    const input = {
      token,
      rating: 1,
      title: "Honest criticism",
      body: "This product did not meet my expectations.",
      displayName: "Controlled shopper",
      publishConsent: true,
    };
    const { submitNativeReview } = await import(
      "../../lib/weletic/reviews/service"
    );
    return {
      requestId: seedReview.requestId,
      input,
      submit: () => submitNativeReview(fixture.storeId, input),
    };
  }

  it.each([false, true])(
    "validates a real low-rating submission and claims its single promised incentive (coupon=%s)",
    async (coupon) => {
      const fixture = await incentiveFixture(coupon);
      if (!coupon) await enrollPointsAccount(fixture);
      await database.weleticReviewSettings.update({
        where: { storeId: fixture.storeId },
        data: { autoPublish: coupon },
      });
      const invitation = await prepareParticipationSubmission(fixture);
      const submitted = await invitation.submit();
      const review = await database.weleticProductReview.findUniqueOrThrow({
        where: { id: submitted.id },
      });
      expect(review).toMatchObject({
        participationStatus: "validated",
        rating: 1,
        status: coupon ? "published" : "pending",
        incentivized: true,
        verifiedPurchase: true,
      });
      const claim =
        await database.weleticReviewIncentiveClaim.findUniqueOrThrow({
          where: {
            storeId_orderId: {
              storeId: fixture.storeId,
              orderId: fixture.orderId,
            },
          },
        });
      expect(claim.sourceReviewId).toBe(review.id);
      expect(claim.status).toBe(coupon ? "reserved" : "fulfilled");
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(coupon ? 0 : 1);
      expect(
        await database.weleticRewardRedemption.count({
          where: { storeId: fixture.storeId, fulfillmentReference: claim.id },
        }),
      ).toBe(coupon ? 1 : 0);
      await expect(invitation.submit()).rejects.toThrow(
        "Review request unavailable",
      );
    },
  );

  it("derives the photo bonus from owned uploaded media on real submission", async () => {
    const fixture = await incentiveFixture();
    await enrollPointsAccount(fixture);
    const invitation = await prepareParticipationSubmission(fixture);
    const mediaId = `wrevmedia_${randomUUID()}`;
    // This is the upload validator's durable output, not a live upload proof.
    await database.weleticReviewMedia.create({
      data: {
        id: mediaId,
        storeId: fixture.storeId,
        requestId: invitation.requestId,
        objectKey: `synthetic/${mediaId}`,
        contentType: "image/jpeg",
        sizeBytes: 10,
        status: "uploaded",
        uploadExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const { submitNativeReview } = await import(
      "../../lib/weletic/reviews/service"
    );
    const review = await submitNativeReview(fixture.storeId, {
      ...invitation.input,
      mediaIds: [mediaId],
    });
    expect(
      await database.weleticReviewMedia.findUnique({ where: { id: mediaId } }),
    ).toMatchObject({ reviewId: review.id });
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: {
          storeId_orderId: {
            storeId: fixture.storeId,
            orderId: fixture.orderId,
          },
        },
      }),
    ).toMatchObject({
      sourceReviewId: review.id,
      status: "fulfilled",
      awardSnapshot: { kind: "points", points: "120" },
    });
    const entries = await database.weleticPointsLedgerEntry.findMany({
      where: { storeId: fixture.storeId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].pointsDelta).toBe(BigInt(120));
  });

  it.each([false, true])(
    "rolls back real submission and its financial writes when commit fails (coupon=%s)",
    async (coupon) => {
      const fixture = await incentiveFixture(coupon);
      if (!coupon) await enrollPointsAccount(fixture);
      const invitation = await prepareParticipationSubmission(fixture);
      const requestBefore =
        await database.weleticReviewRequest.findUniqueOrThrow({
          where: { id: invitation.requestId },
        });
      let observedWrites = false;
      beforeDatabaseCommit = async (tx) => {
        expect(
          await tx.weleticProductReview.count({
            where: { storeId: fixture.storeId },
          }),
        ).toBe(1);
        expect(
          await tx.weleticReviewIncentiveClaim.count({
            where: { storeId: fixture.storeId },
          }),
        ).toBe(1);
        expect(
          await tx.weleticPointsLedgerEntry.count({
            where: { storeId: fixture.storeId },
          }),
        ).toBe(coupon ? 0 : 1);
        expect(
          await tx.weleticRewardRedemption.count({
            where: { storeId: fixture.storeId },
          }),
        ).toBe(coupon ? 1 : 0);
        expect(
          await tx.weleticLoyaltyOutboxJob.count({
            where: { storeId: fixture.storeId },
          }),
        ).toBeGreaterThan(0);
        observedWrites = true;
        throw new Error("synthetic participation commit failure");
      };
      try {
        await expect(invitation.submit()).rejects.toThrow(
          "synthetic participation commit failure",
        );
      } finally {
        beforeDatabaseCommit = null;
      }
      expect(observedWrites).toBe(true);
      expect(
        await database.weleticReviewRequest.findUnique({
          where: { id: invitation.requestId },
        }),
      ).toEqual(requestBefore);
      expect(
        await database.weleticProductReview.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticReviewIncentiveClaim.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticRewardRedemption.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticLoyaltyOutboxJob.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      if (!coupon) {
        expect(
          await database.weleticLoyaltyAccount.findUnique({
            where: { id: fixture.accountId },
          }),
        ).toMatchObject({ cachedPointsBalance: BigInt(0) });
      }
      await invitation.submit();
      expect(
        await database.weleticReviewIncentiveClaim.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(1);
    },
  );

  it("serializes competing real product submissions into one order-wide points award", async () => {
    const fixture = await incentiveFixture();
    await enrollPointsAccount(fixture);
    const invitations = await Promise.all([
      prepareParticipationSubmission(fixture),
      prepareParticipationSubmission(fixture),
    ]);
    const submitted = await Promise.all(
      invitations.map(({ submit }) => submit()),
    );
    expect(submitted).toHaveLength(2);
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticProductReview.count({
        where: { storeId: fixture.storeId, participationStatus: "validated" },
      }),
    ).toBe(2);
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ cachedPointsBalance: BigInt(100) });
  });

  it("rolls back token consumption and the submitted review when promised incentive evidence is damaged", async () => {
    const fixture = await incentiveFixture();
    await enrollPointsAccount(fixture);
    const invitation = await prepareParticipationSubmission(fixture);
    await database.weleticReviewIncentivePolicy.update({
      where: { id: fixture.policy.id },
      data: { contentDigest: "damaged-fixture" },
    });
    await expect(invitation.submit()).rejects.toThrow(
      "Promised incentive policy is unavailable",
    );
    expect(
      await database.weleticReviewRequest.findUnique({
        where: { id: invitation.requestId },
      }),
    ).toMatchObject({ status: "sent" });
    expect(
      await database.weleticProductReview.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    await database.weleticReviewIncentivePolicy.update({
      where: { id: fixture.policy.id },
      data: { contentDigest: fixture.policy.contentDigest },
    });
    await invitation.submit();
  });

  it("honors a real submitted points promise after refund and later enrollment without a second award", async () => {
    const fixture = await incentiveFixture();
    const invitation = await prepareParticipationSubmission(fixture);
    const submitted = await invitation.submit();
    const claim = await database.weleticReviewIncentiveClaim.findUniqueOrThrow({
      where: {
        storeId_orderId: { storeId: fixture.storeId, orderId: fixture.orderId },
      },
    });
    expect(claim.status).toBe("reserved");
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: submitted.id },
      }),
    ).toMatchObject({ incentivized: true });
    await database.weleticCommerceOrder.update({
      where: { id: fixture.orderId },
      data: { status: "refunded" },
    });
    await enrollPointsAccount(fixture);
    const { fulfillProductReviewPointsIncentive } = await import(
      "../../lib/weletic/reviews/incentive-points"
    );
    const fulfill = () =>
      fulfillProductReviewPointsIncentive({
        storeId: fixture.storeId,
        claimId: claim.id,
        expectedInstallationGeneration: "g1",
      });
    expect(await fulfill()).toMatchObject({ status: "fulfilled" });
    expect(await fulfill()).toMatchObject({ status: "already_fulfilled" });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it("rejects unavailable submission media before consuming the incentive invitation", async () => {
    const fixture = await incentiveFixture();
    const invitation = await prepareParticipationSubmission(fixture);
    const { submitNativeReview } = await import(
      "../../lib/weletic/reviews/service"
    );
    await expect(
      submitNativeReview(fixture.storeId, {
        ...invitation.input,
        mediaIds: ["wrevmedia_foreign"],
      }),
    ).rejects.toThrow("Photo unavailable or owned by another request");
    expect(
      await database.weleticReviewRequest.findUnique({
        where: { id: invitation.requestId },
      }),
    ).toMatchObject({ status: "sent" });
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  async function pointsFixture(promisedPoints = "100") {
    const fixture = await incentiveFixture(false, promisedPoints);
    const review = await fixture.addReview(1);
    const reserved = await fixture.reserve(review.id);
    if (!reserved.claim) throw new Error("Expected points claim");
    const { fulfillProductReviewPointsIncentive } = await import(
      "../../lib/weletic/reviews/incentive-points"
    );
    return {
      ...fixture,
      review,
      claim: reserved.claim,
      fulfill: () =>
        fulfillProductReviewPointsIncentive({
          storeId: fixture.storeId,
          claimId: reserved.claim!.id,
          expectedInstallationGeneration: "g1",
        }),
    };
  }

  async function addIdentityOnlyReviewSuppression(
    fixture: Awaited<ReturnType<typeof incentiveFixture>>,
    kind: "id" | "email" = "id",
  ) {
    const shopper = await database.weleticShopper.findUniqueOrThrow({
      where: { id: fixture.shopperId },
    });
    const { deriveAllShopifyCustomerPrivacyIdentities } = await import(
      "../../lib/weletic/shopify/privacy-identity"
    );
    const [identity] = deriveAllShopifyCustomerPrivacyIdentities({
      storeId: fixture.storeId,
      ...(kind === "id"
        ? { shopifyCustomerId: shopper.shopifyCustomerId }
        : { email: shopper.email }),
    });
    const tombstone =
      await database.weleticShopifyCustomerPrivacyTombstone.create({
        data: {
          id: `identity-only-${randomUUID()}`,
          storeId: fixture.storeId,
          ...identity,
          redactedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    expect(tombstone.shopperId).toBeNull();
    expect(tombstone.accountId).toBeNull();
  }

  it.each(["pending", "hidden", "rejected"] as const)(
    "retries an owned participation points promise without publishing %s feedback",
    async (status) => {
      const fixture = await incentiveFixture();
      const invitation = await prepareParticipationSubmission(fixture);
      const submitted = await invitation.submit();
      const { moderateNativeReview } = await import(
        "../../lib/weletic/reviews/service"
      );
      const { listAdminReviews } = await import(
        "../../lib/weletic/reviews/admin"
      );
      let version = 1;
      if (status !== "pending") {
        await moderateNativeReview(
          fixture.storeId,
          submitted.id,
          "synthetic-owner",
          { version, status },
        );
        version++;
      }
      const page = await listAdminReviews(fixture.storeId, { view: "reviews" });
      expect(page.items.find(({ id }) => id === submitted.id)).toMatchObject({
        rewardPolicy: "participation",
        canRetryReward: true,
        rewardReason: "active_reviews_and_loyalty_account_required",
      });
      await database.weleticCommerceOrder.update({
        where: { id: fixture.orderId },
        data: { status: "refunded" },
      });
      await enrollPointsAccount(fixture);
      const retried = await moderateNativeReview(
        fixture.storeId,
        submitted.id,
        "synthetic-owner",
        { version, retryReward: true },
      );
      expect(retried).toMatchObject({
        status,
        rewardStatus: "awarded",
        rewardReason: null,
        publishedAt: null,
      });
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(1);
      await moderateNativeReview(
        fixture.storeId,
        submitted.id,
        "synthetic-owner",
        { version: version + 1, retryReward: true },
      );
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(1);
      const after = await listAdminReviews(fixture.storeId, {
        view: "reviews",
      });
      expect(after.items.find(({ id }) => id === submitted.id)).toMatchObject({
        canRetryReward: false,
      });
      expect(JSON.stringify(after)).not.toContain("incentivePolicyId");
    },
  );

  it("keeps coupon retries in the shared delivery worker and rejects sibling review reward claims", async () => {
    const fixture = await incentiveFixture(true);
    const first = await prepareParticipationSubmission(fixture);
    const second = await prepareParticipationSubmission(fixture);
    const winner = await first.submit();
    const sibling = await second.submit();
    const { moderateNativeReview } = await import(
      "../../lib/weletic/reviews/service"
    );
    const { listAdminReviews } = await import(
      "../../lib/weletic/reviews/admin"
    );
    await expect(
      moderateNativeReview(fixture.storeId, winner.id, "synthetic-owner", {
        version: 1,
        retryReward: true,
      }),
    ).rejects.toThrow(
      "Coupon fulfillment is managed by the reward delivery worker",
    );
    await expect(
      moderateNativeReview(fixture.storeId, sibling.id, "synthetic-owner", {
        version: 1,
        retryReward: true,
      }),
    ).rejects.toThrow("This review has no owned incentive claim to retry");
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    const page = await listAdminReviews(fixture.storeId, { view: "reviews" });
    expect(
      page.items.every(
        (item) => "canRetryReward" in item && item.canRetryReward === false,
      ),
    ).toBe(true);
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: winner.id },
      }),
    ).toMatchObject({ version: 1, status: "pending" });
  });

  it.each([false, true])(
    "rejects real versioned submission for an identity-only suppressed shopper (coupon=%s)",
    async (coupon) => {
      const fixture = await incentiveFixture(coupon);
      if (!coupon) await enrollPointsAccount(fixture);
      const invitation = await prepareParticipationSubmission(fixture);
      await addIdentityOnlyReviewSuppression(fixture);
      await expect(invitation.submit()).rejects.toThrow(
        "Review request unavailable",
      );
      expect(
        await database.weleticReviewRequest.findUnique({
          where: { id: invitation.requestId },
        }),
      ).toMatchObject({ status: "sent" });
      expect(
        await database.weleticProductReview.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticReviewIncentiveClaim.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticRewardRedemption.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    },
  );

  it.each(["id", "email"] as const)(
    "rejects legacy invitation preview and submission for identity-only %s suppression",
    async (kind) => {
      const fixture = await incentiveFixture();
      const invitation = await prepareParticipationSubmission(fixture);
      const requestBefore = await database.weleticReviewRequest.update({
        where: { id: invitation.requestId },
        data: { incentivePolicyId: null },
      });
      await addIdentityOnlyReviewSuppression(fixture, kind);
      const { getReviewRequestPreview } = await import(
        "../../lib/weletic/reviews/requests"
      );
      await expect(
        getReviewRequestPreview(fixture.storeId, invitation.input.token),
      ).rejects.toThrow("Review request unavailable");
      await expect(invitation.submit()).rejects.toThrow(
        "Review request unavailable",
      );
      const { uploadReviewPhoto } = await import(
        "../../lib/weletic/reviews/media"
      );
      await expect(
        uploadReviewPhoto(
          fixture.storeId,
          invitation.input.token,
          Buffer.from("not-decoded"),
          "image/jpeg",
        ),
      ).rejects.toThrow("Review request unavailable");
      expect(
        await database.weleticReviewRequest.findUnique({
          where: { id: invitation.requestId },
        }),
      ).toEqual(requestBefore);
      expect(
        await database.weleticProductReview.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticReviewMedia.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    },
  );

  it.each(["id", "email"] as const)(
    "rejects delayed points fulfillment for identity-only %s suppression",
    async (kind) => {
      const fixture = await pointsFixture();
      await enrollPointsAccount(fixture);
      await addIdentityOnlyReviewSuppression(fixture, kind);
      await expect(fixture.fulfill()).rejects.toThrow(
        "Review request unavailable",
      );
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    },
  );

  it("rejects direct coupon reservation for an identity-only suppressed participant", async () => {
    const fixture = await incentiveFixture(true);
    const review = await fixture.addReview();
    await addIdentityOnlyReviewSuppression(fixture, "email");
    await expect(fixture.reserve(review.id)).rejects.toThrow(
      "Review request unavailable",
    );
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("blocks asynchronous coupon provisioning when identity-only suppression follows real submission", async () => {
    const fixture = await incentiveFixture(true);
    const invitation = await prepareParticipationSubmission(fixture);
    await invitation.submit();
    const claim = await database.weleticReviewIncentiveClaim.findUniqueOrThrow({
      where: {
        storeId_orderId: { storeId: fixture.storeId, orderId: fixture.orderId },
      },
    });
    const redemption = await database.weleticRewardRedemption.findFirstOrThrow({
      where: { storeId: fixture.storeId, fulfillmentReference: claim.id },
    });
    await addIdentityOnlyReviewSuppression(fixture);
    couponTransport.credentials.mockClear();
    couponTransport.lookup.mockClear();
    couponTransport.create.mockClear();
    const { provisionShopperReviewCoupon } = await import(
      "../../lib/weletic/loyalty/shopper-coupon-worker"
    );
    await expect(
      provisionShopperReviewCoupon({
        storeId: fixture.storeId,
        payload: {
          claimId: claim.id,
          redemptionId: redemption.id,
          installationGeneration: "g1",
        },
      }),
    ).rejects.toThrow("Shopper coupon owner is privacy suppressed");
    expect(couponTransport.credentials).not.toHaveBeenCalled();
    expect(couponTransport.lookup).not.toHaveBeenCalled();
    expect(couponTransport.create).not.toHaveBeenCalled();
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: redemption.id },
      }),
    ).toEqual(redemption);
  });

  it("rejects an empty invitation policy before auto-publication or legacy earning", async () => {
    const fixture = await incentiveFixture();
    await enrollPointsAccount(fixture);
    const invitation = await prepareParticipationSubmission(fixture);
    await database.weleticReviewSettings.update({
      where: { storeId: fixture.storeId },
      data: { autoPublish: true },
    });
    await database.weleticReviewRequest.update({
      where: { id: invitation.requestId },
      data: { incentivePolicyId: "" },
    });
    await expect(invitation.submit()).rejects.toThrow(
      "Review incentive policy requires reconciliation",
    );
    expect(
      await database.weleticReviewRequest.findUnique({
        where: { id: invitation.requestId },
      }),
    ).toMatchObject({ status: "sent" });
    expect(
      await database.weleticProductReview.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("rejects empty-policy moderation without invoking legacy reversal", async () => {
    const fixture = await incentiveFixture();
    await enrollPointsAccount(fixture);
    const invitation = await prepareParticipationSubmission(fixture);
    const submitted = await invitation.submit();
    await database.weleticReviewRequest.update({
      where: { id: invitation.requestId },
      data: { incentivePolicyId: "" },
    });
    const { moderateNativeReview } = await import(
      "../../lib/weletic/reviews/service"
    );
    await expect(
      moderateNativeReview(fixture.storeId, submitted.id, "synthetic-owner", {
        version: 1,
        status: "hidden",
      }),
    ).rejects.toThrow("Review incentive policy requires reconciliation");
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: submitted.id },
      }),
    ).toMatchObject({ version: 1, status: "pending", rewardStatus: "awarded" });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  async function reversalFixture(promisedPoints = "100") {
    const fixture = await pointsFixture(promisedPoints);
    await enrollPointsAccount(fixture);
    await fixture.fulfill();
    const { reverseFulfilledReviewPointsIncentive } = await import(
      "../../lib/weletic/reviews/incentive-reversal"
    );
    const decision = {
      decisionId: randomUUID(),
      actorUserId: "synthetic-fraud-reviewer",
      reason: "confirmed_fraud" as const,
    };
    return {
      ...fixture,
      decision,
      reverse: () =>
        reverseFulfilledReviewPointsIncentive({
          storeId: fixture.storeId,
          claimId: fixture.claim.id,
          expectedInstallationGeneration: "g1",
          decision,
        }),
    };
  }

  it("appends one exact confirmed-fraud reversal under a race, even after the points are spent", async () => {
    const fixture = await reversalFixture();
    const original = await database.weleticPointsLedgerEntry.findFirstOrThrow({
      where: { storeId: fixture.storeId },
    });
    const { appendPointsLedgerEntry } = await import(
      "../../lib/weletic/loyalty/ledger"
    );
    const { withReviewMutation } = await import(
      "../../lib/weletic/reviews/transaction"
    );
    await withReviewMutation(
      fixture.storeId,
      (tx) =>
        appendPointsLedgerEntry({
          tx,
          storeId: fixture.storeId,
          accountId: fixture.accountId,
          entryType: "REDEEM_REWARD",
          pointsDelta: BigInt(-100),
          idempotencyKey: "synthetic-spend",
        }),
      "g1",
    );
    const results = await Promise.all([fixture.reverse(), fixture.reverse()]);
    expect(results.map(({ status }) => status).sort()).toEqual([
      "already_reversed",
      "reversed",
    ]);
    expect(
      results.every(
        ({ pointsReversed, balanceAfter }) =>
          pointsReversed === "100" && balanceAfter === "-100",
      ),
    ).toBe(true);
    expect(
      await database.weleticPointsLedgerEntry.findUnique({
        where: { id: original.id },
      }),
    ).toEqual(original);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(3);
    const reversal = await database.weleticPointsLedgerEntry.findFirstOrThrow({
      where: {
        storeId: fixture.storeId,
        referenceType: "REVIEW_INCENTIVE_REVERSAL",
      },
    });
    expect(reversal).toMatchObject({
      pointsDelta: BigInt(-100),
      referenceId: fixture.claim.id,
      metadata: {
        ...fixture.decision,
        originalAwardEntryId: original.id,
        claimId: fixture.claim.id,
        policyId: fixture.policy.id,
      },
    });
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({
      status: "reversed",
      awardSnapshot: fixture.claim.awardSnapshot,
      validationSnapshot: fixture.claim.validationSnapshot,
    });
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: fixture.review.id },
      }),
    ).toMatchObject({
      rewardStatus: "reversed",
      rewardLedgerId: original.id,
      participationStatus: "invalidated",
      status: fixture.review.status,
    });
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ cachedPointsBalance: BigInt(-100) });
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: fixture.storeId, jobType: "TIER_REVIEW" },
      }),
    ).toBe(2);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: fixture.storeId, jobType: "FLOW_TRIGGER" },
      }),
    ).toBe(1);
    await expect(fixture.fulfill()).rejects.toThrow();
  });

  it("reverses the original exact BigInt award without safe-integer rounding", async () => {
    const fixture = await reversalFixture("9007199254740993");
    expect(await fixture.reverse()).toMatchObject({
      pointsReversed: "9007199254740993",
      balanceAfter: "0",
    });
    expect(await fixture.reverse()).toMatchObject({
      status: "already_reversed",
      pointsReversed: "9007199254740993",
    });
  });

  it("removes invalid points from lifetime and VIP qualification, preserving ordinary tier grace", async () => {
    const fixture = await reversalFixture();
    await database.weleticLoyaltyTier.createMany({
      data: [
        {
          id: `entry-${randomUUID()}`,
          programId: fixture.programId,
          name: "Entry",
          slug: "entry",
          tierOrder: 1,
        },
        {
          id: `earned-${randomUUID()}`,
          programId: fixture.programId,
          name: "Earned",
          slug: "earned",
          tierOrder: 2,
          minPointsThreshold: BigInt(100),
        },
      ],
    });
    const { evaluateTierMaintenanceCycle } = await import(
      "../../lib/weletic/loyalty/tier-lifecycle"
    );
    const evaluation = {
      storeId: fixture.storeId,
      accountId: fixture.accountId,
      milestoneMode: "points_earned",
      reviewPeriod: "ROLLING_12M" as const,
      expectedInstallationGeneration: "g1",
      now: new Date(Date.now() + 1000),
    };
    expect(await evaluateTierMaintenanceCycle(evaluation)).toMatchObject({
      status: "PROMOTED",
      qualifyingPoints: BigInt(100),
    });
    await fixture.reverse();
    expect(
      await evaluateTierMaintenanceCycle({
        ...evaluation,
        now: new Date(Date.now() + 2000),
      }),
    ).toMatchObject({ status: "IN_GRACE_PERIOD", qualifyingPoints: BigInt(0) });
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ lifetimePointsEarned: BigInt(0) });
    const { auditAccountLedger } = await import(
      "../../lib/weletic/loyalty/reconciliation"
    );
    expect(
      await auditAccountLedger(fixture.accountId, {
        autoRepair: false,
        quarantineFatal: false,
      }),
    ).toMatchObject({ isClean: true, anomalies: [] });
    const { reconcileAccountPoints } = await import(
      "../../lib/weletic/loyalty/ledger"
    );
    await reconcileAccountPoints(fixture.accountId);
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ lifetimePointsEarned: BigInt(0) });
  });

  it("matches invalidation to the original VIP window and does not subtract an earlier award from a later cycle", async () => {
    const fixture = await reversalFixture();
    await database.weleticPointsLedgerEntry.updateMany({
      where: { storeId: fixture.storeId },
      data: { createdAt: new Date("2025-06-01T00:00:00Z") },
    });
    await fixture.reverse();
    const { withReviewMutation } = await import(
      "../../lib/weletic/reviews/transaction"
    );
    const { appendPointsLedgerEntry } = await import(
      "../../lib/weletic/loyalty/ledger"
    );
    await withReviewMutation(
      fixture.storeId,
      (tx) =>
        appendPointsLedgerEntry({
          tx,
          storeId: fixture.storeId,
          accountId: fixture.accountId,
          entryType: "EARN_ORDER",
          pointsDelta: BigInt(50),
          idempotencyKey: "synthetic-valid-purchase",
        }),
      "g1",
    );
    await withReviewMutation(
      fixture.storeId,
      (tx) =>
        appendPointsLedgerEntry({
          tx,
          storeId: fixture.storeId,
          accountId: fixture.accountId,
          entryType: "REFUND_REVERSAL",
          pointsDelta: BigInt(-10),
          idempotencyKey: "synthetic-ordinary-refund",
          referenceType: "ORDER_REFUND",
        }),
      "g1",
    );
    const { sumValidQualifyingPoints } = await import(
      "../../lib/weletic/loyalty/qualifying-review-points"
    );
    const entries = await database.weleticPointsLedgerEntry.findMany({
      where: { storeId: fixture.storeId, pointsDelta: { gt: BigInt(0) } },
    });
    const sum = (selected: typeof entries) =>
      sumValidQualifyingPoints({
        db: database,
        storeId: fixture.storeId,
        accountId: fixture.accountId,
        entries: selected,
      });
    expect(
      await sum(
        entries.filter((entry) => entry.createdAt.getUTCFullYear() === 2025),
      ),
    ).toBe(BigInt(0));
    expect(
      await sum(
        entries.filter((entry) => entry.createdAt.getUTCFullYear() !== 2025),
      ),
    ).toBe(BigInt(50));
    expect(await sum(entries)).toBe(BigInt(50));
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ lifetimePointsEarned: BigInt(50) });
    await database.weleticPointsLedgerEntry.updateMany({
      where: {
        storeId: fixture.storeId,
        referenceType: "REVIEW_INCENTIVE_REVERSAL",
      },
      data: { pointsDelta: BigInt(-99) },
    });
    await expect(sum(entries)).rejects.toThrow("requires reconciliation");
  });

  it("uses the original award despite changed review content, current settings, or paused modules", async () => {
    const fixture = await reversalFixture();
    await database.weleticProductReview.update({
      where: { id: fixture.review.id },
      data: {
        body: "Changed content after confirmed fraudulent participation",
        verifiedPurchase: false,
      },
    });
    await database.weleticReviewSettings.update({
      where: { storeId: fixture.storeId },
      data: { enabled: false },
    });
    await database.weleticLoyaltyProgram.update({
      where: { id: fixture.programId },
      data: { status: "disabled", killSwitchActive: true },
    });
    expect(await fixture.reverse()).toMatchObject({
      status: "reversed",
      pointsReversed: "100",
      balanceAfter: "0",
    });
  });

  it("keeps the winning reversal decision immutable and rejects contradictory replay evidence", async () => {
    const fixture = await reversalFixture();
    await fixture.reverse();
    const { reverseFulfilledReviewPointsIncentive } = await import(
      "../../lib/weletic/reviews/incentive-reversal"
    );
    await expect(
      reverseFulfilledReviewPointsIncentive({
        storeId: fixture.storeId,
        claimId: fixture.claim.id,
        expectedInstallationGeneration: "g1",
        decision: { ...fixture.decision, decisionId: randomUUID() },
      }),
    ).rejects.toThrow("decision or ledger");
    await database.weleticPointsLedgerEntry.updateMany({
      where: {
        storeId: fixture.storeId,
        referenceType: "REVIEW_INCENTIVE_REVERSAL",
      },
      data: { pointsDelta: BigInt(-99) },
    });
    await expect(fixture.reverse()).rejects.toThrow("decision or ledger");
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(2);
  });

  it("rolls back reversal, decision, review state and outbox if the owning transaction fails", async () => {
    const fixture = await reversalFixture();
    const { reverseReviewPointsClaimInTransaction } = await import(
      "../../lib/weletic/reviews/incentive-reversal"
    );
    const { withReviewMutation } = await import(
      "../../lib/weletic/reviews/transaction"
    );
    await expect(
      withReviewMutation(
        fixture.storeId,
        async (tx, generation) => {
          await reverseReviewPointsClaimInTransaction({
            tx,
            storeId: fixture.storeId,
            claimId: fixture.claim.id,
            generation: generation!,
            decision: fixture.decision,
          });
          throw new Error("controlled-reversal-rollback");
        },
        "g1",
      ),
    ).rejects.toThrow("controlled-reversal-rollback");
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({ status: "fulfilled" });
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: fixture.review.id },
      }),
    ).toMatchObject({
      rewardStatus: "awarded",
      participationStatus: "validated",
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(2);
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ cachedPointsBalance: BigInt(100) });
  });

  it("rejects cross-store, stale-installation, privacy-redacted and unfulfilled claims without corrections", async () => {
    const fixture = await reversalFixture();
    const other = await seed(false);
    const { reverseFulfilledReviewPointsIncentive } = await import(
      "../../lib/weletic/reviews/incentive-reversal"
    );
    await expect(
      reverseFulfilledReviewPointsIncentive({
        storeId: other.storeId,
        claimId: fixture.claim.id,
        expectedInstallationGeneration: "g1",
        decision: fixture.decision,
      }),
    ).rejects.toThrow();
    await expect(
      reverseFulfilledReviewPointsIncentive({
        storeId: fixture.storeId,
        claimId: fixture.claim.id,
        expectedInstallationGeneration: "old-installation",
        decision: fixture.decision,
      }),
    ).rejects.toThrow();
    const { redactNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    await redactNativeReviewsBatch(fixture.storeId, fixture.shopperId);
    await expect(fixture.reverse()).rejects.toThrow();
    const unpaid = await pointsFixture();
    await expect(
      reverseFulfilledReviewPointsIncentive({
        storeId: unpaid.storeId,
        claimId: unpaid.claim.id,
        expectedInstallationGeneration: "g1",
        decision: fixture.decision,
      }),
    ).rejects.toThrow();
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: unpaid.storeId },
      }),
    ).toBe(0);
  });

  it("rejects damaged award ownership or missing reversal evidence without issuing another correction", async () => {
    const fixture = await reversalFixture();
    await database.weleticReviewIncentiveClaim.update({
      where: { id: fixture.claim.id },
      data: { awardSnapshot: { kind: "points", points: "99" } },
    });
    await expect(fixture.reverse()).rejects.toThrow("ledger evidence");
    await database.weleticReviewIncentiveClaim.update({
      where: { id: fixture.claim.id },
      data: {
        awardSnapshot: fixture.claim.awardSnapshot as Prisma.InputJsonValue,
        status: "reversed",
      },
    });
    await expect(fixture.reverse()).rejects.toThrow(
      "reversal ledger evidence is missing",
    );
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it("fulfills one immutable points promise under concurrent claims without requiring publication", async () => {
    const fixture = await incentiveFixture();
    await enrollPointsAccount(fixture);
    const first = await fixture.addReview(1);
    const second = await fixture.addReview(5);
    const results = await Promise.all([
      fixture.reserve(first.id),
      fixture.reserve(second.id),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "already_claimed",
      "fulfilled",
    ]);
    const entries = await database.weleticPointsLedgerEntry.findMany({
      where: { storeId: fixture.storeId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: "EARN_BONUS",
      pointsDelta: BigInt(100),
      referenceType: "REVIEW_INCENTIVE",
    });
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({
      cachedPointsBalance: BigInt(100),
      lifetimePointsEarned: BigInt(100),
      ledgerVersion: 1,
    });
    const jobs = await database.weleticLoyaltyOutboxJob.findMany({
      where: { storeId: fixture.storeId },
    });
    expect(jobs.map((job) => job.jobType).sort()).toEqual([
      "FLOW_TRIGGER",
      "TIER_REVIEW",
    ]);
    const sourceOrder = await database.weleticCommerceOrder.findUniqueOrThrow({
      where: { id: fixture.orderId },
    });
    expect(
      jobs.find((job) => job.jobType === "FLOW_TRIGGER")?.payload,
    ).toMatchObject({
      orderId: sourceOrder.externalId,
      pointsDelta: "100",
      pointsBalance: "100",
      installationGeneration: "g1",
    });
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("keeps an unenrolled promise pending, then fulfills its original amount once after enrollment", async () => {
    const fixture = await pointsFixture();
    expect(await fixture.fulfill()).toMatchObject({ status: "pending" });
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    const { createReviewIncentivePolicyRevision } = await import(
      "../../lib/weletic/reviews/incentive-policy"
    );
    await createReviewIncentivePolicyRevision(fixture.storeId, {
      kind: "points",
      basePoints: "999",
      photoBonusPoints: "0",
      videoBonusPoints: "0",
      maxPoints: "999",
    });
    await enrollPointsAccount(fixture);
    const results = await Promise.all([fixture.fulfill(), fixture.fulfill()]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "already_fulfilled",
      "fulfilled",
    ]);
    expect(
      await database.weleticPointsLedgerEntry.findFirst({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({ pointsDelta: BigInt(100) });
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(2);
  });

  it("does not revoke or reissue a fulfilled participation award when legitimate criticism is hidden or refunded", async () => {
    const fixture = await pointsFixture();
    await enrollPointsAccount(fixture);
    await fixture.fulfill();
    const { moderateNativeReview } = await import(
      "../../lib/weletic/reviews/service"
    );
    await moderateNativeReview(
      fixture.storeId,
      fixture.review.id,
      "synthetic-moderator",
      { version: 1, status: "hidden" },
    );
    await database.weleticCommerceOrder.update({
      where: { id: fixture.orderId },
      data: { status: "refunded" },
    });
    expect(await fixture.fulfill()).toMatchObject({
      status: "already_fulfilled",
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ cachedPointsBalance: BigInt(100) });
  });

  it("audits hiding a participation review without touching its award, and rolls back an uncommitted audit", async () => {
    const fixture = await pointsFixture();
    await enrollPointsAccount(fixture);
    await fixture.fulfill();
    const { withReviewMutation } = await import(
      "../../lib/weletic/reviews/transaction"
    );
    const { moderateReviewWithAuditInTransaction } = await import(
      "../../lib/weletic/reviews/moderation-audit"
    );
    const snapshot = async () => ({
      review: await database.weleticProductReview.findUniqueOrThrow({
        where: { id: fixture.review.id },
      }),
      account: await database.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: fixture.accountId },
      }),
      ledger: await database.weleticPointsLedgerEntry.findMany({
        where: { storeId: fixture.storeId },
        orderBy: { id: "asc" },
      }),
      claims: await database.weleticReviewIncentiveClaim.findMany({
        where: { storeId: fixture.storeId },
        orderBy: { id: "asc" },
      }),
      audits: await database.weleticReviewModerationAudit.findMany({
        where: { storeId: fixture.storeId },
        orderBy: { id: "asc" },
      }),
      outbox: await database.weleticLoyaltyOutboxJob.findMany({
        where: { storeId: fixture.storeId },
        orderBy: { id: "asc" },
      }),
    });
    const before = await snapshot();
    const moderate = (rollback: boolean) =>
      withReviewMutation(fixture.storeId, async (tx, generation) => {
        const result = await moderateReviewWithAuditInTransaction({
          tx,
          storeId: fixture.storeId,
          generation,
          actor: { kind: "workspace", userId: "synthetic-audit-moderator" },
          input: {
            reviewId: fixture.review.id,
            version: before.review.version,
            status: "hidden",
            reason: "personal_information",
          },
        });
        if (rollback) throw new Error("synthetic audit rollback");
        return result;
      });
    await expect(moderate(true)).rejects.toThrow("synthetic audit rollback");
    expect(await snapshot()).toEqual(before);
    const result = await moderate(false);
    const after = await snapshot();
    expect(result).toMatchObject({
      status: "hidden",
      version: before.review.version + 1,
    });
    expect(after.account).toEqual(before.account);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.claims).toEqual(before.claims);
    // A pending-to-hidden review has no published projection to invalidate.
    expect(before.review.status).toBe("pending");
    expect(after.outbox).toEqual(before.outbox);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({
      id: result.auditId,
      reasonCode: "personal_information",
      fromVersion: before.review.version,
      toVersion: before.review.version + 1,
    });
    expect(after.review.rewardStatus).toBe(before.review.rewardStatus);
    await expect(moderate(false)).rejects.toMatchObject({ code: "conflict" });
    expect(await snapshot()).toEqual(after);
  });

  it("includes validated photo points once in the order-wide award", async () => {
    const fixture = await incentiveFixture();
    const review = await fixture.addReview();
    const mediaId = `wrevmedia_${randomUUID()}`;
    await database.weleticReviewMedia.create({
      data: {
        id: mediaId,
        storeId: fixture.storeId,
        requestId: review.requestId,
        reviewId: review.id,
        objectKey: `synthetic/${mediaId}`,
        contentType: "image/jpeg",
        sizeBytes: 10,
        status: "uploaded",
        uploadExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const { reviewParticipationContentDigest } = await import(
      "../../lib/weletic/reviews/incentive-evidence"
    );
    await database.weleticProductReview.update({
      where: { id: review.id },
      data: {
        participationContentDigest: reviewParticipationContentDigest({
          ...review,
          mediaIds: [mediaId],
        }),
      },
    });
    await enrollPointsAccount(fixture);
    const claim = await fixture.reserve(review.id);
    expect(claim.claim).toMatchObject({
      status: "fulfilled",
      awardSnapshot: { kind: "points", points: "120" },
    });
    const another = await fixture.addReview(5);
    expect(await fixture.reserve(another.id)).toMatchObject({
      status: "already_claimed",
    });
    const entries = await database.weleticPointsLedgerEntry.findMany({
      where: { storeId: fixture.storeId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].pointsDelta).toBe(BigInt(120));
  });

  it("honors validated reserved participation after an ordinary refund before fulfillment", async () => {
    const fixture = await pointsFixture();
    await enrollPointsAccount(fixture);
    await database.weleticCommerceOrder.update({
      where: { id: fixture.orderId },
      data: { status: "refunded" },
    });
    expect(await fixture.fulfill()).toMatchObject({ status: "fulfilled" });
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({ status: "fulfilled" });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it("refuses a second credit when durable fulfilled-ledger evidence is inconsistent", async () => {
    const fixture = await pointsFixture();
    await enrollPointsAccount(fixture);
    await fixture.fulfill();
    await database.weleticProductReview.update({
      where: { id: fixture.review.id },
      data: { rewardLedgerId: "damaged-link" },
    });
    await expect(fixture.fulfill()).rejects.toThrow(
      "ledger evidence requires reconciliation",
    );
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ cachedPointsBalance: BigInt(100) });
  });

  it("retains exact integer points above Number.MAX_SAFE_INTEGER", async () => {
    const points = "9007199254740993";
    const fixture = await pointsFixture(points);
    await enrollPointsAccount(fixture);
    expect(await fixture.fulfill()).toMatchObject({
      status: "fulfilled",
      points,
    });
    expect(
      await database.weleticPointsLedgerEntry.findFirst({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({
      pointsDelta: BigInt(points),
      balanceAfter: BigInt(points),
    });
  });

  it("rolls back claim fulfillment, balances, review marker and events at the real transaction boundary", async () => {
    const fixture = await pointsFixture();
    await enrollPointsAccount(fixture);
    const { withReviewMutation } = await import(
      "../../lib/weletic/reviews/transaction"
    );
    const { fulfillReviewPointsClaimInTransaction } = await import(
      "../../lib/weletic/reviews/incentive-points"
    );
    await expect(
      withReviewMutation(
        fixture.storeId,
        async (tx) => {
          await fulfillReviewPointsClaimInTransaction({
            tx,
            storeId: fixture.storeId,
            claimId: fixture.claim.id,
            generation: "g1",
          });
          throw new Error("controlled transaction rollback");
        },
        "g1",
      ),
    ).rejects.toThrow("controlled transaction rollback");
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({ status: "reserved" });
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: fixture.review.id },
      }),
    ).toMatchObject({ rewardLedgerId: null });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ cachedPointsBalance: BigInt(0), ledgerVersion: 0 });
  });

  it("rejects changed validation, forged award totals, stale generations and privacy-redacted claims", async () => {
    const fixture = await pointsFixture();
    await enrollPointsAccount(fixture);
    await database.weleticProductReview.update({
      where: { id: fixture.review.id },
      data: { body: "Changed after trusted validation" },
    });
    await expect(fixture.fulfill()).rejects.toThrow(
      "immutable participation evidence",
    );
    await database.weleticProductReview.update({
      where: { id: fixture.review.id },
      data: { body: fixture.review.body },
    });
    await database.weleticReviewIncentiveClaim.update({
      where: { id: fixture.claim.id },
      data: { awardSnapshot: { kind: "points", points: "500" } },
    });
    await expect(fixture.fulfill()).rejects.toThrow(
      "immutable participation evidence",
    );
    await database.weleticReviewIncentiveClaim.update({
      where: { id: fixture.claim.id },
      data: { awardSnapshot: { kind: "points", points: "100" } },
    });
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { installationGeneration: "g2" },
    });
    await expect(fixture.fulfill()).rejects.toThrow();
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { installationGeneration: "g1" },
    });
    const { redactNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    await redactNativeReviewsBatch(fixture.storeId, fixture.shopperId);
    await expect(fixture.fulfill()).rejects.toThrow("not eligible");
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("rejects a coupon claim at the points boundary without manufacturing a ledger", async () => {
    const fixture = await couponFixture();
    await enrollPointsAccount(fixture);
    const { fulfillProductReviewPointsIncentive } = await import(
      "../../lib/weletic/reviews/incentive-points"
    );
    await expect(
      fulfillProductReviewPointsIncentive({
        storeId: fixture.storeId,
        claimId: fixture.claim.id,
        expectedInstallationGeneration: "g1",
      }),
    ).rejects.toThrow();
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  const invalidationDecision = () => ({
    decisionId: randomUUID(),
    actorUserId: "synthetic-fraud-reviewer",
    reason: "confirmed_fraud" as const,
  });
  async function invalidateClaim(
    fixture: { storeId: string; claim: { id: string } },
    decision = invalidationDecision(),
  ) {
    const { invalidateReviewIncentive } = await import(
      "../../lib/weletic/reviews/incentive-invalidation"
    );
    return invalidateReviewIncentive({
      storeId: fixture.storeId,
      claimId: fixture.claim.id,
      expectedInstallationGeneration: "g1",
      decision,
    });
  }

  it("durably cancels an unpaid points claim once without inventing a reversal", async () => {
    const fixture = await pointsFixture();
    const decision = invalidationDecision();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => invalidateClaim(fixture, decision)),
    );
    expect(new Set(results.map((result) => result.invalidationId)).size).toBe(
      1,
    );
    expect(
      await database.weleticReviewIncentiveInvalidation.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({
      status: "invalidated",
      awardSnapshot: fixture.claim.awardSnapshot,
      validationSnapshot: fixture.claim.validationSnapshot,
    });
    await enrollPointsAccount(fixture);
    await expect(fixture.fulfill()).rejects.toThrow("not eligible");
    expect(await fixture.reserve((await fixture.addReview()).id)).toMatchObject(
      { status: "already_claimed", created: false },
    );
    await expect(invalidateClaim(fixture)).rejects.toThrow(
      "decision requires reconciliation",
    );
  });

  it("serializes fulfillment against confirmed invalidity with a zero final balance", async () => {
    const fixture = await pointsFixture();
    await enrollPointsAccount(fixture);
    const [award, invalidation] = await Promise.allSettled([
      fixture.fulfill(),
      invalidateClaim(fixture),
    ]);
    expect(invalidation.status).toBe("fulfilled");
    const entries = await database.weleticPointsLedgerEntry.findMany({
      where: { storeId: fixture.storeId },
    });
    expect(
      entries.reduce((sum, entry) => sum + entry.pointsDelta, BigInt(0)),
    ).toBe(BigInt(0));
    expect(entries.length).toBe(award.status === "fulfilled" ? 2 : 0);
    expect(
      await database.weleticLoyaltyAccount.findUnique({
        where: { id: fixture.accountId },
      }),
    ).toMatchObject({ cachedPointsBalance: BigInt(0) });
  });

  it("records the same confirmed decision beside an exact fulfilled-points reversal", async () => {
    const fixture = await reversalFixture();
    const result = await invalidateClaim(fixture, fixture.decision);
    expect(result.outcome).toBe("points_reversed");
    expect(await invalidateClaim(fixture, fixture.decision)).toMatchObject({
      status: "already_recorded",
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(2);
    expect(
      await database.weleticReviewIncentiveInvalidation.findUnique({
        where: { id: result.invalidationId },
      }),
    ).toMatchObject({
      ...fixture.decision,
      outcome: "points_reversed",
      cleanupId: null,
    });
  });

  it("rejects foreign claims, stale installations and unsupported invalidity reasons", async () => {
    const fixture = await pointsFixture();
    const foreign = await pointsFixture();
    const { invalidateReviewIncentive } = await import(
      "../../lib/weletic/reviews/incentive-invalidation"
    );
    const params = {
      storeId: fixture.storeId,
      claimId: fixture.claim.id,
      expectedInstallationGeneration: "g1",
      decision: invalidationDecision(),
    };
    await expect(
      invalidateReviewIncentive({ ...params, claimId: foreign.claim.id }),
    ).rejects.toThrow();
    await expect(
      invalidateReviewIncentive({
        ...params,
        expectedInstallationGeneration: "g2",
      }),
    ).rejects.toThrow();
    expect(() =>
      invalidateReviewIncentive({
        ...params,
        decision: { ...params.decision, reason: "low_rating" } as never,
      }),
    ).toThrow();
    expect(
      await database.weleticReviewIncentiveInvalidation.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  async function runInvalidatedCouponCleanup(
    fixture: Awaited<ReturnType<typeof couponFixture>>,
  ) {
    const job = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId: fixture.storeId, jobType: "VOUCHER_PRIVACY_CLEANUP" },
    });
    const { executeOutboxJob } = await import(
      "../../lib/weletic/loyalty/outbox-worker"
    );
    return executeOutboxJob(job);
  }

  it("cancels an unattempted direct coupon through the existing durable cleanup job", async () => {
    const fixture = await couponFixture();
    const result = await invalidateClaim(fixture);
    expect(result.outcome).toBe("pending");
    couponTransport.lookup.mockResolvedValue(null);
    await runInvalidatedCouponCleanup(fixture);
    expect(
      await database.weleticReviewIncentiveInvalidation.findUnique({
        where: { id: result.invalidationId },
      }),
    ).toMatchObject({
      outcome: "coupon_absent",
      cleanupId: expect.any(String),
      completedAt: expect.any(Date),
    });
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "cancelled" });
    await expect(fixture.provision()).rejects.toThrow("not eligible");
    expect(couponTransport.create).not.toHaveBeenCalled();
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("deactivates a used review coupon and preserves the benefit without shopper debt", async () => {
    const fixture = await couponSettlementFixture();
    await fixture.settle();
    const decision = invalidationDecision();
    const result = await invalidateClaim(fixture, decision);
    couponTransport.lookup.mockResolvedValue({
      ...fixture.remote,
      asyncUsageCount: 1,
    });
    await runInvalidatedCouponCleanup(fixture);
    await runInvalidatedCouponCleanup(fixture);
    expect(couponTransport.deactivate).toHaveBeenCalledTimes(1);
    expect(
      await database.weleticReviewIncentiveInvalidation.findUnique({
        where: { id: result.invalidationId },
      }),
    ).toMatchObject({ outcome: "coupon_used" });
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: fixture.review.id },
      }),
    ).toMatchObject({
      rewardStatus: "unrecoverable",
      participationStatus: "invalidated",
      rating: 1,
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(await invalidateClaim(fixture, decision)).toMatchObject({
      status: "already_recorded",
    });
  });

  it.each(["EXPIRED", "ACTIVE"])(
    "reconciles unused coupons and re-deactivates reactivated artifacts (%s)",
    async (remoteStatus) => {
      const fixture = await couponSettlementFixture();
      const result = await invalidateClaim(fixture);
      couponTransport.lookup.mockResolvedValue(fixture.remote);
      await expect(runInvalidatedCouponCleanup(fixture)).rejects.toThrow(
        "reconciliation",
      );
      const audit =
        await database.weleticReviewIncentiveInvalidation.findUniqueOrThrow({
          where: { id: result.invalidationId },
        });
      expect(audit.outcome).toBe("pending");
      if (!audit.cleanupId) throw new Error("Missing cleanup");
      couponTransport.lookup.mockResolvedValue({
        ...fixture.remote,
        status: remoteStatus,
      });
      await database.weleticShopifyVoucherCleanup.update({
        where: { id: audit.cleanupId },
        data: {
          remoteDeactivatedAt: new Date(Date.now() - 180_000),
          nextRetryAt: new Date(Date.now() - 1000),
        },
      });
      await runInvalidatedCouponCleanup(fixture);
      expect(
        await database.weleticReviewIncentiveInvalidation.findUnique({
          where: { id: result.invalidationId },
        }),
      ).toMatchObject({ outcome: "coupon_deactivated" });
      expect(couponTransport.deactivate).toHaveBeenCalledTimes(
        remoteStatus === "ACTIVE" ? 2 : 1,
      );
    },
  );

  it("exports only the owned invalidity decision without staff identity or worker leases", async () => {
    const fixture = await couponFixture();
    const result = await invalidateClaim(fixture);
    const { getShopperDataExport } = await import(
      "../../lib/weletic/loyalty/shopper-privacy"
    );
    const exported = await getShopperDataExport({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    expect(exported?.reviewIncentiveInvalidations).toHaveLength(1);
    expect(exported?.reviewIncentiveInvalidations[0]).toMatchObject({
      id: result.invalidationId,
      claimId: fixture.claim.id,
      outcome: "pending",
    });
    expect(exported?.reviewIncentiveInvalidations[0]).not.toHaveProperty(
      "actorUserId",
    );
    expect(exported?.reviewIncentiveInvalidations[0]).not.toHaveProperty(
      "cleanupId",
    );
    const foreign = await couponFixture();
    const foreignExport = await getShopperDataExport({
      storeId: foreign.storeId,
      shopifyCustomerId: "1234",
    });
    expect(foreignExport?.reviewIncentiveInvalidations).toEqual([]);
  });

  it("rejects mismatched decision policy evidence before completing coupon recovery", async () => {
    const fixture = await couponFixture();
    const result = await invalidateClaim(fixture);
    const audit =
      await database.weleticReviewIncentiveInvalidation.findUniqueOrThrow({
        where: { id: result.invalidationId },
      });
    const { reviewInvalidationSnapshotSchema } = await import(
      "../../lib/weletic/reviews/incentive-decision"
    );
    const snapshot = reviewInvalidationSnapshotSchema.parse(
      audit.decisionSnapshot,
    );
    await database.weleticReviewIncentiveInvalidation.update({
      where: { id: audit.id },
      data: {
        decisionSnapshot: { ...snapshot, sourceReviewId: "wrong_review" },
      },
    });
    couponTransport.lookup.mockResolvedValue(null);
    await expect(runInvalidatedCouponCleanup(fixture)).rejects.toThrow(
      "requires reconciliation",
    );
    expect(
      await database.weleticReviewIncentiveInvalidation.findUnique({
        where: { id: audit.id },
      }),
    ).toMatchObject({ outcome: "pending", completedAt: null });
    const { readInvalidatedReviewCouponCost } = await import(
      "../../lib/weletic/reviews/incentive-invalidation-cost"
    );
    expect(
      await readInvalidatedReviewCouponCost({
        storeId: fixture.storeId,
        invalidationId: audit.id,
        accountingCurrency: "JPY",
      }),
    ).toMatchObject({
      unrecoverableMinor: null,
      reason: "claim_ownership_unavailable",
    });
  });

  it("never reports zero from a forged absence or invalid provider usage count", async () => {
    const fixture = await couponFixture();
    const result = await invalidateClaim(fixture);
    couponTransport.lookup.mockResolvedValue(null);
    await runInvalidatedCouponCleanup(fixture);
    const audit =
      await database.weleticReviewIncentiveInvalidation.findUniqueOrThrow({
        where: { id: result.invalidationId },
      });
    if (!audit.cleanupId) throw new Error("Missing cleanup");
    const { readInvalidatedReviewCouponCost } = await import(
      "../../lib/weletic/reviews/incentive-invalidation-cost"
    );
    const params = {
      storeId: fixture.storeId,
      invalidationId: audit.id,
      accountingCurrency: "JPY",
    };
    expect(await readInvalidatedReviewCouponCost(params)).toMatchObject({
      dataQuality: "available",
      unrecoverableMinor: "0",
    });
    await database.weleticShopifyVoucherCleanup.update({
      where: { id: audit.cleanupId },
      data: { remoteUsageCount: -1 },
    });
    expect(await readInvalidatedReviewCouponCost(params)).toMatchObject({
      unrecoverableMinor: null,
      reason: "provider_evidence_unavailable",
    });
    await database.weleticShopifyVoucherCleanup.update({
      where: { id: audit.cleanupId },
      data: {
        remoteUsageCount: null,
        expectedDiscountId: "gid://shopify/DiscountCodeNode/7654",
      },
    });
    expect(await readInvalidatedReviewCouponCost(params)).toMatchObject({
      unrecoverableMinor: null,
      reason: "provider_evidence_unavailable",
    });
  });

  it("rejects replay after the exact reversal ledger evidence is damaged", async () => {
    const fixture = await reversalFixture();
    await invalidateClaim(fixture, fixture.decision);
    await database.weleticPointsLedgerEntry.deleteMany({
      where: {
        storeId: fixture.storeId,
        referenceType: "REVIEW_INCENTIVE_REVERSAL",
        referenceId: fixture.claim.id,
      },
    });
    await expect(invalidateClaim(fixture, fixture.decision)).rejects.toThrow(
      "ledger evidence is missing",
    );
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it("reports exact observed coupon costs and fails closed on missing or mismatched evidence", async () => {
    const fixture = await couponSettlementFixture();
    await fixture.settle();
    const result = await invalidateClaim(fixture);
    const { readInvalidatedReviewCouponCost } = await import(
      "../../lib/weletic/reviews/incentive-invalidation-cost"
    );
    const params = {
      storeId: fixture.storeId,
      invalidationId: result.invalidationId,
      accountingCurrency: "JPY",
    };
    expect(await readInvalidatedReviewCouponCost(params)).toMatchObject({
      observedMinor: "100",
      unrecoverableMinor: null,
      reason: "recovery_pending",
    });
    couponTransport.lookup.mockResolvedValue({
      ...fixture.remote,
      asyncUsageCount: 1,
    });
    await runInvalidatedCouponCleanup(fixture);
    expect(await readInvalidatedReviewCouponCost(params)).toMatchObject({
      dataQuality: "available",
      unrecoverableMinor: "100",
      recordedUses: 1,
    });
    expect(
      await readInvalidatedReviewCouponCost({
        ...params,
        accountingCurrency: "USD",
      }),
    ).toMatchObject({
      unrecoverableMinor: null,
      reason: "accounting_currency_mismatch",
    });
    await database.weleticRewardCouponUse.updateMany({
      where: { storeId: fixture.storeId },
      data: { discountAmountMinor: BigInt("9007199254740993") },
    });
    expect(await readInvalidatedReviewCouponCost(params)).toMatchObject({
      unrecoverableMinor: "9007199254740993",
    });
    await database.weleticRewardCouponUse.updateMany({
      where: { storeId: fixture.storeId },
      data: {
        discountAmountMinor: null,
        amountUnavailableReason: "missing_coupon_allocations",
      },
    });
    expect(await readInvalidatedReviewCouponCost(params)).toMatchObject({
      unrecoverableMinor: null,
      reason: "allocation_unavailable",
    });
  });

  it.each([false, true])(
    "advances late use after completed recovery without restoring erased review content (redacted=%s)",
    async (redacted) => {
      const fixture = await couponSettlementFixture();
      const result = await invalidateClaim(fixture);
      couponTransport.lookup.mockResolvedValue(fixture.remote);
      await expect(runInvalidatedCouponCleanup(fixture)).rejects.toThrow(
        "reconciliation",
      );
      const audit =
        await database.weleticReviewIncentiveInvalidation.findUniqueOrThrow({
          where: { id: result.invalidationId },
        });
      if (!audit.cleanupId) throw new Error("Missing cleanup");
      await database.weleticShopifyVoucherCleanup.update({
        where: { id: audit.cleanupId },
        data: {
          remoteDeactivatedAt: new Date(Date.now() - 180_000),
          nextRetryAt: new Date(Date.now() - 1000),
        },
      });
      couponTransport.lookup.mockResolvedValue({
        ...fixture.remote,
        status: "EXPIRED",
      });
      await runInvalidatedCouponCleanup(fixture);
      if (redacted) {
        const { redactNativeReviewsBatch } = await import(
          "../../lib/weletic/reviews/privacy"
        );
        await redactNativeReviewsBatch(fixture.storeId, fixture.shopperId);
      }
      const beforeReview =
        await database.weleticProductReview.findUniqueOrThrow({
          where: { id: fixture.review.id },
        });
      await fixture.settle();
      const afterReview = await database.weleticProductReview.findUniqueOrThrow(
        { where: { id: fixture.review.id } },
      );
      expect(
        await database.weleticReviewIncentiveInvalidation.findUnique({
          where: { id: result.invalidationId },
        }),
      ).toMatchObject({
        outcome: "coupon_used",
        decisionSnapshot: audit.decisionSnapshot,
      });
      if (redacted) expect(afterReview).toEqual(beforeReview);
      else expect(afterReview.rewardStatus).toBe("unrecoverable");
      expect(couponTransport.deactivate).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses review-invalidity cleanup without a confirmed decision", async () => {
    const fixture = await couponFixture();
    const { enqueueVoucherPrivacyCleanup } = await import(
      "../../lib/weletic/loyalty/voucher-privacy-cleanup"
    );
    await expect(
      enqueueVoucherPrivacyCleanup({
        redemption: fixture.redemption,
        source: "review_invalidation",
      }),
    ).rejects.toThrow("Confirmed coupon invalidation is unavailable");
    expect(
      await database.weleticShopifyVoucherCleanup.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  async function couponFixture(multiUse = false) {
    couponTransport.credentials.mockReset().mockResolvedValue({
      shopDomain: "synthetic.myshopify.com",
      accessToken: "synthetic-token",
      source: "app_session",
    });
    couponTransport.lookup.mockReset();
    couponTransport.create.mockReset();
    couponTransport.deactivate.mockReset().mockResolvedValue(true);
    const fixture = await incentiveFixture(true, "100", multiUse);
    const review = await fixture.addReview();
    const result = await fixture.reserve(review.id);
    if (!result.claim) throw new Error("Expected coupon claim");
    const redemption = await database.weleticRewardRedemption.findFirstOrThrow({
      where: {
        storeId: fixture.storeId,
        fulfillmentReference: result.claim.id,
      },
    });
    const { readLoyaltyRedemptionProvisioningSnapshot } = await import(
      "../../lib/weletic/loyalty/redemption-provisioning-snapshot"
    );
    const { getPersistedLoyaltyDiscountProvisioningIdentity } = await import(
      "../../lib/weletic/loyalty/redemption-discount-identity"
    );
    const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
      redemption.metadata,
    );
    const ownership = getPersistedLoyaltyDiscountProvisioningIdentity({
      identity: {
        storeId: fixture.storeId,
        redemptionId: redemption.id,
        ownerKind: "shopper",
        shopperId: fixture.shopperId,
        fulfillmentSource: "review_incentive_v1",
        fulfillmentReference: result.claim.id,
        rewardDefinitionId: redemption.rewardDefinitionId,
        discountCode: redemption.shopifyDiscountCode,
      },
      metadata: redemption.metadata,
    });
    if (!snapshot || !ownership)
      throw new Error("Expected immutable provisioning evidence");
    const remote: import("@/lib/weletic/loyalty/shopify-discounts").ShopifyDiscountResult =
      {
        id: "gid://shopify/DiscountCodeNode/7654",
        code: redemption.shopifyDiscountCode,
        title: ownership.expectedTitle,
        status: "ACTIVE",
        asyncUsageCount: 0,
        configuration: {
          kind: "basic",
          startsAt: new Date(
            Math.floor(new Date(snapshot.startsAt).getTime() / 1000) * 1000,
          ).toISOString(),
          endsAt: snapshot.expiresAt
            ? new Date(
                Math.floor(new Date(snapshot.expiresAt).getTime() / 1000) *
                  1000,
              ).toISOString()
            : null,
          usageLimit: multiUse ? 5 : 1,
          appliesOncePerCustomer: !multiUse,
          appliesOnOneTimePurchase: true,
          appliesOnSubscription: false,
          recurringCycleLimit: 1,
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },
          customerSelection: {
            kind: "customers",
            customerIds: ["gid://shopify/Customer/1234"],
          },
          minimumRequirement: null,
          basicValue: {
            kind: "amount",
            amount: "100",
            currencyCode: "JPY",
            appliesOnEachItem: false,
          },
          basicItems: { kind: "all" },
        },
      };
    const provision = async () => {
      const { provisionShopperReviewCoupon } = await import(
        "../../lib/weletic/loyalty/shopper-coupon-worker"
      );
      return provisionShopperReviewCoupon({
        storeId: fixture.storeId,
        payload: {
          redemptionId: redemption.id,
          claimId: result.claim!.id,
          installationGeneration: "g1",
        },
      });
    };
    return {
      ...fixture,
      review,
      claim: result.claim,
      redemption,
      remote,
      provision,
    };
  }

  async function couponSettlementFixture(multiUse = false) {
    const fixture = await couponFixture(multiUse);
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    await fixture.provision();
    const { settleRewardRedemptionsUsedByOrder } = await import(
      "../../lib/weletic/loyalty/redemption-settlement"
    );
    const evidence = (amount = "100") => ({
      discount_applications: [
        { type: "discount_code", code: fixture.redemption.shopifyDiscountCode },
      ],
      line_items: [
        {
          discount_allocations: [
            {
              discount_application_index: 0,
              amount_set: { shop_money: { amount, currency_code: "JPY" } },
            },
          ],
        },
      ],
      shipping_lines: [],
    });
    const params = {
      storeId: fixture.storeId,
      discountCodes: [fixture.redemption.shopifyDiscountCode],
      orderId: "987654",
      shopifyCustomerId: "1234",
      usedAt: new Date("2026-09-01T00:00:00Z"),
      expectedInstallationGeneration: "g1",
      orderDiscountEvidence: evidence(),
      orderMetadata: { email: "must-not-retain@example.invalid" },
    };
    return {
      ...fixture,
      params,
      evidence,
      settle: (overrides: Partial<typeof params> = {}) =>
        settleRewardRedemptionsUsedByOrder({ ...params, ...overrides }),
    };
  }

  it("settles concurrent direct coupon usage once without enrollment or points", async () => {
    const fixture = await couponSettlementFixture();
    const results = await Promise.all([fixture.settle(), fixture.settle()]);
    expect(results.reduce((sum, result) => sum + result.markedUsed, 0)).toBe(1);
    const uses = await database.weleticRewardCouponUse.findMany({
      where: { storeId: fixture.storeId },
    });
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({
      shopperId: fixture.shopperId,
      orderExternalId: "987654",
      discountAmountMinor: BigInt(100),
      currency: "JPY",
      amountUnavailableReason: null,
    });
    const reward = await database.weleticRewardRedemption.findUniqueOrThrow({
      where: { id: fixture.redemption.id },
    });
    expect(reward).toMatchObject({
      status: "used",
      orderId: "987654",
      accountId: null,
      pointsSpent: BigInt(0),
    });
    expect(JSON.stringify(reward.metadata)).not.toContain("must-not-retain");
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(await fixture.settle()).toMatchObject({ markedUsed: 0 });
  });

  it("records multiple permitted order uses and exports exact shopper-owned costs", async () => {
    const fixture = await couponSettlementFixture(true);
    await fixture.settle();
    await Promise.all([
      fixture.settle({ orderId: "987655" }),
      fixture.settle({ orderId: "987656" }),
    ]);
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(3);
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ orderId: "987654", usedAt: fixture.params.usedAt });
    expect(
      await database.weleticReconciliationIssue.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    const { getShopperDataExport } = await import(
      "../../lib/weletic/loyalty/shopper-privacy"
    );
    const exported = await getShopperDataExport({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    expect(exported?.rewardCouponUses).toHaveLength(3);
    expect(
      exported?.rewardCouponUses.every(
        (use) => use.discountAmountMinor === "100",
      ),
    ).toBe(true);
    expect(exported?.exportCompleteness.recordCounts.rewardCouponUses).toBe(3);
  });

  it("retains actual over-limit use as an issue, never as customer points debt", async () => {
    const fixture = await couponSettlementFixture();
    await fixture.settle();
    await fixture.settle({ orderId: "987655" });
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(2);
    expect(
      await database.weleticReconciliationIssue.findFirst({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({
      details: { reason: "shopper_coupon_usage_limit_exceeded" },
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("does not rewrite a recorded use when replayed money evidence conflicts", async () => {
    const fixture = await couponSettlementFixture();
    await fixture.settle();
    await fixture.settle({ orderDiscountEvidence: fixture.evidence("101") });
    expect(
      await database.weleticRewardCouponUse.findFirst({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({ discountAmountMinor: BigInt(100) });
    expect(
      await database.weleticReconciliationIssue.findFirst({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({
      details: { reason: "shopper_coupon_use_evidence_conflict" },
    });
  });

  it("records unavailable cost instead of the coupon face value", async () => {
    const fixture = await couponSettlementFixture();
    await fixture.settle({ orderDiscountEvidence: undefined });
    expect(
      await database.weleticRewardCouponUse.findFirst({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({
      discountAmountMinor: null,
      currency: null,
      amountUnavailableReason: "missing_discount_applications",
    });
  });

  it("refuses mismatched customer, invalid order and earlier-installation settlement", async () => {
    const fixture = await couponSettlementFixture();
    await fixture.settle({ shopifyCustomerId: "5678" });
    await fixture.settle({ orderId: "unknown" });
    await expect(
      fixture.settle({ expectedInstallationGeneration: "g0" }),
    ).rejects.toThrow();
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "issued" });
  });

  it("refuses local reservation alone as proof of remotely issued coupon ownership", async () => {
    const fixture = await couponSettlementFixture();
    await database.weleticRewardRedemption.update({
      where: { id: fixture.redemption.id },
      data: {
        status: "provisioning",
        shopifyDiscountId: null,
      },
    });
    await fixture.settle();
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("settles a late order after verified privacy deactivation without recovering erased metadata", async () => {
    const fixture = await couponSettlementFixture();
    const { run } = await cleanupCoupon(fixture);
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    expect(await run()).toBe("deactivated");
    await fixture.settle();
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({
      status: "used",
      metadata: { privacySafeCancellation: true },
    });
  });

  it("settles pseudonymous late use on a frozen store without restoring erased customer context", async () => {
    const fixture = await couponSettlementFixture();
    const { anonymizeWeleticShopper } = await import(
      "../../lib/weletic/loyalty/shopper-privacy"
    );
    await anonymizeWeleticShopper({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    const { run } = await cleanupCoupon(fixture);
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    expect(await run()).toBe("deactivated");
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { complianceState: "frozen" },
    });
    await fixture.settle();
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticShopper.findUnique({
        where: { id: fixture.shopperId },
      }),
    ).not.toMatchObject({ shopifyCustomerId: "1234" });
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({ status: "privacy_redacted" });
    await fixture.settle({ orderId: "987655", shopifyCustomerId: "5678" });
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it.each(["shopper", "policy", "points"])(
    "rejects damaged direct coupon %s ownership",
    async (field) => {
      const fixture = await couponSettlementFixture();
      const foreign = await incentiveFixture();
      if (field === "policy") {
        await database.weleticReviewIncentiveClaim.update({
          where: { id: fixture.claim.id },
          data: { policyId: foreign.policy.id },
        });
      } else {
        await database.weleticRewardRedemption.update({
          where: { id: fixture.redemption.id },
          data:
            field === "shopper"
              ? { shopperId: foreign.shopperId }
              : { pointsSpent: BigInt(1) },
        });
      }
      await fixture.settle();
      expect(
        await database.weleticRewardCouponUse.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    },
  );

  it("rolls back the usage fact and redemption projection together", async () => {
    const fixture = await couponSettlementFixture();
    const { settleShopperCouponUse } = await import(
      "../../lib/weletic/loyalty/shopper-coupon-settlement"
    );
    await expect(
      database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${fixture.storeId} FOR UPDATE`;
        const redemption = await tx.weleticRewardRedemption.findUniqueOrThrow({
          where: { id: fixture.redemption.id },
        });
        expect(
          await settleShopperCouponUse({
            tx,
            redemption,
            installationGeneration: "g1",
            orderId: fixture.params.orderId,
            shopifyCustomerId: "1234",
            usedAt: fixture.params.usedAt,
            orderDiscountEvidence: fixture.evidence(),
          }),
        ).toMatchObject({ marked: true });
        throw new Error("synthetic coupon settlement rollback");
      }),
    ).rejects.toThrow("synthetic coupon settlement rollback");
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "issued", orderId: null, usedAt: null });
  });

  it("rejects cleanup proof with a missing verified remote discount identity", async () => {
    const fixture = await couponSettlementFixture();
    const { cleanup, run } = await cleanupCoupon(fixture);
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    expect(await run()).toBe("deactivated");
    await database.weleticRewardRedemption.update({
      where: { id: fixture.redemption.id },
      data: {
        status: "provisioning",
        shopifyDiscountId: null,
      },
    });
    await database.weleticShopifyVoucherCleanup.update({
      where: { id: cleanup.id },
      data: { expectedDiscountId: null },
    });
    await fixture.settle();
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "provisioning" });
  });

  it("does not retain arbitrary order names in direct settlement reconciliation", async () => {
    const fixture = await couponSettlementFixture();
    await fixture.settle({ orderId: "customer@example.invalid" });
    const issues = await database.weleticReconciliationIssue.findMany({
      where: { storeId: fixture.storeId },
    });
    expect(issues).toHaveLength(1);
    expect(JSON.stringify(issues)).not.toContain("customer@example.invalid");
    expect(issues[0].externalKey).toMatch(/^unverified:/);
  });

  it("rejects embedded and wrong-resource Shopify IDs before financial settlement", async () => {
    const fixture = await couponSettlementFixture();
    for (const orderId of [
      "12gid://shopify/Order/34",
      "gid://shopify/Customer/1234",
    ]) {
      await fixture.settle({ orderId });
    }
    for (const shopifyCustomerId of [
      "12gid://shopify/Customer/34",
      "gid://shopify/Order/1234",
    ]) {
      await fixture.settle({ shopifyCustomerId });
    }
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    await fixture.settle({
      orderId: "gid://shopify/Order/987654",
      shopifyCustomerId: "gid://shopify/Customer/1234",
    });
    expect(
      await database.weleticRewardCouponUse.findFirst({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({ orderExternalId: "987654" });
  });

  async function retentionFixture() {
    const fixture = await couponSettlementFixture(true);
    await fixture.settle();
    await fixture.settle({ orderId: "987655" });
    await fixture.settle({ orderId: "987656" });
    const { cleanup, run } = await cleanupCoupon(fixture);
    couponTransport.lookup.mockResolvedValue({
      ...fixture.remote,
      asyncUsageCount: 3,
    });
    expect(await run()).toBe("used_preserved");
    const now = new Date();
    const expiresAt = new Date(now.getTime() - 1000);
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: {
        complianceState: "redacted",
        redactedAt: new Date(now.getTime() - 2000),
        financialRetentionUntil: expiresAt,
      },
    });
    const { purgeExpiredShopperCouponUsesPage } = await import(
      "../../lib/weletic/loyalty/coupon-use-retention"
    );
    return {
      ...fixture,
      cleanup,
      now,
      expiresAt,
      purge: (batchSize = 1) =>
        purgeExpiredShopperCouponUsesPage({
          storeId: fixture.storeId,
          batchSize,
          now,
        }),
    };
  }

  it("quarantines malformed retention progress so a later eligible store is not starved", async () => {
    const bad = await retentionFixture();
    const missingGeneration = await retentionFixture();
    const good = await retentionFixture();
    await database.weleticShopifyStore.update({
      where: { id: bad.storeId },
      data: {
        financialRetentionUntil: new Date(good.now.getTime() - 10_000),
      },
    });
    await database.weleticShopifyStore.update({
      where: { id: missingGeneration.storeId },
      data: {
        installationGeneration: null,
        financialRetentionUntil: new Date(good.now.getTime() - 20_000),
      },
    });
    await database.weleticReconciliationIssue.create({
      data: {
        id: `retention-bad-${randomUUID()}`,
        storeId: bad.storeId,
        kind: "coupon_use_retention",
        externalKey: "shop_financial_retention_v1",
        severity: "critical",
        status: "open",
        details: { malformed: "retained-for-review" },
      },
    });
    const { deleteExpiredShopperCouponUsesBatch } = await import(
      "../../lib/weletic/loyalty/coupon-use-retention"
    );
    expect(
      await deleteExpiredShopperCouponUsesBatch({
        batchSize: 1,
        now: good.now,
      }),
    ).toMatchObject({
      selectedStores: 1,
      deleted: 0,
      results: [{ storeId: bad.storeId, status: "failed" }],
    });
    expect(
      await deleteExpiredShopperCouponUsesBatch({
        batchSize: 1,
        now: good.now,
      }),
    ).toMatchObject({
      selectedStores: 1,
      deleted: 1,
      results: [{ storeId: good.storeId, status: "pending" }],
    });
    expect(
      await database.weleticReconciliationIssue.findFirst({
        where: { storeId: bad.storeId, kind: "coupon_use_retention" },
      }),
    ).toMatchObject({ details: { malformed: "retained-for-review" } });
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: missingGeneration.storeId },
      }),
    ).toBe(3);
  });

  it("purges only expired shop financial use facts in resumable bounded pages", async () => {
    const fixture = await retentionFixture();
    const foreign = await couponSettlementFixture();
    await foreign.settle();
    expect(await fixture.purge()).toMatchObject({
      status: "pending",
      scanned: 1,
      deleted: 1,
    });
    expect(await fixture.purge()).toMatchObject({
      status: "pending",
      scanned: 1,
      deleted: 1,
    });
    expect(await fixture.purge()).toMatchObject({
      status: "completed",
      scanned: 1,
      deleted: 1,
    });
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: foreign.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "used", pointsSpent: BigInt(0) });
    await fixture.settle();
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(await fixture.purge()).toMatchObject({
      status: "completed",
      scanned: 0,
    });
    expect(
      await database.weleticReconciliationIssue.findFirst({
        where: { storeId: fixture.storeId, kind: "coupon_use_retention" },
      }),
    ).toMatchObject({ details: { deletedCount: 3 } });
  });

  it("does not purge before the saved deadline or when a shop is reactivated", async () => {
    const fixture = await retentionFixture();
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: {
        financialRetentionUntil: new Date(fixture.now.getTime() + 60_000),
      },
    });
    expect(await fixture.purge()).toMatchObject({
      status: "not_due",
      deleted: 0,
    });
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: {
        financialRetentionUntil: fixture.expiresAt,
        complianceState: "active",
      },
    });
    expect(await fixture.purge()).toMatchObject({
      status: "not_due",
      deleted: 0,
    });
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(3);
  });

  it("advances past blocked facts and requires explicit resolution before retrying them", async () => {
    const fixture = await retentionFixture();
    const first = await database.weleticRewardCouponUse.findFirstOrThrow({
      where: { storeId: fixture.storeId },
      orderBy: { id: "asc" },
    });
    await database.weleticRewardCouponUse.update({
      where: { id: first.id },
      data: { source: "damaged_fixture" },
    });
    expect(await fixture.purge()).toMatchObject({
      status: "pending",
      deleted: 0,
      blocked: 1,
    });
    expect(await fixture.purge()).toMatchObject({
      status: "pending",
      deleted: 1,
      blocked: 0,
    });
    expect(await fixture.purge()).toMatchObject({
      status: "manual_reconciliation",
      deleted: 1,
    });
    expect(await fixture.purge()).toMatchObject({
      status: "manual_reconciliation",
      scanned: 0,
    });
    await database.weleticRewardCouponUse.update({
      where: { id: first.id },
      data: { source: "shopify_orders_paid" },
    });
    await database.weleticReconciliationIssue.updateMany({
      where: { storeId: fixture.storeId, kind: "coupon_use_retention" },
      data: { status: "resolved" },
    });
    expect(await fixture.purge()).toMatchObject({
      status: "completed",
      deleted: 1,
    });
    expect(
      await database.weleticReconciliationIssue.findFirst({
        where: { storeId: fixture.storeId, kind: "coupon_use_retention" },
      }),
    ).toMatchObject({ details: { deletedCount: 3 } });
  });

  it("retains records with incomplete provider cleanup and reports them", async () => {
    const fixture = await retentionFixture();
    await database.weleticShopifyVoucherCleanup.update({
      where: { id: fixture.cleanup.id },
      data: { remoteDeactivatedAt: null },
    });
    expect(await fixture.purge(100)).toMatchObject({
      status: "manual_reconciliation",
      scanned: 3,
      deleted: 0,
      blocked: 3,
    });
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(3);
  });

  it("serializes concurrent retention workers and rejects changed generation progress", async () => {
    const fixture = await retentionFixture();
    const results = await Promise.all([fixture.purge(), fixture.purge()]);
    expect(results.reduce((sum, result) => sum + result.deleted, 0)).toBe(2);
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { installationGeneration: "g2" },
    });
    await expect(fixture.purge()).rejects.toThrow("scope changed");
    expect(
      await database.weleticRewardCouponUse.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it("exports only the shopper's incentive promises and claims without invitation authority", async () => {
    const fixture = await couponFixture();
    const foreign = await incentiveFixture();
    await foreign.reserve((await foreign.addReview()).id);
    const { getShopperDataExport } = await import(
      "../../lib/weletic/loyalty/shopper-privacy"
    );
    const exported = await getShopperDataExport({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    expect(exported?.reviewIncentiveClaims).toHaveLength(1);
    expect(exported?.reviewIncentiveClaims[0]).toMatchObject({
      id: fixture.claim.id,
      policy: { id: fixture.policy.id, revision: fixture.policy.revision },
      validationSnapshot: { revision: "purchase_abuse_v1" },
    });
    expect(exported?.reviewRequests[0].incentivePolicy?.id).toBe(
      fixture.policy.id,
    );
    expect(exported?.nativeReviews[0].participationStatus).toBe("validated");
    const serialized = JSON.stringify(exported, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    expect(serialized).not.toContain(foreign.policy.id);
    expect(serialized).not.toContain("tokenHash");
    expect(serialized).not.toContain("encryptedDeliveryToken");
  });

  it("retains owned claims with damaged policy references without leaking another store's promise", async () => {
    const fixture = await incentiveFixture();
    const foreign = await incentiveFixture();
    const claim = (await fixture.reserve((await fixture.addReview()).id))
      .claim!;
    // Deliberately malformed synthetic history under relationMode=prisma.
    await database.weleticReviewIncentiveClaim.update({
      where: { id: claim.id },
      data: { policyId: foreign.policy.id },
    });
    const { getShopperDataExport } = await import(
      "../../lib/weletic/loyalty/shopper-privacy"
    );
    const exported = await getShopperDataExport({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    expect(exported?.reviewIncentiveClaims).toHaveLength(1);
    expect(exported?.reviewIncentiveClaims[0]).toMatchObject({
      id: claim.id,
      policy: null,
      policyUnavailableReason: "same_store_policy_not_found",
    });
  });

  it("redacts participation and stops pending coupon jobs while preserving the unique financial marker", async () => {
    const fixture = await couponFixture();
    const foreign = await incentiveFixture();
    const foreignClaim = (await foreign.reserve((await foreign.addReview()).id))
      .claim!;
    const { redactNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    expect(
      await redactNativeReviewsBatch(fixture.storeId, fixture.shopperId),
    ).toEqual({ hasMore: false });
    const claim = await database.weleticReviewIncentiveClaim.findUniqueOrThrow({
      where: { id: fixture.claim.id },
    });
    expect(claim).toMatchObject({
      status: "privacy_redacted",
      awardSnapshot: fixture.claim.awardSnapshot,
      validationSnapshot: { redacted: true },
    });
    expect(claim.validationSnapshot).not.toHaveProperty("contentDigest");
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: fixture.review.id },
      }),
    ).toMatchObject({
      status: "redacted",
      body: "",
      participationStatus: "privacy_redacted",
      participationContentDigest: null,
      participationValidatedAt: null,
    });
    expect(
      await database.weleticLoyaltyOutboxJob.findFirst({
        where: {
          storeId: fixture.storeId,
          jobType: "SHOPPER_REWARD_PROVISION",
        },
      }),
    ).toMatchObject({ status: "cancelled", lockedBy: null });
    await expect(fixture.provision()).rejects.toThrow("eligible");
    expect(couponTransport.create).not.toHaveBeenCalled();
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: foreignClaim.id },
      }),
    ).toMatchObject({ status: "reserved" });
    expect(
      await redactNativeReviewsBatch(fixture.storeId, fixture.shopperId),
    ).toEqual({ hasMore: false });
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it("redacts orphaned claim evidence in resumable bounded pages without deleting order markers", async () => {
    const fixture = await incentiveFixture();
    for (let index = 0; index < 21; index++) {
      const orderId = await order(fixture, "paid");
      await database.weleticReviewIncentiveClaim.create({
        data: {
          id: `orphan-claim-${randomUUID()}`,
          storeId: fixture.storeId,
          shopperId: fixture.shopperId,
          orderId,
          policyId: fixture.policy.id,
          subjectType: "product",
          sourceReviewId: `missing-review-${index}`,
          awardSnapshot: { kind: "points", points: "100" },
          validationSnapshot: { contentDigest: "legacy-private-evidence" },
        },
      });
    }
    const { redactNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    expect(
      await redactNativeReviewsBatch(fixture.storeId, fixture.shopperId),
    ).toEqual({ hasMore: true });
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId, status: "privacy_redacted" },
      }),
    ).toBe(20);
    expect(
      await redactNativeReviewsBatch(fixture.storeId, fixture.shopperId),
    ).toEqual({ hasMore: false });
    const claims = await database.weleticReviewIncentiveClaim.findMany({
      where: { storeId: fixture.storeId },
    });
    expect(claims).toHaveLength(21);
    expect(
      claims.every(
        (claim) =>
          claim.status === "privacy_redacted" &&
          !JSON.stringify(claim.validationSnapshot).includes(
            "legacy-private-evidence",
          ),
      ),
    ).toBe(true);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("purges frozen-store incentive policies and claims in bounded pages without touching another store", async () => {
    const fixture = await incentiveFixture();
    const foreign = await incentiveFixture();
    await fixture.reserve((await fixture.addReview()).id);
    const { createReviewIncentivePolicyRevision } = await import(
      "../../lib/weletic/reviews/incentive-policy"
    );
    for (let index = 0; index < 21; index++)
      await createReviewIncentivePolicyRevision(fixture.storeId, {
        kind: "none",
      });
    const { purgeNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    await expect(purgeNativeReviewsBatch(fixture.storeId)).rejects.toThrow(
      "frozen",
    );
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { complianceState: "frozen" },
    });
    expect(await purgeNativeReviewsBatch(fixture.storeId)).toEqual({
      hasMore: true,
    });
    expect(await purgeNativeReviewsBatch(fixture.storeId)).toEqual({
      hasMore: false,
    });
    expect(
      await database.weleticReviewIncentivePolicy.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticReviewIncentivePolicy.count({
        where: { storeId: foreign.storeId },
      }),
    ).toBe(1);
  });

  it("refuses to purge pending coupon evidence even when a store is frozen", async () => {
    const fixture = await couponFixture();
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { complianceState: "frozen" },
    });
    const { purgeNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    await expect(purgeNativeReviewsBatch(fixture.storeId)).rejects.toThrow(
      "voucher cleanup must finish",
    );
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticProductReview.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it.each([false, true])(
    "finishes frozen-shop review purge while retaining invalidation financial evidence (coupon=%s)",
    async (coupon) => {
      const fixture = coupon ? await couponFixture() : await reversalFixture();
      const result = await invalidateClaim(fixture);
      const audit =
        await database.weleticReviewIncentiveInvalidation.findUniqueOrThrow({
          where: { id: result.invalidationId },
        });
      const foreign = await couponFixture();
      const foreignReview =
        await database.weleticProductReview.findUniqueOrThrow({
          where: { id: foreign.review.id },
        });
      await database.weleticShopifyStore.update({
        where: { id: fixture.storeId },
        data: { complianceState: "frozen" },
      });
      const { purgeNativeReviewsBatch } = await import(
        "../../lib/weletic/reviews/privacy"
      );
      expect(await purgeNativeReviewsBatch(fixture.storeId)).toEqual({
        hasMore: false,
      });
      expect(await purgeNativeReviewsBatch(fixture.storeId)).toEqual({
        hasMore: false,
      });
      expect(
        await database.weleticReviewRequest.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticProductReview.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticReviewIncentiveInvalidation.findUnique({
          where: { id: audit.id },
        }),
      ).toEqual(audit);
      expect(
        await database.weleticReviewIncentiveClaim.findUnique({
          where: { id: fixture.claim.id },
        }),
      ).toMatchObject({
        status: "privacy_redacted",
        validationSnapshot: { redacted: true },
      });
      expect(
        await database.weleticReviewIncentivePolicy.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(1);
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(coupon ? 0 : 2);
      expect(
        await database.weleticProductReview.findUnique({
          where: { id: foreign.review.id },
        }),
      ).toEqual(foreignReview);
    },
  );

  it("requires both a verified cleanup outcome and terminal local coupon state before purging claims", async () => {
    const fixture = await couponFixture();
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { complianceState: "frozen" },
    });
    const cleanup = await database.weleticShopifyVoucherCleanup.create({
      data: {
        id: `privacy-cleanup-${randomUUID()}`,
        storeId: fixture.storeId,
        redemptionId: fixture.redemption.id,
        source: "shop_redact",
        status: "completed",
        expectedDiscountCode: fixture.redemption.shopifyDiscountCode,
        expectedDiscountCodeCanonical: fixture.redemption.shopifyDiscountCode,
      },
    });
    const { purgeNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    await expect(purgeNativeReviewsBatch(fixture.storeId)).rejects.toThrow(
      "voucher cleanup must finish",
    );
    await database.weleticShopifyVoucherCleanup.update({
      where: { id: cleanup.id },
      data: { remoteOutcome: "verified_absent" },
    });
    await expect(purgeNativeReviewsBatch(fixture.storeId)).rejects.toThrow(
      "voucher cleanup must finish",
    );
    // Controlled completed-cleanup fixture, not proof of a Shopify deactivation.
    await database.weleticRewardRedemption.update({
      where: { id: fixture.redemption.id },
      data: { status: "cancelled" },
    });
    expect(await purgeNativeReviewsBatch(fixture.storeId)).toEqual({
      hasMore: false,
    });
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("atomically reserves one zero-point coupon and outbox job from competing review claims", async () => {
    const fixture = await incentiveFixture(true);
    const first = await fixture.addReview();
    const second = await fixture.addReview();
    const results = await Promise.all([
      fixture.reserve(first.id),
      fixture.reserve(second.id),
    ]);
    expect(results.filter((item) => item.created)).toHaveLength(1);
    expect(
      await database.weleticRewardRedemption.findMany({
        where: { storeId: fixture.storeId },
        select: {
          accountId: true,
          shopperId: true,
          pointsSpent: true,
          ledgerEntryId: true,
          status: true,
        },
      }),
    ).toEqual([
      {
        accountId: null,
        shopperId: fixture.shopperId,
        pointsSpent: BigInt(0),
        ledgerEntryId: null,
        status: "provisioning",
      },
    ]);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: {
          storeId: fixture.storeId,
          jobType: "SHOPPER_REWARD_PROVISION",
        },
      }),
    ).toBe(1);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("rolls back the claim when its coupon cannot be reserved", async () => {
    const fixture = await incentiveFixture(true);
    const review = await fixture.addReview();
    await database.weleticRewardDefinition.deleteMany({
      where: { storeId: fixture.storeId },
    });
    await expect(fixture.reserve(review.id)).rejects.toThrow(
      "catalog record is unavailable",
    );
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  async function cleanupCoupon(
    fixture: Awaited<ReturnType<typeof couponFixture>>,
    source:
      | "customer_redact"
      | "app_uninstalled"
      | "shop_redact" = "customer_redact",
  ) {
    const { enqueueVoucherPrivacyCleanup, handleVoucherPrivacyCleanup } =
      await import("../../lib/weletic/loyalty/voucher-privacy-cleanup");
    const cleanup = await enqueueVoucherPrivacyCleanup({
      redemption: fixture.redemption,
      source,
    });
    if (!cleanup) throw new Error("Expected durable cleanup");
    return {
      cleanup,
      run: () =>
        handleVoucherPrivacyCleanup({
          storeId: fixture.storeId,
          cleanupId: cleanup.id,
          redemptionId: fixture.redemption.id,
          ownerKind: "shopper",
          shopperId: fixture.shopperId,
          outboxJobId: `cleanup-test-${randomUUID()}`,
        }),
    };
  }

  it("enumerates shopper-only coupons and dispatches exact cleanup without points compensation", async () => {
    const fixture = await couponFixture();
    const foreign = await couponFixture();
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    const { enqueueVoucherPrivacyCleanupsForAccountPage } = await import(
      "../../lib/weletic/loyalty/voucher-privacy-cleanup"
    );
    const page = await enqueueVoucherPrivacyCleanupsForAccountPage({
      storeId: fixture.storeId,
      shopperId: fixture.shopperId,
    });
    expect(page.scanned).toBe(1);
    const job = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId: fixture.storeId, jobType: "VOUCHER_PRIVACY_CLEANUP" },
    });
    expect(job.payload).toEqual({
      cleanupId: expect.any(String),
      redemptionId: fixture.redemption.id,
      ownerKind: "shopper",
      shopperId: fixture.shopperId,
    });
    const { executeOutboxJob } = await import(
      "../../lib/weletic/loyalty/outbox-worker"
    );
    await executeOutboxJob(job);
    expect(couponTransport.deactivate).toHaveBeenCalledTimes(1);
    const current = await database.weleticRewardRedemption.findUniqueOrThrow({
      where: { id: fixture.redemption.id },
    });
    expect(current).toMatchObject({
      status: "cancelled",
      accountId: null,
      pointsSpent: BigInt(0),
      ledgerEntryId: null,
      metadata: { privacySafeCancellation: true },
    });
    expect(current.metadata).not.toHaveProperty("loyaltyProvisioningSnapshot");
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticShopifyVoucherCleanup.count({
        where: { storeId: foreign.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyOutboxJob.findFirst({
        where: {
          storeId: fixture.storeId,
          jobType: "SHOPPER_REWARD_PROVISION",
        },
      }),
    ).toMatchObject({ status: "cancelled" });
    await expect(fixture.provision()).rejects.toThrow("not eligible");
    await executeOutboxJob(job);
    expect(couponTransport.deactivate).toHaveBeenCalledTimes(1);
  });

  it("captures current ambiguous-create evidence instead of the enumeration copy", async () => {
    const fixture = await couponFixture();
    const { markLoyaltyDiscountRemoteProvisionAttempt } = await import(
      "../../lib/weletic/loyalty/redemption-discount-identity"
    );
    const metadata = markLoyaltyDiscountRemoteProvisionAttempt({
      metadata: fixture.redemption.metadata,
      preparationId: "lost-worker",
    });
    await database.weleticRewardRedemption.update({
      where: { id: fixture.redemption.id },
      data: { metadata },
    });
    const { cleanup, run } = await cleanupCoupon(fixture);
    expect(cleanup.ownershipSnapshot).toMatchObject({
      version: 2,
      kind: "shopper",
      installationGeneration: "g1",
      remoteProvisionAttemptedAt: expect.any(String),
    });
    couponTransport.lookup.mockResolvedValue(null);
    await expect(run()).rejects.toThrow("reconciliation");
    expect(couponTransport.deactivate).not.toHaveBeenCalled();
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "provisioning" });
    expect(
      await database.weleticShopifyVoucherCleanup.findUnique({
        where: { id: cleanup.id },
      }),
    ).toMatchObject({ status: "retrying" });
  });

  it("proves unattempted absence only after durable quarantine prevents a late provision", async () => {
    const fixture = await couponFixture();
    const { run } = await cleanupCoupon(fixture);
    couponTransport.lookup.mockResolvedValue(null);
    expect(await run()).toBe("verified_absent");
    await expect(fixture.provision()).rejects.toThrow("not eligible");
    expect(couponTransport.create).not.toHaveBeenCalled();
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "cancelled" });
  });

  it.each(["issued", "used", "cancelled"] as const)(
    "preserves used shopper benefit from %s without inventing points debt",
    async (status) => {
      const fixture = await couponFixture();
      await database.weleticRewardRedemption.update({
        where: { id: fixture.redemption.id },
        data: { status },
      });
      const { run } = await cleanupCoupon(fixture);
      couponTransport.lookup.mockResolvedValue({
        ...fixture.remote,
        asyncUsageCount: 1,
      });
      expect(await run()).toBe("used_preserved");
      const current = await database.weleticRewardRedemption.findUniqueOrThrow({
        where: { id: fixture.redemption.id },
      });
      expect(current).toMatchObject({
        status: "used",
        accountId: null,
        pointsSpent: BigInt(0),
        ledgerEntryId: null,
        metadata: {
          privacySafeFinancialAudit: true,
          voucherPrivacyCleanup: {
            outcome: "used_preserved",
            remoteUsageCount: 1,
          },
        },
      });
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticReviewIncentiveClaim.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(1);
    },
  );

  it("rejects a stale installation before credentials or remote cleanup", async () => {
    const fixture = await couponFixture();
    const { cleanup, run } = await cleanupCoupon(fixture);
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { installationGeneration: "g2" },
    });
    expect(await run()).toBe("manual_reconciliation");
    expect(couponTransport.credentials).not.toHaveBeenCalled();
    expect(couponTransport.lookup).not.toHaveBeenCalled();
    expect(couponTransport.deactivate).not.toHaveBeenCalled();
    expect(
      await database.weleticShopifyVoucherCleanup.findUnique({
        where: { id: cleanup.id },
      }),
    ).toMatchObject({ status: "dead_letter" });
  });

  it("rechecks generation between remote lookup and deactivation", async () => {
    const fixture = await couponFixture();
    const { run } = await cleanupCoupon(fixture);
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    let rotated = false;
    afterDatabaseTransaction = async () => {
      if (rotated || couponTransport.lookup.mock.calls.length === 0) return;
      rotated = true;
      await database.weleticShopifyStore.update({
        where: { id: fixture.storeId },
        data: { installationGeneration: "g2" },
      });
    };
    try {
      expect(await run()).toBe("manual_reconciliation");
    } finally {
      afterDatabaseTransaction = null;
    }
    expect(couponTransport.lookup).toHaveBeenCalledTimes(1);
    expect(couponTransport.deactivate).not.toHaveBeenCalled();
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "provisioning" });
  });

  it("serializes competing shopper cleanup workers without a Redis mutex", async () => {
    const fixture = await couponFixture();
    const { run } = await cleanupCoupon(fixture);
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    const results = await Promise.allSettled([run(), run()]);
    expect(
      results.some(
        (result) =>
          result.status === "fulfilled" && result.value === "deactivated",
      ),
    ).toBe(true);
    expect(couponTransport.deactivate).toHaveBeenCalledTimes(1);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it.each([
    { pointsSpent: BigInt(1) },
    { fulfillmentSource: "unknown" },
    { shopperId: "foreign-shopper" },
  ])(
    "fails closed before remote cleanup when immutable ownership is damaged: %s",
    async (data) => {
      const fixture = await couponFixture();
      const { run } = await cleanupCoupon(fixture);
      await database.weleticRewardRedemption.update({
        where: { id: fixture.redemption.id },
        data,
      });
      expect(await run()).toBe("manual_reconciliation");
      expect(couponTransport.credentials).not.toHaveBeenCalled();
      expect(couponTransport.deactivate).not.toHaveBeenCalled();
      expect(
        await database.weleticPointsLedgerEntry.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    },
  );

  it("keeps frozen-store cleanup pending through the usage grace and preserves a late used benefit", async () => {
    const fixture = await couponFixture();
    const { cleanup, run } = await cleanupCoupon(fixture, "app_uninstalled");
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { complianceState: "frozen" },
    });
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    await expect(run()).rejects.toThrow("usage reconciliation");
    expect(
      await database.weleticShopifyVoucherCleanup.findUnique({
        where: { id: cleanup.id },
      }),
    ).toMatchObject({ status: "retrying", remoteUsageCount: 0 });
    await database.weleticShopifyVoucherCleanup.update({
      where: { id: cleanup.id },
      data: {
        nextRetryAt: new Date(0),
        remoteDeactivatedAt: new Date(Date.now() - 180_000),
      },
    });
    couponTransport.lookup.mockResolvedValue({
      ...fixture.remote,
      status: "INACTIVE",
      asyncUsageCount: 1,
    });
    expect(await run()).toBe("used_preserved");
    expect(couponTransport.deactivate).toHaveBeenCalledTimes(1);
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({
      status: "used",
      accountId: null,
      pointsSpent: BigInt(0),
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("uses the real integration credential resolver without recursively locking its store", async () => {
    const fixture = await couponFixture();
    const store = await database.weleticShopifyStore.findUniqueOrThrow({
      where: { id: fixture.storeId },
    });
    const { shopifyCredentialVerificationHash } = await import(
      "../../lib/weletic/shopify/store-resolver"
    );
    const token = `synthetic-${randomUUID()}`;
    const id = `cleanup-integration-${randomUUID()}`;
    integrations.push(id);
    await database.installedIntegration.create({
      data: {
        id,
        userId: "synthetic-cleanup-user",
        integrationId: SHOPIFY_INTEGRATION_ID,
        projectId: store.projectId,
        credentials: {
          shop: store.shopDomain,
          accessToken: token,
          installationGeneration: "g1",
          shopVerificationTokenHash: shopifyCredentialVerificationHash(token),
          scope: "write_discounts",
        },
      },
    });
    const actual = await vi.importActual<
      typeof import("@/lib/weletic/loyalty/shopify-discounts")
    >("@/lib/weletic/loyalty/shopify-discounts");
    couponTransport.credentials.mockImplementation(
      actual.resolveShopifyOfflineCredentials,
    );
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    const { run } = await cleanupCoupon(fixture);
    expect(await run()).toBe("deactivated");
    expect(couponTransport.lookup).toHaveBeenCalledWith(
      store.shopDomain,
      token,
      fixture.redemption.shopifyDiscountCode,
    );
    expect(couponTransport.deactivate).toHaveBeenCalledWith(
      store.shopDomain,
      token,
      fixture.remote.id,
    );
  });

  it("quarantines a real prepared provision before the paused worker can dispatch", async () => {
    const fixture = await couponFixture();
    let prepared!: () => void;
    let resume!: () => void;
    const preparedBarrier = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const resumeBarrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let paused = false;
    afterDatabaseTransaction = async () => {
      if (paused) return;
      const row = await database.weleticRewardRedemption.findUniqueOrThrow({
        where: { id: fixture.redemption.id },
      });
      if (!(row.metadata as Prisma.JsonObject)?.remoteProvisionPreparationId)
        return;
      paused = true;
      prepared();
      await resumeBarrier;
    };
    const provision = fixture.provision();
    const result = provision.then(
      () => "issued",
      (error: Error) => error.message,
    );
    try {
      await preparedBarrier;
      const { cleanup } = await cleanupCoupon(fixture);
      expect(cleanup.ownershipSnapshot).toMatchObject({
        remoteProvisionAttemptedAt: expect.any(String),
      });
      resume();
      expect(await result).toContain("not eligible");
    } finally {
      resume();
      afterDatabaseTransaction = null;
      await result;
    }
    expect(couponTransport.lookup).not.toHaveBeenCalled();
    expect(couponTransport.create).not.toHaveBeenCalled();
  });

  it("fences a worker superseded after lookup by a real stale-lease acquisition", async () => {
    const fixture = await couponFixture();
    const { cleanup, run } = await cleanupCoupon(fixture);
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    let reclaimed = false;
    afterDatabaseTransaction = async () => {
      if (reclaimed || couponTransport.lookup.mock.calls.length === 0) return;
      reclaimed = true;
      await database.weleticShopifyVoucherCleanup.update({
        where: { id: cleanup.id },
        data: { lockedAt: new Date(0) },
      });
      expect(await run()).toBe("deactivated");
    };
    try {
      await expect(run()).rejects.toThrow("lost its lease");
    } finally {
      afterDatabaseTransaction = null;
    }
    expect(couponTransport.deactivate).toHaveBeenCalledTimes(1);
    expect(
      await database.weleticShopifyVoucherCleanup.findUnique({
        where: { id: cleanup.id },
      }),
    ).toMatchObject({ status: "completed", attempts: 2 });
  });

  it("redacts an accountless shopper through the compatibility service while retaining executable cleanup evidence", async () => {
    const fixture = await couponFixture();
    const { anonymizeWeleticShopper } = await import(
      "../../lib/weletic/loyalty/shopper-privacy"
    );
    await anonymizeWeleticShopper({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    const shopper = await database.weleticShopper.findUniqueOrThrow({
      where: { id: fixture.shopperId },
    });
    expect(shopper.email).toBeNull();
    expect(shopper.shopifyCustomerId).not.toBe("1234");
    expect(
      await database.weleticShopifyCustomerPrivacyTombstone.count({
        where: { storeId: fixture.storeId, shopperId: fixture.shopperId },
      }),
    ).toBe(2);
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({ status: "privacy_redacted" });
    const cleanup =
      await database.weleticShopifyVoucherCleanup.findFirstOrThrow({
        where: { storeId: fixture.storeId },
      });
    expect(cleanup.ownershipSnapshot).toMatchObject({
      kind: "shopper",
      shopperId: fixture.shopperId,
    });
    couponTransport.lookup.mockResolvedValue(fixture.remote);
    const { executeOutboxJob } = await import(
      "../../lib/weletic/loyalty/outbox-worker"
    );
    const job = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId: fixture.storeId, jobType: "VOUCHER_PRIVACY_CLEANUP" },
    });
    expect(await executeOutboxJob(job)).toMatchObject({
      voucherPrivacyCleanupOutcome: "deactivated",
    });
    await expect(fixture.provision()).rejects.toThrow();
    expect(couponTransport.create).not.toHaveBeenCalled();
  });

  it("links shopper-only enumeration to the durable erasure request and waits for cleanup", async () => {
    const fixture = await couponFixture();
    const requestId = `cleanup-request-${randomUUID()}`;
    await database.weleticShopifyComplianceRequest.create({
      data: {
        id: requestId,
        storeId: fixture.storeId,
        webhookId: randomUUID(),
        shopDomain: "synthetic.myshopify.com",
        requestType: "customer_redact",
      },
    });
    const {
      processAccountVoucherEnumerationComplianceStep,
      getVoucherCleanupRequestTerminalCounts,
    } = await import("../../lib/weletic/loyalty/voucher-privacy-cleanup");
    await processAccountVoucherEnumerationComplianceStep({
      requestId,
      storeId: fixture.storeId,
      shopperId: fixture.shopperId,
    });
    expect(
      await getVoucherCleanupRequestTerminalCounts({
        requestId,
        storeId: fixture.storeId,
      }),
    ).toMatchObject({ total: 1, outstanding: 1 });
  });

  it("blocks invalidated claims and stale installation jobs before credentials or Shopify I/O", async () => {
    const fixture = await couponFixture();
    await database.weleticReviewIncentiveClaim.update({
      where: { id: fixture.claim.id },
      data: { status: "invalidated" },
    });
    await expect(fixture.provision()).rejects.toThrow("not eligible");
    await database.weleticReviewIncentiveClaim.update({
      where: { id: fixture.claim.id },
      data: { status: "reserved" },
    });
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { installationGeneration: "g2" },
    });
    await expect(fixture.provision()).rejects.toThrow();
    expect(couponTransport.credentials).not.toHaveBeenCalled();
    expect(couponTransport.lookup).not.toHaveBeenCalled();
    expect(couponTransport.create).not.toHaveBeenCalled();
  });

  it("provisions exactly once through competing workers with MySQL fences and no Redis mutex", async () => {
    const fixture = await couponFixture();
    let remote: typeof fixture.remote | null = null;
    couponTransport.lookup.mockImplementation(async () => remote);
    couponTransport.create.mockImplementation(async () => {
      remote = fixture.remote;
      return remote;
    });
    const results = await Promise.allSettled([
      fixture.provision(),
      fixture.provision(),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await fixture.provision()).toEqual({ status: "already_issued" });
    expect(couponTransport.create).toHaveBeenCalledTimes(1);
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({ status: "fulfilled" });
    expect(
      await database.weleticProductReview.findUnique({
        where: { id: fixture.review.id },
      }),
    ).toMatchObject({
      incentivized: true,
      rewardStatus: "awarded",
      rating: 1,
      status: "pending",
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("adopts the same verified coupon after a lost create response without issuing twice", async () => {
    const fixture = await couponFixture();
    couponTransport.lookup
      .mockResolvedValueOnce(null)
      .mockResolvedValue(fixture.remote);
    couponTransport.create.mockRejectedValueOnce(
      new Error("Synthetic lost create response"),
    );
    await expect(fixture.provision()).rejects.toThrow("lost create response");
    expect(await fixture.provision()).toEqual({ status: "issued" });
    expect(couponTransport.create).toHaveBeenCalledTimes(1);
  });

  it("dispatches and completes the durable coupon job through the production outbox lease", async () => {
    const fixture = await couponFixture();
    couponTransport.lookup
      .mockResolvedValueOnce(null)
      .mockResolvedValue(fixture.remote);
    couponTransport.create.mockResolvedValue(fixture.remote);
    const job = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId: fixture.storeId, jobType: "SHOPPER_REWARD_PROVISION" },
    });
    const { processOutboxJobsBatch } = await import(
      "../../lib/weletic/loyalty/outbox-worker"
    );
    const result = await processOutboxJobsBatch({
      storeId: fixture.storeId,
      jobIds: [job.id],
      batchSize: 1,
      workerId: "synthetic-coupon-worker",
    });
    expect(result).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
    expect(
      await database.weleticLoyaltyOutboxJob.findUnique({
        where: { id: job.id },
      }),
    ).toMatchObject({ status: "completed", lockedBy: null });
    expect(couponTransport.create).toHaveBeenCalledTimes(1);
  });

  it("does not retry create when an uncertain coupon remains absent", async () => {
    const fixture = await couponFixture();
    couponTransport.lookup.mockResolvedValue(null);
    couponTransport.create.mockRejectedValueOnce(
      new Error("Synthetic unknown remote outcome"),
    );
    await expect(fixture.provision()).rejects.toThrow("unknown remote outcome");
    await expect(fixture.provision()).rejects.toThrow(
      "reconciliation remains pending",
    );
    expect(couponTransport.create).toHaveBeenCalledTimes(1);
    expect(
      await database.weleticRewardRedemption.findUnique({
        where: { id: fixture.redemption.id },
      }),
    ).toMatchObject({ status: "provisioning", pointsSpent: BigInt(0) });
  });

  it("fences a retry that prepared before another worker cleared its failed pre-dispatch marker", async () => {
    const fixture = await couponFixture();
    const deferred = () => {
      let resolve: () => void = () => {};
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    };
    const firstReady = deferred();
    const secondReady = deferred();
    const firstContinue = deferred();
    const secondContinue = deferred();
    let calls = 0;
    // Only pause after real commits, never replace the transactional work.
    afterDatabaseTransaction = async () => {
      const call = ++calls;
      if (call === 2) {
        firstReady.resolve();
        await firstContinue.promise;
      }
      if (call === 4) {
        secondReady.resolve();
        await secondContinue.promise;
      }
    };
    const outcomes: Promise<unknown>[] = [];
    try {
      couponTransport.lookup.mockRejectedValueOnce(
        new Error("Synthetic first lookup failed"),
      );
      const first = fixture.provision().catch((error: unknown) => error);
      outcomes.push(first);
      await firstReady.promise;
      const second = fixture.provision().catch((error: unknown) => error);
      outcomes.push(second);
      await secondReady.promise;
      firstContinue.resolve();
      expect(await first).toMatchObject({
        message: "Synthetic first lookup failed",
      });
      secondContinue.resolve();
      expect(await second).toMatchObject({
        message: "Shopper coupon preparation changed; retry from durable state",
      });
      expect(couponTransport.create).not.toHaveBeenCalled();
      expect(couponTransport.lookup).toHaveBeenCalledTimes(1);
      couponTransport.lookup
        .mockResolvedValueOnce(null)
        .mockResolvedValue(fixture.remote);
      couponTransport.create.mockResolvedValue(fixture.remote);
      expect(await fixture.provision()).toEqual({ status: "issued" });
      expect(couponTransport.create).toHaveBeenCalledTimes(1);
    } finally {
      firstContinue.resolve();
      secondContinue.resolve();
      await Promise.allSettled(outcomes);
      afterDatabaseTransaction = null;
    }
  });

  it("retries credential and pre-dispatch lookup failures without a false ambiguous-create marker", async () => {
    const fixture = await couponFixture();
    couponTransport.credentials.mockRejectedValueOnce(
      new Error("Synthetic credentials unavailable"),
    );
    await expect(fixture.provision()).rejects.toThrow(
      "credentials unavailable",
    );
    const afterCredentials =
      await database.weleticRewardRedemption.findUniqueOrThrow({
        where: { id: fixture.redemption.id },
      });
    expect(afterCredentials.metadata).not.toHaveProperty(
      "remoteProvisionAttemptedAt",
    );
    couponTransport.lookup.mockRejectedValueOnce(
      new Error("Synthetic lookup unavailable"),
    );
    await expect(fixture.provision()).rejects.toThrow("lookup unavailable");
    const afterLookup =
      await database.weleticRewardRedemption.findUniqueOrThrow({
        where: { id: fixture.redemption.id },
      });
    expect(afterLookup.metadata).not.toHaveProperty(
      "remoteProvisionAttemptedAt",
    );
    couponTransport.lookup
      .mockResolvedValueOnce(null)
      .mockResolvedValue(fixture.remote);
    couponTransport.create.mockResolvedValue(fixture.remote);
    expect(await fixture.provision()).toEqual({ status: "issued" });
    expect(couponTransport.create).toHaveBeenCalledTimes(1);
  });

  it("refuses foreign or differently configured remote coupons and never replaces their code", async () => {
    const fixture = await couponFixture();
    couponTransport.lookup.mockResolvedValue({
      ...fixture.remote,
      title: "Another merchant's coupon",
    });
    await expect(fixture.provision()).rejects.toThrow("ownership mismatch");
    couponTransport.lookup.mockResolvedValue({
      ...fixture.remote,
      configuration: {
        ...fixture.remote.configuration,
        customerSelection: { kind: "all" },
      },
    });
    await expect(fixture.provision()).rejects.toThrow(
      "configuration does not match",
    );
    expect(couponTransport.create).not.toHaveBeenCalled();
    expect(
      await database.weleticReviewIncentiveClaim.findUnique({
        where: { id: fixture.claim.id },
      }),
    ).toMatchObject({ status: "reserved" });
  });

  it("reserves exactly one order-wide incentive in concurrent production transactions without enrolling a shopper", async () => {
    const fixture = await incentiveFixture();
    const first = await fixture.addReview(1);
    const second = await fixture.addReview(5);
    const results = await Promise.all([
      fixture.reserve(first.id),
      fixture.reserve(second.id),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.claim?.id)).size).toBe(1);
    expect(results[0].claim?.awardSnapshot).toEqual({
      kind: "points",
      points: "100",
    });
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("keeps a low-rating hidden review eligible and its pinned promise unchanged by a newer policy", async () => {
    const fixture = await incentiveFixture();
    const review = await fixture.addReview(1);
    await database.weleticProductReview.update({
      where: { id: review.id },
      data: { status: "hidden" },
    });
    const { createReviewIncentivePolicyRevision } = await import(
      "../../lib/weletic/reviews/incentive-policy"
    );
    const next = await createReviewIncentivePolicyRevision(fixture.storeId, {
      kind: "points",
      basePoints: "900",
      photoBonusPoints: "0",
      videoBonusPoints: "0",
      maxPoints: "900",
    });
    expect(next.revision).toBe(2);
    expect((await fixture.reserve(review.id)).claim?.awardSnapshot).toEqual({
      kind: "points",
      points: "100",
    });
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({ activeIncentivePolicyId: null });
  });

  it("requires durable validation even when a review is published", async () => {
    const fixture = await incentiveFixture();
    const review = await fixture.addReview(5);
    await database.weleticProductReview.update({
      where: { id: review.id },
      data: { status: "published", participationStatus: "pending" },
    });
    await expect(fixture.reserve(review.id)).rejects.toThrow(
      "Trusted participation validation",
    );
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("rejects content mutation after validation, then rejects a fully refunded purchase", async () => {
    const fixture = await incentiveFixture();
    const review = await fixture.addReview();
    await database.weleticProductReview.update({
      where: { id: review.id },
      data: { body: "Changed after validation" },
    });
    await expect(fixture.reserve(review.id)).rejects.toThrow(
      "Trusted participation validation",
    );
    await database.weleticProductReview.update({
      where: { id: review.id },
      data: { body: review.body },
    });
    await database.weleticCommerceOrder.update({
      where: { id: fixture.orderId },
      data: { status: "refunded" },
    });
    await expect(fixture.reserve(review.id)).rejects.toThrow(
      "Review request unavailable",
    );
  });

  it("rejects stale installations, cross-store reviews and legacy invitations", async () => {
    const fixture = await incentiveFixture();
    const foreign = await incentiveFixture();
    const review = await fixture.addReview();
    await expect(
      fixture.reserve(review.id, "old-generation"),
    ).rejects.toThrow();
    await expect(foreign.reserve(review.id)).rejects.toThrow(
      "Review unavailable",
    );
    await database.weleticReviewRequest.update({
      where: { id: review.requestId },
      data: { incentivePolicyId: null },
    });
    await expect(fixture.reserve(review.id)).rejects.toThrow(
      "Historical review",
    );
  });

  it("freezes coupon catalog terms in an inactive policy without spending points", async () => {
    const fixture = await seed(false);
    const reward = await database.weleticRewardDefinition.create({
      data: {
        id: `claim-coupon-${randomUUID()}`,
        storeId: fixture.storeId,
        name: "Promised coupon",
        rewardType: "amount_off",
        discountValue: 100,
        pointsCost: 500,
      },
    });
    const { createReviewIncentivePolicyRevision } = await import(
      "../../lib/weletic/reviews/incentive-policy"
    );
    const policy = await createReviewIncentivePolicyRevision(fixture.storeId, {
      kind: "coupon",
      rewardDefinitionId: reward.id,
    });
    await database.weleticRewardDefinition.update({
      where: { id: reward.id },
      data: { discountValue: 500 },
    });
    expect(policy.snapshot).toMatchObject({
      version: 1,
      award: {
        kind: "coupon",
        terms: {
          discountValue: "100",
          shopCurrency: "JPY",
          rewardDefinitionId: reward.id,
        },
      },
    });
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("excludes mixed legacy orders even if their historical award was already reversed", async () => {
    const fixture = await incentiveFixture();
    const legacy = await fixture.addReview();
    const current = await fixture.addReview();
    await database.weleticReviewRequest.update({
      where: { id: legacy.requestId },
      data: { incentivePolicyId: null },
    });
    await database.weleticProductReview.update({
      where: { id: legacy.id },
      data: { rewardStatus: "reversed", rewardLedgerId: "retained-ledger" },
    });
    await expect(fixture.reserve(current.id)).rejects.toThrow(
      "legacy review invitations",
    );
    expect(
      await database.weleticReviewIncentiveClaim.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("keeps later product invitations on the legacy order policy across cutover", async () => {
    const fixture = await incentiveFixture();
    const legacy = await fixture.addReview();
    const later = await fixture.addReview();
    await database.weleticProductReview.delete({ where: { id: later.id } });
    await database.weleticReviewRequestLine.deleteMany({
      where: { requestId: later.requestId },
    });
    await database.weleticReviewRequest.delete({
      where: { id: later.requestId },
    });
    await database.weleticReviewRequest.update({
      where: { id: legacy.requestId },
      data: { incentivePolicyId: null },
    });
    await database.weleticReviewSettings.update({
      where: { storeId: fixture.storeId },
      data: {
        requestEmailEnabled: true,
        activatedAt: new Date(0),
        activeIncentivePolicyId: fixture.policy.id,
      },
    });
    const purchase = await database.weleticCommerceOrder.findUniqueOrThrow({
      where: { id: fixture.orderId },
    });
    const { createFulfilledReviewRequests } = await import(
      "../../lib/weletic/reviews/requests"
    );
    await createFulfilledReviewRequests({
      storeId: fixture.storeId,
      orderExternalId: purchase.externalId,
      fulfilledAt: new Date(),
      expectedInstallationGeneration: "g1",
    });
    expect(
      await database.weleticReviewRequest.findMany({
        where: { storeId: fixture.storeId },
        select: { incentivePolicyId: true },
      }),
    ).toEqual([{ incentivePolicyId: null }, { incentivePolicyId: null }]);
  });

  it("retains an invalidated order claim instead of creating or reviving another", async () => {
    const fixture = await incentiveFixture();
    const review = await fixture.addReview();
    const first = await fixture.reserve(review.id);
    if (!first.claim) throw new Error("Expected claim");
    await database.weleticReviewIncentiveClaim.update({
      where: { id: first.claim.id },
      data: { status: "invalidated" },
    });
    expect(await fixture.reserve(review.id)).toMatchObject({
      status: "already_claimed",
      created: false,
      claim: { id: first.claim.id, status: "invalidated" },
    });
  });

  it("allocates distinct append-only policy revisions under concurrent edits without activation", async () => {
    const fixture = await seed(false);
    const { createReviewIncentivePolicyRevision } = await import(
      "../../lib/weletic/reviews/incentive-policy"
    );
    const revisions = await Promise.all(
      [1, 2, 3].map(() =>
        createReviewIncentivePolicyRevision(fixture.storeId, { kind: "none" }),
      ),
    );
    expect(revisions.map((row) => row.revision).sort()).toEqual([1, 2, 3]);
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: fixture.storeId },
      }),
    ).toMatchObject({ activeIncentivePolicyId: null });
  });

  it("reads direct zero-point coupons for a reviews-only shopper through the production transaction", async () => {
    const fixture = await seed(false);
    const foreign = await seed(false);
    const reward = await database.weleticRewardDefinition.create({
      data: {
        id: `direct-catalog-${randomUUID()}`,
        storeId: fixture.storeId,
        name: "Synthetic coupon",
        rewardType: "amount_off",
        pointsCost: BigInt(100),
        discountValue: 100,
      },
    });
    const add = async (
      suffix: string,
      overrides: Partial<Prisma.WeleticRewardRedemptionUncheckedCreateInput> = {},
    ) => {
      const id = `direct-${randomUUID()}`;
      await database.weleticRewardRedemption.create({
        data: {
          id,
          storeId: fixture.storeId,
          accountId: null,
          shopperId: fixture.shopperId,
          rewardDefinitionId: reward.id,
          pointsSpent: BigInt(0),
          shopifyDiscountCode: id,
          shopifyDiscountCodeCanonical: id.toUpperCase(),
          fulfillmentSource: "review_incentive_v1",
          fulfillmentReference: `${fixture.storeId}-${suffix}`,
          status: "issued",
          ...overrides,
        },
      });
      return id;
    };
    const valid = await add("valid");
    const otherShopperId = `other-shopper-${randomUUID()}`;
    const otherAccountId = `other-account-${randomUUID()}`;
    const otherProgramId = `other-program-${randomUUID()}`;
    await database.weleticShopper.create({
      data: {
        id: otherShopperId,
        storeId: fixture.storeId,
        shopifyCustomerId: "5678",
      },
    });
    await database.weleticLoyaltyProgram.create({
      data: {
        id: otherProgramId,
        storeId: fixture.storeId,
        status: "disabled",
      },
    });
    await database.weleticLoyaltyAccount.create({
      data: {
        id: otherAccountId,
        storeId: fixture.storeId,
        shopperId: otherShopperId,
        programId: otherProgramId,
      },
    });
    const contradictory = await add("contradictory-owner", {
      accountId: otherAccountId,
    });
    await add("foreign-shopper", { shopperId: foreign.shopperId });
    await add("points", { pointsSpent: BigInt(1) });
    await add("ledger", { ledgerEntryId: "invalid-ledger-reference" });
    await add("unknown-source", { fulfillmentSource: "unknown" });
    await add("gift-card", { artifactKind: "gift_card" });
    const result = await read(fixture, "rewards");
    if (result.section !== "rewards" || !("items" in result))
      throw new Error("Wrong result");
    expect(result.items.map((item) => item.id)).toEqual([valid]);
    expect(result.items).toMatchObject([
      { pointsSpent: "0", fulfillmentSource: "review_incentive_v1" },
    ]);
    const { getShopperDataExport } = await import(
      "../../lib/weletic/loyalty/shopper-privacy"
    );
    const exported = await getShopperDataExport({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    expect(exported?.loyaltyAccount).toBeNull();
    // Privacy export includes malformed source records for the known owner,
    // unlike the wallet; it must not silently discard retained customer context.
    expect(exported?.rewardFulfillments).toHaveLength(5);
    expect(
      exported?.rewardFulfillments.some((row) => row.id === contradictory),
    ).toBe(false);
    const accountOwnerExport = await getShopperDataExport({
      storeId: fixture.storeId,
      shopifyCustomerId: "5678",
    });
    expect(accountOwnerExport?.rewardFulfillments.map((row) => row.id)).toEqual(
      [contradictory],
    );
    expect(exported?.rewardFulfillments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: valid, pointsSpent: "0" }),
      ]),
    );
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId, shopperId: fixture.shopperId },
      }),
    ).toBe(0);
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("enforces direct source uniqueness on MySQL without rewriting legacy rows", async () => {
    const fixture = await seed(false);
    const data = {
      storeId: fixture.storeId,
      shopperId: fixture.shopperId,
      accountId: null,
      rewardDefinitionId: "unused",
      pointsSpent: BigInt(0),
      fulfillmentSource: "review_incentive_v1",
      fulfillmentReference: `order-${randomUUID()}`,
    };
    const results = await Promise.allSettled(
      [1, 2].map(() => {
        const id = `direct-race-${randomUUID()}`;
        return database.$transaction((tx) =>
          tx.weleticRewardRedemption.create({
            data: {
              ...data,
              id,
              shopifyDiscountCode: id,
              shopifyDiscountCodeCanonical: id.toUpperCase(),
            },
          }),
        );
      }),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure).toMatchObject({
      status: "rejected",
      reason: { code: "P2002" },
    });
    expect(
      await database.weleticRewardRedemption.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it("segments actual order states without enrolling shoppers or trusting lifetime counters", async () => {
    const { listMerchantShoppers } = await import(
      "../../lib/weletic/shoppers/directory"
    );
    for (const status of [
      "paid",
      "partially_refunded",
      "refunded",
      "pending",
      "voided",
    ] as const) {
      const fixture = await seed(false);
      await order(fixture, status);
      await database.weleticShopper.update({
        where: { id: fixture.shopperId },
        data: { ordersCount: 999, totalSpent: 999999 },
      });
      const eligible = status === "paid" || status === "partially_refunded";
      expect(
        (
          await listMerchantShoppers(fixture.projectId, {
            purchase: "has_order",
            loyalty: "not_enrolled",
          })
        ).items,
      ).toHaveLength(eligible ? 1 : 0);
      expect(
        (
          await listMerchantShoppers(fixture.projectId, {
            purchase: "no_order",
          })
        ).items,
      ).toHaveLength(eligible ? 0 : 1);
      expect(
        await database.weleticLoyaltyAccount.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    }
  });

  it("intersects balance/status/purchase facts with exact BigInts and UTC boundaries", async () => {
    const { listMerchantShoppers } = await import(
      "../../lib/weletic/shoppers/directory"
    );
    const fixture = await seed();
    await database.weleticLoyaltyAccount.update({
      where: { id: fixture.accountId },
      data: {
        status: "suspended",
        cachedPointsBalance: BigInt("9007199254740993"),
      },
    });
    await order(fixture, "partially_refunded");
    const filters = {
      loyalty: "suspended",
      minPoints: "9007199254740993",
      maxPoints: "9007199254740993",
      purchase: "has_order",
      purchasedFrom: "2026-09-06",
      purchasedBefore: "2026-09-07",
    };
    expect(
      (await listMerchantShoppers(fixture.projectId, filters)).items.map(
        (row) => row.id,
      ),
    ).toEqual([fixture.shopperId]);
    for (const changed of [
      { loyalty: "active" },
      { minPoints: "9007199254740994", maxPoints: "" },
      { purchasedFrom: "2026-09-05", purchasedBefore: "2026-09-06" },
    ])
      expect(
        (
          await listMerchantShoppers(fixture.projectId, {
            ...filters,
            ...changed,
          })
        ).items,
      ).toEqual([]);
    await database.weleticLoyaltyAccount.update({
      where: { id: fixture.accountId },
      data: { cachedPointsBalance: BigInt(-5) },
    });
    expect(
      (await listMerchantShoppers(fixture.projectId, { maxPoints: "-5" }))
        .items,
    ).toHaveLength(1);
    expect(
      (await listMerchantShoppers(fixture.projectId, { minPoints: "0" })).items,
    ).toEqual([]);
  });

  it("does not use another store's order even when a malformed scalar relation points at this shopper", async () => {
    const { listMerchantShoppers } = await import(
      "../../lib/weletic/shoppers/directory"
    );
    const fixture = await seed(false),
      foreign = await seed(false);
    await order(foreign, "paid", undefined, fixture.shopperId);
    expect(
      (await listMerchantShoppers(fixture.projectId, { purchase: "has_order" }))
        .items,
    ).toEqual([]);
    expect(
      (await listMerchantShoppers(fixture.projectId, { purchase: "no_order" }))
        .items,
    ).toHaveLength(1);
  });

  it("filters current tier assignments without accepting deleted or foreign tiers", async () => {
    const { listMerchantShoppers } = await import(
      "../../lib/weletic/shoppers/directory"
    );
    const fixture = await seed(),
      foreign = await seed();
    const tier = await database.weleticLoyaltyTier.create({
      data: {
        id: `segment-tier-${randomUUID()}`,
        programId: fixture.programId,
        name: "Fixture",
        slug: "fixture",
      },
    });
    expect(
      (await listMerchantShoppers(fixture.projectId, { vip: "unassigned" }))
        .items,
    ).toHaveLength(1);
    await database.weleticLoyaltyAccount.update({
      where: { id: fixture.accountId },
      data: { currentTierId: tier.id },
    });
    expect(
      (await listMerchantShoppers(fixture.projectId, { vip: "assigned" }))
        .items,
    ).toHaveLength(1);
    await database.weleticLoyaltyTier.update({
      where: { id: tier.id },
      data: { deletedAt: new Date() },
    });
    expect(
      (await listMerchantShoppers(fixture.projectId, { vip: "assigned" }))
        .items,
    ).toEqual([]);
    await database.weleticLoyaltyTier.update({
      where: { id: tier.id },
      data: { deletedAt: null, programId: foreign.programId },
    });
    expect(
      (await listMerchantShoppers(fixture.projectId, { vip: "assigned" }))
        .items,
    ).toEqual([]);
  });

  it("reads an unenrolled shopper and leaves account creation untouched", async () => {
    const fixture = await seed(false);
    expect(await read(fixture)).toMatchObject({
      section: "overview",
      shopper: { id: fixture.shopperId },
      loyalty: null,
    });
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("isolates identical Shopify customer IDs across stores", async () => {
    const first = await seed();
    const second = await seed();
    const { readMerchantShopperProfile } = await import(
      "../../lib/weletic/shoppers/profile"
    );
    await expect(
      readMerchantShopperProfile(first.projectId, {
        shopperId: second.shopperId,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await read(first)).toMatchObject({
      shopper: { id: first.shopperId },
      loyalty: { pointsBalance: "-5", pendingPoints: "9007199254740993" },
      modules: { loyalty: { status: "disabled" } },
    });
  });

  it("pages actual ledger rows by sequence despite timestamps moving backwards", async () => {
    const fixture = await seed();
    await database.weleticPointsLedgerEntry.createMany({
      data: [1, 2, 3].map((sequenceNumber) => ({
        id: `ledger-${fixture.storeId}-${sequenceNumber}`,
        storeId: fixture.storeId,
        accountId: fixture.accountId,
        sequenceNumber,
        entryType: "EARN_ORDER" as const,
        pointsDelta: BigInt(0),
        pendingDelta: BigInt("9007199254740993"),
        balanceAfter: BigInt(-5),
        idempotencyKey: `profile:${sequenceNumber}`,
        createdAt: new Date(Date.UTC(2026, 0, 4 - sequenceNumber)),
      })),
    });
    const first = await read(fixture, "points", undefined, 2);
    if (!("pagination" in first) || !first.pagination)
      throw new Error("Expected collection");
    expect(first).toMatchObject({
      items: [
        { sequenceNumber: 3, pendingDelta: "9007199254740993" },
        { sequenceNumber: 2 },
      ],
      pagination: { hasMore: true },
    });
    const second = await read(
      fixture,
      "points",
      first.pagination.nextCursor!,
      2,
    );
    expect(second).toMatchObject({
      items: [{ sequenceNumber: 1 }],
      pagination: { hasMore: false },
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(3);
  });

  it("reads review history without loyalty enrollment or live token/media exposure", async () => {
    const fixture = await seed(false);
    const id = randomUUID();
    // The projection does not dereference commerce/product rows. Each unused
    // scalar parent ID is unique; these fixtures exercise the real select only.
    await database.weleticReviewRequest.create({
      data: {
        id: `request-${id}`,
        storeId: fixture.storeId,
        shopperId: fixture.shopperId,
        orderId: `order-${id}`,
        productId: `product-${id}`,
        fulfilledAt: new Date(),
        sendAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        tokenHash: randomBytes(32).toString("hex"),
        encryptedDeliveryToken: "synthetic-secret-do-not-project",
        status: "submitted",
      },
    });
    await database.weleticProductReview.create({
      data: {
        id: `review-${id}`,
        storeId: fixture.storeId,
        requestId: `request-${id}`,
        productId: `product-${id}`,
        shopperId: fixture.shopperId,
        rating: 1,
        title: "Controlled low-rating fixture",
        body: "Synthetic body",
        displayName: "Fixture",
        status: "hidden",
      },
    });
    expect(await read(fixture, "reviews")).toMatchObject({
      items: [{ rating: 1, status: "hidden", subject: "product" }],
    });
    const requests = await read(fixture, "review_requests");
    expect(JSON.stringify(requests)).not.toMatch(
      /synthetic-secret|tokenHash|encryptedDeliveryToken/,
    );
  });

  it("uses real HMAC privacy tombstones and refuses reads after redaction", async () => {
    const fixture = await seed();
    const { deriveAllShopifyCustomerPrivacyIdentities } = await import(
      "../../lib/weletic/shopify/privacy-identity"
    );
    const [identity] = deriveAllShopifyCustomerPrivacyIdentities({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    await database.weleticShopifyCustomerPrivacyTombstone.create({
      data: {
        id: `tombstone-${randomUUID()}`,
        storeId: fixture.storeId,
        ...identity,
        redactedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(read(fixture)).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects frozen stores and stale-installation cursors", async () => {
    const fixture = await seed();
    const { shopperProfilePage } = await import(
      "../../lib/weletic/shoppers/profile-query"
    );
    const rows = [
      { id: "b", createdAt: new Date() },
      { id: "a", createdAt: new Date() },
    ];
    const cursor = shopperProfilePage(
      {
        storeId: fixture.storeId,
        shopperId: fixture.shopperId,
        section: "reviews",
        generation: "g1",
      },
      rows,
      1,
      (row) => row.id,
    ).pagination.nextCursor!;
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { installationGeneration: "g2" },
    });
    await expect(read(fixture, "reviews", cursor)).rejects.toMatchObject({
      code: "bad_request",
    });
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { complianceState: "frozen" },
    });
    await expect(read(fixture)).rejects.toMatchObject({ code: "not_found" });
  });

  it("discovers reviews-only shoppers without enrolling or leaking another store", async () => {
    const fixture = await seed(false);
    await seed(false);
    const { listMerchantShoppers } = await import(
      "../../lib/weletic/shoppers/directory"
    );
    const result = await listMerchantShoppers(fixture.projectId, {
      search: "1234",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: fixture.shopperId,
      loyalty: null,
    });
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it("continues past a fully suppressed page and fences search and installation cursors", async () => {
    const fixture = await seed(false);
    const { listMerchantShoppers } = await import(
      "../../lib/weletic/shoppers/directory"
    );
    const { deriveAllShopifyCustomerPrivacyIdentities } = await import(
      "../../lib/weletic/shopify/privacy-identity"
    );
    const [identity] = deriveAllShopifyCustomerPrivacyIdentities({
      storeId: fixture.storeId,
      shopifyCustomerId: "1234",
    });
    await database.weleticShopifyCustomerPrivacyTombstone.create({
      data: {
        id: `tombstone-${randomUUID()}`,
        storeId: fixture.storeId,
        ...identity,
        redactedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const older = await database.weleticShopper.create({
      data: {
        id: `shopper-${randomUUID()}`,
        storeId: fixture.storeId,
        shopifyCustomerId: "5678",
        firstName: "Visible fixture",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const first = await listMerchantShoppers(fixture.projectId, { limit: 1 });
    expect(first.items).toEqual([]);
    expect(first.pagination.hasMore).toBe(true);
    const cursor = first.pagination.nextCursor!;
    expect(
      (
        await listMerchantShoppers(fixture.projectId, { limit: 1, cursor })
      ).items.map((row) => row.id),
    ).toEqual([older.id]);
    await expect(
      listMerchantShoppers(fixture.projectId, { cursor, search: "Visible" }),
    ).rejects.toMatchObject({ code: "bad_request" });
    const other = await seed(false);
    await expect(
      listMerchantShoppers(other.projectId, { cursor }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await database.weleticShopifyStore.update({
      where: { id: fixture.storeId },
      data: { installationGeneration: "g2" },
    });
    await expect(
      listMerchantShoppers(fixture.projectId, { cursor }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("keeps expired linked-owner suppression even with many historical identities", async () => {
    const fixture = await seed();
    const { listMerchantShoppers } = await import(
      "../../lib/weletic/shoppers/directory"
    );
    expect(
      (await listMerchantShoppers(fixture.projectId, { maxPoints: "0" })).items,
    ).toHaveLength(1);
    await database.weleticShopifyCustomerPrivacyTombstone.createMany({
      data: Array.from({ length: 80 }, (_, index) => ({
        id: `tombstone-${randomUUID()}`,
        storeId: fixture.storeId,
        identityKind: "customer_id",
        identityKeyId: "historical-test",
        customerDigest: String(index).padStart(64, "0"),
        shopperId: index % 2 ? fixture.shopperId : null,
        accountId: index % 2 ? null : fixture.accountId,
        redactedAt: new Date("2020-01-01T00:00:00Z"),
        expiresAt: new Date("2020-02-01T00:00:00Z"),
      })),
    });
    expect(
      (await listMerchantShoppers(fixture.projectId, { maxPoints: "0" })).items,
    ).toEqual([]);
  });

  it("continues a filtered page and rejects changing its facts", async () => {
    const fixture = await seed(false);
    const { listMerchantShoppers } = await import(
      "../../lib/weletic/shoppers/directory"
    );
    const older = await database.weleticShopper.create({
      data: {
        id: `segment-older-${randomUUID()}`,
        storeId: fixture.storeId,
        shopifyCustomerId: "5678",
        createdAt: new Date("2020-01-01T00:00:00Z"),
      },
    });
    const filters = { purchase: "no_order", loyalty: "not_enrolled", limit: 1 };
    const first = await listMerchantShoppers(fixture.projectId, filters);
    expect(first.items.map((row) => row.id)).toEqual([fixture.shopperId]);
    const cursor = first.pagination.nextCursor!;
    expect(
      (
        await listMerchantShoppers(fixture.projectId, { ...filters, cursor })
      ).items.map((row) => row.id),
    ).toEqual([older.id]);
    await expect(
      listMerchantShoppers(fixture.projectId, { cursor }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      listMerchantShoppers(fixture.projectId, {
        ...filters,
        cursor,
        purchase: "has_order",
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
