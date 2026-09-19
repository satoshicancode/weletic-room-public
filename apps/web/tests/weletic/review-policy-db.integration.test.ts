import { Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { shopperDatabaseTarget } from "../utils/shopper-database-target";

const database = new PrismaClient();
vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("server-only", () => ({}));
const catalog = vi.hoisted(() => ({ capture: vi.fn() }));
vi.mock("@/lib/weletic/reviews/coupon-catalog-labels", () => ({
  captureReviewCouponCatalogLabels: catalog.capture,
}));

describe("review policy public-installation SQL authorization", () => {
  beforeEach(() => catalog.capture.mockReset());
  beforeAll(async () => {
    const expected = shopperDatabaseTarget(
      process.env.DATABASE_URL,
      process.env.SHOPPER_PROFILE_DATABASE_INTEGRATION,
    );
    expect(
      await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
    ).toEqual([expected]);
    vi.stubEnv("SHOPIFY_API_KEY", "review-policy-isolated");
    vi.stubEnv("ENCRYPTION_KEY", "37".repeat(32));
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `policy-test:${randomBytes(32).toString("base64")}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("External requests forbidden");
      }),
    );
  });
  // The runner drops this entire fresh database and scoped account. It never
  // targets retained development rows, sessions or credentials.
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await database.$disconnect();
  });

  async function seed(owner = true) {
    const suffix = randomUUID();
    const storeId = `policy-${suffix}`;
    const shop = `policy-${suffix}.myshopify.com`;
    const workspaceId = `workspace-${suffix}`;
    const appId = "review-policy-isolated";
    const installationGeneration = "g1";
    const { encrypt } = await import("../../lib/encryption");
    const { deriveAllShopifyShopPrivacyIdentities } = await import(
      "../../lib/weletic/shopify/privacy-identity"
    );
    const { bindShopifyOnlineSession } = await import(
      "../../lib/weletic/shopify/session-online-binding"
    );
    await database.weleticShopifyStore.create({
      data: {
        id: storeId,
        projectId: workspaceId,
        programId: `program-${suffix}`,
        shopDomain: shop,
        shopCurrency: "JPY",
        currencyVerifiedAt: new Date(),
        apiVersion: "2026-07",
        installationGeneration,
        storeAccessState: "active",
      },
    });
    await database.weleticShopifyPendingInstallation.create({
      data: {
        id: randomUUID(),
        appId,
        ...deriveAllShopifyShopPrivacyIdentities({ shopDomain: shop })[0],
        mappedStoreId: storeId,
        installationGeneration,
        state: "mapped",
        authenticatedAt: new Date(),
      },
    });
    await database.weleticShopifyInstallationCredential.create({
      data: {
        id: randomUUID(),
        storeId,
        appId,
        installationGeneration,
        revision: 1,
        credentialCiphertext: encrypt(
          JSON.stringify({
            version: 1,
            revision: 1,
            identity: {
              storeId,
              workspaceId,
              appId,
              shop,
              installationGeneration,
            },
            material: {
              accessToken: "synthetic-offline",
              scope: "read_products",
            },
          }),
        ),
      },
    });
    const binding = { storeId, appId, shop, installationGeneration };
    const userId = "123";
    const sessionId = `${shop}_${userId}`;
    const expiresAt = new Date(Date.now() + 3600000);
    const payload = encrypt(
      JSON.stringify(
        bindShopifyOnlineSession(
          [
            ["id", sessionId],
            ["shop", shop],
            ["isOnline", true],
            ["userId", 123],
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
    await database.weleticShopifyAppSession.create({
      data: { id: sessionId, shop, isOnline: true, payload, expiresAt },
    });
    const actor = {
      ...binding,
      version: 1 as const,
      userId,
      sessionId,
      sessionDigest: createHash("sha256").update(payload).digest("hex"),
      authenticatedAt: Date.now() - 1000,
      requestId: randomBytes(32).toString("hex"),
    };
    const { shopifyStaffGrantId } = await import(
      "../../lib/weletic/shopify/staff-authorization"
    );
    const grantId = shopifyStaffGrantId(actor);
    if (!owner)
      await database.weleticShopifyStaffGrant.create({
        data: {
          id: grantId,
          storeId,
          appId,
          installationGeneration,
          shopifyUserId: userId,
          updatedByShopifyUserId: userId,
          permissions: ["reviews.configure"],
          revision: 1,
        },
      });
    return { actor, storeId, grantId };
  }
  const receiptCount = (storeId: string) =>
    database.weleticShopifyMerchantAction.count({ where: { storeId } });
  async function save(
    f: Awaited<ReturnType<typeof seed>>,
    expectedRevision = 0,
    draft: unknown = { kind: "none" },
  ) {
    const { draftShopifyMerchantReviewIncentive } = await import(
      "../../lib/weletic/shopify/merchant-review-incentive-draft"
    );
    return draftShopifyMerchantReviewIncentive({
      envelope: f.actor,
      input: { expectedRevision, expectedInstallationGeneration: "g1", draft },
    });
  }

  async function activate(
    f: Awaited<ReturnType<typeof seed>>,
    policy: Awaited<ReturnType<typeof save>>,
    expectedActivePolicyId: string | null = null,
  ) {
    const { activateShopifyMerchantReviewIncentive } = await import(
      "../../lib/weletic/shopify/merchant-review-incentive-activation"
    );
    return activateShopifyMerchantReviewIncentive({
      envelope: { ...f.actor, requestId: randomBytes(32).toString("hex") },
      input: {
        policyId: policy.policyId,
        contentDigest: policy.contentDigest,
        expectedRevision: policy.revision,
        expectedInstallationGeneration: "g1",
        expectedActivePolicyId,
      },
    });
  }

  it("atomically activates one concurrent winner with one audit and receipt", async () => {
    const f = await seed();
    const policy = await save(f);
    const results = await Promise.allSettled([
      activate(f, policy),
      activate(f, policy),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "conflict" },
    });
    expect(await receiptCount(f.storeId)).toBe(2);
    const history = await database.weleticReviewIncentiveActivation.findMany({
      where: { storeId: f.storeId },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      policyId: policy.policyId,
      contentDigest: policy.contentDigest,
      previousPolicyId: null,
      shopifyUserId: f.actor.userId,
    });
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: f.storeId },
      }),
    ).toMatchObject({ activeIncentivePolicyId: policy.policyId });
  });

  it("resolves delayed orders on both sides of an explicit none cutover", async () => {
    const f = await seed();
    const policy = await save(f);
    const result = await activate(f, policy);
    const { reviewPolicyAtOrderTime } = await import(
      "../../lib/weletic/reviews/incentive-activation-history"
    );
    await database.$transaction(async (tx) => {
      expect(
        await reviewPolicyAtOrderTime(
          tx,
          f.storeId,
          new Date(new Date(result.effectiveAt).getTime() - 1),
          policy.policyId,
        ),
      ).toBeNull();
      expect(
        await reviewPolicyAtOrderTime(
          tx,
          f.storeId,
          new Date(result.effectiveAt),
          policy.policyId,
        ),
      ).toBe(policy.policyId);
    });
  });

  it("purges owned activation identity before settings and permits clean history after erasure", async () => {
    const f = await seed();
    const foreign = await seed();
    const policy = await save(f);
    const foreignPolicy = await save(foreign);
    await activate(f, policy);
    await activate(foreign, foreignPolicy);
    const { purgeNativeReviewsBatch } = await import(
      "../../lib/weletic/reviews/privacy"
    );
    await expect(purgeNativeReviewsBatch(f.storeId)).rejects.toThrow("frozen");
    await database.weleticShopifyStore.update({
      where: { id: f.storeId },
      data: { complianceState: "frozen" },
    });
    expect(await purgeNativeReviewsBatch(f.storeId)).toEqual({ hasMore: true });
    expect(
      await database.weleticReviewIncentiveActivation.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticReviewIncentivePolicy.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
    expect(await purgeNativeReviewsBatch(f.storeId)).toEqual({
      hasMore: false,
    });
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: f.storeId },
      }),
    ).toBeNull();
    expect(
      await database.weleticReviewIncentiveActivation.count({
        where: { storeId: foreign.storeId },
      }),
    ).toBe(1);
    const { reviewPolicyAtOrderTime } = await import(
      "../../lib/weletic/reviews/incentive-activation-history"
    );
    expect(
      await database.$transaction((tx) =>
        reviewPolicyAtOrderTime(tx, f.storeId, new Date(), null),
      ),
    ).toBeNull();
  });

  it("preflight creates no receipt, but rejects replay after committed authorization", async () => {
    const f = await seed();
    const { authorizeShopifyMerchantInTransaction: authorize } = await import(
      "../../lib/weletic/shopify/staff-authorization"
    );
    await database.$transaction((tx) =>
      authorize({
        tx,
        envelope: f.actor,
        permission: "reviews.configure",
        recordAction: false,
      }),
    );
    expect(await receiptCount(f.storeId)).toBe(0);
    await save(f);
    expect(await receiptCount(f.storeId)).toBe(1);
    await expect(
      database.$transaction((tx) =>
        authorize({
          tx,
          envelope: f.actor,
          permission: "reviews.configure",
          recordAction: false,
        }),
      ),
    ).rejects.toThrow("request_replayed");
  });

  it("rolls back the receipt when expected revision is stale", async () => {
    const f = await seed();
    await expect(save(f, 1)).rejects.toThrow("policy changed");
    expect(await receiptCount(f.storeId)).toBe(0);
    expect(
      await database.weleticReviewIncentivePolicy.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
  });

  it("concurrent same-revision saves have one winner and one receipt", async () => {
    const f = await seed();
    const other = {
      ...f,
      actor: { ...f.actor, requestId: randomBytes(32).toString("hex") },
    };
    const results = await Promise.allSettled([save(f), save(other)]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
    expect(await receiptCount(f.storeId)).toBe(1);
    expect(
      await database.weleticReviewIncentivePolicy.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
    expect(
      (
        await database.weleticReviewSettings.findUniqueOrThrow({
          where: { storeId: f.storeId },
        })
      ).activeIncentivePolicyId,
    ).toBeNull();
  });

  it("rolls back receipt and revision allocation when policy insertion fails", async () => {
    const f = await seed();
    const { reviewIncentivePolicyDigest } = await import(
      "../../lib/weletic/reviews/incentive-policy"
    );
    const snapshot = { version: 1, award: { kind: "none" } };
    // Deliberately inconsistent synthetic allocator: immutable history already
    // owns revision 1. Its unique constraint must abort the entire new save.
    await database.weleticReviewIncentivePolicy.create({
      data: {
        id: randomUUID(),
        storeId: f.storeId,
        revision: 1,
        snapshot,
        contentDigest: reviewIncentivePolicyDigest(snapshot),
      },
    });
    await expect(save(f)).rejects.toMatchObject({ code: "P2002" });
    expect(await receiptCount(f.storeId)).toBe(0);
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: f.storeId },
      }),
    ).toBeNull();
    expect(
      await database.weleticReviewIncentivePolicy.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(1);
  });

  it.each(["grant", "session", "generation"])(
    "rejects %s invalidation between coupon preflight and commit",
    async (change) => {
      const f = await seed(false);
      const rewardId = randomUUID();
      await database.weleticRewardDefinition.create({
        data: {
          id: rewardId,
          storeId: f.storeId,
          name: "Coupon",
          rewardType: "amount_off",
          pointsCost: BigInt(100),
          discountValue: new Prisma.Decimal(100),
        },
      });
      let invalidated = false;
      catalog.capture.mockImplementationOnce(async () => {
        expect(await receiptCount(f.storeId)).toBe(0);
        if (change === "grant")
          await database.weleticShopifyStaffGrant.update({
            where: { id: f.grantId },
            data: { permissions: [], revision: 2 },
          });
        if (change === "session")
          await database.weleticShopifyAppSession.update({
            where: { id: f.actor.sessionId },
            data: { expiresAt: new Date(0) },
          });
        if (change === "generation")
          await database.weleticShopifyStore.update({
            where: { id: f.storeId },
            data: { installationGeneration: "g2" },
          });
        invalidated = true;
        return [];
      });
      await expect(
        save(f, 0, { kind: "coupon", rewardDefinitionId: rewardId }),
      ).rejects.toMatchObject(
        change === "generation"
          ? { complianceState: "stale_installation_generation" }
          : { code: change === "grant" ? "access_denied" : "invalid_actor" },
      );
      expect(catalog.capture).toHaveBeenCalledTimes(1);
      expect(invalidated).toBe(true);
      expect(await receiptCount(f.storeId)).toBe(0);
      expect(
        await database.weleticReviewIncentivePolicy.count({
          where: { storeId: f.storeId },
        }),
      ).toBe(0);
    },
  );
});
