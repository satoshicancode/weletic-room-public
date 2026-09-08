import { PrismaClient, type WeleticLoyaltyProgram } from "@prisma/client";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const database = new PrismaClient();
const stores: string[] = [];
let safeToClean = false;
vi.mock("@/lib/prisma", () => ({ prisma: database }));
vi.mock("@/lib/api/links/cache", () => ({ linkCache: {} }));

describe("module lifecycle production transactions on isolated MySQL", () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || "invalid:");
    if (
      process.env.MODULE_LIFECYCLE_DATABASE_INTEGRATION !== "1" ||
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      url.username !== "loyalty_dev" ||
      url.pathname !== "/weletic_loyalty_dev"
    )
      throw new Error("Refusing non-isolated module lifecycle database");
    expect(
      await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
    ).toEqual([{ name: "weletic_loyalty_dev", principal: "loyalty_dev@%" }]);
    safeToClean = true;
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `lifecycle:${randomBytes(32).toString("base64")}`,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("External network forbidden in module lifecycle tests");
      }),
    );
  });
  afterAll(async () => {
    if (safeToClean && stores.length) {
      const where = { storeId: { in: stores } };
      await database.weleticShopifyCustomerPrivacyTombstone.deleteMany({
        where,
      });
      await database.weleticLoyaltyAccount.deleteMany({ where });
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

  async function seed(
    status?: WeleticLoyaltyProgram["status"],
    killSwitchActive = false,
  ) {
    const id = randomUUID();
    const storeId = `lifecycle-store-${id}`;
    const programId = `lifecycle-program-${id}`;
    stores.push(storeId);
    // Isolated synthetic scalar parents; no retained merchant or integration.
    await database.weleticShopifyStore.create({
      data: {
        id: storeId,
        projectId: `workspace-${id}`,
        programId: `affiliate-${id}`,
        shopDomain: `lifecycle-${id}.myshopify.com`,
        shopCurrency: "JPY",
        currencyVerifiedAt: new Date(),
        apiVersion: "2026-07",
        installationGeneration: "g1",
      },
    });
    if (status)
      await database.weleticLoyaltyProgram.create({
        data: { id: programId, storeId, status, killSwitchActive },
      });
    return { storeId, programId, expectedInstallationGeneration: "g1" };
  }
  async function ingest(fixture: Awaited<ReturnType<typeof seed>>) {
    const { upsertWeleticShopper } = await import(
      "../../lib/weletic/loyalty/shopper"
    );
    return upsertWeleticShopper({
      ...fixture,
      customer: { id: "42", email: "synthetic@example.test" },
    });
  }

  it.each([undefined, "draft", "test", "disabled"] as const)(
    "keeps shared shopper identity without enrollment for status %s",
    async (status) => {
      const fixture = await seed(status);
      const result = await ingest(fixture);
      expect(result?.shopper?.id).toBeTruthy();
      expect(result?.loyaltyAccount).toBeNull();
      expect(
        await database.weleticLoyaltyAccount.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
      expect(
        await database.weleticLoyaltyProgram.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(status ? 1 : 0);
    },
  );

  it("serializes competing enrollment calls into one account after activation", async () => {
    const fixture = await seed("draft");
    const before = await ingest(fixture);
    await database.weleticLoyaltyProgram.update({
      where: { id: fixture.programId },
      data: { status: "active" },
    });
    const results = await Promise.all([ingest(fixture), ingest(fixture)]);
    expect(
      results.every((result) => result?.shopper?.id === before?.shopper?.id),
    ).toBe(true);
    expect(
      results.filter((result) => result?.loyaltyAccountCreated),
    ).toHaveLength(1);
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it("preserves exact account balances and closed state through disable and reactivation", async () => {
    const fixture = await seed("active");
    const enrolled = await ingest(fixture);
    const id = enrolled!.loyaltyAccount!.id;
    await database.weleticLoyaltyAccount.update({
      where: { id },
      data: {
        status: "closed",
        cachedPointsBalance: BigInt("-9007199254740993"),
      },
    });
    await database.weleticLoyaltyProgram.update({
      where: { id: fixture.programId },
      data: { status: "disabled" },
    });
    expect((await ingest(fixture))?.loyaltyAccount).toMatchObject({
      id,
      status: "closed",
      cachedPointsBalance: BigInt("-9007199254740993"),
    });
    await database.weleticLoyaltyProgram.update({
      where: { id: fixture.programId },
      data: { status: "active" },
    });
    expect((await ingest(fixture))?.loyaltyAccount).toMatchObject({
      id,
      status: "closed",
      cachedPointsBalance: BigInt("-9007199254740993"),
    });
  });

  it("rejects a stale installation before creating shared identity", async () => {
    const fixture = await seed("active");
    await expect(
      ingest({ ...fixture, expectedInstallationGeneration: "old" }),
    ).rejects.toMatchObject({
      complianceState: "stale_installation_generation",
    });
    expect(
      await database.weleticShopper.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(0);
  });

  it.each([
    { status: "draft" as const, kill: false },
    { status: "test" as const, kill: false },
    { status: "disabled" as const, kill: false },
    { status: "active" as const, kill: true },
  ])(
    "prevents preview enrollment for $status / kill=$kill",
    async ({ status, kill }) => {
      const fixture = await seed(status, kill);
      const shopper = (await ingest(fixture))!.shopper!;
      const { ensureBackfillPreviewAccount } = await import(
        "../../lib/weletic/loyalty/backfill"
      );
      await expect(
        ensureBackfillPreviewAccount({ ...fixture, shopperId: shopper.id }),
      ).rejects.toMatchObject({ name: "LoyaltyProgramWriteBlockedError" });
      expect(
        await database.weleticLoyaltyAccount.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    },
  );

  it("reuses one account across concurrent preview enrollment and rejects another store's shopper", async () => {
    const fixture = await seed("draft");
    const shopper = (await ingest(fixture))!.shopper!;
    await database.weleticLoyaltyProgram.update({
      where: { id: fixture.programId },
      data: { status: "active" },
    });
    const { ensureBackfillPreviewAccount } = await import(
      "../../lib/weletic/loyalty/backfill"
    );
    const input = { ...fixture, shopperId: shopper.id };
    const [first, second] = await Promise.all([
      ensureBackfillPreviewAccount(input),
      ensureBackfillPreviewAccount(input),
    ]);
    expect(first?.id).toBeTruthy();
    expect(first?.id).toBe(second?.id);
    const foreign = await seed("active");
    expect(
      await ensureBackfillPreviewAccount({ ...foreign, shopperId: shopper.id }),
    ).toBeNull();
    expect(
      await database.weleticLoyaltyAccount.count({
        where: { storeId: fixture.storeId },
      }),
    ).toBe(1);
  });

  it.each(["pseudonym", "expired-owner"] as const)(
    "does not enroll an erased reviews-only identity: %s",
    async (mode) => {
      const fixture = await seed("draft");
      const shopper = (await ingest(fixture))!.shopper!;
      if (mode === "pseudonym") {
        await database.weleticShopper.update({
          where: { id: shopper.id },
          data: {
            shopifyCustomerId: `redacted:v1:lifecycle:${"A".repeat(64)}`,
            email: null,
          },
        });
      } else {
        await database.weleticShopifyCustomerPrivacyTombstone.create({
          data: {
            id: randomUUID(),
            storeId: fixture.storeId,
            shopperId: shopper.id,
            identityKind: "customer_id",
            identityKeyId: "retired",
            customerDigest: "B".repeat(64),
            redactedAt: new Date("2025-01-01"),
            expiresAt: new Date("2025-01-02"),
          },
        });
      }
      await database.weleticLoyaltyProgram.update({
        where: { id: fixture.programId },
        data: { status: "active" },
      });
      const { ensureBackfillPreviewAccount } = await import(
        "../../lib/weletic/loyalty/backfill"
      );
      expect(
        await ensureBackfillPreviewAccount({
          ...fixture,
          shopperId: shopper.id,
        }),
      ).toBeNull();
      expect(
        await database.weleticLoyaltyAccount.count({
          where: { storeId: fixture.storeId },
        }),
      ).toBe(0);
    },
  );

  it("observes disable when it wins the store lock before customer ingestion", async () => {
    const fixture = await seed("active");
    let started!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      started = resolve;
    });
    const finish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const disable = database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${fixture.storeId} FOR UPDATE`;
      started();
      await finish;
      await tx.weleticLoyaltyProgram.update({
        where: { id: fixture.programId },
        data: { status: "disabled" },
      });
    });
    await locked;
    const pendingIngestion = ingest(fixture);
    release();
    const [, result] = await Promise.all([disable, pendingIngestion]);
    expect(result?.loyaltyProgram?.status).toBe("disabled");
    expect(result?.loyaltyAccount).toBeNull();
  });
});
