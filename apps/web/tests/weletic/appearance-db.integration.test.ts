import { prisma } from "@/lib/prisma";
import {
  LoyaltyAppearanceConflictError,
  readLoyaltyAppearanceInTransaction,
  saveLoyaltyAppearanceInTransaction,
} from "@/lib/weletic/loyalty/appearance-service";
import { DEFAULT_LOYALTY_BRANDING } from "@/lib/weletic/loyalty/branding";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  ShopifyStoreOperationalWritesBlockedError,
} from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const fixtures: string[] = [];
let verified = false;
const options = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: 15_000,
};
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.APPEARANCE_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    url.pathname !== "/weletic_loyalty_it_expiry_1789023388566"
  )
    throw new Error("Refusing non-isolated appearance database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    { databaseName: url.pathname.slice(1), principal: "loyalty_dev@%" },
  ]);
  expect(await prisma.weleticShopifyStore.count()).toBe(0);
  expect(await prisma.weleticLoyaltyProgram.count()).toBe(0);
  expect(await prisma.project.count()).toBe(0);
  expect(await prisma.program.count()).toBe(0);
  verified = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in appearance DB tests");
    }),
  );
});
afterAll(async () => {
  if (verified && fixtures.length) {
    await prisma.weleticLoyaltyProgram.deleteMany({
      where: { storeId: { in: fixtures } },
    });
    await prisma.weleticShopifyStore.deleteMany({
      where: { id: { in: fixtures } },
    });
    expect(
      await prisma.programEnrollment.count({
        where: { programId: { in: fixtures } },
      }),
    ).toBe(0);
    // Exact fixture parents only; avoid the legacy relation-mode enrollment
    // cascade, without changing shared schema or deleting unknown records.
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM Program WHERE id IN (${Prisma.join(fixtures)})`,
    );
    await prisma.$executeRaw(
      Prisma.sql`DELETE FROM Project WHERE id IN (${Prisma.join(fixtures)})`,
    );
    expect(await prisma.weleticLoyaltyProgram.count()).toBe(0);
    expect(await prisma.weleticShopifyStore.count()).toBe(0);
    expect(await prisma.program.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
  }
  vi.unstubAllGlobals();
  await prisma.$disconnect();
});
async function seed() {
  const id = `appearance-${randomUUID()}`;
  fixtures.push(id);
  await prisma.project.create({
    data: { id, name: "Appearance DB fixture", slug: id, billingCycleStart: 1 },
  });
  await prisma.program.create({
    data: {
      id,
      workspaceId: id,
      name: "Appearance DB fixture",
      slug: id,
      defaultFolderId: id,
      defaultGroupId: id,
    },
  });
  await prisma.weleticShopifyStore.create({
    data: {
      id,
      projectId: id,
      programId: id,
      shopDomain: `${id}.myshopify.com`,
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date(),
      storeAccessState: "active",
      complianceState: "active",
      installationGeneration: "g1",
      apiVersion: "2026-07",
    },
  });
  await prisma.weleticLoyaltyProgram.create({
    data: {
      id,
      storeId: id,
      status: "disabled",
      metadata: { unrelated: "preserve" },
    },
  });
  return id;
}
const read = (storeId: string) =>
  prisma.$transaction(
    (tx) => readLoyaltyAppearanceInTransaction(tx, storeId),
    options,
  );
function save(storeId: string, revision: string, text: string) {
  return prisma.$transaction(async (tx) => {
    // Real operational store lock/generation gate; actor authentication is
    // separately covered by the signed gateway tests, not claimed here.
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId,
      expectedInstallationGeneration: "g1",
      action: "loyalty_appearance_write",
    });
    return saveLoyaltyAppearanceInTransaction({
      tx,
      storeId,
      installationGeneration: "g1",
      request: {
        operation: "save",
        expectedInstallationGeneration: "g1",
        expectedRevision: revision,
        branding: { ...DEFAULT_LOYALTY_BRANDING, launcherText: text },
      },
    });
  }, options);
}
it("commits exactly one of two competing revisions without activating loyalty", async () => {
  const id = await seed();
  const initial = await read(id);
  const results = await Promise.allSettled([
    save(id, initial.revision, "First"),
    save(id, initial.revision, "Second"),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  for (const result of results) {
    if (result.status === "rejected")
      expect(result.reason).toBeInstanceOf(LoyaltyAppearanceConflictError);
  }
  const row = await prisma.weleticLoyaltyProgram.findUniqueOrThrow({
    where: { storeId: id },
  });
  expect(row.status).toBe("disabled");
  expect(row.metadata).toEqual({
    unrelated: "preserve",
    loyaltyAppearanceSequence: 1,
  });
  expect(["First", "Second"]).toContain(
    (row.branding as Record<string, unknown>).launcherText,
  );
  expect((await read(id)).revision).not.toBe(initial.revision);
});
it("rejects a foreign store revision without changing either program", async () => {
  const first = await seed();
  const second = await seed();
  await expect(
    save(second, (await read(first)).revision, "Foreign"),
  ).rejects.toBeInstanceOf(LoyaltyAppearanceConflictError);
  expect((await read(first)).branding.launcherText).not.toBe("Foreign");
  expect((await read(second)).branding.launcherText).not.toBe("Foreign");
});
it("rejects a stale generation after an overlapping generation writer commits first", async () => {
  const id = await seed();
  const initial = await read(id);
  let release!: () => void;
  let locked!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const change = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${id} FOR UPDATE`;
    locked();
    await hold;
    await tx.weleticShopifyStore.update({
      where: { id },
      data: { installationGeneration: "g2" },
    });
  }, options);
  // Avoid an unhandled rejection if setup fails before acquiring the lock.
  await Promise.race([acquired, change]);
  const attempt = save(id, initial.revision, "Stale");
  release();
  const results = await Promise.allSettled([change, attempt]);
  expect(results[0].status).toBe("fulfilled");
  expect(results[1].status).toBe("rejected");
  if (results[1].status === "rejected")
    expect(results[1].reason).toBeInstanceOf(
      ShopifyStoreOperationalWritesBlockedError,
    );
  expect((await read(id)).revision).toBe(initial.revision);
});
