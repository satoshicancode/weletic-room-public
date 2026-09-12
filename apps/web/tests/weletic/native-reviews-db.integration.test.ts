import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { awardVerifiedReviewPoints } from "@/lib/weletic/loyalty/review-rewards";
import {
  generateReviewToken,
  hashReviewToken,
} from "@/lib/weletic/reviews/contracts";
import { deliverReviewRequest } from "@/lib/weletic/reviews/email";
import { uploadReviewPhoto } from "@/lib/weletic/reviews/media";
import { redactNativeReviewsBatch } from "@/lib/weletic/reviews/privacy";
import { getPublicProductReviews } from "@/lib/weletic/reviews/public";
import {
  cancelIneligibleReviewRequests,
  createFulfilledReviewRequests,
  getReviewRequestPreview,
  recordReviewOrderCancellation,
} from "@/lib/weletic/reviews/requests";
import {
  moderateNativeReview,
  submitNativeReview,
} from "@/lib/weletic/reviews/service";
import { withReviewMutation } from "@/lib/weletic/reviews/transaction";
import { Prisma } from "@prisma/client";
import sharp from "sharp";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
  resend: null as object | null,
  viaResend: vi.fn(),
  viaSmtp: vi.fn(),
  upload: vi.fn(),
  delete: vi.fn(),
  beforeMediaLock: null as null | (() => Promise<void>),
}));
vi.mock("../../../../packages/email/src/resend", () => ({
  get resend() {
    return mocks.resend;
  },
}));
vi.mock("../../../../packages/email/src/send-via-resend", () => ({
  sendBatchEmailViaResend: mocks.viaResend,
  sendEmailViaResend: vi.fn(),
}));
vi.mock("../../../../packages/email/src/send-via-nodemailer", () => ({
  sendViaNodeMailer: mocks.viaSmtp,
}));
vi.mock("@/lib/storage", () => ({
  storage: { upload: mocks.upload, delete: mocks.delete },
}));
// Deliberately remove Redis serialization: these tests must prove MySQL CAS /
// unique constraints themselves, not an in-memory mutex masquerading as proof.
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: ({
    fn,
  }: {
    fn: () => Promise<unknown>;
  }) => fn(),
}));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: async ({
    key,
    fn,
  }: {
    key: string;
    fn: () => Promise<unknown>;
  }) => {
    if (key.startsWith("weletic:reviews:media:") && mocks.beforeMediaLock) {
      const before = mocks.beforeMediaLock;
      mocks.beforeMediaLock = null;
      await before();
    }
    return fn();
  },
}));

const run = `reviews-it-${process.pid}-${Date.now()}`;
const storeId = `store-${run}`;
const workspaceId = `workspace-${run}`;
const programId = `program-${run}`;
const loyaltyProgramId = `loyalty-${run}`;
const shopperId = `shopper-${run}`;
const accountId = `account-${run}`;
const productId = `product-${run}`;
let sequence = 100;
let safeDatabase = false;

async function purchase() {
  const externalId = String(++sequence);
  const id = `order-${run}-${externalId}`;
  await prisma.weleticCommerceOrder.create({
    data: {
      id,
      storeId,
      programId,
      shopperId,
      externalId,
      occurredAt: new Date(),
      status: "paid",
      shopCurrency: "USD",
      presentmentCurrency: "USD",
      accountingCurrency: "USD",
      accountingFxRate: new Prisma.Decimal(1),
      shopSubtotal: 200,
      shopNet: 200,
      shopTotal: 200,
      presentmentSubtotal: 200,
      presentmentNet: 200,
      presentmentTotal: 200,
      accountingNet: 200,
      accountingTotal: 200,
      lines: {
        create: {
          id: `line-${id}`,
          externalId: `line-${externalId}`,
          productId,
          title: "Review fixture product",
          quantity: 2,
          shopGross: 200,
          shopNet: 200,
          presentmentGross: 200,
          presentmentNet: 200,
          accountingNet: 200,
          commissionableAccountingAmount: 200,
        },
      },
    },
  });
  return { id, externalId, lineId: `line-${id}` };
}

async function invitation(order: Awaited<ReturnType<typeof purchase>>) {
  const [id] = await createFulfilledReviewRequests({
    storeId,
    orderExternalId: order.externalId,
    fulfilledAt: new Date(Date.now() - 1000),
    expectedInstallationGeneration: "g1",
  });
  expect(id).toBeTruthy();
  const token = generateReviewToken();
  await prisma.weleticReviewRequest.update({
    where: { id },
    data: {
      status: "sent",
      sentAt: new Date(),
      tokenHash: hashReviewToken(token),
    },
  });
  return { id, token };
}
const input = (token: string) => ({
  token,
  rating: 1,
  title: "Honest review",
  body: "The product did not meet my expectations.",
  displayName: "Buyer",
  publishConsent: true,
});

describe("native reviews real MySQL production-service boundaries", () => {
  beforeAll(async () => {
    if (
      process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
      !process.env.DATABASE_URL ||
      !new URL(process.env.DATABASE_URL).pathname.startsWith(
        "/weletic_loyalty_it_",
      )
    )
      throw new Error(
        "Native review DB tests require an explicitly isolated database",
      );
    safeDatabase = true;
    vi.stubEnv("ENCRYPTION_KEY", Buffer.alloc(32, 0x37).toString("base64"));
    vi.stubEnv("SMTP_HOST", "smtp.invalid");
    vi.stubEnv("SMTP_PORT", "2525");
    vi.stubEnv(
      "WELETIC_TRANSACTIONAL_EMAIL_FROM",
      "Reviews <reviews@example.test>",
    );
    vi.stubEnv("WELETIC_TRANSACTIONAL_EMAIL_REPLY_TO", "");
    await prisma.project.create({
      data: {
        id: workspaceId,
        name: "Native reviews isolated test",
        slug: workspaceId,
        billingCycleStart: 1,
      },
    });
    await prisma.program.create({
      data: {
        id: programId,
        workspaceId,
        defaultFolderId: `folder-${run}`,
        defaultGroupId: `group-${run}`,
        name: "Native reviews isolated test",
        slug: programId,
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        storeAccessState: "active",
        id: storeId,
        projectId: workspaceId,
        programId,
        shopDomain: `${run}.myshopify.com`,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date(),
        apiVersion: "2026-07",
        installationGeneration: "g1",
      },
    });
    await prisma.weleticLoyaltyProgram.create({
      data: { id: loyaltyProgramId, storeId, status: "active" },
    });
    await prisma.weleticShopper.create({
      data: {
        id: shopperId,
        storeId,
        shopifyCustomerId: "123456",
        email: "buyer@example.test",
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: accountId,
        storeId,
        shopperId,
        programId: loyaltyProgramId,
        referralCode: `REF-${run}`,
      },
    });
    await prisma.weleticShopifyProduct.create({
      data: {
        id: productId,
        storeId,
        programId,
        externalId: "gid://shopify/Product/1234",
        handle: "fixture",
        title: "Review fixture product",
      },
    });
    await prisma.weleticReviewSettings.create({
      data: {
        storeId,
        enabled: true,
        requestEmailEnabled: true,
        sendAfterDays: 0,
        activatedAt: new Date("2020-01-01"),
      },
    });
    await prisma.weleticLoyaltyEarningRule.create({
      data: {
        id: `rule-${run}`,
        programId: loyaltyProgramId,
        name: "Honest review",
        triggerCode: "product_review",
        ruleType: "fixed_points",
        fixedPoints: 100,
        maxEventsPerCustomer: 100,
        conditions: {
          provider: "native",
          minContentLength: 20,
          photoBonusPoints: 0,
          videoBonusPoints: 0,
        },
      },
    });
  });
  beforeEach(() => {
    mocks.resend = null;
    mocks.viaResend
      .mockReset()
      .mockResolvedValue({ data: [{ id: "resend-test" }], error: null });
    mocks.viaSmtp.mockReset().mockResolvedValue({ messageId: "smtp-test" });
    mocks.upload
      .mockReset()
      .mockResolvedValue({ url: "https://storage.invalid/test" });
    mocks.delete.mockReset().mockResolvedValue(undefined);
    mocks.beforeMediaLock = null;
  });
  afterAll(async () => {
    if (safeDatabase) await prisma.$disconnect();
    vi.unstubAllEnvs();
  });

  it("deduplicates overlapping fulfilled-order requests and their outbox job", async () => {
    const order = await purchase();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        createFulfilledReviewRequests({
          storeId,
          orderExternalId: order.externalId,
          fulfilledAt: new Date(),
          expectedInstallationGeneration: "g1",
        }),
      ),
    );
    expect(new Set(results.flat()).size).toBe(1);
    expect(
      await prisma.weleticReviewRequest.count({
        where: { storeId, orderId: order.id },
      }),
    ).toBe(1);
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({
        where: {
          storeId,
          idempotencyKey: `review_request_email:${results[0][0]}`,
        },
      }),
    ).toBe(1);
  });
  it("keeps cancellation authoritative before the paid-order projection arrives", async () => {
    await recordReviewOrderCancellation({
      storeId,
      orderExternalId: "99999",
      cancelledAt: new Date(),
      expectedInstallationGeneration: "g1",
    });
    await expect(
      createFulfilledReviewRequests({
        storeId,
        orderExternalId: "99999",
        fulfilledAt: new Date(),
        expectedInstallationGeneration: "g1",
      }),
    ).resolves.toEqual([]);
  });
  it("consumes one bearer token exactly once across concurrent Prisma transactions", async () => {
    const request = await invitation(await purchase());
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        submitNativeReview(storeId, input(request.token)),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await prisma.weleticProductReview.count({
        where: { storeId, requestId: request.id },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.weleticReviewRequest.findUniqueOrThrow({
          where: { id: request.id },
        })
      ).tokenHash,
    ).toBeNull();
  });
  it.each(["resend", "smtp"])(
    "permits one %s send despite concurrent acquisition without Redis serialization",
    async (provider) => {
      mocks.resend = provider === "resend" ? {} : null;
      const order = await purchase();
      const [id] = await createFulfilledReviewRequests({
        storeId,
        orderExternalId: order.externalId,
        fulfilledAt: new Date(Date.now() - 1000),
        expectedInstallationGeneration: "g1",
      });
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          deliverReviewRequest(storeId, id, "g1"),
        ),
      );
      expect(
        outcomes.filter((result) => result.status === "fulfilled").length,
        outcomes
          .filter((result) => result.status === "rejected")
          .map((result) =>
            result.status === "rejected" && result.reason instanceof Error
              ? result.reason.message
              : "unknown failure",
          )
          .join("; "),
      ).toBeGreaterThan(0);
      expect(mocks.viaResend).toHaveBeenCalledTimes(
        provider === "resend" ? 1 : 0,
      );
      expect(mocks.viaSmtp).toHaveBeenCalledTimes(provider === "smtp" ? 1 : 0);
      const delivered =
        provider === "resend"
          ? mocks.viaResend.mock.calls[0][0][0]
          : mocks.viaSmtp.mock.calls[0][0];
      expect(delivered).toMatchObject({
        from: "Reviews <reviews@example.test>",
        replyTo: "noreply",
      });
      const sent = await prisma.weleticReviewRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(sent.status).toBe("sent");
      expect(sent.deliveryAttempts).toBe(1);
      expect(sent.encryptedDeliveryToken).toBeNull();
    },
  );
  it("clears stale worker authority when an invitation expires", async () => {
    const order = await purchase();
    const request = await invitation(order);
    await prisma.weleticReviewRequest.update({
      where: { id: request.id },
      data: {
        status: "sending",
        sendAt: new Date(Date.now() - 86400000),
        expiresAt: new Date(Date.now() - 1000),
        deliveryToken: "expired-worker",
        deliveryReservedAt: new Date(Date.now() - 180000),
        deliveryLeaseExpiresAt: new Date(Date.now() - 60000),
      },
    });
    await deliverReviewRequest(storeId, request.id, "g1");
    expect(
      await prisma.weleticReviewRequest.findUniqueOrThrow({
        where: { id: request.id },
      }),
    ).toMatchObject({
      status: "expired",
      tokenHash: null,
      encryptedDeliveryToken: null,
      deliveryToken: null,
      deliveryLeaseExpiresAt: null,
    });
    expect(mocks.viaSmtp).not.toHaveBeenCalled();
    expect(mocks.viaResend).not.toHaveBeenCalled();
  });

  it("finalizes a slow successful transport by its winning token even if the lease clock elapsed", async () => {
    const order = await purchase();
    const [id] = await createFulfilledReviewRequests({
      storeId,
      orderExternalId: order.externalId,
      fulfilledAt: new Date(Date.now() - 1000),
      expectedInstallationGeneration: "g1",
    });
    mocks.viaSmtp.mockImplementation(async () => {
      await prisma.weleticReviewRequest.update({
        where: { id },
        data: { deliveryLeaseExpiresAt: new Date(0) },
      });
      return { messageId: "accepted-late" };
    });
    await deliverReviewRequest(storeId, id, "g1");
    await deliverReviewRequest(storeId, id, "g1");
    expect(mocks.viaSmtp).toHaveBeenCalledTimes(1);
    expect(
      (await prisma.weleticReviewRequest.findUniqueOrThrow({ where: { id } }))
        .status,
    ).toBe("sent");
  });
  it("does not let an old email worker finalize another token", async () => {
    const order = await purchase();
    const [id] = await createFulfilledReviewRequests({
      storeId,
      orderExternalId: order.externalId,
      fulfilledAt: new Date(Date.now() - 1000),
      expectedInstallationGeneration: "g1",
    });
    mocks.viaSmtp.mockImplementation(async () => {
      await prisma.weleticReviewRequest.update({
        where: { id },
        data: { deliveryToken: "new-winner" },
      });
      return { messageId: "old-worker" };
    });
    await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow(
      "lease lost",
    );
    const current = await prisma.weleticReviewRequest.findUniqueOrThrow({
      where: { id },
    });
    expect(current.deliveryToken).toBe("new-winner");
    expect(current.status).toBe("sending");
    await prisma.weleticReviewRequest.update({
      where: { id },
      data: {
        status: "cancelled",
        deliveryToken: null,
        deliveryLeaseExpiresAt: null,
        encryptedDeliveryToken: null,
        tokenHash: null,
      },
    });
  });
  it("rolls back review points, account caches, and their Flow job together", async () => {
    const reviewId = `rollback-review-${run}`;
    const before = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    let rolledBackJobId: string | undefined;
    await expect(
      withReviewMutation(storeId, async (tx) => {
        const result = await awardVerifiedReviewPoints({
          tx,
          storeId,
          provider: "native",
          accountIdentity: { shopperId },
          review: {
            id: reviewId,
            body: "An honest review of my verified purchase.",
            rating: 1,
            productId: "gid://shopify/Product/1234",
            hasPhoto: false,
            hasVideo: false,
            verifiedStatus: "verified-purchase",
          },
        });
        expect(result.status).toBe("awarded");
        const award = await tx.weleticPointsLedgerEntry.findUniqueOrThrow({
          where: {
            storeId_idempotencyKey: {
              storeId,
              idempotencyKey: `review:native:${storeId}:${reviewId}`,
            },
          },
        });
        const job = await tx.weleticLoyaltyOutboxJob.findUniqueOrThrow({
          where: {
            storeId_idempotencyKey: {
              storeId,
              idempotencyKey: `flow_trigger:weletic-points-earned:${award.id}`,
            },
          },
        });
        rolledBackJobId = job.id;
        expect(job.payload).toMatchObject({ installationGeneration: "g1" });
        throw new Error("Injected failure after review award and Flow enqueue");
      }),
    ).rejects.toThrow("Injected failure after review award and Flow enqueue");
    if (!rolledBackJobId)
      throw new Error("Expected the Flow job before rollback");
    expect(
      await prisma.weleticPointsLedgerEntry.count({
        where: {
          storeId,
          referenceType: "REVIEW_NATIVE",
          referenceId: reviewId,
        },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticLoyaltyOutboxJob.findUnique({
        where: { id: rolledBackJobId },
      }),
    ).toBeNull();
    expect(
      await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
        where: { id: accountId },
      }),
    ).toEqual(before);
  });
  it("concurrently publishes one review with one generation-bound Flow event and never re-emits after reversal", async () => {
    const request = await invitation(await purchase());
    const created = await submitNativeReview(storeId, input(request.token));
    const flowCountBefore = await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId, jobType: "FLOW_TRIGGER" },
    });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        moderateNativeReview(storeId, created.id, "owner-test", {
          version: 1,
          status: "published",
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await prisma.weleticPointsLedgerEntry.count({
        where: {
          storeId,
          referenceType: "REVIEW_NATIVE",
          referenceId: created.id,
        },
      }),
    ).toBe(1);
    const award = await prisma.weleticPointsLedgerEntry.findUniqueOrThrow({
      where: {
        storeId_idempotencyKey: {
          storeId,
          idempotencyKey: `review:native:${storeId}:${created.id}`,
        },
      },
    });
    const flowJobs = await prisma.weleticLoyaltyOutboxJob.findMany({
      where: {
        storeId,
        jobType: "FLOW_TRIGGER",
        idempotencyKey: `flow_trigger:weletic-points-earned:${award.id}`,
      },
    });
    expect(flowJobs).toHaveLength(1);
    expect(flowJobs[0].payload).toEqual({
      accountId,
      handle: "weletic-points-earned",
      pointsDelta: award.pointsDelta.toString(),
      pointsBalance: award.balanceAfter.toString(),
      reason: "verified_review",
      orderId: null,
      installationGeneration: "g1",
    });
    await appendPointsLedgerEntry({
      storeId,
      accountId,
      entryType: "MANUAL_ADJUSTMENT",
      pointsDelta: BigInt(-150),
      referenceType: "DB_TEST",
      referenceId: created.id,
      idempotencyKey: `spend-${created.id}`,
      reason: "Isolated negative-balance fixture",
    });
    const before = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    await moderateNativeReview(storeId, created.id, "owner-test", {
      version: 2,
      status: "hidden",
    });
    await moderateNativeReview(storeId, created.id, "owner-test", {
      version: 3,
      status: "published",
    });
    const after = await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: accountId },
    });
    expect(after.cachedPointsBalance).toBe(
      before.cachedPointsBalance - BigInt(100),
    );
    expect(after.cachedPointsBalance < BigInt(0)).toBe(true);
    expect(
      (
        await prisma.weleticProductReview.findUniqueOrThrow({
          where: { id: created.id },
        })
      ).rewardStatus,
    ).toBe("reversed");
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({
        where: { storeId, jobType: "FLOW_TRIGGER" },
      }),
    ).toBe(flowCountBefore + 1);
  });
  it("keeps a partial-quantity refund eligible and cancels after the last purchased unit is refunded", async () => {
    const order = await purchase();
    const request = await invitation(order);
    await prisma.weleticCommerceOrder.update({
      where: { id: order.id },
      data: { status: "partially_refunded" },
    });
    for (let refundNumber = 1; refundNumber <= 2; refundNumber++) {
      const id = `refund-${order.id}-${refundNumber}`;
      await prisma.weleticCommerceRefund.create({
        data: {
          id,
          storeId,
          orderId: order.id,
          externalId: id,
          presentmentCurrency: "USD",
          shopCurrency: "USD",
          accountingCurrency: "USD",
          presentmentAmount: 100,
          shopAmount: 100,
          accountingAmount: 100,
          accountingFxRate: new Prisma.Decimal(1),
          occurredAt: new Date(),
          lines: {
            create: {
              id: `line-${id}`,
              orderLineId: order.lineId,
              externalId: `line-${id}`,
              quantity: 1,
              presentmentAmount: 100,
              shopAmount: 100,
              accountingAmount: 100,
            },
          },
        },
      });
      await cancelIneligibleReviewRequests(storeId, order.id, false, {
        expectedInstallationGeneration: "g1",
      });
      if (refundNumber === 1)
        expect(
          await getReviewRequestPreview(storeId, request.token),
        ).toMatchObject({ productTitle: "Review fixture product" });
    }
    await expect(
      getReviewRequestPreview(storeId, request.token),
    ).rejects.toThrow("unavailable");
    expect(
      await prisma.weleticReviewRequest.findUniqueOrThrow({
        where: { id: request.id },
      }),
    ).toMatchObject({ status: "cancelled", tokenHash: null });
  });

  it("paginates published reviews with stable rating/time/id cursors and rejects changed filter scope", async () => {
    const reviewIds: string[] = [];
    for (const rating of [1, 1, 5]) {
      const request = await invitation(await purchase());
      const review = await submitNativeReview(storeId, {
        ...input(request.token),
        rating,
      });
      // Seed publication only; this read-service test does not simulate an award.
      await prisma.weleticProductReview.update({
        where: { id: review.id },
        data: {
          status: "published",
          createdAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      reviewIds.push(review.id);
    }
    const query = { productId: "1234", sort: "lowest", limit: 1 };
    const first = await getPublicProductReviews(storeId, query);
    expect(first.nextCursor).toBeTruthy();
    await expect(
      getPublicProductReviews(storeId, {
        ...query,
        rating: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toThrow("Invalid review cursor");
    const items = [...first.items];
    let cursor = first.nextCursor;
    while (cursor && items.length < 20) {
      const page = await getPublicProductReviews(storeId, { ...query, cursor });
      items.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(new Set(items.map((row) => row.id)).size).toBe(items.length);
    expect(items.map((row) => row.id)).toEqual(
      expect.arrayContaining(reviewIds),
    );
    expect(items.map((row) => row.rating)).toEqual(
      items.map((row) => row.rating).sort((a, b) => a - b),
    );
    for (const row of items) {
      expect(row).not.toHaveProperty("shopperId");
      expect(row).not.toHaveProperty("requestId");
    }
  });

  it("invalidates a fully refunded invitation at the real request boundary", async () => {
    const order = await purchase();
    const request = await invitation(order);
    await prisma.weleticCommerceOrder.update({
      where: { id: order.id },
      data: { status: "refunded" },
    });
    await cancelIneligibleReviewRequests(storeId, order.id, false, {
      expectedInstallationGeneration: "g1",
    });
    await expect(
      submitNativeReview(storeId, input(request.token)),
    ).rejects.toThrow("unavailable");
    expect(
      (
        await prisma.weleticReviewRequest.findUniqueOrThrow({
          where: { id: request.id },
        })
      ).status,
    ).toBe("cancelled");
  });
  it("does not write a photo when privacy revokes its row before upload lock acquisition", async () => {
    for (const key of [
      "STORAGE_ENDPOINT",
      "STORAGE_PRIVATE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ])
      vi.stubEnv(key, "isolated-fixture");
    const request = await invitation(await purchase());
    const png = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    mocks.beforeMediaLock = async () => {
      await prisma.weleticReviewMedia.updateMany({
        where: { storeId, requestId: request.id },
        data: { status: "deleted" },
      });
    };
    await expect(
      uploadReviewPhoto(storeId, request.token, png, "image/png"),
    ).rejects.toThrow("revoked");
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it("scrubs customer content and tokens while retaining append-only rewards", async () => {
    const ledgerCount = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    while ((await redactNativeReviewsBatch(storeId, shopperId)).hasMore) {
      /* Drain bounded test pages. */
    }
    expect(
      await prisma.weleticReviewRequest.count({
        where: { storeId, tokenHash: { not: null } },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticProductReview.count({
        where: { storeId, status: { not: "redacted" } },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticProductReview.count({
        where: { storeId, body: { not: "" } },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledgerCount);
  });
});
