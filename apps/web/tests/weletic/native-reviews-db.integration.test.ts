import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { awardVerifiedReviewPoints } from "@/lib/weletic/loyalty/review-rewards";
import { upsertWeleticShopper } from "@/lib/weletic/loyalty/shopper";
import { scrubWeleticShopperCustomerContext } from "@/lib/weletic/loyalty/shopper-privacy";
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
import {
  cleanupReviewPhoto,
  getPublicReviewPhoto,
  uploadReviewPhoto,
} from "@/lib/weletic/reviews/media";
import { moderateReviewWithAuditInTransaction } from "@/lib/weletic/reviews/moderation-audit";
import { redactNativeReviewsBatch } from "@/lib/weletic/reviews/privacy";
import { backfillReviewOwnerPrivacyPage } from "@/lib/weletic/reviews/privacy-owner-backfill";
import {
  buildReviewPrivacyOwnerProjection,
  reviewPrivacyKeySetDigest,
} from "@/lib/weletic/reviews/privacy-owner-contract";
import { redactReviewOwnerPrivacyProjection } from "@/lib/weletic/reviews/privacy-owner-redact";
import { replaceReviewOwnerPrivacyProjection } from "@/lib/weletic/reviews/privacy-owner-write";
import {
  buildReviewPublicPrivacySql,
  buildStoreReviewPublicPrivacySql,
} from "@/lib/weletic/reviews/privacy-public-sql";
import { inspectReviewPrivacyReaderCoverage } from "@/lib/weletic/reviews/privacy-readiness";
import { reconcileReviewPrivacySourcePage } from "@/lib/weletic/reviews/privacy-source-reconciliation";
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
import {
  purgeStoreReviewsBatch,
  redactStoreReviewsBatch,
} from "@/lib/weletic/reviews/store-privacy";
import { getPublicStoreReviews } from "@/lib/weletic/reviews/store-public";
import { syncProductReviewSummary } from "@/lib/weletic/reviews/summary-sync";
import { withReviewMutation } from "@/lib/weletic/reviews/transaction";
import { reviewTranslationExportSelection } from "@/lib/weletic/reviews/translation-export";
import { readReviewTranslationsInTransaction } from "@/lib/weletic/reviews/translation-read";
import { writeReviewTranslationInTransaction } from "@/lib/weletic/reviews/translation-write";
import {
  readShopifyMerchantReviewTranslations,
  writeShopifyMerchantReviewTranslation,
} from "@/lib/weletic/shopify/merchant-review-translations";
import {
  loadShopifyPrivacyHmacKeyring,
  upsertShopifyCustomerPrivacyTombstones,
} from "@/lib/weletic/shopify/privacy-identity";
import {
  auditShopifyPrivacyKeyRetirement,
  auditShopifyPrivacyKeyRetirementBatch,
  type ShopifyPrivacyKeyRetirementAuditCursor,
} from "@/lib/weletic/shopify/privacy-key-retirement-audit";
import type { ShopifyMerchantActorEnvelope } from "@/lib/weletic/shopify/staff-contract";
import { Prisma } from "@prisma/client";
import { fork, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  signedDownload: vi.fn(),
  headPrivate: vi.fn(),
  readPrivate: vi.fn(),
  summaryGraphql: vi.fn(),
  summaryCredentials: vi.fn(),
  beforeMediaLock: null as null | (() => Promise<void>),
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >()),
  resolveShopifyOfflineCredentials: mocks.summaryCredentials,
  shopifyAdminGraphqlRequest: mocks.summaryGraphql,
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
  storage: {
    upload: mocks.upload,
    delete: mocks.delete,
    getSignedDownloadUrl: mocks.signedDownload,
    headPrivateR2Object: mocks.headPrivate,
    readPrivateR2Object: mocks.readPrivate,
  },
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

async function purchase(buyerId = shopperId, itemProductId = productId) {
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
          productId: itemProductId,
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
    // This fixture bypasses production ingestion; establish its private owner
    // coverage explicitly before exercising public readers.
    await prisma.$transaction((tx) =>
      replaceReviewOwnerPrivacyProjection({
        tx,
        storeId,
        shopperId,
        installationGeneration: "g1",
      }),
    );
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
    mocks.headPrivate.mockReset().mockResolvedValue(null);
    mocks.signedDownload
      .mockReset()
      .mockResolvedValue("https://storage.invalid/synthetic-private-download");
    mocks.beforeMediaLock = null;
    mocks.summaryCredentials.mockReset().mockResolvedValue({
      shopDomain: "isolated-summary.myshopify.com",
      accessToken: "synthetic-not-a-credential",
    });
    mocks.summaryGraphql.mockReset().mockResolvedValue({
      metafieldsSet: { userErrors: [] },
      metafieldsDelete: { userErrors: [] },
    });
  });
  afterAll(async () => {
    if (safeDatabase) await prisma.$disconnect();
    vi.unstubAllEnvs();
  });

  it("store review privacy: discovers store-only owners and detects orphan sources", async () => {
    const owner = `zz-store-owner-${run}-1`;
    const reviewId = `store-only-${run}`;
    await prisma.weleticShopper.create({
      data: {
        id: owner,
        storeId,
        shopifyCustomerId: String(++sequence),
        email: "store-only@example.test",
      },
    });
    await prisma.weleticStoreReview.create({
      data: {
        id: reviewId,
        storeId,
        shopperId: owner,
        source: "open",
        status: "published",
        rating: 1,
        title: "Store only",
        body: "Feedback without product participation",
        displayName: "Buyer",
        locale: "en",
      },
    });
    const checkpoint = {
      storeId,
      installationGeneration: "g1",
      keySetDigest: reviewPrivacyKeySetDigest(),
      afterShopperId: `zz-store-owner-${run}-0`,
    };
    const inspect = () =>
      reconcileReviewPrivacySourcePage({
        storeId,
        installationGeneration: "g1",
        checkpoint,
        limit: 1,
      });
    await prisma.weleticStoreReviewSettings.create({
      data: {
        id: `store-settings-${run}`,
        storeId,
      },
    });
    const privacy = buildStoreReviewPublicPrivacySql({
      storeId,
      installationGeneration: "g1",
    });
    const counts = async () => {
      const rows = await prisma.$queryRaw<
        Array<{ eligible: bigint; unknown: bigint; suppressed: bigint }>
      >(Prisma.sql`
        SELECT SUM(CASE WHEN ${privacy.eligible} THEN 1 ELSE 0 END) AS eligible,
          SUM(CASE WHEN ${privacy.unknown} THEN 1 ELSE 0 END) AS unknown,
          SUM(CASE WHEN ${privacy.suppressed} THEN 1 ELSE 0 END) AS suppressed
        FROM ${privacy.from} WHERE r.storeId = ${storeId}`);
      return Object.fromEntries(
        Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]),
      );
    };
    expect(await counts()).toEqual({ eligible: 0, unknown: 0, suppressed: 0 });
    await prisma.weleticStoreReviewSettings.update({
      where: { storeId },
      data: { enabled: true },
    });
    expect(await counts()).toEqual({ eligible: 0, unknown: 1, suppressed: 0 });
    await expect(getPublicStoreReviews(storeId, {})).rejects.toThrow(
      "Store reviews unavailable",
    );
    expect((await inspect()).counts.missing).toBe(1);
    expect(
      await backfillReviewOwnerPrivacyPage({
        ...checkpoint,
        checkpoint,
        limit: 1,
      }),
    ).toMatchObject({ projected: 1 });
    expect((await inspect()).counts.matched).toBe(1);
    expect(await counts()).toEqual({ eligible: 1, unknown: 0, suppressed: 0 });
    const visible = await getPublicStoreReviews(storeId, {});
    expect(visible.summary).toMatchObject({ count: 1, average: 1 });
    expect(visible.items).toEqual([
      expect.objectContaining({
        id: reviewId,
        verifiedPurchase: false,
        incentivized: false,
      }),
    ]);
    expect(visible.items[0]).not.toHaveProperty("shopperId");
    expect(visible.items[0]).not.toHaveProperty("requestId");
    const identity =
      await prisma.weleticReviewOwnerPrivacyIdentity.findFirstOrThrow({
        where: { storeId, shopperId: owner, identityKind: "customer_email" },
      });
    await prisma.weleticShopifyCustomerPrivacyTombstone.create({
      data: {
        id: `store-tombstone-${run}`,
        storeId,
        identityKind: identity.identityKind,
        identityKeyId: identity.identityKeyId,
        customerDigest: identity.customerDigest,
        redactedAt: new Date(),
        expiresAt: new Date("2040-01-01"),
      },
    });
    expect(await counts()).toEqual({ eligible: 0, unknown: 0, suppressed: 1 });
    expect(await getPublicStoreReviews(storeId, {})).toMatchObject({
      summary: { count: 0, average: null },
      items: [],
      nextCursor: null,
    });
    const scan = () =>
      reconcileReviewPrivacySourcePage({
        storeId,
        installationGeneration: "g1",
      });
    const before = (await scan()).orphanReviews!;
    await prisma.$executeRaw`UPDATE WeleticStoreReview SET shopperId = ${`missing-${run}`} WHERE id = ${reviewId}`;
    expect((await scan()).orphanReviews).toBe(before + 1);
    await prisma.weleticStoreReview.delete({ where: { id: reviewId } });
    await prisma.weleticStoreReviewSettings.update({
      where: { storeId },
      data: { enabled: false },
    });
  });

  it("store review privacy: detects orphan invitations before any submitted review", async () => {
    const { id: orderId } = await purchase();
    const requestId = `store-orphan-invitation-${run}`;
    await prisma.weleticStoreReviewRequest.create({
      data: {
        id: requestId,
        storeId,
        shopperId,
        orderId,
        installationGeneration: "g1",
        settingsRevision: 1,
        fulfilledAt: new Date(),
        sendAt: new Date(),
        expiresAt: new Date("2040-01-01"),
      },
    });
    const inspect = () =>
      reconcileReviewPrivacySourcePage({
        storeId,
        installationGeneration: "g1",
      });
    const before = (await inspect()).orphanRequests!;
    await prisma.$executeRaw`UPDATE WeleticStoreReviewRequest SET shopperId = ${`absent-${run}`} WHERE id = ${requestId}`;
    expect((await inspect()).orphanRequests).toBe(before + 1);
    await prisma.weleticStoreReviewRequest.delete({ where: { id: requestId } });
  });

  it("store review privacy: pages tied timestamps and filters without leaking owner fields", async () => {
    await prisma.weleticStoreReviewSettings.upsert({
      where: { storeId },
      create: { id: `store-settings-${run}`, storeId, enabled: true },
      update: { enabled: true },
    });
    const prefix = `store-page-${run}`;
    const rows = [1, 2, 3].map((n) => ({
      id: `${prefix}-${n}`,
      storeId,
      shopperId,
      source: "open" as const,
      status: "published" as const,
      rating: n,
      title: `Feedback ${n}`,
      body: "Original store feedback",
      displayName: "Buyer",
      locale: "en",
      createdAt: new Date("2026-01-01"),
    }));
    await prisma.weleticStoreReview.createMany({ data: rows });
    const first = await getPublicStoreReviews(storeId, { limit: 1 });
    expect(first.summary).toMatchObject({ count: 3, average: 2 });
    expect(first.items.map((r) => r.id)).toEqual([`${prefix}-3`]);
    const next = await getPublicStoreReviews(storeId, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(next.items.map((r) => r.id)).toEqual([`${prefix}-2`, `${prefix}-1`]);
    expect(next.nextCursor).toBeNull();
    const filtered = await getPublicStoreReviews(storeId, { rating: 1 });
    expect(filtered.items.map((r) => r.id)).toEqual([`${prefix}-1`]);
    expect(filtered.summary.count).toBe(3);
    await expect(
      getPublicStoreReviews(storeId, { rating: 1, cursor: first.nextCursor }),
    ).rejects.toThrow("Invalid store review cursor");
    await prisma.weleticStoreReview.deleteMany({
      where: { storeId, id: { in: rows.map((r) => r.id) } },
    });
    await prisma.weleticStoreReviewSettings.update({
      where: { storeId },
      data: { enabled: false },
    });
  });

  it("store review privacy: rolls back source changes on SQL failure and drains bounded pages", async () => {
    const owner = `store-erasure-${run}`;
    await prisma.weleticShopper.create({
      data: { id: owner, storeId, shopifyCustomerId: String(++sequence) },
    });
    const rows = Array.from({ length: 21 }, (_, n) => ({
      id: `store-erasure-${run}-${String(n).padStart(2, "0")}`,
      storeId,
      shopperId: owner,
      source: "open" as const,
      rating: 2,
      title: "Private source",
      body: "Private store feedback before erasure",
      displayName: "Buyer",
      locale: "en",
    }));
    await prisma.weleticStoreReview.createMany({ data: rows });
    const scope = { kind: "customer" as const, storeId, shopperId: owner };
    await expect(
      prisma.$transaction(async (tx) => {
        await redactStoreReviewsBatch(tx, scope);
        await tx.weleticStoreReview.create({ data: rows[0] });
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await prisma.weleticStoreReview.count({
        where: {
          storeId,
          shopperId: owner,
          redactedAt: null,
          title: "Private source",
          version: 1,
        },
      }),
    ).toBe(21);
    expect(
      await prisma.$transaction((tx) => redactStoreReviewsBatch(tx, scope)),
    ).toEqual({ hasMore: true });
    expect(
      await prisma.weleticStoreReview.count({
        where: {
          storeId,
          shopperId: owner,
          redactedAt: { not: null },
          title: "",
          body: "",
          displayName: "Redacted customer",
        },
      }),
    ).toBe(20);
    expect(
      await prisma.$transaction((tx) => redactStoreReviewsBatch(tx, scope)),
    ).toEqual({ hasMore: false });
    const after = await prisma.weleticStoreReview.findMany({
      where: { storeId, shopperId: owner },
      orderBy: { id: "asc" },
    });
    await prisma.$transaction((tx) => redactStoreReviewsBatch(tx, scope));
    expect(
      await prisma.weleticStoreReview.findMany({
        where: { storeId, shopperId: owner },
        orderBy: { id: "asc" },
      }),
    ).toEqual(after);
    expect(
      await prisma.weleticStoreReview.count({
        where: { storeId, shopperId: owner, incentivized: true },
      }),
    ).toBe(0);
    await expect(
      prisma.$transaction((tx) => purgeStoreReviewsBatch(tx, storeId)),
    ).rejects.toThrow("frozen store");
    await prisma.weleticStoreReview.deleteMany({
      where: { storeId, shopperId: owner },
    });
  });

  it("review owner privacy: bounded multi-tenant query plans and public load", async () => {
    const { verifyReviewPrivacyLoad } = await import(
      "./helpers/review-privacy-load"
    );
    await verifyReviewPrivacyLoad({ run });
  }, 120_000);

  it("review owner privacy: retirement audit paginates orphan identities without skipped enum boundaries", async () => {
    const envName = "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS";
    const previous = process.env[envName];
    const baseline = loadShopifyPrivacyHmacKeyring();
    const currentKey = "audit-fixture-current";
    const retiredKey = "audit-fixture-previous";
    const orphanStores = [`audit-a-${run}`, `audit-b-${run}`];
    const rows = orphanStores.flatMap((storeId) =>
      ["owner-a", "owner-b"].flatMap((shopperId) =>
        (["customer_id", "customer_email"] as const).flatMap((identityKind) =>
          [currentKey, retiredKey].map((identityKeyId) => ({
            storeId,
            shopperId,
            identityKind,
            identityKeyId,
            customerDigest: "C".repeat(64),
          })),
        ),
      ),
    );
    try {
      vi.stubEnv(
        envName,
        [
          { identityKeyId: currentKey, secret: Buffer.alloc(32, 0x71) },
          { identityKeyId: retiredKey, secret: Buffer.alloc(32, 0x72) },
          ...baseline.all,
        ]
          .map((key) => `${key.identityKeyId}:${key.secret.toString("base64")}`)
          .join(","),
      );
      // relationMode=prisma has no SQL FKs. Synthetic orphan proofs must be
      // found without joining to coverage, owner or store records.
      await prisma.weleticReviewOwnerPrivacyIdentity.createMany({ data: rows });
      expect(
        await prisma.weleticShopifyStore.count({
          where: { id: { in: orphanStores } },
        }),
      ).toBe(0);
      expect(
        await prisma.weleticReviewOwnerPrivacyCoverage.count({
          where: { storeId: { in: orphanStores } },
        }),
      ).toBe(0);
      const expected = rows
        .filter((row) => row.identityKeyId === retiredKey)
        .map((row) =>
          JSON.stringify([
            row.storeId,
            row.shopperId,
            row.identityKind,
            row.identityKeyId,
          ]),
        )
        .sort();
      const independentCount =
        await prisma.weleticReviewOwnerPrivacyIdentity.count();
      for (const batchSize of [1, 2, 3, 7]) {
        // Source 12 is appended after the existing checkpoint-compatible sources.
        let cursor: ShopifyPrivacyKeyRetirementAuditCursor | null = {
          sourceIndex: 12,
        };
        const seen: string[] = [];
        let scanned = 0;
        let pages = 0;
        while (cursor) {
          expect(++pages).toBeLessThan(100);
          const page = await auditShopifyPrivacyKeyRetirementBatch({
            retiringKeyIds: [retiredKey],
            cursor,
            batchSize,
          });
          expect(page.scanned).toBeLessThanOrEqual(batchSize);
          scanned += page.scanned;
          for (const finding of page.dependencies) {
            expect(finding.source).toBe("review_owner_identities");
            expect(finding.keyId).toBe(retiredKey);
            seen.push(...finding.sampleRecordIds);
          }
          cursor = page.cursor;
        }
        expect(scanned).toBe(independentCount);
        // At most four previous-key rows per page, below the five-sample bound.
        expect(seen.sort()).toEqual(expected);
      }
      const audit = await auditShopifyPrivacyKeyRetirement({
        retiringKeyIds: [retiredKey],
        retiringKeyLastWriteAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
        writersFenced: true,
        batchSize: 3,
      });
      expect(audit.ready).toBe(false);
      expect(audit.cacheOverlapSatisfied).toBe(true);
      expect(
        audit.dependencies.find(
          (finding) => finding.source === "review_owner_identities",
        ),
      ).toMatchObject({ keyId: retiredKey, count: expected.length });
      expect(JSON.stringify(audit)).not.toContain("C".repeat(64));
    } finally {
      await prisma.weleticReviewOwnerPrivacyIdentity.deleteMany({
        where: { storeId: { in: orphanStores } },
      });
      vi.stubEnv(envName, previous);
    }
  });

  it("review owner privacy: bounded backfill resumes and contains only authoritative suppression", async () => {
    const owners = [`backfill-a-${run}`, `backfill-b-${run}`];
    const ids = [String(++sequence), String(++sequence)];
    for (const [index, owner] of owners.entries()) {
      await prisma.weleticShopper.create({
        data: {
          id: owner,
          storeId,
          shopifyCustomerId: ids[index],
          email: `backfill-${index}@example.test`,
        },
      });
      const request = await invitation(await purchase(owner));
      await submitNativeReview(storeId, input(request.token));
    }
    const scope = {
      storeId,
      installationGeneration: "g1",
      keySetDigest: reviewPrivacyKeySetDigest(loadShopifyPrivacyHmacKeyring()),
      limit: 1,
      audit: {
        runId: "6cfbe2b9-a0ae-4a20-a3c2-85392075b98e",
        operatorReference: "isolated_test",
      },
    };
    // Disposable schema only: force a database-side audit failure after the
    // projection writes, then independently prove transaction rollback.
    await prisma.$executeRawUnsafe(
      "ALTER TABLE WeleticReviewPrivacyBackfillAudit ADD CONSTRAINT review_privacy_audit_failure CHECK (operatorReference <> 'isolated_test')",
    );
    try {
      await expect(backfillReviewOwnerPrivacyPage(scope)).rejects.toThrow(
        "review_privacy_audit_failure",
      );
      expect(
        await prisma.weleticReviewOwnerPrivacyCoverage.count({
          where: { storeId, shopperId: owners[0] },
        }),
      ).toBe(0);
      expect(
        await prisma.weleticReviewOwnerPrivacyIdentity.count({
          where: { storeId, shopperId: owners[0] },
        }),
      ).toBe(0);
      expect(
        await prisma.weleticReviewPrivacyBackfillAudit.count({
          where: { storeId, runId: scope.audit.runId },
        }),
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        "ALTER TABLE WeleticReviewPrivacyBackfillAudit DROP CHECK review_privacy_audit_failure",
      );
    }
    const first = await backfillReviewOwnerPrivacyPage(scope);
    expect(first).toMatchObject({
      projected: 1,
      suppressed: 0,
      checkpoint: { afterShopperId: owners[0] },
    });
    const checkpoint = first.checkpoint!;
    for (const value of [
      "redacted:broken",
      `redacted:v1:unavailable-key:${"A".repeat(64)}`,
    ]) {
      await prisma.weleticShopper.update({
        where: { id: owners[1] },
        data: { shopifyCustomerId: value },
      });
      await expect(
        backfillReviewOwnerPrivacyPage({ ...scope, checkpoint }),
      ).rejects.toThrow(/pseudonym/);
      expect(
        await prisma.weleticReviewOwnerPrivacyCoverage.findUnique({
          where: { storeId_shopperId: { storeId, shopperId: owners[1] } },
        }),
      ).toBeNull();
    }
    await prisma.weleticShopper.update({
      where: { id: owners[1] },
      data: { shopifyCustomerId: ids[1] },
    });
    await upsertShopifyCustomerPrivacyTombstones({
      storeId,
      email: "backfill-1@example.test",
      expiresAt: new Date("2000-01-01"),
    });
    const last = await backfillReviewOwnerPrivacyPage({ ...scope, checkpoint });
    expect(last).toEqual({ projected: 0, suppressed: 1, checkpoint: null });
    const coverage =
      await prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
        where: { storeId_shopperId: { storeId, shopperId: owners[1] } },
      });
    expect(coverage).toMatchObject({
      state: "redacted",
      identityCount: 0,
      sourceDigest: null,
      keySetDigest: null,
    });
    expect(
      await prisma.weleticReviewOwnerPrivacyIdentity.count({
        where: { storeId, shopperId: owners[1] },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticLoyaltyAccount.count({
        where: { storeId, shopperId: { in: owners } },
      }),
    ).toBe(0);
    const replay = await backfillReviewOwnerPrivacyPage({
      ...scope,
      checkpoint,
    });
    expect(replay).toEqual(last);
    const auditRows = await prisma.weleticReviewPrivacyBackfillAudit.findMany({
      where: { storeId, runId: scope.audit.runId },
    });
    expect(auditRows.map((row) => row.outcome).sort()).toEqual([
      "projected",
      "suppressed",
      "suppressed",
    ]);
    expect(
      auditRows.every(
        (row) =>
          row.operatorReference === "isolated_test" &&
          row.installationGeneration === "g1",
      ),
    ).toBe(true);
    expect(JSON.stringify(auditRows)).not.toContain(owners[0]);
    expect(JSON.stringify(auditRows)).not.toContain("@example.test");
    expect(
      (
        await prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
          where: { storeId_shopperId: { storeId, shopperId: owners[1] } },
        })
      ).redactedAt,
    ).toEqual(coverage.redactedAt);
  });

  it("review owner privacy: operator CLI previews, applies and resumes with private checkpoints", async () => {
    const directory = mkdtempSync(join(tmpdir(), "review-privacy-cli-"));
    const runId = "662b565a-9019-4e26-8c85-290c1030cf32";
    const cli = (args: string[], status = 0) => {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          fileURLToPath(
            new URL(
              "../../scripts/loyalty/backfill-review-privacy.ts",
              import.meta.url,
            ),
          ),
          "--store",
          storeId,
          "--generation",
          "g1",
          "--limit",
          "1",
          ...args,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            DATABASE_URL: process.env.DATABASE_URL,
            UPSTASH_REDIS_REST_URL: "http://127.0.0.1:1",
            UPSTASH_REDIS_REST_TOKEN: "isolated-unused-placeholder",
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, child.stderr).toBe(status);
      expect(child.stdout).not.toContain(storeId);
      expect(child.stdout).not.toContain("@example.test");
      if (status === 0) {
        expect(child.stderr).toBe("");
        return JSON.parse(child.stdout);
      }
      expect(child.stdout).toBe("");
      return null;
    };
    const auditCount = () =>
      prisma.weleticReviewPrivacyBackfillAudit.count({
        where: { storeId, runId },
      });
    try {
      const preview = cli([]);
      expect(preview).toMatchObject({
        mode: "preview",
        productionReady: false,
        preview: { selected: 1, hasMore: true },
      });
      expect(await auditCount()).toBe(0);
      const output = join(directory, "first.json");
      const applyArgs = [
        "--apply",
        "--expected-preview",
        preview.preview.digest,
        "--operator",
        "sql_fixture",
        "--run-id",
        runId,
        "--checkpoint-output",
        output,
      ];
      expect(cli(applyArgs)).toMatchObject({
        mode: "apply",
        projected: 1,
        suppressed: 0,
        hasMore: true,
      });
      expect(await auditCount()).toBe(1);
      expect(statSync(output).mode & 0o777).toBe(0o600);
      const checkpoint = JSON.parse(readFileSync(output, "utf8"));
      expect(checkpoint.storeId).toBe(storeId);
      expect(checkpoint.afterShopperId).toBe(`backfill-a-${run}`);
      cli(applyArgs, 1); // Never overwrite a completed private checkpoint.
      expect(await auditCount()).toBe(1);
      const next = cli(["--checkpoint", output]);
      cli([
        "--checkpoint",
        output,
        "--apply",
        "--expected-preview",
        next.preview.digest,
        "--operator",
        "sql_fixture",
        "--run-id",
        runId,
        "--checkpoint-output",
        join(directory, "second.json"),
      ]);
      expect(await auditCount()).toBe(2);
      cli(
        [
          "--apply",
          "--expected-preview",
          "0".repeat(64),
          "--operator",
          "sql_fixture",
          "--run-id",
          runId,
          "--checkpoint-output",
          join(directory, "failed.json"),
        ],
        1,
      );
      expect(await auditCount()).toBe(2);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("review owner privacy: independently reconciles persisted sources and exact identity proofs", async () => {
    const owner = `reconcile-${run}-1`;
    const customerId = String(++sequence);
    await prisma.weleticShopper.create({
      data: {
        id: owner,
        storeId,
        shopifyCustomerId: customerId,
        email: "reconcile@example.test",
      },
    });
    const request = await invitation(await purchase(owner));
    const submitted = await submitNativeReview(storeId, input(request.token));
    const checkpoint = {
      storeId,
      installationGeneration: "g1",
      keySetDigest: reviewPrivacyKeySetDigest(),
      afterShopperId: `reconcile-${run}-0`,
    };
    const inspect = () =>
      reconcileReviewPrivacySourcePage({
        storeId,
        installationGeneration: "g1",
        checkpoint,
        limit: 1,
      });
    expect(await inspect()).toMatchObject({
      checked: 1,
      counts: { missing: 1 },
      productionReady: false,
    });
    await prisma.$transaction((tx) =>
      replaceReviewOwnerPrivacyProjection({
        tx,
        storeId,
        shopperId: owner,
        installationGeneration: "g1",
      }),
    );
    const matched = await inspect();
    expect(matched.counts.matched).toBe(1);
    expect(JSON.stringify(matched.counts)).not.toContain(owner);
    // Simulate a legacy writer bypassing the atomic projection update. Structural
    // reader checks can miss this same-shaped stale email proof; source comparison cannot.
    await prisma.weleticShopper.update({
      where: { id: owner },
      data: { email: "changed@example.test" },
    });
    expect((await inspect()).counts.mismatched).toBe(1);
    await prisma.$transaction((tx) =>
      replaceReviewOwnerPrivacyProjection({
        tx,
        storeId,
        shopperId: owner,
        installationGeneration: "g1",
      }),
    );
    expect((await inspect()).counts.matched).toBe(1);
    const before = await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
      where: { storeId, shopperId: owner },
    });
    await prisma.weleticReviewOwnerPrivacyIdentity.updateMany({
      where: { storeId, shopperId: owner, identityKind: "customer_email" },
      data: { customerDigest: "B".repeat(64) },
    });
    expect((await inspect()).counts.mismatched).toBe(1);
    // Exact synthetic proof restoration only, not a production repair route.
    for (const row of before)
      await prisma.weleticReviewOwnerPrivacyIdentity.updateMany({
        where: {
          storeId,
          shopperId: owner,
          identityKind: row.identityKind,
          identityKeyId: row.identityKeyId,
        },
        data: { customerDigest: row.customerDigest },
      });
    await upsertShopifyCustomerPrivacyTombstones({
      storeId,
      email: "changed@example.test",
      expiresAt: new Date("2000-01-01"),
    });
    const suppressed = await inspect();
    expect(suppressed.counts.suppressedPending).toBe(1);
    // The persisted source moves again without its projection. The expired,
    // unlinked tombstone still matches the retained proof and must block rewrite.
    await prisma.weleticShopper.update({
      where: { id: owner },
      data: { email: "new-after-erasure@example.test" },
    });
    expect((await inspect()).counts.suppressedPending).toBe(1);
    await expect(
      prisma.$transaction((tx) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner,
          installationGeneration: "g1",
        }),
      ),
    ).rejects.toThrow("source suppressed");
    expect(
      await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
        where: { storeId, shopperId: owner },
      }),
    ).toEqual(before);
    await prisma.weleticShopper.update({
      where: { id: owner },
      data: { shopifyCustomerId: "redacted:broken" },
    });
    expect((await inspect()).counts.invalidSource).toBe(1);
    await prisma.weleticShopper.update({
      where: { id: owner },
      data: { shopifyCustomerId: customerId },
    });
    await expect(
      reconcileReviewPrivacySourcePage({
        storeId,
        installationGeneration: "stale",
        limit: 1,
      }),
    ).rejects.toThrow("installation unavailable");
    await expect(
      reconcileReviewPrivacySourcePage({
        storeId,
        installationGeneration: "g1",
        checkpoint: { ...checkpoint, storeId: "foreign" },
      }),
    ).rejects.toThrow("checkpoint mismatch");
    const auditBefore = await prisma.weleticReviewPrivacyBackfillAudit.count({
      where: { storeId },
    });
    for (const maxPages of [1, 100]) {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          fileURLToPath(
            new URL(
              "../../scripts/loyalty/inspect-review-privacy.ts",
              import.meta.url,
            ),
          ),
          "--store",
          storeId,
          "--generation",
          "g1",
          "--sources",
          "--page-size",
          "1",
          "--max-pages",
          String(maxPages),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            DATABASE_URL: process.env.DATABASE_URL,
            UPSTASH_REDIS_REST_URL: "http://127.0.0.1:1",
            UPSTASH_REDIS_REST_TOKEN: "isolated-unused-placeholder",
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status, child.stderr).toBe(1);
      expect(child.stderr).toBe("");
      const report = JSON.parse(child.stdout);
      expect(report).toMatchObject({
        scope: "persisted_review_owners",
        productionReady: false,
        consistentStoreSnapshot: false,
        scanComplete: maxPages === 100,
        orphanReviews: 0,
      });
      if (maxPages === 100) {
        expect(report.counts.suppressedPending).toBeGreaterThanOrEqual(1);
        const owners = await prisma.weleticShopper.count({
          where: {
            storeId,
            OR: [
              { nativeReviews: { some: { storeId } } },
              { reviewRequests: { some: { storeId } } },
              { storeReviews: { some: { storeId } } },
              { storeReviewRequests: { some: { storeId } } },
            ],
          },
        });
        expect(report.checked).toBe(owners);
        expect(report.pages).toBe(owners);
      } else expect(report.checked).toBe(1);
      expect(child.stdout).not.toContain(owner);
      expect(child.stdout).not.toContain("@example.test");
      expect(child.stdout).not.toContain(checkpoint.keySetDigest);
      expect(
        await prisma.weleticReviewPrivacyBackfillAudit.count({
          where: { storeId },
        }),
      ).toBe(auditBefore);
    }
    await prisma.weleticProductReview.updateMany({
      where: { storeId, id: submitted.id },
      data: { shopperId: `absent-${run}` },
    });
    try {
      const orphan = await reconcileReviewPrivacySourcePage({
        storeId,
        installationGeneration: "g1",
        limit: 1,
      });
      expect(orphan.orphanReviews).toBe(1);
    } finally {
      await prisma.weleticProductReview.updateMany({
        where: { storeId, id: submitted.id },
        data: { shopperId: owner },
      });
    }
  });

  it("review owner privacy: summary worker preserves unknowns, clears disabled ratings and rejects stale publication", async () => {
    const isolatedProduct = `privacy-summary-${run}`;
    const owner = `summary-owner-${run}`;
    const externalId = "gid://shopify/Product/98766";
    await prisma.weleticShopifyProduct.create({
      data: {
        id: isolatedProduct,
        storeId,
        programId,
        externalId,
        handle: "summary-isolated",
        title: "Synthetic summary fixture",
      },
    });
    await prisma.weleticShopper.create({
      data: {
        id: owner,
        storeId,
        shopifyCustomerId: String(++sequence),
        email: "summary-owner@example.test",
      },
    });
    const request = await invitation(await purchase(owner, isolatedProduct));
    const review = await submitNativeReview(storeId, input(request.token));
    await prisma.weleticProductReview.update({
      where: { id: review.id },
      data: { status: "published", rating: 4 },
    });
    const sync = () => syncProductReviewSummary(storeId, isolatedProduct, "g1");
    const inspect = () =>
      inspectReviewPrivacyReaderCoverage({
        storeId,
        installationGeneration: "g1",
      });
    const inspectProcess = (expectedStatus: number) => {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          fileURLToPath(
            new URL(
              "../../scripts/loyalty/inspect-review-privacy.ts",
              import.meta.url,
            ),
          ),
          "--store",
          storeId,
          "--generation",
          "g1",
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            DATABASE_URL: process.env.DATABASE_URL,
          },
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.signal).toBeNull();
      expect(child.status).toBe(expectedStatus);
      expect(child.stderr).toBe("");
      const result = JSON.parse(child.stdout);
      expect(result.scope).toBe("currently_publishable_reviews");
      expect(result.productionReady).toBe(false);
      expect(child.stdout).not.toContain(owner);
      expect(child.stdout).not.toContain("summary-owner@example.test");
      return result;
    };
    try {
      expect(await inspect()).toEqual({
        status: "inspected",
        readerCoverageComplete: false,
        counts: { total: 1, eligible: 0, suppressed: 0, unknown: 1 },
      });
      expect(inspectProcess(1)).toMatchObject({
        status: "inspected",
        readerCoverageComplete: false,
        counts: { unknown: 1 },
      });
      await expect(sync()).rejects.toThrow("privacy coverage unavailable");
      expect(mocks.summaryCredentials).not.toHaveBeenCalled();
      expect(mocks.summaryGraphql).not.toHaveBeenCalled();

      await prisma.weleticReviewSettings.update({
        where: { storeId },
        data: { enabled: false },
      });
      await sync();
      expect(await inspect()).toEqual({
        status: "module_disabled",
        readerCoverageComplete: false,
        counts: null,
      });
      expect(inspectProcess(1)).toMatchObject({
        status: "module_disabled",
        readerCoverageComplete: false,
      });
      expect(mocks.summaryGraphql).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variables: {
            metafields: [
              {
                ownerId: externalId,
                namespace: "reviews",
                key: "rating_count",
                type: "number_integer",
                value: "0",
              },
            ],
            delete: [
              { ownerId: externalId, namespace: "reviews", key: "rating" },
            ],
          },
        }),
      );
      await prisma.weleticReviewSettings.update({
        where: { storeId },
        data: { enabled: true },
      });
      await prisma.$transaction((tx) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner,
          installationGeneration: "g1",
        }),
      );
      await sync();
      const independent = await prisma.weleticProductReview.aggregate({
        where: { id: review.id, storeId, productId: isolatedProduct },
        _count: { rating: true },
        _sum: { rating: true },
      });
      expect(await inspect()).toEqual({
        status: "inspected",
        readerCoverageComplete: true,
        counts: { total: 1, eligible: 1, suppressed: 0, unknown: 0 },
      });
      expect(inspectProcess(0)).toMatchObject({
        status: "inspected",
        readerCoverageComplete: true,
        counts: { eligible: 1 },
      });
      expect(independent).toEqual({
        _count: { rating: 1 },
        _sum: { rating: 4 },
      });
      expect(mocks.summaryGraphql).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variables: {
            metafields: [
              {
                ownerId: externalId,
                namespace: "reviews",
                key: "rating_count",
                type: "number_integer",
                value: "1",
              },
              {
                ownerId: externalId,
                namespace: "reviews",
                key: "rating",
                type: "rating",
                value: JSON.stringify({
                  value: "4.00",
                  scale_min: "1.0",
                  scale_max: "5.0",
                }),
              },
            ],
          },
        }),
      );
      await upsertShopifyCustomerPrivacyTombstones({
        storeId,
        email: "summary-owner@example.test",
        expiresAt: new Date("2000-01-01T00:00:00Z"),
      });
      await sync();
      expect(await inspect()).toEqual({
        status: "inspected",
        readerCoverageComplete: true,
        counts: { total: 1, eligible: 0, suppressed: 1, unknown: 0 },
      });
      expect(mocks.summaryGraphql).toHaveBeenLastCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            metafields: [
              expect.objectContaining({ key: "rating_count", value: "0" }),
            ],
            delete: [
              { ownerId: externalId, namespace: "reviews", key: "rating" },
            ],
          }),
        }),
      );
      // A real database generation change during mocked credential resolution
      // must reject the stale worker before any further provider invocation.
      mocks.summaryGraphql.mockClear();
      mocks.summaryCredentials.mockImplementationOnce(async () => {
        await prisma.weleticShopifyStore.update({
          where: { id: storeId },
          data: { installationGeneration: "g-summary-reinstalled" },
        });
        return {
          shopDomain: "isolated-summary.myshopify.com",
          accessToken: "synthetic-not-a-credential",
        };
      });
      await expect(sync()).rejects.toThrow("stale_installation_generation");
      expect(mocks.summaryGraphql).not.toHaveBeenCalled();
    } finally {
      await prisma.weleticReviewSettings.update({
        where: { storeId },
        data: { enabled: true },
      });
      await prisma.weleticShopifyStore.update({
        where: { id: storeId },
        data: { installationGeneration: "g1" },
      });
    }
  });

  it("review owner privacy: key rotation preserves old tombstones and rejects same-id secret replacement", async () => {
    const envName = "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS";
    const previous = process.env[envName];
    const baseline = loadShopifyPrivacyHmacKeyring();
    const encode = (keys: typeof baseline.all) =>
      keys
        .map((key) => `${key.identityKeyId}:${key.secret.toString("base64")}`)
        .join(",");
    const owner = `rotation-${run}`;
    const isolatedProduct = `rotation-product-${run}`;
    await prisma.weleticShopifyProduct.create({
      data: {
        id: isolatedProduct,
        storeId,
        programId,
        externalId: "gid://shopify/Product/98767",
        handle: "rotation-fixture",
        title: "Rotation fixture",
      },
    });
    await prisma.weleticShopper.create({
      data: {
        id: owner,
        storeId,
        shopifyCustomerId: String(++sequence),
        email: "rotation-owner@example.test",
      },
    });
    const request = await invitation(await purchase(owner, isolatedProduct));
    const review = await submitNativeReview(storeId, input(request.token));
    await prisma.weleticProductReview.update({
      where: { id: review.id },
      data: { status: "published" },
    });
    const replace = () =>
      prisma.$transaction((tx) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner,
          installationGeneration: "g1",
        }),
      );
    const read = () => getPublicProductReviews(storeId, { productId: "98767" });
    try {
      await replace();
      expect((await read()).summary.count).toBe(1);
      const before = await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
        where: { storeId, shopperId: owner },
        orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
      });
      vi.stubEnv(
        envName,
        encode(
          baseline.all.map((key, index) =>
            index === 0 ? { ...key, secret: Buffer.alloc(32, 0x66) } : key,
          ),
        ),
      );
      await expect(read()).rejects.toMatchObject({ code: "unavailable" });
      await expect(replace()).rejects.toThrow(
        "retained identity proof mismatch",
      );
      expect(
        await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
          where: { storeId, shopperId: owner },
          orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
        }),
      ).toEqual(before);
      for (const emailOnly of [true, false]) {
        await prisma.weleticReviewOwnerPrivacyIdentity.deleteMany({
          where: {
            storeId,
            shopperId: owner,
            ...(emailOnly ? { identityKind: "customer_id" as const } : {}),
          },
        });
        const remaining =
          await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
            where: { storeId, shopperId: owner },
            orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
          });
        await expect(replace()).rejects.toThrow("anchors unavailable");
        expect(
          await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
            where: { storeId, shopperId: owner },
            orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
          }),
        ).toEqual(remaining);
      }
      // Restore only the exact synthetic rows deliberately removed above.
      await prisma.weleticReviewOwnerPrivacyIdentity.createMany({
        data: before,
      });
      const rotated = [
        {
          identityKeyId: "rotation-fixture-v2",
          secret: Buffer.alloc(32, 0x67),
        },
        ...baseline.all,
      ];
      vi.stubEnv(envName, encode(rotated));
      await expect(read()).rejects.toMatchObject({ code: "unavailable" });
      await replace();
      expect((await read()).summary.count).toBe(1);
      expect(
        await prisma.weleticReviewOwnerPrivacyIdentity.count({
          where: { storeId, shopperId: owner },
        }),
      ).toBe(rotated.length * 2);
      const newKeyProofs =
        await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
          where: {
            storeId,
            shopperId: owner,
            identityKeyId: rotated[0].identityKeyId,
          },
        });
      await prisma.weleticReviewOwnerPrivacyIdentity.deleteMany({
        where: {
          storeId,
          shopperId: owner,
          identityKeyId: rotated[0].identityKeyId,
        },
      });
      vi.stubEnv(
        envName,
        encode([
          { ...rotated[0], secret: Buffer.alloc(32, 0x68) },
          ...baseline.all,
        ]),
      );
      await expect(replace()).rejects.toThrow(
        "retained identity count mismatch",
      );
      expect(
        await prisma.weleticReviewOwnerPrivacyIdentity.count({
          where: { storeId, shopperId: owner },
        }),
      ).toBe(baseline.all.length * 2);
      await prisma.weleticReviewOwnerPrivacyIdentity.createMany({
        data: newKeyProofs,
      });
      vi.stubEnv(envName, encode(rotated));
      // Insert through the real old-key writer, then restore the new current key.
      vi.stubEnv(envName, encode(baseline.all));
      await upsertShopifyCustomerPrivacyTombstones({
        storeId,
        email: "rotation-owner@example.test",
        expiresAt: new Date("2000-01-01"),
      });
      vi.stubEnv(envName, encode(rotated));
      const tombstone =
        await prisma.weleticShopifyCustomerPrivacyTombstone.findFirstOrThrow({
          where: {
            storeId,
            identityKind: "customer_email",
            identityKeyId: baseline.current.identityKeyId,
            customerDigest: before.find(
              (row) =>
                row.identityKind === "customer_email" &&
                row.identityKeyId === baseline.current.identityKeyId,
            )!.customerDigest,
            shopperId: null,
          },
          orderBy: { createdAt: "desc" },
        });
      expect(tombstone.expiresAt.getTime()).toBeLessThan(Date.now());
      expect((await read()).summary.count).toBe(0);
      await expect(replace()).rejects.toThrow("source suppressed");
      const retainedCoverage =
        await prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
          where: { storeId_shopperId: { storeId, shopperId: owner } },
        });
      const retainedIdentities =
        await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
          where: { storeId, shopperId: owner },
          orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
        });
      vi.stubEnv(envName, encode([rotated[0]]));
      // Retained proofs still match the old-key tombstone even when that key
      // is absent from configuration; authoritative suppression takes precedence.
      await expect(replace()).rejects.toThrow("source suppressed");
      expect(
        await prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
          where: { storeId_shopperId: { storeId, shopperId: owner } },
        }),
      ).toEqual(retainedCoverage);
      expect(
        await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
          where: { storeId, shopperId: owner },
          orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
        }),
      ).toEqual(retainedIdentities);
      expect((await read()).summary.count).toBe(0);
    } finally {
      vi.stubEnv(envName, previous);
      await prisma.weleticProductReview.update({
        where: { id: review.id },
        data: { status: "hidden" },
      });
    }
  });

  it("review owner privacy: public pagination skips suppressed boundaries across sorts and rating filters", async () => {
    const isolatedProduct = `privacy-pages-${run}`;
    await prisma.weleticShopifyProduct.create({
      data: {
        id: isolatedProduct,
        storeId,
        programId,
        externalId: "gid://shopify/Product/98765",
        handle: "privacy-pages",
        title: "Privacy page fixture",
      },
    });
    const rows: Array<{
      id: string;
      rating: number;
      createdAt: Date;
      suppressed: boolean;
      owner: string;
      email: string;
    }> = [];
    const ratings = [3, 2, 5, 1, 2, 5, 4];
    for (let index = 0; index < ratings.length; index++) {
      const owner = `privacy-pages-owner-${run}-${index}`;
      const email = `privacy-pages-${index}@example.test`;
      await prisma.weleticShopper.create({
        data: {
          id: owner,
          storeId,
          shopifyCustomerId: String(++sequence),
          email,
        },
      });
      await prisma.$transaction((tx) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner,
          installationGeneration: "g1",
        }),
      );
      const invitationResult = await invitation(
        await purchase(owner, isolatedProduct),
      );
      const review = await submitNativeReview(storeId, {
        ...input(invitationResult.token),
        rating: ratings[index],
      });
      const createdAt = new Date(Date.UTC(2026, 8, 1, 0, 0, index));
      // Synthetic publication/time setup; reader and SQL transport are real.
      await prisma.weleticProductReview.update({
        where: { id: review.id },
        data: { status: "published", createdAt },
      });
      const suppressed = [0, 3, 6].includes(index);
      if (suppressed)
        await upsertShopifyCustomerPrivacyTombstones({
          storeId,
          email,
          expiresAt: new Date("2000-01-01T00:00:00Z"),
        });
      rows.push({
        id: review.id,
        rating: ratings[index],
        createdAt,
        suppressed,
        owner,
        email,
      });
    }
    for (const sort of ["newest", "highest", "lowest"] as const) {
      for (const rating of [undefined, 2, 5]) {
        const expected = rows
          .filter(
            (row) => !row.suppressed && (!rating || row.rating === rating),
          )
          .sort((a, b) => {
            const ratingOrder =
              sort === "newest"
                ? 0
                : sort === "highest"
                  ? b.rating - a.rating
                  : a.rating - b.rating;
            return (
              ratingOrder ||
              b.createdAt.getTime() - a.createdAt.getTime() ||
              b.id.localeCompare(a.id)
            );
          });
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let pageIndex = 0; pageIndex <= expected.length; pageIndex++) {
          const page = await getPublicProductReviews(storeId, {
            productId: "98765",
            sort,
            rating,
            limit: 1,
            cursor,
          });
          expect(page.summary).toEqual({
            count: 4,
            average: 3.5,
            distribution: { 1: 0, 2: 2, 3: 0, 4: 0, 5: 2 },
          });
          expect(page.items).toHaveLength(1);
          seen.push(page.items[0].id);
          for (const row of rows) {
            expect(JSON.stringify(page)).not.toContain(row.owner);
            expect(JSON.stringify(page)).not.toContain(row.email);
          }
          if (!page.nextCursor) break;
          const boundary = JSON.parse(
            Buffer.from(page.nextCursor, "base64url").toString("utf8"),
          );
          expect(rows.find((row) => row.id === boundary.id)?.suppressed).toBe(
            false,
          );
          cursor = page.nextCursor;
        }
        expect(seen).toEqual(expected.map((row) => row.id));
        expect(new Set(seen).size).toBe(seen.length);
      }
    }
  });

  it("review owner privacy: shared SQL distinguishes missing coverage and excludes retained unlinked tombstones before aggregates", async () => {
    const owner = `privacy-sql-${run}`;
    const customerId = String(++sequence);
    await prisma.weleticShopper.create({
      data: {
        id: owner,
        storeId,
        shopifyCustomerId: customerId,
        email: "sql-privacy@example.test",
      },
    });
    const request = await invitation(await purchase(owner));
    const review = await submitNativeReview(storeId, input(request.token));
    // Synthetic publication isolates this SQL predicate test from merchant UI.
    await prisma.weleticProductReview.update({
      where: { id: review.id },
      data: { status: "published" },
    });
    const mediaId = `privacy-photo-${run}`;
    await prisma.weleticReviewMedia.create({
      data: {
        id: mediaId,
        storeId,
        requestId: request.id,
        reviewId: review.id,
        objectKey: `weletic/reviews/${storeId}/${mediaId}.webp`,
        contentType: "image/webp",
        sizeBytes: 10,
        status: "uploaded",
        uploadExpiresAt: new Date(),
      },
    });
    await expect(getPublicReviewPhoto(storeId, mediaId)).rejects.toMatchObject({
      code: "not_found",
    });
    const fragments = buildReviewPublicPrivacySql({
      storeId,
      productId,
      installationGeneration: "g1",
    });
    const counts = async () => {
      const [eligible] = await prisma.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT COUNT(*) AS count FROM ${fragments.from} WHERE ${fragments.eligible} AND r.id = ${review.id}`,
      );
      const [unknown] = await prisma.$queryRaw<Array<{ count: bigint }>>(
        Prisma.sql`SELECT COUNT(*) AS count FROM ${fragments.from} WHERE ${fragments.unknown} AND r.id = ${review.id}`,
      );
      return {
        eligible: Number(eligible.count),
        unknown: Number(unknown.count),
      };
    };
    expect(await counts()).toEqual({ eligible: 0, unknown: 1 });
    await expect(
      getPublicProductReviews(storeId, { productId: "1234" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await prisma.$transaction((tx) =>
      replaceReviewOwnerPrivacyProjection({
        tx,
        storeId,
        shopperId: owner,
        installationGeneration: "g1",
      }),
    );
    expect(await counts()).toEqual({ eligible: 1, unknown: 0 });
    const storageNames = [
      "STORAGE_ENDPOINT",
      "STORAGE_PRIVATE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ];
    const previousStorage = storageNames.map((name) => process.env[name]);
    try {
      for (const name of storageNames) vi.stubEnv(name, "isolated-placeholder");
      expect(await getPublicReviewPhoto(storeId, mediaId)).toEqual({
        url: "https://storage.invalid/synthetic-private-download",
      });
      const publicPhoto = async () =>
        (
          await getPublicProductReviews(storeId, {
            productId: "1234",
            limit: 50,
          })
        ).items.find(({ id }) => id === review.id)?.media;
      expect(await publicPhoto()).toEqual([{ id: mediaId }]);
      // Deliberately malformed isolated metadata: invitation and open ownership
      // must never jointly authorize the same object, even with matching IDs.
      await prisma.weleticOpenReviewMediaOwnership.create({
        data: {
          id: `mixed-photo-${run}`,
          storeId,
          mediaId,
          shopperId: owner,
          productId,
          installationGeneration: "g1",
          source: "app_proxy",
          submissionKey: "mixed",
          idempotencyKey: `mixed-${run}`,
          contentDigest: "synthetic",
          settingsRevision: 1,
          storageWriteState: "confirmed",
        },
      });
      try {
        expect(await publicPhoto()).toEqual([]);
        await expect(
          getPublicReviewPhoto(storeId, mediaId),
        ).rejects.toMatchObject({ code: "not_found" });
        expect(mocks.signedDownload).toHaveBeenCalledTimes(1);
      } finally {
        await prisma.weleticOpenReviewMediaOwnership.delete({
          where: { mediaId },
        });
      }
    } finally {
      storageNames.forEach((name, index) =>
        vi.stubEnv(name, previousStorage[index]),
      );
    }
    expect(mocks.signedDownload).toHaveBeenCalledTimes(1);
    expect(mocks.signedDownload).toHaveBeenCalledWith({
      key: `weletic/reviews/${storeId}/${mediaId}.webp`,
      bucket: "private",
      expiresIn: 60,
    });
    const publicPage = await getPublicProductReviews(storeId, {
      productId: "1234",
    });
    expect(publicPage.items.map((row) => row.id)).toContain(review.id);
    await prisma.weleticReviewOwnerPrivacyCoverage.update({
      where: { storeId_shopperId: { storeId, shopperId: owner } },
      data: { identityCount: 1 },
    });
    expect(await counts()).toEqual({ eligible: 0, unknown: 1 });
    await expect(
      prisma.$transaction((tx) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner,
          installationGeneration: "g1",
        }),
      ),
    ).rejects.toThrow("retained identity count mismatch");
    // Restore the exact fixture marker that this test deliberately corrupted;
    // ordinary backfill is not an authority to repair ambiguous retained proofs.
    await prisma.weleticReviewOwnerPrivacyCoverage.update({
      where: { storeId_shopperId: { storeId, shopperId: owner } },
      data: {
        identityCount: await prisma.weleticReviewOwnerPrivacyIdentity.count({
          where: { storeId, shopperId: owner },
        }),
      },
    });
    await upsertShopifyCustomerPrivacyTombstones({
      storeId,
      email: "sql-privacy@example.test",
      expiresAt: new Date("2000-01-01T00:00:00Z"),
    });
    expect(await counts()).toEqual({ eligible: 0, unknown: 0 });
    await expect(getPublicReviewPhoto(storeId, mediaId)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(mocks.signedDownload).toHaveBeenCalledTimes(1);
    const suppressedPage = await getPublicProductReviews(storeId, {
      productId: "1234",
    });
    expect(suppressedPage.items.map((row) => row.id)).not.toContain(review.id);
    expect(suppressedPage.summary.count).toBe(publicPage.summary.count - 1);
    await prisma.weleticReviewMedia.update({
      where: { id: mediaId },
      data: { status: "deletion_pending" },
    });
    try {
      for (const name of storageNames) vi.stubEnv(name, "isolated-placeholder");
      await cleanupReviewPhoto(storeId, mediaId);
    } finally {
      storageNames.forEach((name, index) =>
        vi.stubEnv(name, previousStorage[index]),
      );
    }
    expect(mocks.delete).toHaveBeenCalledWith({
      key: `weletic/reviews/${storeId}/${mediaId}.webp`,
      bucket: "private",
    });
    expect(
      (
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: mediaId },
        })
      ).status,
    ).toBe("deleted");
  });

  it("review owner privacy: ingestion preserves partial identity, isolates enrollment and rejects saved-email erasure bypass", async () => {
    const customerId = String(++sequence);
    await prisma.weleticLoyaltyProgram.update({
      where: { id: loyaltyProgramId },
      data: { status: "disabled" },
    });
    try {
      const ingest = (customer: {
        id: string;
        email?: string;
        first_name?: string;
      }) =>
        upsertWeleticShopper({
          storeId,
          customer,
          expectedInstallationGeneration: "g1",
        });
      const first = await ingest({
        id: customerId,
        email: "saved-ingress@example.test",
        first_name: "Original",
      });
      expect(first).toMatchObject({
        loyaltyAccount: null,
        loyaltyAccountCreated: false,
        privacyTombstoned: false,
      });
      const owner = first!.shopper!.id;
      const read = () =>
        prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
          where: { storeId_shopperId: { storeId, shopperId: owner } },
          include: {
            identities: {
              orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
            },
          },
        });
      const original = await read();
      const partial = await ingest({ id: customerId, first_name: "Updated" });
      expect(partial?.shopper?.email).toBe("saved-ingress@example.test");
      const saved = await read();
      expect(saved.sourceDigest).toBe(original.sourceDigest);
      expect(saved.identities).toEqual(original.identities);
      expect(
        await prisma.weleticLoyaltyAccount.count({
          where: { storeId, shopperId: owner },
        }),
      ).toBe(0);
      const tombstones = await upsertShopifyCustomerPrivacyTombstones({
        storeId,
        email: "saved-ingress@example.test",
      });
      expect(
        (
          await ingest({
            id: customerId,
            email: "replacement@example.test",
            first_name: "Must not persist",
          })
        )?.privacyTombstoned,
      ).toBe(true);
      await prisma.weleticShopifyCustomerPrivacyTombstone.updateMany({
        where: { storeId, id: { in: tombstones.map((row) => row.id) } },
        data: { expiresAt: new Date("2000-01-01T00:00:00Z") },
      });
      await expect(
        ingest({
          id: customerId,
          email: "replacement@example.test",
          first_name: "Still must not persist",
        }),
      ).rejects.toThrow("Review privacy source suppressed");
      expect(
        await prisma.weleticShopper.findUniqueOrThrow({ where: { id: owner } }),
      ).toMatchObject({
        email: "saved-ingress@example.test",
        firstName: "Updated",
      });
      expect(await read()).toEqual(saved);
    } finally {
      await prisma.weleticLoyaltyProgram.update({
        where: { id: loyaltyProgramId },
        data: { status: "active" },
      });
    }
  });

  it("review owner privacy: legacy null-generation erasure needs no operational installation", async () => {
    const owner = `privacy-legacy-${run}`;
    const customerId = String(++sequence);
    await prisma.weleticShopper.create({
      data: {
        id: owner,
        storeId,
        shopifyCustomerId: customerId,
        email: "legacy@example.test",
      },
    });
    await prisma.weleticShopifyStore.update({
      where: { id: storeId },
      data: { installationGeneration: null },
    });
    try {
      await scrubWeleticShopperCustomerContext({
        storeId,
        shopifyCustomerId: customerId,
        shopperId: owner,
      });
      // Shop erasure's already-pseudonymized retry uses the same primitive.
      await prisma.$transaction((tx) =>
        redactReviewOwnerPrivacyProjection({ tx, storeId, shopperId: owner }),
      );
      expect(
        await prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
          where: { storeId_shopperId: { storeId, shopperId: owner } },
          include: { identities: true },
        }),
      ).toMatchObject({
        state: "redacted",
        installationGeneration: null,
        identityCount: 0,
        identities: [],
      });
      expect(
        await prisma.weleticShopper.findUniqueOrThrow({ where: { id: owner } }),
      ).toMatchObject({
        email: null,
        shopifyCustomerId: expect.stringMatching(/^redacted:/),
      });
    } finally {
      await prisma.weleticShopifyStore.update({
        where: { id: storeId },
        data: { installationGeneration: "g1" },
      });
    }
  });

  it("review owner privacy: source erasure, rollback and replay preserve terminal coverage without identity proofs", async () => {
    const owner = `privacy-erase-${run}`;
    const customerId = String(++sequence);
    await prisma.weleticShopper.create({
      data: {
        id: owner,
        storeId,
        shopifyCustomerId: customerId,
        email: "erase@example.test",
      },
    });
    await prisma.$transaction((tx) =>
      replaceReviewOwnerPrivacyProjection({
        tx,
        storeId,
        shopperId: owner,
        installationGeneration: "g1",
      }),
    );
    const read = () =>
      prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
        where: { storeId_shopperId: { storeId, shopperId: owner } },
        include: {
          identities: {
            orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
          },
        },
      });
    const before = await read();
    await expect(
      prisma.$transaction(async (tx) => {
        await redactReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner,
        });
        await tx.weleticShopper.update({
          where: { id: owner },
          data: { email: null },
        });
        throw new Error("synthetic source transaction failure");
      }),
    ).rejects.toThrow("synthetic source transaction failure");
    expect(await read()).toEqual(before);
    expect(
      (await prisma.weleticShopper.findUniqueOrThrow({ where: { id: owner } }))
        .email,
    ).toBe("erase@example.test");

    const redactedAt = new Date("2026-09-20T00:00:00Z");
    await scrubWeleticShopperCustomerContext({
      storeId,
      shopifyCustomerId: customerId,
      shopperId: owner,
      redactedAt,
    });
    const erased = await read();
    expect(erased).toMatchObject({
      state: "redacted",
      keySetDigest: null,
      sourceDigest: null,
      identityCount: 0,
      redactedAt,
      identities: [],
    });
    const shopper = await prisma.weleticShopper.findUniqueOrThrow({
      where: { id: owner },
    });
    expect(shopper.email).toBeNull();
    expect(shopper.shopifyCustomerId).toMatch(/^redacted:/);
    await scrubWeleticShopperCustomerContext({
      storeId,
      shopifyCustomerId: customerId,
      shopperId: owner,
      redactedAt: new Date("2026-09-21T00:00:00Z"),
    });
    expect(await read()).toMatchObject({
      state: "redacted",
      redactedAt,
      identities: [],
    });
    await expect(
      prisma.$transaction((tx) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner,
          installationGeneration: "g1",
        }),
      ),
    ).rejects.toThrow();
    expect(await read()).toMatchObject({
      state: "redacted",
      redactedAt,
      identities: [],
    });
  });

  it.each(["email", "redacted", "tombstone"] as const)(
    "review owner privacy: current reads defeat an established snapshot after %s commits",
    async (change) => {
      const owner = `privacy-owner-${run}-${change}`;
      const customerId = String(++sequence);
      const oldEmail = `before-${change}@example.test`;
      const newEmail = `after-${change}@example.test`;
      await prisma.weleticShopper.create({
        data: {
          id: owner,
          storeId,
          shopifyCustomerId: customerId,
          email: oldEmail,
        },
      });
      const replace = (tx: Prisma.TransactionClient) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: owner,
          installationGeneration: "g1",
        });
      await prisma.$transaction(replace);
      const readProjection = () =>
        prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
          where: { storeId_shopperId: { storeId, shopperId: owner } },
          include: {
            identities: {
              orderBy: [{ identityKind: "asc" }, { identityKeyId: "asc" }],
            },
          },
        });
      let beforeDenial: Awaited<ReturnType<typeof readProjection>> | undefined;
      await prisma.$transaction(
        async (tx) => {
          const initial = await tx.weleticShopper.findUniqueOrThrow({
            where: { id: owner },
          });
          expect(initial.email).toBe(oldEmail);
          expect(
            await tx.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
              where: { storeId_shopperId: { storeId, shopperId: owner } },
            }),
          ).toMatchObject({ state: "active" });
          expect(
            await tx.weleticShopifyCustomerPrivacyTombstone.count({
              where: { storeId, shopperId: owner },
            }),
          ).toBe(0);
          const [readerConnection] = await tx.$queryRaw<
            Array<{ id: bigint }>
          >`SELECT CONNECTION_ID() AS id`;
          await prisma.$transaction(async (writer) => {
            const [writerConnection] = await writer.$queryRaw<
              Array<{ id: bigint }>
            >`SELECT CONNECTION_ID() AS id`;
            expect(String(writerConnection.id)).not.toBe(
              String(readerConnection.id),
            );
            if (change === "email")
              await writer.weleticShopper.update({
                where: { id: owner },
                data: { email: newEmail },
              });
            if (change === "redacted")
              await writer.weleticReviewOwnerPrivacyCoverage.update({
                where: { storeId_shopperId: { storeId, shopperId: owner } },
                data: {
                  state: "redacted",
                  redactedAt: new Date(),
                  sourceDigest: null,
                  keySetDigest: null,
                  identityCount: 0,
                },
              });
            if (change === "tombstone")
              await upsertShopifyCustomerPrivacyTombstones({
                tx: writer,
                storeId,
                shopifyCustomerId: customerId,
              });
          });
          if (change !== "email") beforeDenial = await readProjection();
          // Prove the ordinary reader really remains stale after the other commit.
          expect(
            (
              await tx.weleticShopper.findUniqueOrThrow({
                where: { id: owner },
              })
            ).email,
          ).toBe(oldEmail);
          expect(
            (
              await tx.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
                where: { storeId_shopperId: { storeId, shopperId: owner } },
              })
            ).state,
          ).toBe("active");
          if (change === "email")
            expect(await replace(tx)).toEqual({ identityCount: 2 });
          else
            await expect(replace(tx)).rejects.toThrow(
              "Review privacy source suppressed",
            );
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
          timeout: 15000,
        },
      );
      // Denial is caught inside the transaction: commit must still preserve the
      // entire prior projection, detecting accidental writes before throwing.
      if (change !== "email")
        expect(await readProjection()).toEqual(beforeDenial);
      const coverage =
        await prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
          where: { storeId_shopperId: { storeId, shopperId: owner } },
        });
      if (change === "redacted")
        expect(coverage).toMatchObject({
          state: "redacted",
          sourceDigest: null,
          identityCount: 0,
        });
      if (change === "email") {
        const expected = buildReviewPrivacyOwnerProjection({
          storeId,
          shopperId: owner,
          installationGeneration: "g1",
          shopifyCustomerId: customerId,
          email: newEmail,
        });
        expect(coverage.sourceDigest).toBe(expected.sourceDigest);
        const identities =
          await prisma.weleticReviewOwnerPrivacyIdentity.findMany({
            where: { storeId, shopperId: owner },
            select: {
              identityKind: true,
              identityKeyId: true,
              customerDigest: true,
            },
          });
        expect(identities).toHaveLength(expected.identities.length);
        expect(identities).toEqual(expect.arrayContaining(expected.identities));
      }
    },
  );

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
  it("review transaction retries a real post-mutation deadlock with one moderation audit", async () => {
    const request = await invitation(await purchase());
    const review = await submitNativeReview(storeId, input(request.token));
    // This file is restricted to disposable test databases. The scratch table
    // deliberately inverts lock order to provoke recovery, not production use.
    await prisma.$executeRaw`CREATE TABLE ReviewDeadlockFixture (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB`;
    let releaseWriter!: () => void;
    const writerEntered = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let ready!: () => void;
    let failReady!: (error: unknown) => void;
    const competitorReady = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failReady = reject;
    });
    let competitor: Promise<void> | undefined;
    let competingError: unknown;
    let attempts = 0;
    const deadlocks: unknown[] = [];
    try {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO ReviewDeadlockFixture (id, value)
        VALUES ${Prisma.join(Array.from({ length: 1024 }, (_, index) => Prisma.sql`(${index + 1}, 0)`))}
      `);
      competitor = prisma
        .$transaction(
          async (tx) => {
            // More modified rows than the review transaction make the latter the
            // lighter rollback victim; assertions below require that actual error.
            await tx.$executeRaw`UPDATE ReviewDeadlockFixture SET value = value + 1`;
            ready();
            await writerEntered;
            await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10000,
          },
        )
        .then(
          () => undefined,
          (error) => {
            competingError = error;
            failReady(error);
          },
        );
      await competitorReady;
      const stableActor = {
        kind: "workspace" as const,
        userId: "synthetic-review-operator",
      };
      const result = await withReviewMutation(
        storeId,
        async (tx, generation) => {
          attempts++;
          const written = await moderateReviewWithAuditInTransaction({
            tx,
            storeId,
            generation,
            actor: stableActor,
            input: {
              reviewId: review.id,
              version: 1,
              merchantReply: "Committed only once",
              reason: "merchant_reply",
            },
          });
          // Both rows exist inside this attempt before it becomes the victim.
          // The retry must reuse the same actor and expected version after rollback.
          releaseWriter();
          try {
            await tx.$queryRaw`SELECT id FROM ReviewDeadlockFixture WHERE id = 1 FOR UPDATE`;
          } catch (error) {
            deadlocks.push(error);
            throw error;
          }
          return written;
        },
        "g1",
      );
      await competitor;
      expect(competingError).toBeUndefined();
      expect(attempts).toBe(2);
      expect(deadlocks).toHaveLength(1);
      expect(deadlocks[0]).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(deadlocks[0]).toMatchObject({
        code: "P2010",
        meta: { code: "1213" },
      });
      expect(result.version).toBe(2);
      expect(
        await prisma.weleticProductReview.findFirst({
          where: { storeId, id: review.id },
          select: { version: true, merchantReply: true },
        }),
      ).toEqual({ version: 2, merchantReply: "Committed only once" });
      expect(
        await prisma.weleticReviewModerationAudit.count({
          where: { storeId, reviewId: review.id },
        }),
      ).toBe(1);
    } finally {
      releaseWriter();
      await competitor;
      await prisma.$executeRaw`DROP TABLE ReviewDeadlockFixture`;
    }
  });

  async function translationFixture() {
    const request = await invitation(await purchase());
    return submitNativeReview(storeId, input(request.token));
  }
  it("manual translations: retries an actual MySQL deadlock then commits one translation audit", async () => {
    const review = await translationFixture();
    // This file is restricted to disposable test databases. The scratch table
    // deliberately inverts lock order to provoke recovery, not production use.
    await prisma.$executeRaw`CREATE TABLE ReviewTranslationDeadlockFixture (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB`;
    let releaseWriter!: () => void;
    const writerEntered = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let ready!: () => void;
    let failReady!: (error: unknown) => void;
    const competitorReady = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failReady = reject;
    });
    let competitor: Promise<void> | undefined;
    let competingError: unknown;
    let attempts = 0;
    const deadlocks: unknown[] = [];
    try {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO ReviewTranslationDeadlockFixture (id, value)
        VALUES ${Prisma.join(Array.from({ length: 1024 }, (_, index) => Prisma.sql`(${index + 1}, 0)`))}
      `);
      competitor = prisma
        .$transaction(
          async (tx) => {
            // More modified rows than the review transaction make the latter the
            // lighter rollback victim; assertions below require that actual error.
            await tx.$executeRaw`UPDATE ReviewTranslationDeadlockFixture SET value = value + 1`;
            ready();
            await writerEntered;
            await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10000,
          },
        )
        .then(
          () => undefined,
          (error) => {
            competingError = error;
            failReady(error);
          },
        );
      await competitorReady;
      const stableActor = translationActor();
      const result = await withReviewMutation(
        storeId,
        async (tx, generation) => {
          attempts++;
          const written = await writeReviewTranslationInTransaction({
            tx,
            storeId,
            generation,
            actor: stableActor,
            input: {
              action: "save",
              reviewId: review.id,
              locale: "ja",
              sourceLocale: "en",
              expectedInstallationGeneration: "g1",
              expectedReviewVersion: 1,
              expectedTranslationRevision: 0,
              title: "After deadlock",
              body: "Committed only once",
            },
          });
          // Both rows exist inside this attempt before it becomes the victim.
          // The retry must reuse the same action identity after real rollback.
          releaseWriter();
          try {
            await tx.$queryRaw`SELECT id FROM ReviewTranslationDeadlockFixture WHERE id = 1 FOR UPDATE`;
          } catch (error) {
            deadlocks.push(error);
            throw error;
          }
          return written;
        },
        "g1",
      );
      await competitor;
      expect(competingError).toBeUndefined();
      expect(attempts).toBe(2);
      expect(deadlocks).toHaveLength(1);
      expect(deadlocks[0]).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(deadlocks[0]).toMatchObject({
        code: "P2010",
        meta: { code: "1213" },
      });
      expect(result.revision).toBe(1);
      expect(
        await prisma.weleticProductReviewTranslation.count({
          where: { storeId, reviewId: review.id },
        }),
      ).toBe(1);
      expect(
        await prisma.weleticReviewTranslationAudit.count({
          where: { storeId, translation: { reviewId: review.id } },
        }),
      ).toBe(1);
    } finally {
      releaseWriter();
      await competitor;
      await prisma.$executeRaw`DROP TABLE ReviewTranslationDeadlockFixture`;
    }
  });
  it.each(["legacy", "public"] as const)(
    "manual translations: %s staff authorization and action receipt commit atomically with content",
    async (mode) => {
      const { encrypt } = await import("@/lib/encryption");
      const { SHOPIFY_INTEGRATION_ID } = await import("@dub/utils");
      const { bindShopifyOnlineSession } = await import(
        "@/lib/weletic/shopify/session-online-binding"
      );
      const review = await translationFixture();
      const shop = `${run}.myshopify.com`;
      const appId = "translation-auth-sql";
      const installationId = `translation-install-${run}`;
      const admissionId = `translation-admission-${run}`;
      const sessionIds = [`offline_${shop}`, `${shop}_123`, `${shop}_456`];
      const previousAppId = process.env.SHOPIFY_API_KEY;
      vi.stubEnv("SHOPIFY_API_KEY", appId);
      const actor = async (
        owner: boolean,
      ): Promise<ShopifyMerchantActorEnvelope> => {
        const userId = owner ? "123" : "456";
        const sessionId = `${shop}_${userId}`;
        const expiresAt = new Date(Date.now() + 3600000);
        const binding = { appId, shop, storeId, installationGeneration: "g1" };
        const payload = encrypt(
          JSON.stringify(
            bindShopifyOnlineSession(
              [
                ["id", sessionId],
                ["shop", shop],
                ["isOnline", true],
                ["userId", Number(userId)],
                ["accountOwner", owner],
                ["collaborator", false],
                ["associatedUserScope", "read_products"],
                ["accessToken", "synthetic-online"],
                ["expires", expiresAt.getTime()],
              ],
              binding,
            ),
          ),
        );
        await prisma.weleticShopifyAppSession.upsert({
          where: { id: sessionId },
          create: { id: sessionId, shop, isOnline: true, payload, expiresAt },
          update: { payload, expiresAt },
        });
        return {
          ...binding,
          version: 1,
          userId,
          sessionId,
          sessionDigest: createHash("sha256").update(payload).digest("hex"),
          authenticatedAt: Date.now() - 1000,
          requestId: randomBytes(32).toString("hex"),
        };
      };
      try {
        if (mode === "public") {
          const { deriveAllShopifyShopPrivacyIdentities } = await import(
            "@/lib/weletic/shopify/privacy-identity"
          );
          const { publishStoreOwnedShopifyCredential } = await import(
            "@/lib/weletic/shopify/store-owned-credential"
          );
          const identity = deriveAllShopifyShopPrivacyIdentities({
            shopDomain: shop,
          })[0];
          await prisma.weleticShopifyPendingInstallation.create({
            data: {
              id: admissionId,
              appId,
              ...identity,
              state: "mapped",
              mappedStoreId: storeId,
              installationGeneration: "g1",
              authenticatedAt: new Date(),
            },
          });
          await prisma.$transaction((tx) =>
            publishStoreOwnedShopifyCredential(tx, {
              identity: {
                storeId,
                workspaceId,
                appId,
                shop,
                installationGeneration: "g1",
              },
              expectedRevision: null,
              material: {
                accessToken: "synthetic-offline",
                scope: "read_products",
              },
            }),
          );
        } else {
          await prisma.installedIntegration.create({
            data: {
              id: installationId,
              projectId: workspaceId,
              userId: `synthetic-user-${run}`,
              integrationId: SHOPIFY_INTEGRATION_ID,
              credentials: {
                shop,
                accessToken: encrypt("synthetic-offline"),
                installationGeneration: "g1",
              },
            },
          });
        }
        await prisma.weleticShopifyAppSession.create({
          data: {
            id: sessionIds[0],
            shop,
            isOnline: false,
            payload: encrypt(
              JSON.stringify([
                ["id", sessionIds[0]],
                ["shop", shop],
                ["isOnline", false],
                ["accessToken", "synthetic-offline"],
              ]),
            ),
          },
        });
        const envelope = await actor(true);
        const source = await prisma.weleticProductReview.findUniqueOrThrow({
          where: { storeId_id: { storeId, id: review.id } },
          select: { version: true },
        });
        const patch = {
          action: "save",
          reviewId: review.id,
          locale: "ja",
          sourceLocale: "en",
          expectedInstallationGeneration: "g1",
          expectedReviewVersion: source.version,
          expectedTranslationRevision: 0,
          title: "日本語",
          body: "認証済みの翻訳",
        };
        await expect(
          writeShopifyMerchantReviewTranslation({ envelope, input: patch }),
        ).resolves.toMatchObject({ revision: 1 });
        const actions = () =>
          prisma.weleticShopifyMerchantAction.findMany({
            where: { storeId, appId },
          });
        let receipts = await actions();
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
          permission: "reviews.moderate",
          owner: true,
          requestId: envelope.requestId,
        });
        const audit =
          await prisma.weleticReviewTranslationAudit.findFirstOrThrow({
            where: { storeId, translation: { reviewId: review.id } },
          });
        expect(audit.merchantActionId).toBe(receipts[0].id);
        await expect(
          writeShopifyMerchantReviewTranslation({
            envelope,
            input: { ...patch, expectedTranslationRevision: 1 },
          }),
        ).rejects.toMatchObject({ code: "request_replayed" });
        expect(await actions()).toHaveLength(1);
        const fresh = {
          ...envelope,
          requestId: randomBytes(32).toString("hex"),
        };
        await expect(
          writeShopifyMerchantReviewTranslation({
            envelope: fresh,
            input: patch,
          }),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(await actions()).toHaveLength(1);
        const unauthorized = await actor(false);
        await expect(
          writeShopifyMerchantReviewTranslation({
            envelope: unauthorized,
            input: { ...patch, expectedTranslationRevision: 1 },
          }),
        ).rejects.toMatchObject({ code: "access_denied" });
        expect(await actions()).toHaveLength(1);
        // A failed write's action receipt rolls back: the same fresh request
        // identity remains usable for a later authorized read.
        const page = await readShopifyMerchantReviewTranslations({
          envelope: fresh,
          input: { reviewId: review.id },
        });
        expect(page.translations).toHaveLength(1);
        expect(page.translations[0]).toMatchObject({
          revision: 1,
          title: patch.title,
        });
        receipts = await actions();
        expect(receipts).toHaveLength(2);
        expect(
          receipts.find((item) => item.requestId === fresh.requestId)
            ?.permission,
        ).toBe("reviews.read");
        expect(
          await prisma.weleticReviewTranslationAudit.count({
            where: { storeId, translation: { reviewId: review.id } },
          }),
        ).toBe(1);
      } finally {
        await prisma.weleticShopifyMerchantAction.deleteMany({
          where: { storeId, appId },
        });
        await prisma.weleticShopifyAppSession.deleteMany({
          where: { id: { in: sessionIds }, shop },
        });
        await prisma.weleticShopifySessionCoordination.deleteMany({
          where: { appId, shop },
        });
        await prisma.weleticShopifyInstallationCredential.deleteMany({
          where: { storeId, appId },
        });
        await prisma.weleticShopifyPendingInstallation.deleteMany({
          where: { id: admissionId, appId, mappedStoreId: storeId },
        });
        await prisma.installedIntegration.deleteMany({
          where: { id: installationId, projectId: workspaceId },
        });
        if (previousAppId === undefined) delete process.env.SHOPIFY_API_KEY;
        else process.env.SHOPIFY_API_KEY = previousAppId;
      }
    },
  );
  const translationActor = () => ({
    kind: "shopify",
    userId: "42",
    appId: "test-public-app",
    installationGeneration: "g1",
    merchantActionId: randomBytes(32).toString("hex"),
  });
  function translationWrite(
    reviewId: string,
    revision = 0,
    actor = translationActor(),
    extra: Record<string, unknown> = {},
  ) {
    return withReviewMutation(
      storeId,
      (tx, generation) =>
        writeReviewTranslationInTransaction({
          tx,
          storeId,
          generation,
          actor,
          input: {
            action: "save",
            reviewId,
            locale: "ja",
            sourceLocale: "en",
            title: "手動翻訳",
            body: "手動で翻訳したレビューです。",
            expectedInstallationGeneration: "g1",
            expectedReviewVersion: 1,
            expectedTranslationRevision: revision,
            ...extra,
          },
        }),
      "g1",
    );
  }
  it.each(["expired", "old_email", "terminal", "pseudonym"] as const)(
    "manual translations: retained %s owner suppression blocks both editor read and write",
    async (mode) => {
      const customerId = String(++sequence);
      const ownerId = `translation-owner-${run}-${customerId}`;
      const email = `translation-${customerId}@example.test`;
      await prisma.weleticShopper.create({
        data: {
          id: ownerId,
          storeId,
          shopifyCustomerId: customerId,
          email,
        },
      });
      await prisma.$transaction((tx) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: ownerId,
          installationGeneration: "g1",
        }),
      );
      const request = await invitation(await purchase(ownerId));
      const review = await submitNativeReview(storeId, input(request.token));
      if (mode === "expired" || mode === "old_email") {
        await upsertShopifyCustomerPrivacyTombstones({
          storeId,
          email,
          expiresAt: new Date("2000-01-01"),
        });
        if (mode === "old_email")
          await prisma.weleticShopper.update({
            where: { id: ownerId },
            data: { email: `changed-${email}` },
          });
      } else {
        if (mode === "terminal")
          await prisma.$transaction((tx) =>
            redactReviewOwnerPrivacyProjection({
              tx,
              storeId,
              shopperId: ownerId,
            }),
          );
        if (mode === "pseudonym") {
          const { getShopifyCustomerPrivacyPseudonym } = await import(
            "@/lib/weletic/shopify/privacy-identity"
          );
          await prisma.weleticShopper.update({
            where: { id: ownerId },
            data: {
              shopifyCustomerId: getShopifyCustomerPrivacyPseudonym({
                storeId,
                shopifyCustomerId: customerId,
              }),
              email: null,
            },
          });
        }
      }
      await expect(
        withReviewMutation(
          storeId,
          (tx, generation) =>
            readReviewTranslationsInTransaction({
              tx,
              storeId,
              reviewId: review.id,
              generation: generation!,
            }),
          "g1",
        ),
      ).rejects.toThrow("Review unavailable");
      await expect(translationWrite(review.id)).rejects.toThrow(
        "Review unavailable",
      );
      expect(
        await prisma.weleticProductReviewTranslation.count({
          where: { storeId, reviewId: review.id },
        }),
      ).toBe(0);
      expect(
        await prisma.weleticReviewTranslationAudit.count({
          where: { storeId, translation: { reviewId: review.id } },
        }),
      ).toBe(0);
    },
  );
  it("manual translations: lifecycle and exact private export retain revision tombstones", async () => {
    const review = await translationFixture();
    for (const locale of ["en", "ja", "vi"])
      await translationWrite(review.id, 0, translationActor(), {
        locale,
        sourceLocale: null,
      });
    const page = await withReviewMutation(
      storeId,
      (tx) =>
        readReviewTranslationsInTransaction({
          tx,
          storeId,
          reviewId: review.id,
          generation: "g1",
        }),
      "g1",
    );
    expect(page.translations).toHaveLength(3);
    expect(
      page.translations.every(
        (row) => row.revision === 1 && row.status === "active",
      ),
    ).toBe(true);
    const exported = await prisma.weleticProductReview.findFirstOrThrow({
      where: { storeId, id: review.id, shopperId },
      select: { translations: reviewTranslationExportSelection(storeId) },
    });
    expect(exported.translations.map((row) => row.locale)).toEqual([
      "en",
      "ja",
      "vi",
    ]);
    expect(JSON.stringify(exported)).not.toContain("sourceDigest");
    await withReviewMutation(
      storeId,
      (tx, generation) =>
        writeReviewTranslationInTransaction({
          tx,
          storeId,
          generation,
          actor: translationActor(),
          input: {
            action: "remove",
            reviewId: review.id,
            locale: "ja",
            expectedInstallationGeneration: "g1",
            expectedReviewVersion: 1,
            expectedTranslationRevision: 1,
          },
        }),
      "g1",
    );
    await expect(translationWrite(review.id, 1)).rejects.toThrow(
      "Translation changed",
    );
    expect(
      await prisma.weleticProductReviewTranslation.findUniqueOrThrow({
        where: {
          storeId_reviewId_locale: {
            storeId,
            reviewId: review.id,
            locale: "ja",
          },
        },
      }),
    ).toMatchObject({
      revision: 2,
      status: "removed",
      title: null,
      body: null,
      sourceDigest: null,
    });
    await translationWrite(review.id, 2);
    expect(
      await prisma.weleticReviewTranslationAudit.count({
        where: { storeId, translation: { reviewId: review.id } },
      }),
    ).toBe(5);
    expect(
      await prisma.weleticProductReview.findUniqueOrThrow({
        where: { id: review.id },
      }),
    ).toMatchObject({ version: 1, title: "Honest review", rating: 1 });
  });
  it("manual translations: concurrent identical revision permits one committed writer", async () => {
    const review = await translationFixture();
    const results = await Promise.allSettled([
      translationWrite(review.id),
      translationWrite(review.id),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      status: "rejected",
      reason: {
        code: "conflict",
        message: "Translation changed; reload before editing",
      },
    });
    expect(
      await prisma.weleticProductReviewTranslation.count({
        where: { storeId, reviewId: review.id },
      }),
    ).toBe(1);
    expect(
      await prisma.weleticReviewTranslationAudit.count({
        where: { storeId, translation: { reviewId: review.id } },
      }),
    ).toBe(1);
  });
  it("manual translations: audit uniqueness failure rolls back content and revision", async () => {
    const review = await translationFixture();
    const actor = translationActor();
    await translationWrite(review.id, 0, actor);
    const failure = await translationWrite(review.id, 1, actor, {
      title: "Must roll back",
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(failure).toMatchObject({ code: "P2002" });
    expect(String(failure.meta?.target)).toContain("review_translation_action");
    expect(
      await prisma.weleticReviewTranslationAudit.count({
        where: { storeId, translation: { reviewId: review.id } },
      }),
    ).toBe(1);
    expect(
      await prisma.weleticProductReviewTranslation.findUniqueOrThrow({
        where: {
          storeId_reviewId_locale: {
            storeId,
            reviewId: review.id,
            locale: "ja",
          },
        },
      }),
    ).toMatchObject({ revision: 1, title: "手動翻訳" });
  });
  it.each(["customer", "email"])(
    "manual translations: unlinked %s erasure blocks real read and write",
    async (identity) => {
      const review = await translationFixture();
      const tombstones = await upsertShopifyCustomerPrivacyTombstones({
        storeId,
        ...(identity === "customer"
          ? { shopifyCustomerId: "123456" }
          : { email: "buyer@example.test" }),
      });
      try {
        expect(tombstones.every((row) => row.shopperId === null)).toBe(true);
        await expect(translationWrite(review.id)).rejects.toThrow(
          "Review unavailable",
        );
        await expect(
          withReviewMutation(
            storeId,
            (tx) =>
              readReviewTranslationsInTransaction({
                tx,
                storeId,
                reviewId: review.id,
                generation: "g1",
              }),
            "g1",
          ),
        ).rejects.toThrow("Review unavailable");
        expect(
          await prisma.weleticProductReviewTranslation.count({
            where: { storeId, reviewId: review.id },
          }),
        ).toBe(0);
      } finally {
        await prisma.weleticShopifyCustomerPrivacyTombstone.deleteMany({
          where: { storeId, id: { in: tombstones.map((row) => row.id) } },
        });
      }
    },
  );

  it("manual translations: another active store cannot read or change owned content", async () => {
    const review = await translationFixture();
    await translationWrite(review.id);
    const other = `foreign-${run}`;
    await prisma.project.create({
      data: {
        id: other,
        name: "Foreign fixture",
        slug: other,
        billingCycleStart: 1,
      },
    });
    await prisma.program.create({
      data: {
        id: other,
        workspaceId: other,
        defaultFolderId: `folder-${other}`,
        defaultGroupId: `group-${other}`,
        name: "Foreign fixture",
        slug: other,
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        id: other,
        projectId: other,
        programId: other,
        shopDomain: `${other}.myshopify.com`,
        shopCurrency: "USD",
        apiVersion: "2026-07",
        installationGeneration: "g1",
        storeAccessState: "active",
      },
    });
    await expect(
      withReviewMutation(
        other,
        (tx) =>
          readReviewTranslationsInTransaction({
            tx,
            storeId: other,
            reviewId: review.id,
            generation: "g1",
          }),
        "g1",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      withReviewMutation(
        other,
        (tx, generation) =>
          writeReviewTranslationInTransaction({
            tx,
            storeId: other,
            generation,
            actor: translationActor(),
            input: {
              action: "remove",
              reviewId: review.id,
              locale: "ja",
              expectedInstallationGeneration: "g1",
              expectedReviewVersion: 1,
              expectedTranslationRevision: 1,
            },
          }),
        "g1",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await prisma.weleticProductReviewTranslation.findUniqueOrThrow({
        where: {
          storeId_reviewId_locale: {
            storeId,
            reviewId: review.id,
            locale: "ja",
          },
        },
      }),
    ).toMatchObject({ revision: 1, status: "active", title: "手動翻訳" });
    expect(
      await prisma.weleticReviewTranslationAudit.count({
        where: { storeId: other },
      }),
    ).toBe(0);
  });

  it.each(["customer", "email"])(
    "manual translations: concurrent uncommitted %s tombstone blocks then rejects writer",
    async (identity) => {
      const review = await translationFixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      let failReady!: (error: unknown) => void;
      const inserted = new Promise<void>((resolve, reject) => {
        ready = resolve;
        failReady = reject;
      });
      let entered!: () => void;
      const writerEntered = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let privacyConnection = "";
      let writerConnection = "";
      let tombstoneIds: string[] = [];
      let privacyError: unknown;
      const privacy = prisma
        .$transaction(
          async (tx) => {
            const connections = await tx.$queryRaw<
              Array<{ id: bigint }>
            >`SELECT CONNECTION_ID() AS id`;
            privacyConnection = String(connections[0].id);
            const rows = await upsertShopifyCustomerPrivacyTombstones({
              tx,
              storeId,
              ...(identity === "customer"
                ? { shopifyCustomerId: "123456" }
                : { email: "buyer@example.test" }),
            });
            tombstoneIds = rows.map((row) => row.id);
            ready();
            await held;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            timeout: 10000,
          },
        )
        .catch((error) => {
          privacyError = error;
          failReady(error);
        });
      let writerOutcome: Promise<unknown> | undefined;
      try {
        await inserted;
        writerOutcome = withReviewMutation(
          storeId,
          async (tx, generation) => {
            const connections = await tx.$queryRaw<
              Array<{ id: bigint }>
            >`SELECT CONNECTION_ID() AS id`;
            writerConnection = String(connections[0].id);
            entered();
            return writeReviewTranslationInTransaction({
              tx,
              storeId,
              generation,
              actor: translationActor(),
              input: {
                action: "save",
                reviewId: review.id,
                locale: "ja",
                sourceLocale: "en",
                title: "Must not persist",
                body: "Concurrent private text",
                expectedInstallationGeneration: "g1",
                expectedReviewVersion: 1,
                expectedTranslationRevision: 0,
              },
            });
          },
          "g1",
        ).then(
          (value) => ({ success: value }),
          (error) => ({ error }),
        );
        await Promise.race([
          writerEntered,
          writerOutcome.then(() => {
            throw new Error("Writer settled before entering transaction");
          }),
        ]);
        expect(writerConnection).not.toBe(privacyConnection);
        // Barriers establish actual insert and writer transaction entry; this
        // bounded observation additionally rejects an early commit/early error.
        expect(
          await Promise.race([
            writerOutcome.then(() => "settled"),
            new Promise<string>((resolve) =>
              setTimeout(() => resolve("pending"), 100),
            ),
          ]),
        ).toBe("pending");
        release();
        await privacy;
        expect(privacyError).toBeUndefined();
        expect(await writerOutcome).toMatchObject({
          error: { code: "not_found", message: "Review unavailable" },
        });
        expect(
          await prisma.weleticProductReviewTranslation.count({
            where: { storeId, reviewId: review.id },
          }),
        ).toBe(0);
        expect(
          await prisma.weleticReviewTranslationAudit.count({
            where: { storeId, translation: { reviewId: review.id } },
          }),
        ).toBe(0);
      } finally {
        release();
        await privacy;
        await writerOutcome;
        await prisma.weleticShopifyCustomerPrivacyTombstone.deleteMany({
          where: { storeId, id: { in: tombstoneIds } },
        });
      }
    },
  );

  it.each(["customer", "email"])(
    "manual translations: writer-first concurrent %s privacy finishes by erasing committed text",
    async (identity) => {
      const review = await translationFixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let ready!: () => void;
      const written = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let privacyEntered!: () => void;
      const enteringPrivacy = new Promise<void>((resolve) => {
        privacyEntered = resolve;
      });
      let writerConnection = "";
      let privacyConnection = "";
      let tombstoneIds: string[] = [];
      const writer = withReviewMutation(
        storeId,
        async (tx, generation) => {
          const connections = await tx.$queryRaw<
            Array<{ id: bigint }>
          >`SELECT CONNECTION_ID() AS id`;
          writerConnection = String(connections[0].id);
          const result = await writeReviewTranslationInTransaction({
            tx,
            storeId,
            generation,
            actor: translationActor(),
            input: {
              action: "save",
              reviewId: review.id,
              locale: "ja",
              sourceLocale: "en",
              title: "Private translated title",
              body: "Private translated text",
              expectedInstallationGeneration: "g1",
              expectedReviewVersion: 1,
              expectedTranslationRevision: 0,
            },
          });
          ready();
          await held;
          return result;
        },
        "g1",
      ).then(
        (value) => ({ success: value }),
        (error) => ({ error }),
      );
      let privacy: Promise<unknown> | undefined;
      try {
        await Promise.race([
          written,
          writer.then(() => {
            throw new Error("Writer settled before held content write");
          }),
        ]);
        privacy = prisma
          .$transaction(
            async (tx) => {
              const connections = await tx.$queryRaw<
                Array<{ id: bigint }>
              >`SELECT CONNECTION_ID() AS id`;
              privacyConnection = String(connections[0].id);
              privacyEntered();
              const rows = await upsertShopifyCustomerPrivacyTombstones({
                tx,
                storeId,
                ...(identity === "customer"
                  ? { shopifyCustomerId: "123456" }
                  : { email: "buyer@example.test" }),
              });
              tombstoneIds = rows.map((row) => row.id);
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              timeout: 10000,
            },
          )
          .then(
            () => ({ success: true }),
            (error) => ({ error }),
          );
        await Promise.race([
          enteringPrivacy,
          privacy.then(() => {
            throw new Error("Privacy settled before transaction entry");
          }),
        ]);
        expect(privacyConnection).not.toBe(writerConnection);
        expect(
          await Promise.race([
            privacy.then(() => "settled"),
            new Promise<string>((resolve) =>
              setTimeout(() => resolve("pending"), 100),
            ),
          ]),
        ).toBe("pending");
        release();
        expect(await writer).toMatchObject({
          success: { revision: 1, status: "active" },
        });
        expect(await privacy).toEqual({ success: true });
        let more = true;
        for (let page = 0; page < 50 && more; page++)
          more = (await redactNativeReviewsBatch(storeId, shopperId)).hasMore;
        expect(more).toBe(false);
        const erased =
          await prisma.weleticProductReviewTranslation.findUniqueOrThrow({
            where: {
              storeId_reviewId_locale: {
                storeId,
                reviewId: review.id,
                locale: "ja",
              },
            },
          });
        expect(erased).toMatchObject({
          status: "redacted",
          revision: 1,
          title: null,
          body: null,
          sourceDigest: null,
        });
        expect(
          await prisma.weleticReviewTranslationAudit.count({
            where: { storeId, translationId: erased.id },
          }),
        ).toBe(1);
        await expect(translationWrite(review.id, 1)).rejects.toMatchObject({
          code: "not_found",
        });
      } finally {
        release();
        await writer;
        await privacy;
        await prisma.weleticShopifyCustomerPrivacyTombstone.deleteMany({
          where: { storeId, id: { in: tombstoneIds } },
        });
      }
    },
  );

  it("manual translations: completed privacy erasure clears content and export without deleting audit history", async () => {
    const review = await translationFixture();
    await translationWrite(review.id);
    const before =
      await prisma.weleticProductReviewTranslation.findUniqueOrThrow({
        where: {
          storeId_reviewId_locale: {
            storeId,
            reviewId: review.id,
            locale: "ja",
          },
        },
      });
    const ledgerCount = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    let more = true;
    for (let page = 0; page < 50 && more; page++)
      more = (await redactNativeReviewsBatch(storeId, shopperId)).hasMore;
    expect(more).toBe(false);
    const erased =
      await prisma.weleticProductReviewTranslation.findUniqueOrThrow({
        where: { id: before.id },
      });
    expect(erased).toMatchObject({
      revision: 1,
      status: "redacted",
      title: null,
      body: null,
      sourceDigest: null,
      sourceLocale: null,
    });
    expect(erased.redactedAt).toBeInstanceOf(Date);
    expect(
      await prisma.weleticReviewTranslationAudit.count({
        where: { storeId, translationId: before.id },
      }),
    ).toBe(1);
    const exported = await prisma.weleticProductReview.findFirstOrThrow({
      where: { storeId, id: review.id },
      select: { translations: reviewTranslationExportSelection(storeId) },
    });
    expect(exported.translations).toEqual([
      expect.objectContaining({ status: "redacted", title: null, body: null }),
    ]);
    await expect(translationWrite(review.id, 1)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledgerCount);
  });

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

  it("open policy: concurrent same-revision commands have one winner and preserve immutable disable history", async () => {
    const { createOpenReviewPolicyRevision } = await import(
      "@/lib/weletic/reviews/open-policy-history"
    );
    const { DEFAULT_OPEN_REVIEW_POLICY } = await import(
      "@/lib/weletic/reviews/open-submission-policy"
    );
    const authorize = async () => ({
      appId: "synthetic-test-app",
      shopifyUserId: "123",
    });
    const ledgerBefore = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    const initial = await prisma.weleticOpenReviewPolicy.count({
      where: { storeId },
    });
    expect(initial).toBe(0);
    const command = {
      expectedInstallationGeneration: "g1",
      expectedRevision: 0,
      policy: { ...DEFAULT_OPEN_REVIEW_POLICY, enabled: true },
    };
    const results = await Promise.allSettled([
      createOpenReviewPolicyRevision(storeId, command, authorize),
      createOpenReviewPolicyRevision(storeId, command, authorize),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({
      code: "conflict",
    });
    const first = await prisma.weleticOpenReviewPolicy.findFirstOrThrow({
      where: { storeId, revision: 1 },
    });
    expect(first.snapshot).toEqual(command.policy);
    await createOpenReviewPolicyRevision(
      storeId,
      { ...command, expectedRevision: 1, policy: DEFAULT_OPEN_REVIEW_POLICY },
      authorize,
    );
    expect(
      await prisma.weleticOpenReviewPolicy.findUniqueOrThrow({
        where: { id: first.id },
      }),
    ).toEqual(first);
    expect(
      await prisma.weleticOpenReviewPolicy.findFirstOrThrow({
        where: { storeId, revision: 2 },
      }),
    ).toMatchObject({ snapshot: DEFAULT_OPEN_REVIEW_POLICY });
    await expect(
      createOpenReviewPolicyRevision(
        storeId,
        {
          ...command,
          expectedRevision: 2,
          expectedInstallationGeneration: "stale-generation",
        },
        authorize,
      ),
    ).rejects.toMatchObject({
      complianceState: "stale_installation_generation",
      storeId,
    });
    await expect(
      createOpenReviewPolicyRevision(
        storeId,
        { ...command, expectedRevision: 2 },
        async () => {
          throw new Error("synthetic authorization denied");
        },
      ),
    ).rejects.toThrow("synthetic authorization denied");
    expect(
      await prisma.weleticOpenReviewPolicy.count({ where: { storeId } }),
    ).toBe(2);
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledgerBefore);
  });

  it.each([
    ["expired", "before"],
    ["old_email", "before"],
    ["terminal", "before"],
    ["expired", "after_credentials"],
    ["old_email", "after_credentials"],
    ["terminal", "after_credentials"],
  ] as const)(
    "open Flow: retained %s privacy at %s prevents provider dispatch",
    async (mode, phase) => {
      const { handleReviewFlowTrigger } = await import(
        "@/lib/weletic/reviews/flow-worker"
      );
      const { REVIEW_FLOW_HANDLES } = await import(
        "@/lib/weletic/reviews/flow-contract"
      );
      const customer = String(++sequence);
      const ownerId = `open-flow-owner-${run}-${customer}`;
      const id = `wreview_${randomBytes(10).toString("hex")}`;
      const email = `flow-${customer}@example.test`;
      await prisma.weleticShopper.create({
        data: { id: ownerId, storeId, shopifyCustomerId: customer, email },
      });
      await prisma.$transaction((tx) =>
        replaceReviewOwnerPrivacyProjection({
          tx,
          storeId,
          shopperId: ownerId,
          installationGeneration: "g1",
        }),
      );
      await prisma.weleticProductReview.create({
        data: {
          id,
          storeId,
          shopperId: ownerId,
          productId,
          rating: 1,
          title: "Synthetic open Flow",
          body: "Synthetic unverified product feedback.",
          displayName: "Fixture",
          verifiedPurchase: false,
          incentivized: false,
          rewardStatus: "ineligible",
          status: "pending",
        },
      });
      await prisma.weleticOpenReviewSubmission.create({
        data: {
          id: `flow-source-${run}-${customer}`,
          storeId,
          reviewId: id,
          shopperId: ownerId,
          installationGeneration: "g1",
          source: "app_proxy",
          idempotencyKey: randomBytes(32).toString("hex"),
          contentDigest: randomBytes(32).toString("hex"),
          settingsRevision: 1,
          disclosureRevision: "open_unverified_unrewarded_v1",
          locale: "en",
        },
      });
      const event = {
        handle: REVIEW_FLOW_HANDLES.SUBMITTED,
        reviewId: id,
        version: 1,
        installationGeneration: "g1",
        occurredAt: new Date().toISOString(),
        rating: 1,
        verifiedPurchase: false,
      };
      mocks.summaryGraphql.mockResolvedValue({
        flowTriggerReceive: { userErrors: [] },
      });
      await handleReviewFlowTrigger(storeId, event);
      expect(mocks.summaryGraphql).toHaveBeenCalledTimes(1);
      mocks.summaryGraphql.mockClear();
      mocks.summaryCredentials.mockClear();
      const suppress = async () => {
        if (mode === "terminal") {
          await prisma.$transaction((tx) =>
            redactReviewOwnerPrivacyProjection({
              tx,
              storeId,
              shopperId: ownerId,
            }),
          );
        } else {
          await upsertShopifyCustomerPrivacyTombstones({
            storeId,
            email,
            expiresAt: new Date("2000-01-01"),
          });
          if (mode === "old_email")
            await prisma.weleticShopper.update({
              where: { id: ownerId },
              data: { email: `changed-${email}` },
            });
        }
      };
      if (phase === "before") await suppress();
      else
        mocks.summaryCredentials.mockImplementationOnce(async () => {
          await suppress();
          return {
            shopDomain: "test.myshopify.com",
            accessToken: "synthetic-token",
          };
        });
      await expect(
        handleReviewFlowTrigger(storeId, event),
      ).rejects.toMatchObject({ retryable: false });
      expect(mocks.summaryGraphql).not.toHaveBeenCalled();
      expect(mocks.summaryCredentials).toHaveBeenCalledTimes(
        phase === "before" ? 0 : 1,
      );
      expect(
        await prisma.weleticLoyaltyAccount.count({
          where: { storeId, shopperId: ownerId },
        }),
      ).toBe(0);
      expect(
        await prisma.weleticProductReview.findUniqueOrThrow({ where: { id } }),
      ).toMatchObject({ status: "pending", redactedAt: null });
    },
  );

  it("open submission: serializes replay and rate races without enrollment, and rolls back provenance failure", async () => {
    const { submitOpenReview } = await import(
      "@/lib/weletic/reviews/open-submission-write"
    );
    const { createOpenReviewPolicyRevision } = await import(
      "@/lib/weletic/reviews/open-policy-history"
    );
    const { OPEN_REVIEW_DISCLOSURE_REVISION } = await import(
      "@/lib/weletic/reviews/open-submission-contract"
    );
    const previous = await prisma.weleticOpenReviewPolicy.findFirst({
      where: { storeId },
      orderBy: { revision: "desc" },
    });
    const policy = await createOpenReviewPolicyRevision(
      storeId,
      {
        expectedInstallationGeneration: "g1",
        expectedRevision: previous?.revision ?? 0,
        policy: {
          enabled: true,
          photoUploadsEnabled: false,
          maxSubmissionsPer24Hours: 1,
        },
      },
      async () => ({ appId: "synthetic-test-app", shopifyUserId: "123" }),
    );
    const ledgerBefore = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    const accountsBefore = await prisma.weleticLoyaltyAccount.count({
      where: { storeId },
    });
    const requestBefore = await prisma.weleticReviewRequest.count({
      where: { storeId },
    });
    const content = {
      submissionId: "11111111-1111-4111-8111-111111111111",
      productId: "gid://shopify/Product/1234",
      expectedInstallationGeneration: "g1",
      expectedSettingsRevision: policy.revision,
      locale: "en",
      disclosureRevision: OPEN_REVIEW_DISCLOSURE_REVISION,
      rating: 1,
      title: "Unverified critical review",
      body: "This item did not meet my expectations.",
      displayName: "Test shopper",
      mediaIds: [],
      publishConsent: true,
    };
    const submit = (customer: string, submissionId: string, locale = "en") =>
      submitOpenReview({
        storeId,
        installationGeneration: "g1",
        input: { ...content, submissionId, locale },
        authorize: async () => ({
          shopifyCustomerId: customer,
          email: `open-${customer}-${run}@example.invalid`,
          source: "app_proxy",
        }),
      });
    const duplicate = await Promise.all([
      submit("990000001001", content.submissionId),
      submit("990000001001", content.submissionId),
    ]);
    expect(duplicate.map((result) => result.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    // Reuse the committed operation as if its first response had been lost.
    expect(await submit("990000001001", content.submissionId)).toEqual({
      status: "received",
      duplicate: true,
    });
    const races = await Promise.allSettled([
      submit("990000001002", "22222222-2222-4222-8222-222222222222"),
      submit("990000001002", "33333333-3333-4333-8333-333333333333"),
    ]);
    expect(
      races.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = races.find((result) => result.status === "rejected");
    expect(loser?.status === "rejected" && loser.reason).toMatchObject({
      code: "unavailable",
      message: "Open review submission limit reached",
    });
    const authors = await prisma.weleticShopper.findMany({
      where: {
        storeId,
        shopifyCustomerId: { in: ["990000001001", "990000001002"] },
      },
      select: { id: true },
    });
    expect(authors).toHaveLength(2);
    const reviews = await prisma.weleticProductReview.findMany({
      where: { storeId, shopperId: { in: authors.map((row) => row.id) } },
    });
    expect(reviews).toHaveLength(2);
    for (const review of reviews)
      expect(review).toMatchObject({
        requestId: null,
        status: "pending",
        verifiedPurchase: false,
        incentivized: false,
        rewardStatus: "ineligible",
        rating: 1,
      });
    const openFlows = await prisma.weleticLoyaltyOutboxJob.findMany({
      where: {
        storeId,
        jobType: "FLOW_TRIGGER",
        OR: reviews.map((review) => ({
          idempotencyKey: `flow_trigger:weletic-review-submitted:${review.id}:weletic-review-submitted:1`,
        })),
      },
    });
    expect(openFlows).toHaveLength(2);
    for (const job of openFlows)
      expect(job.payload).toMatchObject({
        handle: "weletic-review-submitted",
        version: 1,
        rating: 1,
        verifiedPurchase: false,
        installationGeneration: "g1",
      });
    expect(
      await prisma.weleticOpenReviewSubmission.count({
        where: { storeId, shopperId: { in: authors.map((row) => row.id) } },
      }),
    ).toBe(2);
    const reviewCount = await prisma.weleticProductReview.count({
      where: { storeId },
    });
    const coverageCount = await prisma.weleticReviewOwnerPrivacyCoverage.count({
      where: { storeId },
    });
    // This suite requires a disposable database. Fail after original insertion,
    // at provenance insertion, to prove the entire service transaction rolls back.
    await prisma.$executeRawUnsafe(
      "ALTER TABLE WeleticOpenReviewSubmission ADD CONSTRAINT open_review_source_test_failure CHECK (locale <> 'vi')",
    );
    try {
      await expect(
        submit("990000001003", "44444444-4444-4444-8444-444444444444", "vi"),
      ).rejects.toThrow("open_review_source_test_failure");
    } finally {
      await prisma.$executeRawUnsafe(
        "ALTER TABLE WeleticOpenReviewSubmission DROP CHECK open_review_source_test_failure",
      );
    }
    expect(
      await prisma.weleticProductReview.count({ where: { storeId } }),
    ).toBe(reviewCount);
    expect(
      await prisma.weleticShopper.count({
        where: { storeId, shopifyCustomerId: "990000001003" },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticReviewOwnerPrivacyCoverage.count({
        where: { storeId },
      }),
    ).toBe(coverageCount);
    // A queue failure must roll back content, provenance and a newly created
    // author, not leave accepted content without its durable event.
    const queueBefore = await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId },
    });
    const existingFlowIds = await prisma.weleticLoyaltyOutboxJob.findMany({
      where: { jobType: "FLOW_TRIGGER" },
      select: { id: true },
    });
    expect(existingFlowIds.length).toBeGreaterThan(0);
    for (const { id } of existingFlowIds)
      expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
    const allowedFlowIds = existingFlowIds.map(({ id }) => `'${id}'`).join(",");
    await prisma.$executeRawUnsafe(
      `ALTER TABLE WeleticLoyaltyOutboxJob ADD CONSTRAINT open_flow_test_failure CHECK (jobType <> 'FLOW_TRIGGER' OR id IN (${allowedFlowIds}))`,
    );
    try {
      await expect(
        submit("990000001004", "55555555-5555-4555-8555-555555555555"),
      ).rejects.toThrow("open_flow_test_failure");
    } finally {
      await prisma.$executeRawUnsafe(
        "ALTER TABLE WeleticLoyaltyOutboxJob DROP CHECK open_flow_test_failure",
      );
    }
    expect(
      await prisma.weleticProductReview.count({ where: { storeId } }),
    ).toBe(reviewCount);
    expect(
      await prisma.weleticShopper.count({
        where: { storeId, shopifyCustomerId: "990000001004" },
      }),
    ).toBe(0);
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId } }),
    ).toBe(queueBefore);
    expect(
      await prisma.weleticLoyaltyAccount.count({ where: { storeId } }),
    ).toBe(accountsBefore);
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledgerBefore);
    expect(
      await prisma.weleticReviewRequest.count({ where: { storeId } }),
    ).toBe(requestBefore);
    await createOpenReviewPolicyRevision(
      storeId,
      {
        expectedInstallationGeneration: "g1",
        expectedRevision: policy.revision,
        policy: {
          enabled: false,
          photoUploadsEnabled: false,
          maxSubmissionsPer24Hours: 1,
        },
      },
      async () => ({ appId: "synthetic-test-app", shopifyUserId: "123" }),
    );
  });

  it("open author: preserves profiles and consent, deduplicates concurrent identity creation without loyalty writes", async () => {
    const { ensureOpenReviewAuthorInTransaction } = await import(
      "@/lib/weletic/reviews/open-submission-author"
    );
    const original = await prisma.weleticShopper.findUniqueOrThrow({
      where: { id: shopperId },
    });
    const accounts = await prisma.weleticLoyaltyAccount.count({
      where: { storeId },
    });
    const ledger = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    const outbox = await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId },
    });
    const ensure = (customer: {
      shopifyCustomerId: string;
      email: string | null;
    }) =>
      prisma.$transaction((tx) =>
        ensureOpenReviewAuthorInTransaction({
          tx,
          storeId,
          installationGeneration: "g1",
          customer,
        }),
      );
    expect(
      await ensure({
        shopifyCustomerId: original.shopifyCustomerId,
        email: "different-trusted@example.invalid",
      }),
    ).toEqual({ shopperId });
    expect(
      await prisma.weleticShopper.findUniqueOrThrow({
        where: { id: shopperId },
      }),
    ).toEqual(original);
    const customer = {
      shopifyCustomerId: "990000000001",
      email: `open-${run}@example.invalid`,
    };
    const [left, right] = await Promise.all([
      ensure(customer),
      ensure(customer),
    ]);
    expect(left).toEqual(right);
    expect(
      await prisma.weleticShopper.count({
        where: { storeId, shopifyCustomerId: customer.shopifyCustomerId },
      }),
    ).toBe(1);
    expect(
      await prisma.weleticLoyaltyAccount.count({ where: { storeId } }),
    ).toBe(accounts);
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledger);
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({ where: { storeId } }),
    ).toBe(outbox);
    expect(
      await prisma.weleticReviewOwnerPrivacyCoverage.findUniqueOrThrow({
        where: { storeId_shopperId: { storeId, shopperId: left.shopperId } },
      }),
    ).toMatchObject({ state: "active", installationGeneration: "g1" });
    expect(
      await prisma.weleticLoyaltyAccount.findFirst({
        where: { storeId, shopperId: left.shopperId },
      }),
    ).toBeNull();
  });

  it("open author: retained incoming and saved-email suppression cannot create or refresh identity", async () => {
    const { ensureOpenReviewAuthorInTransaction } = await import(
      "@/lib/weletic/reviews/open-submission-author"
    );
    const ensure = (
      customer: { shopifyCustomerId: string; email: string | null },
      installationGeneration = "g1",
    ) =>
      prisma.$transaction((tx) =>
        ensureOpenReviewAuthorInTransaction({
          tx,
          storeId,
          installationGeneration,
          customer,
        }),
      );
    const email = `blocked-open-${run}@example.invalid`;
    await upsertShopifyCustomerPrivacyTombstones({
      storeId,
      email,
      expiresAt: new Date("2000-01-01"),
    });
    await expect(
      ensure({ shopifyCustomerId: "990000000002", email }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await prisma.weleticShopper.findUnique({
        where: {
          storeId_shopifyCustomerId: {
            storeId,
            shopifyCustomerId: "990000000002",
          },
        },
      }),
    ).toBeNull();
    const customer = {
      shopifyCustomerId: "990000000003",
      email: `old-open-${run}@example.invalid`,
    };
    const created = await ensure(customer);
    const original = await prisma.weleticShopper.findUniqueOrThrow({
      where: { id: created.shopperId },
    });
    await upsertShopifyCustomerPrivacyTombstones({
      storeId,
      email: customer.email,
      expiresAt: new Date("2000-01-01"),
    });
    await expect(
      ensure({ ...customer, email: `new-open-${run}@example.invalid` }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await prisma.weleticShopper.findUniqueOrThrow({
        where: { id: created.shopperId },
      }),
    ).toEqual(original);
    await expect(
      ensure(
        { shopifyCustomerId: "990000000004", email: null },
        "old-generation",
      ),
    ).rejects.toThrow();
    expect(
      await prisma.weleticShopper.findUnique({
        where: {
          storeId_shopifyCustomerId: {
            storeId,
            shopifyCustomerId: "990000000004",
          },
        },
      }),
    ).toBeNull();
  });

  it("open author: a committed disable wins over an established repeatable-read snapshot", async () => {
    const { ensureOpenReviewAuthorInTransaction } = await import(
      "@/lib/weletic/reviews/open-submission-author"
    );
    let signalSnapshot!: () => void;
    let release!: () => void;
    const snapshotReady = new Promise<void>((resolve) => {
      signalSnapshot = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attempt = prisma.$transaction(
      async (tx) => {
        const prior = await tx.weleticReviewSettings.findUniqueOrThrow({
          where: { storeId },
        });
        expect(prior.enabled).toBe(true);
        signalSnapshot();
        await proceed;
        return ensureOpenReviewAuthorInTransaction({
          tx,
          storeId,
          installationGeneration: "g1",
          customer: { shopifyCustomerId: "990000000005", email: null },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 15000,
      },
    );
    const observed = attempt.then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    try {
      await snapshotReady;
      await withReviewMutation(
        storeId,
        (tx) =>
          tx.weleticReviewSettings.update({
            where: { storeId },
            data: { enabled: false },
          }),
        "g1",
      );
      release();
      expect((await observed).error).toMatchObject({ code: "disabled" });
      expect(
        await prisma.weleticShopper.findUnique({
          where: {
            storeId_shopifyCustomerId: {
              storeId,
              shopifyCustomerId: "990000000005",
            },
          },
        }),
      ).toBeNull();
    } finally {
      release();
      await observed;
      await withReviewMutation(
        storeId,
        (tx) =>
          tx.weleticReviewSettings.update({
            where: { storeId },
            data: { enabled: true },
          }),
        "g1",
      );
    }
  });

  it("keeps a synthetic requestless review unverified and rejects incentive retry", async () => {
    const id = `wreview_${randomBytes(10).toString("hex")}`;
    const ledgerBefore = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    const flowBefore = await prisma.weleticLoyaltyOutboxJob.count({
      where: { storeId, jobType: "FLOW_TRIGGER" },
    });
    await prisma.weleticProductReview.create({
      data: {
        id,
        storeId,
        shopperId,
        productId,
        requestId: null,
        rating: 1,
        title: "Synthetic open feedback",
        body: "Synthetic requestless review fixture.",
        displayName: "Synthetic shopper",
        rewardStatus: "ineligible",
      },
    });
    const row = await prisma.weleticProductReview.findUniqueOrThrow({
      where: { id },
    });
    expect(row.verifiedPurchase).toBe(false);
    expect(row.incentivized).toBe(false);
    const { openReviewSubmissionEvidence, OPEN_REVIEW_DISCLOSURE_REVISION } =
      await import("@/lib/weletic/reviews/open-submission-contract");
    const evidence = openReviewSubmissionEvidence(
      { storeId, shopperId, installationGeneration: "g1", source: "app_proxy" },
      {
        submissionId: "12345678-1234-4123-8123-123456789012",
        productId: "gid://shopify/Product/1234",
        expectedInstallationGeneration: "g1",
        expectedSettingsRevision: 1,
        locale: "en",
        disclosureRevision: OPEN_REVIEW_DISCLOSURE_REVISION,
        rating: row.rating,
        title: row.title,
        body: row.body,
        displayName: row.displayName,
        mediaIds: [],
        publishConsent: true,
      },
    );
    const provenance = {
      id: `open-source-${run}`,
      storeId,
      reviewId: id,
      shopperId,
      installationGeneration: "g1",
      source: "app_proxy",
      ...evidence,
      settingsRevision: 1,
      disclosureRevision: OPEN_REVIEW_DISCLOSURE_REVISION,
      locale: "en",
    };
    await prisma.weleticOpenReviewSubmission.create({ data: provenance });
    const retryReviewId = `retry-review-${run}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.weleticProductReview.create({
          data: {
            id: retryReviewId,
            storeId,
            shopperId,
            productId,
            rating: 1,
            title: row.title,
            body: row.body,
            displayName: row.displayName,
          },
        });
        await tx.weleticOpenReviewSubmission.create({
          data: {
            ...provenance,
            id: `retry-source-${run}`,
            reviewId: retryReviewId,
          },
        });
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(
      await prisma.weleticProductReview.findUnique({
        where: { id: retryReviewId },
      }),
    ).toBeNull();
    expect(
      await prisma.weleticOpenReviewSubmission.count({
        where: { storeId, idempotencyKey: evidence.idempotencyKey },
      }),
    ).toBe(1);
    const { reserveProductReviewIncentive } = await import(
      "@/lib/weletic/reviews/incentive-claims"
    );
    await expect(
      reserveProductReviewIncentive({
        storeId,
        reviewId: id,
        expectedInstallationGeneration: "g1",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      moderateNativeReview(storeId, id, "synthetic-owner", {
        version: 1,
        retryReward: true,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
    await moderateNativeReview(storeId, id, "synthetic-owner", {
      version: 1,
      status: "published",
    });
    expect(
      await prisma.weleticProductReview.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      status: "published",
      requestId: null,
      verifiedPurchase: false,
      incentivized: false,
      rewardStatus: "ineligible",
      rewardLedgerId: null,
    });
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledgerBefore);
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({
        where: { storeId, jobType: "FLOW_TRIGGER" },
      }),
    ).toBe(flowBefore + 1);
    // Left for the following real customer-erasure scenario; no invitation or
    // fake purchase was created to obtain this content's privacy ownership.
  });

  it("open photo upload: one-shot storage, exact replay and ambiguous-write privacy containment", async () => {
    const { uploadOpenReviewPhoto } = await import(
      "@/lib/weletic/reviews/open-media-upload"
    );
    const { createOpenReviewPolicyRevision, readCurrentOpenReviewPolicy } =
      await import("@/lib/weletic/reviews/open-policy-history");
    const policyBefore = await withReviewMutation(
      storeId,
      (tx) => readCurrentOpenReviewPolicy(tx, storeId),
      "g1",
    );
    const actor = async () => ({
      appId: "isolated-public-app",
      shopifyUserId: "9001",
    });
    const policy = await createOpenReviewPolicyRevision(
      storeId,
      {
        expectedInstallationGeneration: "g1",
        expectedRevision: policyBefore.revision,
        policy: {
          enabled: true,
          photoUploadsEnabled: true,
          maxSubmissionsPer24Hours: 3,
        },
      },
      actor,
    );
    const settingsBefore = await prisma.weleticReviewSettings.findUniqueOrThrow(
      { where: { storeId } },
    );
    await prisma.weleticReviewSettings.update({
      where: { storeId },
      data: { photoUploadsEnabled: true },
    });
    for (const key of [
      "STORAGE_ENDPOINT",
      "STORAGE_PRIVATE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ])
      vi.stubEnv(key, "isolated-photo-fixture");
    const bytes = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    const metadata = {
      submissionId: "a2345678-1234-4123-8123-123456789012",
      uploadId: "a2345678-1234-4123-8123-123456789013",
      productId: "gid://shopify/Product/1234",
      expectedInstallationGeneration: "g1",
      expectedSettingsRevision: policy.revision,
      contentType: "image/png",
    };
    const knownCustomer = "7744121";
    const uncertainCustomer = "7744122";
    const upload = (customerId: string, data = metadata, image = bytes) =>
      uploadOpenReviewPhoto({
        storeId,
        installationGeneration: "g1",
        input: data,
        bytes: image,
        // Synthetic trusted identity callback, not live Shopify authentication.
        authorize: async () => ({
          shopifyCustomerId: customerId,
          email: null,
          source: "app_proxy",
        }),
      });
    const ledgerBefore = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    const owners: string[] = [];
    try {
      const results = await Promise.allSettled([
        upload(knownCustomer),
        upload(knownCustomer),
      ]);
      expect(results.some((result) => result.status === "fulfilled")).toBe(
        true,
      );
      const receipt = await upload(knownCustomer);
      expect(mocks.upload).toHaveBeenCalledTimes(1);
      const first =
        await prisma.weleticOpenReviewMediaOwnership.findUniqueOrThrow({
          where: { mediaId: receipt.id },
        });
      owners.push(first.shopperId);
      expect(first.storageWriteState).toBe("confirmed");
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: receipt.id },
        }),
      ).toMatchObject({ requestId: null, reviewId: null, status: "uploaded" });
      const changed = await sharp({
        create: { width: 1, height: 1, channels: 3, background: "blue" },
      })
        .png()
        .toBuffer();
      await expect(upload(knownCustomer, metadata, changed)).rejects.toThrow(
        "identity already used",
      );
      expect(mocks.upload).toHaveBeenCalledTimes(1);
      expect(
        await prisma.weleticLoyaltyAccount.count({
          where: { storeId, shopperId: first.shopperId },
        }),
      ).toBe(0);
      const { submitOpenReview } = await import(
        "@/lib/weletic/reviews/open-submission-write"
      );
      const { OPEN_REVIEW_DISCLOSURE_REVISION } = await import(
        "@/lib/weletic/reviews/open-submission-contract"
      );
      const submission = {
        submissionId: metadata.submissionId,
        productId: metadata.productId,
        expectedInstallationGeneration: "g1",
        expectedSettingsRevision: policy.revision,
        locale: "en",
        disclosureRevision: OPEN_REVIEW_DISCLOSURE_REVISION,
        rating: 1,
        title: "Synthetic photo review",
        body: "This is a synthetic isolated photo attachment test.",
        displayName: "Fixture",
        publishConsent: true,
        mediaIds: [receipt.id],
      };
      const submit = (patch = {}) =>
        submitOpenReview({
          storeId,
          installationGeneration: "g1",
          input: { ...submission, ...patch },
          authorize: async () => ({
            shopifyCustomerId: knownCustomer,
            email: null,
            source: "customer_account",
          }),
        });
      // Missing media must roll back the original created before attachment.
      await expect(
        submit({ mediaIds: [receipt.id, "wrevmedia_missing"] }),
      ).rejects.toThrow("Photo unavailable");
      expect(
        await prisma.weleticProductReview.count({
          where: { storeId, shopperId: first.shopperId },
        }),
      ).toBe(0);
      await expect(
        submit({ submissionId: "a2345678-1234-4123-8123-123456789014" }),
      ).rejects.toThrow("Photo unavailable");
      expect(
        await prisma.weleticProductReview.count({
          where: { storeId, shopperId: first.shopperId },
        }),
      ).toBe(0);
      // Disposable schema only: force source insertion AFTER the valid media
      // UPDATE, then prove SQL rolls back parent, attachment and provenance.
      expect(Number.isSafeInteger(policy.revision)).toBe(true);
      await prisma.$executeRawUnsafe(
        `ALTER TABLE WeleticOpenReviewSubmission ADD CONSTRAINT open_photo_source_failure CHECK (settingsRevision <> ${policy.revision})`,
      );
      try {
        await expect(submit()).rejects.toThrow("open_photo_source_failure");
      } finally {
        await prisma.$executeRawUnsafe(
          "ALTER TABLE WeleticOpenReviewSubmission DROP CHECK open_photo_source_failure",
        );
      }
      expect(
        await prisma.weleticProductReview.count({
          where: { storeId, shopperId: first.shopperId },
        }),
      ).toBe(0);
      expect(
        await prisma.weleticOpenReviewSubmission.count({
          where: { storeId, shopperId: first.shopperId },
        }),
      ).toBe(0);
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: receipt.id },
        }),
      ).toMatchObject({ reviewId: null, status: "uploaded" });
      const submissions = await Promise.all([submit(), submit()]);
      expect(submissions.map(({ duplicate }) => duplicate).sort()).toEqual([
        false,
        true,
      ]);
      const attached = await prisma.weleticProductReview.findFirstOrThrow({
        where: { storeId, shopperId: first.shopperId },
      });
      expect(attached).toMatchObject({
        status: "pending",
        verifiedPurchase: false,
        incentivized: false,
        rewardStatus: "ineligible",
      });
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: receipt.id },
        }),
      ).toMatchObject({ reviewId: attached.id, requestId: null });
      expect(
        await prisma.weleticOpenReviewSubmission.count({
          where: { storeId, shopperId: first.shopperId },
        }),
      ).toBe(1);
      await expect(submit({ rating: 5 })).rejects.toThrow(
        "identity already used",
      );
      expect(await submit()).toEqual({ status: "received", duplicate: true });
      // Synthetic moderation isolates the read boundary from live merchant UI.
      await prisma.weleticProductReview.update({
        where: { id: attached.id },
        data: { status: "published" },
      });
      expect(await getPublicReviewPhoto(storeId, receipt.id)).toEqual({
        url: "https://storage.invalid/synthetic-private-download",
      });
      const publicItem = async () =>
        (
          await getPublicProductReviews(storeId, {
            productId: metadata.productId,
            limit: 50,
          })
        ).items.find(({ id }) => id === attached.id);
      const visible = await publicItem();
      expect(visible?.media).toEqual([{ id: receipt.id }]);
      for (const privateValue of [
        first.shopperId,
        first.contentDigest,
        first.submissionKey,
        `weletic/reviews/${storeId}/`,
      ])
        expect(JSON.stringify(visible)).not.toContain(privateValue);
      const downloadCount = mocks.signedDownload.mock.calls.length;
      await prisma.weleticOpenReviewMediaOwnership.update({
        where: { mediaId: receipt.id },
        data: { submissionKey: "synthetic-corrupt-key" },
      });
      try {
        expect((await publicItem())?.media).toEqual([]);
        await expect(
          getPublicReviewPhoto(storeId, receipt.id),
        ).rejects.toMatchObject({ code: "not_found" });
        expect(mocks.signedDownload).toHaveBeenCalledTimes(downloadCount);
      } finally {
        await prisma.weleticOpenReviewMediaOwnership.update({
          where: { mediaId: receipt.id },
          data: { submissionKey: first.submissionKey },
        });
      }
      expect(await redactNativeReviewsBatch(storeId, first.shopperId)).toEqual({
        hasMore: false,
      });
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: receipt.id },
        }),
      ).toMatchObject({ status: "deleted" });
      await expect(
        getPublicReviewPhoto(storeId, receipt.id),
      ).rejects.toMatchObject({ code: "not_found" });
      mocks.delete.mockClear();

      mocks.upload.mockRejectedValueOnce(
        new Error("synthetic timeout after dispatch"),
      );
      await expect(upload(uncertainCustomer)).rejects.toThrow(
        "requires reconciliation",
      );
      const uncertain =
        await prisma.weleticOpenReviewMediaOwnership.findFirstOrThrow({
          where: { storeId, storageWriteState: "ambiguous" },
        });
      owners.push(uncertain.shopperId);
      await expect(
        redactNativeReviewsBatch(storeId, uncertain.shopperId),
      ).resolves.toEqual({ hasMore: true });
      expect(mocks.delete).not.toHaveBeenCalled();
      // The provider may complete remotely now, after our local timeout. No
      // DELETE has been issued and no erasure is falsely acknowledged.
      await expect(
        cleanupReviewPhoto(storeId, uncertain.mediaId),
      ).rejects.toThrow("requires reconciliation");
      expect(mocks.delete).not.toHaveBeenCalled();
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: uncertain.mediaId },
        }),
      ).toMatchObject({ status: "reserved" });
      // More than one page of unresolved leading rows must not starve later
      // content scrubbing or deletion of a settled object. These are synthetic
      // state fixtures, not extra provider requests or quota bypasses.
      const pageIds = Array.from(
        { length: 26 },
        (_, index) =>
          `${index === 25 ? "zz" : "aa"}-open-page-${run}-${String(index).padStart(2, "0")}`,
      );
      await prisma.weleticReviewMedia.createMany({
        data: pageIds.map((id) => ({
          id,
          storeId,
          requestId: null,
          reviewId: null,
          objectKey: `weletic/reviews/${storeId}/${id}.webp`,
          contentType: "image/webp",
          sizeBytes: 100,
          status: "reserved",
          uploadExpiresAt: new Date(Date.now() + 86_400_000),
        })),
      });
      await prisma.weleticOpenReviewMediaOwnership.createMany({
        data: pageIds.map((mediaId, index) => ({
          ...uncertain,
          id: mediaId,
          mediaId,
          idempotencyKey: createHash("sha256").update(mediaId).digest("hex"),
          contentDigest: "d".repeat(64),
          redactedAt: null,
          storageWriteState: index === 25 ? "confirmed" : "ambiguous",
        })),
      });
      expect(
        await redactNativeReviewsBatch(storeId, uncertain.shopperId),
      ).toEqual({ hasMore: true });
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: pageIds[25] },
        }),
      ).toMatchObject({ status: "deleted" });
      expect(mocks.delete).toHaveBeenCalledTimes(1);
      expect(
        await prisma.weleticOpenReviewMediaOwnership.count({
          where: {
            storeId,
            shopperId: uncertain.shopperId,
            contentDigest: { not: null },
          },
        }),
      ).toBe(6);
      expect(
        await redactNativeReviewsBatch(storeId, uncertain.shopperId),
      ).toEqual({ hasMore: true });
      expect(
        await prisma.weleticOpenReviewMediaOwnership.count({
          where: {
            storeId,
            shopperId: uncertain.shopperId,
            contentDigest: { not: null },
          },
        }),
      ).toBe(0);
      expect(mocks.delete).toHaveBeenCalledTimes(1);
      await expect(upload(uncertainCustomer)).rejects.toThrow();
      expect(mocks.upload).toHaveBeenCalledTimes(2);
      const { reconcileOpenReviewPhotoStorage } = await import(
        "@/lib/weletic/reviews/open-media-reconciliation"
      );
      const { recordOpenPhotoStorageOutcome } = await import(
        "@/lib/weletic/reviews/open-media-write-state"
      );
      const uncertainMedia = await prisma.weleticReviewMedia.findUniqueOrThrow({
        where: { id: uncertain.mediaId },
      });
      mocks.headPrivate.mockResolvedValueOnce(null);
      expect(
        await reconcileOpenReviewPhotoStorage(storeId, uncertain.mediaId),
      ).toEqual({ status: "unresolved" });
      const retained =
        await prisma.weleticOpenReviewMediaOwnership.findUniqueOrThrow({
          where: { mediaId: uncertain.mediaId },
        });
      expect(retained).toMatchObject({
        storageWriteState: "ambiguous",
        contentDigest: null,
      });
      expect(retained.redactedAt).not.toBeNull();
      // Simulate the exact one-shot PUT becoming observable AFTER privacy began.
      // HEAD proof is taken from that actual mocked upload's metadata, not rebuilt
      // by the test from a different attempt or inferred from a timeout.
      mocks.headPrivate.mockResolvedValue({
        contentType: "image/webp",
        sizeBytes: uncertainMedia.sizeBytes,
        uploadProof:
          mocks.upload.mock.calls[1][0].opts.headers[
            "x-amz-meta-weletic-upload-proof"
          ],
      });
      expect(
        await Promise.all([
          reconcileOpenReviewPhotoStorage(storeId, uncertain.mediaId),
          reconcileOpenReviewPhotoStorage(storeId, uncertain.mediaId),
        ]),
      ).toEqual([{ status: "confirmed" }, { status: "confirmed" }]);
      await expect(
        prisma.$transaction((tx) =>
          recordOpenPhotoStorageOutcome(
            tx,
            storeId,
            uncertain.mediaId,
            uncertain.storageWriteToken!,
            "ambiguous",
          ),
        ),
      ).rejects.toThrow("requires reconciliation");
      expect(
        await prisma.weleticOpenReviewMediaOwnership.findUniqueOrThrow({
          where: { mediaId: uncertain.mediaId },
        }),
      ).toMatchObject({
        storageWriteState: "confirmed",
        contentDigest: null,
        redactedAt: retained.redactedAt,
      });
      expect(
        await redactNativeReviewsBatch(storeId, uncertain.shopperId),
      ).toEqual({ hasMore: true });
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: uncertain.mediaId },
        }),
      ).toMatchObject({ status: "deleted", reviewId: null });
      expect(mocks.upload).toHaveBeenCalledTimes(2);
      const retryCustomer = "7744123";
      mocks.upload.mockRejectedValueOnce(
        new Error("synthetic lost PUT response"),
      );
      await expect(upload(retryCustomer)).rejects.toThrow(
        "requires reconciliation",
      );
      const retryOwner =
        await prisma.weleticOpenReviewMediaOwnership.findFirstOrThrow({
          where: { storeId, storageWriteState: "ambiguous", redactedAt: null },
        });
      owners.push(retryOwner.shopperId);
      const retryMedia = await prisma.weleticReviewMedia.findUniqueOrThrow({
        where: { id: retryOwner.mediaId },
      });
      mocks.headPrivate.mockClear();
      await expect(upload(retryCustomer, metadata, changed)).rejects.toThrow(
        "identity already used",
      );
      expect(mocks.headPrivate).not.toHaveBeenCalled();
      mocks.headPrivate.mockResolvedValueOnce(null);
      await expect(upload(retryCustomer)).rejects.toThrow(
        "requires reconciliation",
      );
      expect(mocks.upload).toHaveBeenCalledTimes(3);
      mocks.headPrivate.mockResolvedValue({
        contentType: "image/webp",
        sizeBytes: retryMedia.sizeBytes,
        uploadProof:
          mocks.upload.mock.calls[2][0].opts.headers[
            "x-amz-meta-weletic-upload-proof"
          ],
      });
      const recovered = await Promise.allSettled([
        upload(retryCustomer),
        upload(retryCustomer),
      ]);
      expect(recovered.some(({ status }) => status === "fulfilled")).toBe(true);
      expect(await upload(retryCustomer)).toEqual({ id: retryOwner.mediaId });
      expect(mocks.upload).toHaveBeenCalledTimes(3);
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: retryOwner.mediaId },
        }),
      ).toMatchObject({ status: "uploaded", reviewId: null });
      expect(
        await redactNativeReviewsBatch(storeId, retryOwner.shopperId),
      ).toEqual({ hasMore: false });
      mocks.upload.mockRejectedValueOnce(
        new Error("synthetic abandoned upload timeout"),
      );
      await expect(upload("7744124")).rejects.toThrow(
        "requires reconciliation",
      );
      const abandoned =
        await prisma.weleticOpenReviewMediaOwnership.findFirstOrThrow({
          where: { storeId, storageWriteState: "ambiguous", redactedAt: null },
        });
      owners.push(abandoned.shopperId);
      const abandonedMedia = await prisma.weleticReviewMedia.findUniqueOrThrow({
        where: { id: abandoned.mediaId },
      });
      mocks.headPrivate.mockResolvedValue({
        contentType: "image/webp",
        sizeBytes: abandonedMedia.sizeBytes,
        uploadProof:
          mocks.upload.mock.calls[3][0].opts.headers[
            "x-amz-meta-weletic-upload-proof"
          ],
      });
      const cleanupJob = await prisma.weleticLoyaltyOutboxJob.findFirstOrThrow({
        where: {
          storeId,
          idempotencyKey: `review_media_expiry:${abandoned.mediaId}`,
        },
      });
      const { executeNativeReviewJob } = await import(
        "@/lib/weletic/reviews/worker"
      );
      const deletesBeforeDue = mocks.delete.mock.calls.length;
      await expect(executeNativeReviewJob(cleanupJob)).rejects.toThrow(
        "not due",
      );
      expect(mocks.delete).toHaveBeenCalledTimes(deletesBeforeDue);
      await prisma.weleticReviewMedia.update({
        where: { id: abandoned.mediaId },
        data: { uploadExpiresAt: new Date(0) },
      });
      // Real worker handler and SQL guards; synthetic due time/provider reply.
      // This does not claim the queue lease/scheduler was exercised here.
      await executeNativeReviewJob(cleanupJob);
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: abandoned.mediaId },
        }),
      ).toMatchObject({ status: "deleted", reviewId: null });
      expect(
        await prisma.weleticOpenReviewMediaOwnership.findUniqueOrThrow({
          where: { mediaId: abandoned.mediaId },
        }),
      ).toMatchObject({ storageWriteState: "confirmed" });
      expect(mocks.upload).toHaveBeenCalledTimes(4);
      mocks.upload.mockRejectedValueOnce(
        new Error("synthetic privacy-race timeout"),
      );
      await expect(upload("7744125")).rejects.toThrow(
        "requires reconciliation",
      );
      const erasedDuringHead =
        await prisma.weleticOpenReviewMediaOwnership.findFirstOrThrow({
          where: { storeId, storageWriteState: "ambiguous", redactedAt: null },
        });
      owners.push(erasedDuringHead.shopperId);
      const erasedMedia = await prisma.weleticReviewMedia.findUniqueOrThrow({
        where: { id: erasedDuringHead.mediaId },
      });
      mocks.headPrivate.mockImplementationOnce(async () => {
        await redactNativeReviewsBatch(storeId, erasedDuringHead.shopperId);
        return {
          contentType: "image/webp",
          sizeBytes: erasedMedia.sizeBytes,
          uploadProof:
            mocks.upload.mock.calls[4][0].opts.headers[
              "x-amz-meta-weletic-upload-proof"
            ],
        };
      });
      await expect(upload("7744125")).rejects.toThrow();
      expect(
        await prisma.weleticReviewMedia.findUniqueOrThrow({
          where: { id: erasedDuringHead.mediaId },
        }),
      ).toMatchObject({ status: "reserved", reviewId: null });
      expect(
        await prisma.weleticOpenReviewMediaOwnership.findUniqueOrThrow({
          where: { mediaId: erasedDuringHead.mediaId },
        }),
      ).toMatchObject({ storageWriteState: "confirmed", contentDigest: null });
      expect(mocks.upload).toHaveBeenCalledTimes(5);
      expect(
        await redactNativeReviewsBatch(storeId, erasedDuringHead.shopperId),
      ).toEqual({ hasMore: false });
      expect(
        await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
      ).toBe(ledgerBefore);
    } finally {
      // No real objects exist: exact synthetic fixture teardown is not an
      // operational reconciliation/erasure of an ambiguous provider write.
      const rows = await prisma.weleticOpenReviewMediaOwnership.findMany({
        where: { storeId, shopperId: { in: owners } },
        select: { mediaId: true },
      });
      await prisma.weleticOpenReviewMediaOwnership.deleteMany({
        where: { storeId, shopperId: { in: owners } },
      });
      await prisma.weleticReviewMedia.deleteMany({
        where: { storeId, id: { in: rows.map(({ mediaId }) => mediaId) } },
      });
      await prisma.weleticReviewSettings.update({
        where: { storeId },
        data: { photoUploadsEnabled: settingsBefore.photoUploadsEnabled },
      });
      await createOpenReviewPolicyRevision(
        storeId,
        {
          expectedInstallationGeneration: "g1",
          expectedRevision: policy.revision,
          policy: policyBefore.policy,
        },
        actor,
      );
    }
  });

  it("open provenance privacy: drains orphan and mismatched ownership pages without false completion", async () => {
    const owner = `provenance-owner-${run}`;
    const foreignStore = `provenance-foreign-${run}`;
    const ownedReview = `provenance-owned-review-${run}`;
    const foreignReview = `provenance-foreign-review-${run}`;
    const erasedAt = new Date("2026-09-01T00:00:00Z");
    const ledgerBefore = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    await prisma.weleticProductReview.createMany({
      data: [
        {
          id: ownedReview,
          storeId,
          shopperId: owner,
          productId,
          rating: 1,
          title: "Synthetic",
          body: "Synthetic privacy original",
          displayName: "Fixture",
        },
        {
          id: foreignReview,
          storeId: foreignStore,
          shopperId: owner,
          productId,
          rating: 1,
          title: "Foreign synthetic",
          body: "Foreign content must remain unchanged",
          displayName: "Fixture",
        },
      ],
    });
    const source = (
      suffix: string,
      rowStore: string,
      rowOwner: string,
      reviewId: string,
    ) => ({
      id: `provenance-source-${run}-${suffix}`,
      storeId: rowStore,
      shopperId: rowOwner,
      reviewId,
      installationGeneration: "g1",
      source: "app_proxy",
      idempotencyKey: createHash("sha256")
        .update(`${run}-${suffix}`)
        .digest("hex"),
      contentDigest: "d".repeat(64),
      settingsRevision: 1,
      disclosureRevision: "open_unverified_unrewarded_v1",
      locale: "en",
    });
    const owned = [
      ...Array.from({ length: 21 }, (_, index) => ({
        ...source(
          `orphan-${index}`,
          storeId,
          owner,
          `missing-original-${run}-${index}`,
        ),
        redactedAt: index === 0 ? erasedAt : null,
      })),
      source("secondary", storeId, `other-owner-${run}`, ownedReview),
      source("foreign-pointer", storeId, owner, foreignReview),
    ];
    const others = [
      source(
        "unrelated",
        storeId,
        `other-owner-${run}`,
        `missing-unrelated-${run}`,
      ),
      source("foreign-store", foreignStore, owner, `missing-foreign-${run}`),
    ];
    const ids = [...owned, ...others].map(({ id }) => id);
    await prisma.weleticOpenReviewSubmission.createMany({
      data: [...owned, ...others],
    });
    const otherWhere = { id: { in: others.map(({ id }) => id) } };
    const before = await prisma.weleticOpenReviewSubmission.findMany({
      where: otherWhere,
      orderBy: { id: "asc" },
    });
    const foreignBefore = await prisma.weleticProductReview.findUniqueOrThrow({
      where: { id: foreignReview },
    });
    try {
      expect(await redactNativeReviewsBatch(storeId, owner)).toEqual({
        hasMore: true,
      });
      expect(
        await prisma.weleticOpenReviewSubmission.count({
          where: {
            id: { in: owned.map(({ id }) => id) },
            contentDigest: { not: null },
          },
        }),
      ).toBe(3);
      expect(await redactNativeReviewsBatch(storeId, owner)).toEqual({
        hasMore: false,
      });
      const erased = await prisma.weleticOpenReviewSubmission.findMany({
        where: { id: { in: owned.map(({ id }) => id) } },
        orderBy: { id: "asc" },
      });
      expect(erased).toHaveLength(23);
      for (const row of erased)
        expect(row).toMatchObject({
          contentDigest: null,
          redactedAt: expect.any(Date),
        });
      expect(erased.find((row) => row.id === owned[0].id)?.redactedAt).toEqual(
        erasedAt,
      );
      expect(await redactNativeReviewsBatch(storeId, owner)).toEqual({
        hasMore: false,
      });
      expect(
        await prisma.weleticOpenReviewSubmission.findMany({
          where: { id: { in: owned.map(({ id }) => id) } },
          orderBy: { id: "asc" },
        }),
      ).toEqual(erased);
      expect(
        await prisma.weleticOpenReviewSubmission.findMany({
          where: otherWhere,
          orderBy: { id: "asc" },
        }),
      ).toEqual(before);
      expect(
        await prisma.weleticProductReview.findUniqueOrThrow({
          where: { id: foreignReview },
        }),
      ).toEqual(foreignBefore);
      expect(
        await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
      ).toBe(ledgerBefore);
    } finally {
      await prisma.weleticOpenReviewSubmission.deleteMany({
        where: { id: { in: ids } },
      });
      await prisma.weleticProductReview.deleteMany({
        where: { id: { in: [ownedReview, foreignReview] } },
      });
    }
  });

  it("open provenance privacy: whole-store scrub includes orphaned sources", async () => {
    const {
      redactOpenReviewProvenanceBatch,
      openReviewProvenanceRedactionWhere,
    } = await import("@/lib/weletic/reviews/open-submission-privacy");
    const scope = `whole-provenance-${run}`;
    const id = `whole-provenance-source-${run}`;
    await prisma.weleticOpenReviewSubmission.create({
      data: {
        id,
        storeId: scope,
        shopperId: `missing-owner-${run}`,
        reviewId: `missing-review-${run}`,
        installationGeneration: "g1",
        source: "app_proxy",
        idempotencyKey: "c".repeat(64),
        contentDigest: "d".repeat(64),
        settingsRevision: 1,
        disclosureRevision: "open_unverified_unrewarded_v1",
        locale: "en",
      },
    });
    try {
      await prisma.$transaction((tx) =>
        redactOpenReviewProvenanceBatch(tx, scope),
      );
      expect(
        await prisma.weleticOpenReviewSubmission.count({
          where: openReviewProvenanceRedactionWhere(scope),
        }),
      ).toBe(0);
      const erased = await prisma.weleticOpenReviewSubmission.findUniqueOrThrow(
        { where: { id } },
      );
      expect(erased).toMatchObject({
        contentDigest: null,
        redactedAt: expect.any(Date),
      });
      await prisma.$transaction((tx) =>
        redactOpenReviewProvenanceBatch(tx, scope),
      );
      expect(
        await prisma.weleticOpenReviewSubmission.findUniqueOrThrow({
          where: { id },
        }),
      ).toEqual(erased);
    } finally {
      await prisma.weleticOpenReviewSubmission.deleteMany({
        where: { id, storeId: scope },
      });
    }
  });

  it("private media export: SQL artifact survives a lost checkpoint and deletion of its cursor row", async () => {
    const { exportReviewMediaPage } = await import(
      "@/lib/weletic/reviews/media-export-checkpoint"
    );
    const requestId = `media-export-request-${run}`;
    const exportShopperId = `media-export-shopper-${run}`;
    const ids = ["a", "b", "c"].map(
      (suffix) => `media-export-${run}-${suffix}`,
    );
    const objects = new Map<string, Buffer>();
    for (const key of [
      "STORAGE_ENDPOINT",
      "STORAGE_PRIVATE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ])
      vi.stubEnv(key, "synthetic-export-storage");
    mocks.upload.mockImplementation(async ({ key, body }) => {
      objects.set(key, Buffer.from(body));
      return { url: "unused" };
    });
    mocks.delete.mockImplementation(async ({ key }) => {
      objects.delete(key);
    });
    mocks.signedDownload.mockImplementation(
      async ({ key }) =>
        `https://export-fixture.invalid/${encodeURIComponent(key)}`,
    );
    mocks.readPrivate.mockResolvedValue(Buffer.from("photo"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const parsed = new URL(url);
        if (parsed.hostname !== "export-fixture.invalid")
          throw new Error("Unexpected fixture network request");
        const bytes = objects.get(decodeURIComponent(parsed.pathname.slice(1)));
        return new Response(bytes ? new Uint8Array(bytes) : null, {
          status: bytes ? 200 : 404,
        });
      }),
    );
    await prisma.weleticShopifyComplianceRequest.create({
      data: {
        id: requestId,
        storeId,
        webhookId: requestId,
        shopDomain: "fixture.myshopify.com",
        requestType: "customer_data_request",
        status: "processing",
        phase: "export_review_media",
        lockedBy: "export-worker",
        leaseVersion: 1,
        progress: { ownerShopperId: exportShopperId },
      },
    });
    try {
      for (const id of ids) {
        await prisma.weleticReviewMedia.create({
          data: {
            id,
            storeId,
            requestId: null,
            objectKey: `weletic/reviews/${storeId}/${id}.webp`,
            contentType: "image/webp",
            sizeBytes: 5,
            status: "uploaded",
            uploadExpiresAt: new Date(Date.now() + 60_000),
          },
        });
        const key = createHash("sha256").update(id).digest("hex");
        await prisma.weleticOpenReviewMediaOwnership.create({
          data: {
            id: `owner-${id}`,
            storeId,
            mediaId: id,
            shopperId: exportShopperId,
            productId,
            installationGeneration: "g1",
            source: "app_proxy",
            settingsRevision: 1,
            submissionKey: key,
            idempotencyKey: key,
            contentDigest: "d".repeat(64),
            storageWriteState: "confirmed",
          },
        });
      }
      const input = {
        requestId,
        storeId,
        shopperId: exportShopperId,
        sequence: 0,
        afterId: null,
        expiresAt: new Date(Date.now() + 60_000),
        lease: { workerId: "export-worker", leaseVersion: 1 },
      };
      expect(await exportReviewMediaPage(input)).toEqual({
        fileId: ids[0],
        hasMore: true,
      });
      // Intentionally lose the returned cursor; emulate a process stopping
      // after durable artifact publication but before the worker checkpoint.
      await prisma.weleticOpenReviewMediaOwnership.deleteMany({
        where: { storeId, mediaId: ids[0] },
      });
      await prisma.weleticReviewMedia.deleteMany({
        where: { storeId, id: ids[0] },
      });
      const reads = mocks.readPrivate.mock.calls.length;
      expect(await exportReviewMediaPage(input)).toEqual({
        fileId: ids[0],
        hasMore: true,
      });
      expect(mocks.readPrivate).toHaveBeenCalledTimes(reads);
      expect(
        await exportReviewMediaPage({ ...input, sequence: 1, afterId: ids[0] }),
      ).toEqual({ fileId: ids[1], hasMore: true });
      const artifacts = await prisma.weleticShopifyComplianceArtifact.findMany({
        where: { requestId, storeId, kind: "review_media" },
        orderBy: { sequence: "asc" },
      });
      expect(artifacts.map(({ sequence }) => sequence)).toEqual([0, 1]);
      const { decrypt } = await import("@/lib/encryption");
      const snapshots = artifacts.map((artifact) =>
        JSON.parse(decrypt(objects.get(artifact.storageKey)!.toString("utf8"))),
      );
      expect(snapshots.map((snapshot) => snapshot.files[0].id)).toEqual(
        ids.slice(0, 2),
      );
      expect(JSON.stringify(snapshots)).not.toContain("downloadUrl");
      expect(JSON.stringify(snapshots)).not.toContain("objectKey");
      await prisma.weleticShopifyComplianceRequest.update({
        where: { id: requestId },
        data: { leaseVersion: 2 },
      });
      await expect(exportReviewMediaPage(input)).rejects.toThrow(
        "lease is no longer valid",
      );
    } finally {
      await prisma.weleticShopifyComplianceArtifact.deleteMany({
        where: { storeId, requestId },
      });
      await prisma.weleticShopifyComplianceRequest.deleteMany({
        where: { storeId, id: requestId },
      });
      await prisma.weleticOpenReviewMediaOwnership.deleteMany({
        where: { storeId, mediaId: { in: ids } },
      });
      await prisma.weleticReviewMedia.deleteMany({
        where: { storeId, id: { in: ids } },
      });
      vi.unstubAllGlobals();
    }
  });

  it("private media export: real ownership, attached-source corruption and erasure during read", async () => {
    const { exportReviewMediaFile, reviewMediaFileExportSelect } = await import(
      "@/lib/weletic/reviews/media-file-export"
    );
    const id = `export-photo-${run}`;
    const reviewId = `export-review-${run}`;
    const submissionKey = createHash("sha256").update(id).digest("hex");
    const ledgerBefore = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    await prisma.weleticReviewMedia.create({
      data: {
        id,
        storeId,
        requestId: null,
        objectKey: `weletic/reviews/${storeId}/${id}.webp`,
        contentType: "image/webp",
        sizeBytes: 5,
        status: "uploaded",
        uploadExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.weleticOpenReviewMediaOwnership.create({
      data: {
        id: `owner-${id}`,
        storeId,
        mediaId: id,
        shopperId,
        productId,
        installationGeneration: "g1",
        source: "app_proxy",
        settingsRevision: 1,
        submissionKey,
        idempotencyKey: submissionKey,
        contentDigest: "d".repeat(64),
        storageWriteState: "confirmed",
      },
    });
    const row = () =>
      prisma.weleticReviewMedia.findUniqueOrThrow({
        where: { id },
        select: reviewMediaFileExportSelect,
      });
    try {
      mocks.readPrivate.mockResolvedValue(Buffer.from("photo"));
      expect(
        (await exportReviewMediaFile(storeId, shopperId, await row())).data,
      ).toBe("cGhvdG8=");
      const calls = mocks.readPrivate.mock.calls.length;
      await expect(
        exportReviewMediaFile(storeId, "foreign-owner", await row()),
      ).rejects.toThrow("ownership changed");
      expect(mocks.readPrivate).toHaveBeenCalledTimes(calls);
      await prisma.weleticProductReview.create({
        data: {
          id: reviewId,
          storeId,
          shopperId,
          productId,
          requestId: null,
          rating: 1,
          title: "Synthetic export",
          body: "Synthetic export",
          displayName: "Fixture",
          status: "pending",
        },
      });
      await prisma.weleticOpenReviewSubmission.create({
        data: {
          id: `source-${id}`,
          storeId,
          reviewId,
          shopperId,
          installationGeneration: "g1",
          source: "app_proxy",
          idempotencyKey: submissionKey,
          settingsRevision: 1,
          disclosureRevision: "open-review-v1",
          locale: "en",
          contentDigest: "c".repeat(64),
        },
      });
      await prisma.weleticReviewMedia.update({
        where: { id },
        data: { reviewId },
      });
      expect(
        (await exportReviewMediaFile(storeId, shopperId, await row())).data,
      ).toBe("cGhvdG8=");
      await prisma.weleticOpenReviewSubmission.update({
        where: { reviewId },
        data: { settingsRevision: 2 },
      });
      await expect(
        exportReviewMediaFile(storeId, shopperId, await row()),
      ).rejects.toThrow("attached photo ownership invalid");
      await prisma.weleticOpenReviewSubmission.update({
        where: { reviewId },
        data: { settingsRevision: 1 },
      });
      mocks.readPrivate.mockImplementationOnce(async () => {
        await prisma.weleticOpenReviewMediaOwnership.update({
          where: { mediaId: id },
          data: { redactedAt: new Date(), contentDigest: null },
        });
        return Buffer.from("photo");
      });
      await expect(
        exportReviewMediaFile(storeId, shopperId, await row()),
      ).rejects.toThrow("ownership changed");
      expect(
        await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
      ).toBe(ledgerBefore);
    } finally {
      await prisma.weleticOpenReviewMediaOwnership.deleteMany({
        where: { storeId, mediaId: id },
      });
      await prisma.weleticReviewMedia.deleteMany({ where: { storeId, id } });
      await prisma.weleticOpenReviewSubmission.deleteMany({
        where: { storeId, reviewId },
      });
      await prisma.weleticProductReview.deleteMany({
        where: { storeId, id: reviewId },
      });
    }
  });

  it("open media privacy: erases abandoned reservations with retry containment and tenant isolation", async () => {
    const ownerId = `open-media-owner-${run}`;
    const foreignStore = `open-media-foreign-${run}`;
    const ids = [
      `open-media-a-${run}`,
      `open-media-b-${run}`,
      `open-media-c-${run}`,
      `open-media-d-${run}`,
    ];
    const attachedReviewId = `open-media-review-${run}`;
    await prisma.weleticProductReview.create({
      data: {
        id: attachedReviewId,
        storeId,
        shopperId: ownerId,
        productId,
        requestId: null,
        rating: 1,
        title: "Synthetic",
        body: "Synthetic owned content",
        displayName: "Fixture",
        status: "pending",
      },
    });
    for (const key of [
      "STORAGE_ENDPOINT",
      "STORAGE_PRIVATE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    ])
      vi.stubEnv(key, "synthetic-storage-fixture");
    const ledgerBefore = await prisma.weleticPointsLedgerEntry.count({
      where: { storeId },
    });
    for (let i = 0; i < ids.length; i++) {
      const rowStore = i === 2 ? foreignStore : storeId;
      await prisma.weleticReviewMedia.create({
        data: {
          id: ids[i],
          storeId: rowStore,
          requestId: null,
          reviewId: i === 3 ? attachedReviewId : null,
          objectKey: `weletic/reviews/${rowStore}/${ids[i]}.webp`,
          contentType: "image/webp",
          sizeBytes: 100,
          status: "uploaded",
          uploadExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      await prisma.weleticOpenReviewMediaOwnership.create({
        data: {
          id: `owner-${ids[i]}`,
          storeId: rowStore,
          mediaId: ids[i],
          // The attached original remains authoritative even with mismatched
          // secondary ownership metadata. This is a corruption fixture only.
          shopperId: i === 1 || i === 3 ? shopperId : ownerId,
          productId,
          installationGeneration: "g1",
          source: "app_proxy",
          settingsRevision: 1,
          submissionKey: createHash("sha256")
            .update(`submission-${ids[i]}`)
            .digest("hex"),
          idempotencyKey: createHash("sha256").update(ids[i]).digest("hex"),
          contentDigest: "d".repeat(64),
        },
      });
    }
    const readOthers = () =>
      prisma.weleticReviewMedia.findMany({
        where: { id: { in: ids.slice(1, 3) } },
        orderBy: { id: "asc" },
      });
    const othersBefore = await readOthers();
    mocks.delete.mockRejectedValueOnce(new Error("synthetic storage failure"));
    await expect(redactNativeReviewsBatch(storeId, ownerId)).rejects.toThrow(
      "synthetic storage failure",
    );
    expect(
      await prisma.weleticReviewMedia.findUniqueOrThrow({
        where: { id: ids[0] },
      }),
    ).toMatchObject({ status: "deletion_pending" });
    const erasedOwner =
      await prisma.weleticOpenReviewMediaOwnership.findUniqueOrThrow({
        where: { mediaId: ids[0] },
      });
    expect(erasedOwner).toMatchObject({
      contentDigest: null,
      redactedAt: expect.any(Date),
    });
    expect(await redactNativeReviewsBatch(storeId, ownerId)).toEqual({
      hasMore: false,
    });
    expect(
      await prisma.weleticReviewMedia.findUniqueOrThrow({
        where: { id: ids[0] },
      }),
    ).toMatchObject({ status: "deleted" });
    expect(await redactNativeReviewsBatch(storeId, ownerId)).toEqual({
      hasMore: false,
    });
    expect(
      await prisma.weleticOpenReviewMediaOwnership.findUniqueOrThrow({
        where: { mediaId: ids[0] },
      }),
    ).toEqual(erasedOwner);
    expect(await readOthers()).toEqual(othersBefore);
    expect(
      await prisma.weleticOpenReviewMediaOwnership.findUniqueOrThrow({
        where: { mediaId: ids[3] },
      }),
    ).toMatchObject({ contentDigest: null, redactedAt: expect.any(Date) });
    expect(
      await prisma.weleticReviewMedia.findUniqueOrThrow({
        where: { id: ids[3] },
      }),
    ).toMatchObject({ status: "deleted" });
    expect(
      await prisma.weleticLoyaltyOutboxJob.count({
        where: { storeId, idempotencyKey: `review_privacy_media:${ids[0]}` },
      }),
    ).toBe(1);
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledgerBefore);
    // Exact synthetic metadata cleanup; storage is mocked, no R2 objects exist.
    await prisma.weleticOpenReviewMediaOwnership.deleteMany({
      where: { mediaId: { in: ids } },
    });
    await prisma.weleticReviewMedia.deleteMany({ where: { id: { in: ids } } });
    await prisma.weleticProductReview.deleteMany({
      where: { id: attachedReviewId, storeId },
    });
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
    const erasedSource =
      await prisma.weleticOpenReviewSubmission.findUniqueOrThrow({
        where: { id: `open-source-${run}` },
      });
    expect(erasedSource.contentDigest).toBeNull();
    expect(erasedSource.redactedAt).toBeInstanceOf(Date);
    expect(erasedSource.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    // A partially erased review must not disappear from privacy discovery when
    // its invitation is already cancelled and no longer has delivery work.
    const terminalReview = await prisma.weleticProductReview.findFirstOrThrow({
      where: { storeId, shopperId, status: "redacted" },
      orderBy: { id: "asc" },
    });
    await prisma.weleticProductReview.update({
      where: { id: terminalReview.id },
      data: { body: "synthetic leftover", merchantReply: "synthetic reply" },
    });
    await redactNativeReviewsBatch(storeId, shopperId);
    const repaired = await prisma.weleticProductReview.findUniqueOrThrow({
      where: { id: terminalReview.id },
    });
    expect(repaired).toMatchObject({
      status: "redacted",
      body: "",
      merchantReply: null,
      version: terminalReview.version + 1,
      redactedAt: terminalReview.redactedAt,
      rewardStatus: terminalReview.rewardStatus,
      rewardLedgerId: terminalReview.rewardLedgerId,
      requestId: terminalReview.requestId,
      verifiedPurchase: terminalReview.verifiedPurchase,
    });
    expect(await redactNativeReviewsBatch(storeId, shopperId)).toEqual({
      hasMore: false,
    });
    expect(
      await prisma.weleticProductReview.findUniqueOrThrow({
        where: { id: terminalReview.id },
      }),
    ).toEqual(repaired);
    await prisma.weleticProductReview.update({
      where: { id: terminalReview.id },
      data: { version: 2147483647, title: "synthetic boundary leftover" },
    });
    expect(await redactNativeReviewsBatch(storeId, shopperId)).toEqual({
      hasMore: false,
    });
    const saturated = await prisma.weleticProductReview.findUniqueOrThrow({
      where: { id: terminalReview.id },
    });
    expect(saturated).toMatchObject({
      status: "redacted",
      title: "",
      version: 2147483647,
      redactedAt: terminalReview.redactedAt,
    });
    expect(await redactNativeReviewsBatch(storeId, shopperId)).toEqual({
      hasMore: false,
    });
    expect(
      await prisma.weleticProductReview.findUniqueOrThrow({
        where: { id: terminalReview.id },
      }),
    ).toEqual(saturated);
    expect(await readOtherState()).toEqual(otherState);
    expect(
      await prisma.weleticPointsLedgerEntry.count({ where: { storeId } }),
    ).toBe(ledgerCount);
  });
});
