import { PrismaClient } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = new PrismaClient();
let accountReadFailure: (() => Promise<never>) | undefined;
const serviceDatabase = database.$extends({
  query: {
    weleticLoyaltyAccount: {
      async findFirst({ args, query }) {
        if (accountReadFailure) return accountReadFailure();
        return query(args);
      },
    },
  },
});
const stores: string[] = [];
let safeToClean = false;
vi.mock("@/lib/prisma", () => ({ prisma: serviceDatabase }));
vi.mock("@/lib/api/links/cache", () => ({ linkCache: {} }));

describe("shared merchant settings on isolated MySQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      process.env.MERCHANT_SETTINGS_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      url.username !== "loyalty_dev" ||
      url.pathname !== "/weletic_loyalty_dev"
    )
      throw new Error("Refusing non-isolated merchant settings database");
    expect(
      await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
    ).toEqual([{ name: "weletic_loyalty_dev", principal: "loyalty_dev@%" }]);
    safeToClean = true;
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `settings:${randomBytes(32).toString("base64")}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error(
          "External network forbidden in settings database tests",
        );
      }),
    );
  });
  afterAll(async () => {
    if (safeToClean && stores.length) {
      const where = { storeId: { in: stores } };
      await database.weleticLoyaltyOutboxJob.deleteMany({ where });
      await database.weleticProductReview.deleteMany({ where });
      await database.weleticReviewRequest.deleteMany({ where });
      await database.weleticReviewSettings.deleteMany({ where });
      await database.weleticLoyaltyReferral.deleteMany({ where });
      await database.weleticMerchantSettings.deleteMany({ where });
      await database.weleticShopifyStore.deleteMany({
        where: { id: { in: stores } },
      });
    }
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await database.$disconnect();
  });
  async function seed() {
    const id = randomUUID();
    const storeId = `settings-${id}`;
    const workspaceId = `workspace-${id}`;
    stores.push(storeId);
    await database.weleticShopifyStore.create({
      data: {
        storeAccessState: "active",
        id: storeId,
        projectId: workspaceId,
        programId: `affiliate-${id}`,
        shopDomain: `settings-${id}.myshopify.com`,
        shopCurrency: "JPY",
        currencyVerifiedAt: new Date(),
        apiVersion: "2026-07",
        installationGeneration: "g1",
      },
    });
    return { storeId, workspaceId };
  }
  async function read(workspaceId: string) {
    return (
      await import("../../lib/weletic/merchant-settings/service")
    ).readMerchantSettings(workspaceId);
  }
  it("toggles loyalty with the existing expiry and immutable earn-policy writer", async () => {
    const { storeId } = await seed();
    const program = await database.weleticLoyaltyProgram.create({
      data: {
        id: `program-${randomUUID()}`,
        storeId,
        status: "disabled",
        pointsPerCurrencyUnit: "2.125",
        pointsExpiryDays: 7,
        liabilityValuationCurrency: "JPY",
        liabilityMinorUnitsNumerator: BigInt(1),
        liabilityPointsDenominator: BigInt(100),
        pointsExpiryPolicyVersion: 3,
      },
    });
    const { toggleLoyaltyModuleInTransaction } = await import(
      "../../lib/weletic/loyalty/module-settings"
    );
    const toggle = (
      status: "active" | "disabled",
      expectedStatus: "active" | "disabled",
    ) =>
      database.$transaction(
        (tx) =>
          toggleLoyaltyModuleInTransaction(tx, storeId, {
            status,
            expectedStatus,
            expectedInstallationGeneration: "g1",
          }),
        { isolationLevel: "Serializable" },
      );
    const before = new Date();
    const active = await toggle("active", "disabled");
    expect(active).toMatchObject({
      status: "active",
      pointsExpiryPolicyVersion: 4,
      pointsExpiryDays: 7,
      liabilityValuationCurrency: "JPY",
      liabilityMinorUnitsNumerator: BigInt(1),
      liabilityPointsDenominator: BigInt(100),
    });
    expect(active.pointsPerCurrencyUnit.toString()).toBe("2.125");
    expect(active.pointsExpiryPolicyAnchorAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    await expect(toggle("disabled", "disabled")).rejects.toMatchObject({
      code: "conflict",
    });
    const disabled = await toggle("disabled", "active");
    expect(disabled).toMatchObject({
      status: "disabled",
      pointsExpiryPolicyVersion: 5,
      pointsExpiryPolicyAnchorAt: null,
    });
    const revisions = await database.weleticLoyaltyEarnPolicyRevision.findMany({
      where: { programId: program.id },
      orderBy: { version: "asc" },
    });
    expect(revisions).toHaveLength(2);
    expect(revisions.map((row) => row.snapshot)).toEqual([
      expect.objectContaining({
        program: expect.objectContaining({
          status: "active",
          pointsExpiryPolicyVersion: 4,
        }),
      }),
      expect.objectContaining({
        program: expect.objectContaining({
          status: "disabled",
          pointsExpiryPolicyVersion: 5,
        }),
      }),
    ]);
  });

  it("rolls back loyalty transitions and preserves the emergency kill switch", async () => {
    const { storeId } = await seed();
    const previous = await database.weleticLoyaltyProgram.create({
      data: {
        id: `program-${randomUUID()}`,
        storeId,
        status: "disabled",
        killSwitchActive: true,
        pointsExpiryDays: 7,
      },
    });
    const { toggleLoyaltyModuleInTransaction } = await import(
      "../../lib/weletic/loyalty/module-settings"
    );
    await expect(
      database.$transaction(
        async (tx) => {
          const next = await toggleLoyaltyModuleInTransaction(tx, storeId, {
            status: "active",
            expectedStatus: "disabled",
            expectedInstallationGeneration: "g1",
          });
          expect(next.killSwitchActive).toBe(true);
          expect(next.pointsExpiryPolicyAnchorAt).toBeNull();
          throw new Error("caller rollback");
        },
        { isolationLevel: "Serializable" },
      ),
    ).rejects.toThrow("caller rollback");
    expect(
      await database.weleticLoyaltyProgram.findUnique({ where: { storeId } }),
    ).toEqual(previous);
    expect(
      await database.weleticLoyaltyEarnPolicyRevision.count({
        where: { storeId },
      }),
    ).toBe(0);
    const empty = await seed();
    await expect(
      database.$transaction(
        (tx) =>
          toggleLoyaltyModuleInTransaction(tx, empty.storeId, {
            status: "active",
            expectedStatus: "draft",
            expectedInstallationGeneration: "g1",
          }),
        { isolationLevel: "Serializable" },
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(
      await database.weleticLoyaltyProgram.count({
        where: { storeId: empty.storeId },
      }),
    ).toBe(0);
  });
  async function save(
    workspaceId: string,
    settings: Record<string, unknown>,
    expectedRevision = 0,
    role = "owner",
    generation = "g1",
  ) {
    return (
      await import("../../lib/weletic/merchant-settings/service")
    ).updateMerchantSettings(
      workspaceId,
      {
        settings,
        expectedRevision,
        expectedInstallationGeneration: generation,
      },
      role,
    );
  }
  it("reads defaults without creating any program or settings row", async () => {
    const f = await seed();
    const result = await read(f.workspaceId);
    expect(result).toMatchObject({
      revision: 0,
      settings: { timeZone: null, shopperEmailPaused: false },
      modules: {
        loyalty: { status: "not_configured" },
        reviews: { enabled: false },
      },
    });
    expect(
      await database.weleticMerchantSettings.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticLoyaltyProgram.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
  });
  it("keeps an externally authorized settings write inside the caller rollback", async () => {
    const f = await seed();
    const {
      updateMerchantSettingsInTransaction,
      readMerchantSettingsInTransaction,
    } = await import("../../lib/weletic/merchant-settings/service");
    await expect(
      database.$transaction(async (tx) => {
        await updateMerchantSettingsInTransaction({
          tx,
          storeId: f.storeId,
          workspaceId: f.workspaceId,
          input: {
            expectedRevision: 0,
            expectedInstallationGeneration: "g1",
            settings: { brandName: "Rolled back", defaultLocale: "vi" },
          },
        });
        const inside = await readMerchantSettingsInTransaction(
          tx,
          f.workspaceId,
        );
        expect(inside.settings.brandName).toBe("Rolled back");
        expect(inside.settings.defaultLocale).toBe("vi");
        throw new Error("authorized caller failed");
      }),
    ).rejects.toThrow("authorized caller failed");
    const after = await read(f.workspaceId);
    expect(after.revision).toBe(0);
    expect(after.settings.brandName).toBeNull();
    expect(after.settings.defaultLocale).toBe("en");
  });
  it("rejects a different workspace and stale revisions in transaction-level writes", async () => {
    const f = await seed();
    const foreign = await seed();
    const { updateMerchantSettingsInTransaction } = await import(
      "../../lib/weletic/merchant-settings/service"
    );
    const input = {
      expectedRevision: 0,
      expectedInstallationGeneration: "g1",
      settings: { shopperEmailPaused: true },
    };
    await expect(
      database.$transaction((tx) =>
        updateMerchantSettingsInTransaction({
          tx,
          storeId: f.storeId,
          workspaceId: foreign.workspaceId,
          input,
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect((await read(foreign.workspaceId)).revision).toBe(0);
    await database.$transaction((tx) =>
      updateMerchantSettingsInTransaction({
        tx,
        storeId: f.storeId,
        workspaceId: f.workspaceId,
        input,
      }),
    );
    await expect(
      database.$transaction((tx) =>
        updateMerchantSettingsInTransaction({
          tx,
          storeId: f.storeId,
          workspaceId: f.workspaceId,
          input,
        }),
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await read(f.workspaceId)).revision).toBe(1);
  });
  it.each(["absent", "unpaused", "paused"] as const)(
    "polls actual MySQL outbox jobs correctly with %s merchant settings",
    async (policy) => {
      const f = await seed();
      if (policy !== "absent")
        await save(f.workspaceId, { shopperEmailPaused: policy === "paused" });
      const prefix = randomUUID();
      const data = [
        {
          id: `${prefix}-review`,
          jobType: "REVIEW_REQUEST_EMAIL" as const,
          payload: {
            requestId: "missing-fixture",
            installationGeneration: "g1",
          },
          priority: 10,
        },
        ...(["warning", "last_chance", "expire"] as const).map((stage) => ({
          id: `${prefix}-${stage}`,
          jobType: "INACTIVITY_EXPIRY" as const,
          payload: {
            accountId: "missing-fixture",
            lastActivityAt: new Date().toISOString(),
            expiryMonths: 12,
            stage,
            installationGeneration: "g1",
          },
          priority: stage === "expire" ? 0 : 10,
        })),
        {
          id: `${prefix}-summary`,
          jobType: "REVIEW_SUMMARY_SYNC" as const,
          payload: { productId: "*", installationGeneration: "g1" },
          priority: 0,
        },
      ].map((job) => ({
        ...job,
        storeId: f.storeId,
        scheduledFor: new Date(0),
      }));
      await database.weleticLoyaltyOutboxJob.createMany({ data });
      const { processOutboxJobsBatch } = await import(
        "../../lib/weletic/loyalty/outbox-worker"
      );
      const result = await processOutboxJobsBatch({
        storeId: f.storeId,
        jobIds: data.map(({ id }) => id),
        batchSize: policy === "paused" ? 2 : 5,
      });
      expect(result).toMatchObject({
        processed: policy === "paused" ? 2 : 5,
        succeeded: policy === "paused" ? 2 : 5,
        failed: 0,
        deadLettered: 0,
      });
      const jobs = await database.weleticLoyaltyOutboxJob.findMany({
        where: { storeId: f.storeId },
      });
      for (const job of jobs) {
        const shouldPause = policy === "paused" && job.priority === 10;
        expect(job).toMatchObject({
          status: shouldPause ? "pending" : "completed",
          attempts: shouldPause ? 0 : 1,
          lockedBy: null,
          lockedAt: null,
        });
      }
      if (policy === "paused") {
        await save(f.workspaceId, { shopperEmailPaused: false }, 1);
        const resumed = await processOutboxJobsBatch({
          storeId: f.storeId,
          jobIds: data.map(({ id }) => id),
        });
        expect(resumed).toMatchObject({
          succeeded: 3,
          failed: 0,
          deadLettered: 0,
        });
      }
    },
  );
  it("saves shared branding and locale without activating either module or inferring a timezone", async () => {
    const f = await seed();
    const result = await save(f.workspaceId, {
      brandName: "Shared Brand",
      defaultLocale: "ja",
      accentColor: "#ABCDEF",
    });
    expect(result).toMatchObject({
      revision: 1,
      settings: {
        brandName: "Shared Brand",
        defaultLocale: "ja",
        accentColor: "#abcdef",
        timeZone: null,
      },
      modules: {
        loyalty: { status: "not_configured" },
        reviews: { enabled: false },
      },
    });
    expect(
      await database.weleticLoyaltyProgram.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticReviewSettings.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
  });
  it.each([false, true])(
    "restores pause deferrals only for the winning MySQL claim (stale worker: %s)",
    async (staleWorker) => {
      const f = await seed();
      const job = await database.weleticLoyaltyOutboxJob.create({
        data: {
          id: randomUUID(),
          storeId: f.storeId,
          jobType: "INACTIVITY_EXPIRY",
          payload: {
            accountId: "missing-fixture",
            stage: "warning",
            expiryAt: "2099-01-01T00:00:00.000Z",
            installationGeneration: "g1",
          },
          scheduledFor: new Date(0),
          status: "failed",
          attempts: 2,
          lastError: "retained failure",
        },
      });
      const { ShopperEmailPausedError } = await import(
        "../../lib/weletic/merchant-settings/communications"
      );
      // Inject the producer's pause signal after the real worker has claimed its
      // row. This tests MySQL claim restoration, not remote lock/transport proof.
      accountReadFailure = async () => {
        accountReadFailure = undefined;
        await save(f.workspaceId, { shopperEmailPaused: true });
        if (staleWorker)
          await database.weleticLoyaltyOutboxJob.update({
            where: { id: job.id },
            data: { lockedBy: "new-winning-worker", attempts: 4 },
          });
        throw new ShopperEmailPausedError();
      };
      try {
        const { processOutboxJobsBatch } = await import(
          "../../lib/weletic/loyalty/outbox-worker"
        );
        const result = await processOutboxJobsBatch({
          storeId: f.storeId,
          jobIds: [job.id],
        });
        expect(result).toMatchObject({
          processed: 0,
          failed: 0,
          deadLettered: 0,
          skipped: 1,
        });
        expect(
          await database.weleticLoyaltyOutboxJob.findUnique({
            where: { id: job.id },
          }),
        ).toMatchObject(
          staleWorker
            ? {
                status: "processing",
                attempts: 4,
                lockedBy: "new-winning-worker",
              }
            : {
                status: "failed",
                attempts: 2,
                lockedBy: null,
                lockedAt: null,
                lastError: "retained failure",
              },
        );
      } finally {
        accountReadFailure = undefined;
      }
    },
  );
  it("blocks referral leases while paused, then permits exactly one resumed delivery callback", async () => {
    const f = await seed();
    const referral = await database.weleticLoyaltyReferral.create({
      data: {
        id: randomUUID(),
        storeId: f.storeId,
        advocateAccountId: "missing-fixture",
        friendRewardProvisionedAt: new Date(),
      },
    });
    await save(f.workspaceId, { shopperEmailPaused: true });
    const { deliverReferralEmailUnderLease } = await import(
      "../../lib/weletic/loyalty/referral-friend-claim"
    );
    const deliver = vi.fn(async () => ({ success: true }));
    const input = { referralId: referral.id, storeId: f.storeId, deliver };
    expect(await deliverReferralEmailUnderLease(input)).toMatchObject({
      acquired: false,
      emailSent: false,
    });
    expect(deliver).not.toHaveBeenCalled();
    expect(
      await database.weleticLoyaltyReferral.findUnique({
        where: { id: referral.id },
      }),
    ).toMatchObject({
      friendEmailDeliveryAttempts: 0,
      friendEmailLeaseToken: null,
    });
    await save(f.workspaceId, { shopperEmailPaused: false }, 1);
    const results = await Promise.all(
      Array.from({ length: 12 }, () => deliverReferralEmailUnderLease(input)),
    );
    expect(results.filter(({ acquired }) => acquired)).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(
      await database.weleticLoyaltyReferral.findUnique({
        where: { id: referral.id },
      }),
    ).toMatchObject({
      friendEmailDeliveryAttempts: 1,
      friendEmailLeaseToken: null,
      friendRewardEmailedAt: expect.any(Date),
    });
  });
  it("rejects one of two racing stale revisions without lost updates", async () => {
    const f = await seed();
    const results = await Promise.allSettled([
      save(f.workspaceId, { brandName: "First" }),
      save(f.workspaceId, { brandName: "Second" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" && rejection.reason.code).toBe(
      "conflict",
    );
    expect((await read(f.workspaceId)).revision).toBe(1);
  });
  it("does not cross workspace boundaries and rejects unauthorized roles", async () => {
    const a = await seed();
    const b = await seed();
    await save(a.workspaceId, { brandName: "A" });
    expect((await read(b.workspaceId)).settings.brandName).toBeNull();
    await expect(
      save(b.workspaceId, { brandName: "Forbidden" }, 0, "member"),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect((await read(b.workspaceId)).revision).toBe(0);
  });
  it("fences reinstall generations and frozen stores", async () => {
    const f = await seed();
    await expect(
      save(f.workspaceId, { brandName: "Stale" }, 0, "owner", "old"),
    ).rejects.toMatchObject({
      complianceState: "stale_installation_generation",
    });
    await database.weleticShopifyStore.update({
      where: { id: f.storeId },
      data: { complianceState: "frozen" },
    });
    await expect(read(f.workspaceId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      save(f.workspaceId, { brandName: "Frozen" }),
    ).rejects.toMatchObject({ complianceState: "frozen" });
    expect(
      await database.weleticMerchantSettings.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
  });
  it("pauses/resumes producer policy without changing review configuration or mistaking a literal Weletic brand for fallback", async () => {
    const f = await seed();
    await database.weleticReviewSettings.create({
      data: {
        storeId: f.storeId,
        enabled: true,
        requestEmailEnabled: true,
        sendAfterDays: 14,
      },
    });
    await save(f.workspaceId, {
      brandName: "Weletic",
      shopperEmailPaused: true,
      timeZone: "America/New_York",
    });
    const { readShopperCommunicationSettings } = await import(
      "../../lib/weletic/merchant-settings/communications"
    );
    expect(
      await readShopperCommunicationSettings({
        storeId: f.storeId,
        legacyBrandName: "Other",
      }),
    ).toMatchObject({ brandName: "Weletic", paused: true });
    await save(f.workspaceId, { shopperEmailPaused: false }, 1);
    expect(
      (await readShopperCommunicationSettings({ storeId: f.storeId })).paused,
    ).toBe(false);
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: f.storeId },
      }),
    ).toMatchObject({
      enabled: true,
      requestEmailEnabled: true,
      sendAfterDays: 14,
    });
  });
  it("toggles reviews through the existing writer without overwriting saved collection policy", async () => {
    const f = await seed();
    const previous = await database.weleticReviewSettings.create({
      data: {
        storeId: f.storeId,
        enabled: true,
        requestEmailEnabled: true,
        sendAfterDays: 21,
        expiresAfterDays: 45,
      },
    });
    const { updateReviewSettings } = await import(
      "../../lib/weletic/reviews/service"
    );
    await updateReviewSettings(f.storeId, null, {
      enabled: false,
      expectedUpdatedAt: previous.updatedAt.toISOString(),
      expectedInstallationGeneration: "g1",
    });
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: f.storeId },
      }),
    ).toMatchObject({
      enabled: false,
      requestEmailEnabled: true,
      sendAfterDays: 21,
      expiresAfterDays: 45,
    });
    await expect(
      updateReviewSettings(f.storeId, null, {
        enabled: true,
        expectedUpdatedAt: previous.updatedAt.toISOString(),
        expectedInstallationGeneration: "g1",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
  it("rolls back a caller-transaction review toggle and its outbox event together", async () => {
    const f = await seed();
    const previous = await database.weleticReviewSettings.create({
      data: {
        storeId: f.storeId,
        enabled: true,
        requestEmailEnabled: true,
        sendAfterDays: 14,
      },
    });
    const { toggleReviewModuleInTransaction } = await import(
      "../../lib/weletic/reviews/service"
    );
    // Cancellation fixtures, not purchase-validation evidence. These references
    // are deliberately synthetic; the module writer never fetches commerce data.
    const requestId = `toggle-${randomUUID()}`;
    const originalTokenHash = randomBytes(32).toString("hex");
    await database.weleticReviewRequest.create({
      data: {
        id: requestId,
        storeId: f.storeId,
        orderId: `order-${requestId}`,
        productId: `product-${requestId}`,
        shopperId: `shopper-${requestId}`,
        status: "sent",
        fulfilledAt: new Date(),
        sendAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        tokenHash: originalTokenHash,
      },
    });
    await expect(
      database.$transaction(async (tx) => {
        const result = await toggleReviewModuleInTransaction(tx, f.storeId, {
          enabled: false,
          expectedUpdatedAt: previous.updatedAt.toISOString(),
          expectedInstallationGeneration: "g1",
        });
        expect(result.enabled).toBe(false);
        expect(
          await tx.weleticReviewRequest.findUnique({
            where: { id: requestId },
          }),
        ).toMatchObject({ status: "cancelled", tokenHash: null });
        expect(
          await tx.weleticLoyaltyOutboxJob.count({
            where: { storeId: f.storeId },
          }),
        ).toBe(1);
        throw new Error("Caller rollback");
      }),
    ).rejects.toThrow("Caller rollback");
    expect(
      await database.weleticReviewSettings.findUnique({
        where: { storeId: f.storeId },
      }),
    ).toEqual(previous);
    expect(
      await database.weleticLoyaltyOutboxJob.count({
        where: { storeId: f.storeId },
      }),
    ).toBe(0);
    expect(
      await database.weleticReviewRequest.findUnique({
        where: { id: requestId },
      }),
    ).toMatchObject({ status: "sent", tokenHash: originalTokenHash });
  });
});
