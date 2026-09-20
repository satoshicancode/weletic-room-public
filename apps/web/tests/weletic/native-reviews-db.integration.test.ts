import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { awardVerifiedReviewPoints } from "@/lib/weletic/loyalty/review-rewards";
import {
  generateReviewToken,
  hashReviewToken,
} from "@/lib/weletic/reviews/contracts";
import { clearExpiredReviewDeliveryEvidence } from "@/lib/weletic/reviews/delivery-retention";
import { deliverReviewRequest } from "@/lib/weletic/reviews/email";
import { reviewFlowCandidateWhere } from "@/lib/weletic/reviews/flow-candidates";
import {
  fulfillProductReviewPointsIncentive,
  reviewIncentivePointsKey,
} from "@/lib/weletic/reviews/incentive-points";
import { createReviewIncentivePolicyRevision } from "@/lib/weletic/reviews/incentive-policy";
import { uploadReviewPhoto } from "@/lib/weletic/reviews/media";
import { moderateReviewWithAuditInTransaction } from "@/lib/weletic/reviews/moderation-audit";
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
import { upsertShopifyCustomerPrivacyTombstones } from "@/lib/weletic/shopify/privacy-identity";
import { Prisma } from "@prisma/client";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
vi.mock("@dub/email/resend", () => ({
  resendCredentialIdentity: "e".repeat(64),
  isResendCredentialCurrent: () => true,
  get resend() {
    return mocks.resend;
  },
}));
vi.mock("@dub/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dub/email")>()),
  sendPreparedResendEmail: (request: unknown, key: string) =>
    mocks.viaResend([request], { idempotencyKey: key }),
  sendBatchEmailViaResend: mocks.viaResend,
  sendEmailViaResend: vi.fn(),
}));
vi.mock("@dub/email/send-via-nodemailer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dub/email/send-via-nodemailer")>()),
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

async function crashReviewWriter(
  reviewId: string,
  phase: "before_commit" | "after_commit",
  claimId?: string,
) {
  const resolve = createRequire(import.meta.url).resolve;
  const child = fork(
    fileURLToPath(new URL("./fixtures/review-crash-child.ts", import.meta.url)),
    [],
    {
      cwd: process.cwd(),
      execArgv: [
        "--conditions=react-server",
        "--import",
        resolve("tsx"),
        "--import",
        fileURLToPath(
          new URL(
            "../../scripts/runtime/async-local-storage.cjs",
            import.meta.url,
          ),
        ),
      ],
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DATABASE_URL: process.env.DATABASE_URL,
        LOYALTY_DATABASE_INTEGRATION: "1",
        ENCRYPTION_KEY: Buffer.alloc(32, 0x37).toString("base64"),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("close", (_code, signal) => resolve(signal));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Crash barrier timed out")),
        15000,
      );
      child.once("error", () =>
        reject(new Error("Crash worker failed to start")),
      );
      child.once("exit", () => reject(new Error("Crash worker exited early")));
      child.once("message", (message) => {
        if ((message as { phase?: string })?.phase === phase) resolve();
        else
          reject(new Error("Crash worker did not reach the requested phase"));
      });
      child.send({
        phase,
        storeId,
        reviewId,
        claimId,
        operation: claimId ? "points" : "moderation",
      });
    });
    expect(child.kill("SIGKILL")).toBe(true);
    expect(await exited).toBe("SIGKILL");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await exited;
  }
}

async function purchase(buyerId = shopperId) {
  const externalId = String(++sequence);
  const id = `order-${run}-${externalId}`;
  await prisma.weleticCommerceOrder.create({
    data: {
      id,
      storeId,
      programId,
      shopperId: buyerId,
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

  it.each(["before_commit", "after_commit"] as const)(
    "recovers moderation after a real process crash %s without a duplicate audit",
    async (phase) => {
      const request = await invitation(await purchase());
      const review = await submitNativeReview(storeId, input(request.token));
      await crashReviewWriter(review.id, phase);
      const read = () =>
        prisma.weleticProductReview.findFirst({
          where: { id: review.id, storeId },
          select: { version: true, merchantReply: true },
        });
      const audits = () =>
        prisma.weleticReviewModerationAudit.count({
          where: { reviewId: review.id, storeId },
        });
      const retry = () =>
        withReviewMutation(
          storeId,
          (tx, generation) =>
            moderateReviewWithAuditInTransaction({
              tx,
              storeId,
              generation,
              actor: { kind: "workspace", userId: "synthetic-crash-operator" },
              input: {
                reviewId: review.id,
                version: 1,
                merchantReply: "One durable reply",
                reason: "merchant_reply",
              },
            }),
          "g1",
        );
      if (phase === "before_commit") {
        expect(await read()).toEqual({ version: 1, merchantReply: null });
        expect(await audits()).toBe(0);
        expect(await retry()).toMatchObject({ version: 2 });
      } else {
        expect(await read()).toEqual({
          version: 2,
          merchantReply: "One durable reply",
        });
        expect(await audits()).toBe(1);
        // A lost response is not proof of rollback. The existing revision fence
        // rejects a blind replay; an authenticated read reconciles the result.
        await expect(retry()).rejects.toMatchObject({ code: "conflict" });
      }
      expect(await read()).toEqual({
        version: 2,
        merchantReply: "One durable reply",
      });
      expect(await audits()).toBe(1);
    },
  );

  it.each(["before_commit", "after_commit"] as const)(
    "reconciles review points after a real process crash %s with one award and outbox pair",
    async (phase) => {
      const buyerId = `crash-buyer-${run}-${phase}`;
      const buyerAccountId = `crash-account-${run}-${phase}`;
      // Above Number.MAX_SAFE_INTEGER, but within the signed ledger range.
      const points = "9007199254740993";
      await prisma.weleticShopper.create({
        data: {
          id: buyerId,
          storeId,
          shopifyCustomerId: String(++sequence),
          email: `crash-${phase}@example.test`,
        },
      });
      await prisma.weleticLoyaltyAccount.create({
        data: {
          id: buyerAccountId,
          storeId,
          shopperId: buyerId,
          programId: loyaltyProgramId,
          status: "suspended",
        },
      });
      const policy = await createReviewIncentivePolicyRevision(storeId, {
        kind: "points",
        basePoints: points,
        photoBonusPoints: "0",
        videoBonusPoints: "0",
        maxPoints: points,
      });
      const request = await invitation(await purchase(buyerId));
      // Fixture binds a synthetic promise; disclosure, activation and email
      // acceptance are outside this crash test.
      await prisma.weleticReviewRequest.update({
        where: { id: request.id },
        data: { incentivePolicyId: policy.id },
      });
      const review = await submitNativeReview(storeId, input(request.token));
      const claim = await prisma.weleticReviewIncentiveClaim.findFirstOrThrow({
        where: { storeId, sourceReviewId: review.id },
      });
      expect(claim.status).toBe("reserved");
      await prisma.weleticLoyaltyAccount.update({
        where: { id: buyerAccountId },
        data: { status: "active" },
      });
      const readState = async () => ({
        account: await prisma.weleticLoyaltyAccount.findUniqueOrThrow({
          where: { id: buyerAccountId },
          select: {
            cachedPointsBalance: true,
            cachedPendingPoints: true,
            lifetimePointsEarned: true,
            ledgerVersion: true,
          },
        }),
        claim: await prisma.weleticReviewIncentiveClaim.findUniqueOrThrow({
          where: { id: claim.id },
          select: { status: true },
        }),
        review: await prisma.weleticProductReview.findUniqueOrThrow({
          where: { id: review.id },
          select: { rewardStatus: true, rewardLedgerId: true },
        }),
        ledger: await prisma.weleticPointsLedgerEntry.findMany({
          where: { storeId, accountId: buyerAccountId },
          select: {
            id: true,
            pointsDelta: true,
            pendingDelta: true,
            referenceType: true,
            referenceId: true,
            idempotencyKey: true,
          },
        }),
        jobs: await prisma.weleticLoyaltyOutboxJob.findMany({
          where: {
            storeId,
            jobType: { in: ["FLOW_TRIGGER", "TIER_REVIEW"] },
            payload: { path: "$.accountId", equals: buyerAccountId },
          },
          orderBy: { idempotencyKey: "asc" },
          select: { jobType: true, idempotencyKey: true, payload: true },
        }),
        // Independent SQL aggregation, not the application's balance helper.
        sums: await prisma.$queryRaw<
          Array<{ points: string; pending: string }>
        >`
          SELECT CAST(COALESCE(SUM(pointsDelta), 0) AS CHAR) AS points,
                 CAST(COALESCE(SUM(pendingDelta), 0) AS CHAR) AS pending
          FROM WeleticPointsLedgerEntry
          WHERE storeId = ${storeId} AND accountId = ${buyerAccountId}
        `,
      });
      const original = await readState();
      expect(original.account).toEqual({
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        ledgerVersion: 0,
      });
      expect(original.ledger).toEqual([]);
      expect(original.jobs).toEqual([]);
      expect(original.sums).toEqual([{ points: "0", pending: "0" }]);

      await crashReviewWriter(review.id, phase, claim.id);
      const afterCrash = await readState();
      if (phase === "before_commit") expect(afterCrash).toEqual(original);
      const recovered = await fulfillProductReviewPointsIncentive({
        storeId,
        claimId: claim.id,
        expectedInstallationGeneration: "g1",
      });
      expect(recovered.status).toBe(
        phase === "before_commit" ? "fulfilled" : "already_fulfilled",
      );
      const final = await readState();
      if (phase === "after_commit") expect(final).toEqual(afterCrash);
      expect(final.account).toEqual({
        cachedPointsBalance: BigInt(points),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(points),
        ledgerVersion: 1,
      });
      expect(final.claim.status).toBe("fulfilled");
      expect(final.ledger).toHaveLength(1);
      const ledger = final.ledger[0];
      expect(ledger).toMatchObject({
        pointsDelta: BigInt(points),
        pendingDelta: BigInt(0),
        referenceType: "REVIEW_INCENTIVE",
        referenceId: claim.id,
        idempotencyKey: reviewIncentivePointsKey(claim.id),
      });
      expect(final.review).toEqual({
        rewardStatus: "awarded",
        rewardLedgerId: ledger.id,
      });
      expect(final.sums).toEqual([{ points, pending: "0" }]);
      expect(final.jobs).toHaveLength(2);
      expect(final.jobs[0]).toMatchObject({
        jobType: "FLOW_TRIGGER",
        idempotencyKey: `flow_trigger:weletic-points-earned:${ledger.id}`,
        payload: {
          accountId: buyerAccountId,
          pointsDelta: points,
          pointsBalance: points,
          installationGeneration: "g1",
        },
      });
      expect(final.jobs[1]).toMatchObject({
        jobType: "TIER_REVIEW",
        idempotencyKey: `tier_review:${buyerAccountId}:${reviewIncentivePointsKey(claim.id)}`,
        payload: { accountId: buyerAccountId, installationGeneration: "g1" },
      });
    },
  );

  it.each([
    "enabled",
    "disabled",
    "missing",
    "suspended",
    "frozen",
    "redacted",
  ])(
    "keeps malformed Flow JSON selectable with %s review authority",
    async (state) => {
      const prefix = `flow-json-${run}-${state}`;
      const originalSettings =
        await prisma.weleticReviewSettings.findUniqueOrThrow({
          where: { storeId },
        });
      const payloads = [
        {},
        Prisma.JsonNull,
        "scalar",
        { handle: null },
        { handle: 42 },
        { handle: {} },
        { handle: ["weletic-review-submitted"] },
        { handle: "weletic-points-earned" },
        { handle: "weletic-review-submitted" },
        { handle: "weletic-review-published" },
      ];
      try {
        if (state === "missing")
          await prisma.weleticReviewSettings.delete({ where: { storeId } });
        if (state === "disabled")
          await prisma.weleticReviewSettings.update({
            where: { storeId },
            data: { enabled: false },
          });
        if (state === "suspended")
          await prisma.weleticShopifyStore.update({
            where: { id: storeId },
            data: { storeAccessState: "suspended" },
          });
        if (state === "frozen" || state === "redacted")
          await prisma.weleticShopifyStore.update({
            where: { id: storeId },
            data: { complianceState: state },
          });
        await prisma.weleticLoyaltyOutboxJob.createMany({
          data: payloads.map((payload, index) => ({
            id: `${prefix}-${index}`,
            storeId,
            jobType: "FLOW_TRIGGER",
            payload,
            idempotencyKey: `${prefix}-${index}`,
            scheduledFor: new Date(0),
          })),
        });
        const found = await prisma.weleticLoyaltyOutboxJob.findMany({
          where: {
            storeId,
            id: { startsWith: prefix },
            AND: reviewFlowCandidateWhere(),
          },
          select: { id: true },
          orderBy: { id: "asc" },
        });
        const count = state === "enabled" || state === "redacted" ? 10 : 8;
        expect(found.map(({ id }) => id).sort()).toEqual(
          Array.from(
            { length: count },
            (_, index) => `${prefix}-${index}`,
          ).sort(),
        );
      } finally {
        await prisma.weleticLoyaltyOutboxJob.deleteMany({
          where: { storeId, id: { startsWith: prefix } },
        });
        await prisma.weleticShopifyStore.update({
          where: { id: storeId },
          data: { storeAccessState: "active", complianceState: "active" },
        });
        await prisma.weleticReviewSettings.upsert({
          where: { storeId },
          update: originalSettings,
          create: originalSettings,
        });
      }
    },
  );

  it.each(["disabled", "suspended", "frozen"])(
    "selects active work behind a full older %s Reviews Flow page",
    async (state) => {
      const prefix = `flow-fair-${run}-${state}`;
      try {
        if (state === "disabled")
          await prisma.weleticReviewSettings.update({
            where: { storeId },
            data: { enabled: false },
          });
        if (state === "suspended")
          await prisma.weleticShopifyStore.update({
            where: { id: storeId },
            data: { storeAccessState: "suspended" },
          });
        if (state === "frozen")
          await prisma.weleticShopifyStore.update({
            where: { id: storeId },
            data: { complianceState: "frozen" },
          });
        await prisma.weleticLoyaltyOutboxJob.createMany({
          data: Array.from({ length: 101 }, (_, index) => ({
            id: `${prefix}-${index}`,
            storeId,
            jobType: "FLOW_TRIGGER",
            payload: {
              handle:
                index < 100
                  ? index % 2
                    ? "weletic-review-submitted"
                    : "weletic-review-published"
                  : "weletic-points-earned",
            },
            idempotencyKey: `${prefix}-${index}`,
            scheduledFor: new Date(index < 100 ? 0 : 1),
          })),
        });
        const found = await prisma.weleticLoyaltyOutboxJob.findMany({
          where: {
            storeId,
            id: { startsWith: prefix },
            status: { in: ["pending", "failed"] },
            scheduledFor: { lte: new Date() },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
            AND: reviewFlowCandidateWhere(),
          },
          orderBy: [{ priority: "desc" }, { scheduledFor: "asc" }],
          take: 50,
          select: { id: true },
        });
        expect(found).toEqual([{ id: `${prefix}-100` }]);
      } finally {
        await prisma.weleticLoyaltyOutboxJob.deleteMany({
          where: { storeId, id: { startsWith: prefix } },
        });
        await prisma.weleticShopifyStore.update({
          where: { id: storeId },
          data: { storeAccessState: "active", complianceState: "active" },
        });
        await prisma.weleticReviewSettings.update({
          where: { storeId },
          data: { enabled: true },
        });
      }
    },
  );

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
  it("rejects an unresolved invitation promise before preview or email reservation", async () => {
    const request = await invitation(await purchase());
    // relationMode=prisma permits a dangling scalar reference in updateMany;
    // simulate corruption rather than constructing a valid alternative promise.
    await prisma.weleticReviewRequest.updateMany({
      where: { id: request.id, storeId },
      data: { incentivePolicyId: `missing-${run}`, status: "queued" },
    });
    await expect(
      deliverReviewRequest(storeId, request.id, "g1"),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(mocks.viaResend).not.toHaveBeenCalled();
    expect(mocks.viaSmtp).not.toHaveBeenCalled();
    const retained = await prisma.weleticReviewRequest.findUniqueOrThrow({
      where: { id: request.id },
    });
    expect(retained.deliveryAttempts).toBe(0);
    expect(retained.deliveryToken).toBeNull();
    expect(retained.status).toBe("queued");
    await prisma.weleticReviewRequest.updateMany({
      where: { id: request.id, storeId },
      data: { status: "sent" },
    });
    await expect(
      getReviewRequestPreview(storeId, request.token),
    ).rejects.toMatchObject({ code: "unavailable" });
    await prisma.weleticReviewRequest.updateMany({
      where: { id: request.id, storeId },
      data: { incentivePolicyId: null },
    });
    await expect(
      getReviewRequestPreview(storeId, request.token),
    ).resolves.toMatchObject({ productTitle: "Review fixture product" });
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
      });
      expect(delivered).not.toHaveProperty("replyTo");
      const sent = await prisma.weleticReviewRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(sent.status).toBe("sent");
      expect(sent.deliveryAttempts).toBe(1);
      expect(sent.encryptedDeliveryToken).toBeNull();
      expect(sent.encryptedDeliverySnapshot).toBeNull();
    },
  );
  it.each([
    ["ja-JP", "ja", "レビューを書く", "特典はありません"],
    ["vi-VN", "vi", "Viết đánh giá", "không có thưởng"],
  ])(
    "delivers the saved none promise in %s without a generic reward offer",
    async (locale, language, action, noReward) => {
      const policy = await createReviewIncentivePolicyRevision(storeId, {
        kind: "none",
      });
      const order = await purchase();
      const [id] = await createFulfilledReviewRequests({
        storeId,
        orderExternalId: order.externalId,
        fulfilledAt: new Date(Date.now() - 1000),
        expectedInstallationGeneration: "g1",
      });
      await prisma.weleticReviewRequest.update({
        where: { id },
        data: { incentivePolicyId: policy.id },
      });
      const shopper = await prisma.weleticShopper.findUniqueOrThrow({
        where: { id: shopperId },
      });
      await prisma.weleticShopper.update({
        where: { id: shopperId },
        data: { locale },
      });
      try {
        await deliverReviewRequest(storeId, id, "g1");
        expect(mocks.viaSmtp).toHaveBeenCalledTimes(1);
        const message = mocks.viaSmtp.mock.calls[0][0];
        const html = message.html;
        expect(message.text).toContain(noReward);
        expect(message.text).toContain(action);
        expect(message.text).toContain(`?locale=${language}#token=`);
        expect(html).toContain(noReward);
        expect(html).toContain(action);
        expect(message.text).not.toContain("Any available loyalty reward");
        expect(html).not.toContain("Any available loyalty reward");
      } finally {
        await prisma.weleticShopper.update({
          where: { id: shopperId },
          data: { locale: shopper.locale },
        });
      }
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
  it("persists before network I/O and retries exactly the original Resend body", async () => {
    mocks.resend = {};
    const order = await purchase();
    const [id] = await createFulfilledReviewRequests({
      storeId,
      orderExternalId: order.externalId,
      fulfilledAt: new Date(Date.now() - 1000),
      expectedInstallationGeneration: "g1",
    });
    mocks.viaResend.mockImplementationOnce(async () => {
      const retained = await prisma.weleticReviewRequest.findUniqueOrThrow({
        where: { id },
      });
      expect(retained.status).toBe("sending");
      expect(retained.encryptedDeliverySnapshot).toBeTruthy();
      expect(retained.encryptedDeliverySnapshot).not.toContain("@example.test");
      throw new Error("ambiguous provider response");
    });
    await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow(
      "transport unavailable",
    );
    const original = mocks.viaResend.mock.calls[0];
    const shopper = await prisma.weleticShopper.findUniqueOrThrow({
      where: { id: shopperId },
    });
    await prisma.weleticShopper.update({
      where: { id: shopperId },
      data: { locale: "ja-JP" },
    });
    try {
      await deliverReviewRequest(storeId, id, "g1");
      expect(mocks.viaResend).toHaveBeenCalledTimes(2);
      expect(mocks.viaResend.mock.calls[1]).toEqual(original);
      expect(
        await prisma.weleticReviewRequest.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        status: "sent",
        deliveryAttempts: 2,
        encryptedDeliverySnapshot: null,
        encryptedDeliveryToken: null,
      });
    } finally {
      await prisma.weleticShopper.update({
        where: { id: shopperId },
        data: { locale: shopper.locale },
      });
    }
  });
  it("does not resend an ambiguous SMTP attempt or an old attempt without retained evidence", async () => {
    const order = await purchase();
    const [id] = await createFulfilledReviewRequests({
      storeId,
      orderExternalId: order.externalId,
      fulfilledAt: new Date(Date.now() - 1000),
      expectedInstallationGeneration: "g1",
    });
    mocks.viaSmtp.mockRejectedValueOnce(new Error("ambiguous SMTP"));
    await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow(
      "transport unavailable",
    );
    await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow(
      "evidence is unavailable",
    );
    expect(mocks.viaSmtp).toHaveBeenCalledTimes(1);
    await prisma.weleticReviewRequest.update({
      where: { id },
      data: { encryptedDeliverySnapshot: null },
    });
    await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow(
      "reconciliation required",
    );
    expect(mocks.viaSmtp).toHaveBeenCalledTimes(1);
  });
  it("refuses changed recipients and clears retained bodies on cancellation", async () => {
    mocks.resend = {};
    const order = await purchase();
    const [id] = await createFulfilledReviewRequests({
      storeId,
      orderExternalId: order.externalId,
      fulfilledAt: new Date(Date.now() - 1000),
      expectedInstallationGeneration: "g1",
    });
    mocks.viaResend.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow();
    const shopper = await prisma.weleticShopper.findUniqueOrThrow({
      where: { id: shopperId },
    });
    await prisma.weleticShopper.update({
      where: { id: shopperId },
      data: { email: "changed@example.test" },
    });
    try {
      await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow(
        "evidence is unavailable",
      );
      expect(mocks.viaResend).toHaveBeenCalledTimes(1);
      await prisma.weleticReviewRequest.update({
        where: { id },
        data: { expiresAt: new Date(0) },
      });
      await deliverReviewRequest(storeId, id, "g1");
      expect(
        await prisma.weleticReviewRequest.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({
        status: "expired",
        encryptedDeliverySnapshot: null,
        encryptedDeliveryToken: null,
      });
    } finally {
      await prisma.weleticShopper.update({
        where: { id: shopperId },
        data: { email: shopper.email },
      });
    }
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
  it("concurrently publishes once and republishes without repeating the points-award Flow event", async () => {
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
    ).toBe(flowCountBefore + 3);
    const publicationJobs = await prisma.weleticLoyaltyOutboxJob.findMany({
      where: {
        storeId,
        jobType: "FLOW_TRIGGER",
        AND: [
          { payload: { path: "$.handle", equals: "weletic-review-published" } },
          { payload: { path: "$.reviewId", equals: created.id } },
        ],
      },
    });
    expect(publicationJobs).toHaveLength(2);
    expect(
      publicationJobs
        .map((job) => (job.payload as { version: number }).version)
        .sort(),
    ).toEqual([2, 4]);
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({
        where: {
          storeId,
          idempotencyKey: `flow_trigger:weletic-points-earned:${award.id}`,
        },
      }),
    ).toBe(1);
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
  it.each([
    ["customer", false],
    ["customer", true],
    ["email", false],
    ["email", true],
  ] as const)(
    "suppresses unlinked %s tombstones before sending (retry=%s)",
    async (identity, retry) => {
      mocks.resend = {};
      const order = await purchase();
      const [id] = await createFulfilledReviewRequests({
        storeId,
        orderExternalId: order.externalId,
        fulfilledAt: new Date(Date.now() - 1000),
        expectedInstallationGeneration: "g1",
      });
      if (retry) {
        mocks.viaResend.mockRejectedValueOnce(new Error("ambiguous"));
        await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow();
      }
      const shopper = await prisma.weleticShopper.findUniqueOrThrow({
        where: { id: shopperId },
      });
      const tombstones = await upsertShopifyCustomerPrivacyTombstones({
        storeId,
        ...(identity === "customer"
          ? { shopifyCustomerId: shopper.shopifyCustomerId }
          : { email: shopper.email }),
      });
      try {
        expect(tombstones.length).toBeGreaterThan(0);
        expect(
          tombstones.every(
            (row) => row.shopperId === null && row.accountId === null,
          ),
        ).toBe(true);
        mocks.viaResend.mockClear();
        await deliverReviewRequest(storeId, id, "g1");
        expect(mocks.viaResend).not.toHaveBeenCalled();
        expect(mocks.viaSmtp).not.toHaveBeenCalled();
        expect(
          await prisma.weleticReviewRequest.findUniqueOrThrow({
            where: { id },
          }),
        ).toMatchObject({
          status: "cancelled",
          encryptedDeliverySnapshot: null,
          encryptedDeliveryToken: null,
          tokenHash: null,
        });
      } finally {
        await prisma.weleticShopifyCustomerPrivacyTombstone.deleteMany({
          where: { storeId, id: { in: tombstones.map((row) => row.id) } },
        });
      }
    },
  );
  it("independently erases expired dead-letter evidence with bounded racing sweeps and no resend", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const order = await purchase();
      const [id] = await createFulfilledReviewRequests({
        storeId,
        orderExternalId: order.externalId,
        fulfilledAt: new Date(Date.now() - 1000),
        expectedInstallationGeneration: "g1",
      });
      mocks.viaSmtp.mockRejectedValueOnce(new Error("ambiguous"));
      await expect(deliverReviewRequest(storeId, id, "g1")).rejects.toThrow();
      ids.push(id);
    }
    const now = new Date();
    await prisma.weleticReviewRequest.update({
      where: { id: ids[0] },
      data: {
        expiresAt: new Date(now.getTime() - 1000),
        installationGeneration: "retired-generation",
      },
    });
    await prisma.weleticLoyaltyOutboxJob.updateMany({
      where: { storeId, idempotencyKey: `review_request_email:${ids[0]}` },
      data: { status: "dead_letter" },
    });
    await prisma.weleticReviewRequest.update({
      where: { id: ids[1] },
      data: { expiresAt: new Date(now.getTime() + 60000) },
    });
    await prisma.weleticReviewRequest.update({
      where: { id: ids[2] },
      data: {
        expiresAt: new Date(now.getTime() - 500),
        deliveryLeaseExpiresAt: new Date(now.getTime() + 10000),
      },
    });
    const results = await Promise.all([
      clearExpiredReviewDeliveryEvidence({ batchSize: 1, now }),
      clearExpiredReviewDeliveryEvidence({ batchSize: 1, now }),
    ]);
    expect(results.reduce((sum, result) => sum + result.cleared, 0)).toBe(1);
    expect(results.every((result) => result.scanned <= 1)).toBe(true);
    const erased = await prisma.weleticReviewRequest.findUniqueOrThrow({
      where: { id: ids[0] },
    });
    expect(erased).toMatchObject({
      status: "expired",
      encryptedDeliverySnapshot: null,
      encryptedDeliveryToken: null,
      tokenHash: null,
      deliveryAttempts: 1,
      lastError: "email_delivery_expired_unreconciled",
    });
    expect(
      (
        await prisma.weleticLoyaltyOutboxJob.findFirstOrThrow({
          where: { storeId, idempotencyKey: `review_request_email:${ids[0]}` },
        })
      ).status,
    ).toBe("dead_letter");
    for (const id of ids.slice(1))
      expect(
        (await prisma.weleticReviewRequest.findUniqueOrThrow({ where: { id } }))
          .encryptedDeliverySnapshot,
      ).toBeTruthy();
    expect(
      await clearExpiredReviewDeliveryEvidence({
        batchSize: 1,
        now: new Date(now.getTime() + 20000),
      }),
    ).toMatchObject({ cleared: 1 });
    expect(
      (
        await prisma.weleticReviewRequest.findUniqueOrThrow({
          where: { id: ids[2] },
        })
      ).encryptedDeliverySnapshot,
    ).toBeNull();
    expect(
      (
        await prisma.weleticReviewRequest.findUniqueOrThrow({
          where: { id: ids[1] },
        })
      ).encryptedDeliverySnapshot,
    ).toBeTruthy();
    await deliverReviewRequest(storeId, ids[0], "g1");
    expect(mocks.viaSmtp).toHaveBeenCalledTimes(3);
  });
  it("binds fulfillment invitations across cutovers without rewriting existing order promises", async () => {
    const settings = await prisma.weleticReviewSettings.findUniqueOrThrow({
      where: { storeId },
    });
    const fulfill = (order: Awaited<ReturnType<typeof purchase>>) =>
      createFulfilledReviewRequests({
        storeId,
        orderExternalId: order.externalId,
        fulfilledAt: new Date(),
        expectedInstallationGeneration: "g1",
      });
    const legacy = await purchase();
    const [legacyRequestId] = await fulfill(legacy);
    const first = await createReviewIncentivePolicyRevision(storeId, {
      kind: "points",
      basePoints: "100",
      photoBonusPoints: "0",
      videoBonusPoints: "0",
      maxPoints: "100",
    });
    const second = await createReviewIncentivePolicyRevision(storeId, {
      kind: "none",
    });
    const start = new Date("2025-01-01T00:00:00.000Z");
    const stop = new Date("2025-02-01T00:00:00.000Z");
    // Synthetic historical cutovers: the actual authenticated writer is covered
    // separately in review-policy-db; this suite exercises fulfillment readers.
    try {
      for (const [policy, effectiveAt, previousPolicyId] of [
        [first, start, settings.activeIncentivePolicyId],
        [second, stop, first.id],
      ] as const) {
        await prisma.weleticReviewIncentiveActivation.create({
          data: {
            id: `activation-${policy.id}`,
            storeId,
            policyId: policy.id,
            policyRevision: policy.revision,
            contentDigest: policy.contentDigest,
            effectiveAt,
            previousPolicyId,
            appId: "native-isolated",
            installationGeneration: "g1",
            shopifyUserId: "12345",
            merchantActionId: `action-${policy.id}`,
          },
        });
      }
      await prisma.weleticReviewSettings.update({
        where: { storeId },
        data: { activeIncentivePolicyId: second.id },
      });
      for (const [time, expectedPolicy] of [
        [new Date(start.getTime() - 1), settings.activeIncentivePolicyId],
        [start, first.id],
        [new Date(stop.getTime() - 1), first.id],
        [stop, second.id],
      ] as const) {
        const order = await purchase();
        await prisma.weleticCommerceOrder.update({
          where: { id: order.id },
          data: { occurredAt: time },
        });
        const [id] = await fulfill(order);
        expect(id).toBeTruthy();
        expect(await fulfill(order)).toEqual([id]);
        expect(
          await prisma.weleticReviewRequest.findUnique({ where: { id } }),
        ).toMatchObject({ incentivePolicyId: expectedPolicy });
        expect(
          await prisma.weleticLoyaltyOutboxJob.count({
            where: { storeId, idempotencyKey: `review_request_email:${id}` },
          }),
        ).toBe(1);
      }
      const additionalProductId = `extra-${run}`;
      await prisma.weleticShopifyProduct.create({
        data: {
          id: additionalProductId,
          storeId,
          programId,
          externalId: "gid://shopify/Product/5678",
          handle: "extra",
          title: "Extra product",
        },
      });
      await prisma.weleticCommerceOrderLine.create({
        data: {
          id: `extra-${legacy.lineId}`,
          externalId: `extra-${legacy.externalId}`,
          orderId: legacy.id,
          productId: additionalProductId,
          title: "Extra product",
          quantity: 1,
          shopGross: 100,
          shopNet: 100,
          presentmentGross: 100,
          presentmentNet: 100,
          accountingNet: 100,
          commissionableAccountingAmount: 100,
        },
      });
      const legacyIds = await fulfill(legacy);
      expect(legacyIds).toHaveLength(2);
      expect(legacyIds).toContain(legacyRequestId);
      const requests = await prisma.weleticReviewRequest.findMany({
        where: { storeId, orderId: legacy.id },
      });
      expect(
        requests.every(
          (r) => r.incentivePolicyId === settings.activeIncentivePolicyId,
        ),
      ).toBe(true);
    } finally {
      await prisma.weleticReviewIncentiveActivation.deleteMany({
        where: { storeId },
      });
      await prisma.weleticReviewSettings.update({
        where: { storeId },
        data: { activeIncentivePolicyId: settings.activeIncentivePolicyId },
      });
    }
  });

  it("scrubs customer content and tokens while retaining append-only rewards", async () => {
    const order = await purchase();
    const [cancelledId] = await createFulfilledReviewRequests({
      storeId,
      orderExternalId: order.externalId,
      fulfilledAt: new Date(Date.now() - 1000),
      expectedInstallationGeneration: "g1",
    });
    mocks.viaSmtp.mockRejectedValueOnce(new Error("ambiguous"));
    await expect(
      deliverReviewRequest(storeId, cancelledId, "g1"),
    ).rejects.toThrow();
    await prisma.weleticReviewRequest.update({
      where: { id: cancelledId },
      data: { status: "cancelled" },
    });
    expect(
      (
        await prisma.weleticReviewRequest.findUniqueOrThrow({
          where: { id: cancelledId },
        })
      ).encryptedDeliverySnapshot,
    ).toBeTruthy();
    const ledgerCount = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    const otherBuyers = ["before_commit", "after_commit"].map(
      (phase) => `crash-buyer-${run}-${phase}`,
    );
    const readOtherState = async () => ({
      reviews: await prisma.weleticProductReview.findMany({
        where: { storeId, shopperId: { in: otherBuyers } },
        orderBy: { id: "asc" },
      }),
      requests: await prisma.weleticReviewRequest.findMany({
        where: { storeId, shopperId: { in: otherBuyers } },
        orderBy: { id: "asc" },
      }),
      accounts: await prisma.weleticLoyaltyAccount.findMany({
        where: { storeId, shopperId: { in: otherBuyers } },
        orderBy: { id: "asc" },
      }),
      claims: await prisma.weleticReviewIncentiveClaim.findMany({
        where: { storeId, shopperId: { in: otherBuyers } },
        orderBy: { id: "asc" },
      }),
      ledger: await prisma.weleticPointsLedgerEntry.findMany({
        where: { storeId, account: { shopperId: { in: otherBuyers } } },
        orderBy: { id: "asc" },
      }),
    });
    const otherState = await readOtherState();
    for (const records of Object.values(otherState))
      expect(records).toHaveLength(2);
    while ((await redactNativeReviewsBatch(storeId, shopperId)).hasMore) {
      /* Drain bounded test pages. */
    }
    expect(
      await prisma.weleticReviewRequest.count({
        where: { storeId, shopperId, tokenHash: { not: null } },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticReviewRequest.count({
        where: { storeId, shopperId, encryptedDeliverySnapshot: { not: null } },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticProductReview.count({
        where: { storeId, shopperId, status: { not: "redacted" } },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticProductReview.count({
        where: { storeId, shopperId, body: { not: "" } },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledgerCount);
    expect(await readOtherState()).toEqual(otherState);
  });
});
