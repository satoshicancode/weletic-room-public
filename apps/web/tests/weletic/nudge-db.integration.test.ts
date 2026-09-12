import { prisma } from "@/lib/prisma";
import { defaultLoyaltyNudgeSettings } from "@/lib/weletic/loyalty/nudge-contract";
import {
  LoyaltyNudgeConflictError,
  readLoyaltyNudgesInTransaction,
  saveLoyaltyNudgesInTransaction,
} from "@/lib/weletic/loyalty/nudge-service";
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
  timeout: 15000,
};
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.NUDGE_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    url.pathname !== "/weletic_loyalty_it_nudges_20260910a"
  )
    throw new Error("Refusing non-isolated nudge database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS db, CURRENT_USER() AS principal, @@server_uuid AS uuid`,
  ).toEqual([
    {
      db: "weletic_loyalty_it_nudges_20260910a",
      principal: "loyalty_dev@%",
      uuid: "e9bdf12e-a953-11f1-a31f-7699455bc162",
    },
  ]);
  for (const table of [
    "Project",
    "Program",
    "WeleticShopifyStore",
    "WeleticLoyaltyProgram",
  ]) {
    expect(
      await prisma.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM ${table}`),
    ).toEqual([{ n: BigInt(0) }]);
  }
  verified = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in nudge DB tests");
    }),
  );
});
afterAll(async () => {
  try {
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
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM Program WHERE id IN (${Prisma.join(fixtures)})`,
      );
      await prisma.$executeRaw(
        Prisma.sql`DELETE FROM Project WHERE id IN (${Prisma.join(fixtures)})`,
      );
    }
  } finally {
    vi.unstubAllGlobals();
    await prisma.$disconnect();
  }
});
async function seed() {
  const id = `nudge-${randomUUID()}`;
  fixtures.push(id);
  await prisma.project.create({
    data: { id, name: "Nudge fixture", slug: id, billingCycleStart: 1 },
  });
  await prisma.program.create({
    data: {
      id,
      workspaceId: id,
      name: "Nudge fixture",
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
const read = (id: string) =>
  prisma.$transaction((tx) => readLoyaltyNudgesInTransaction(tx, id), options);
function save(id: string, revision: string, title: string) {
  return prisma.$transaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: id,
      expectedInstallationGeneration: "g1",
      action: "loyalty_nudge_write",
    });
    const settings = defaultLoyaltyNudgeSettings();
    settings.policies[0].templates.en.title = title;
    return saveLoyaltyNudgesInTransaction({
      tx,
      storeId: id,
      installationGeneration: "g1",
      request: {
        operation: "save",
        expectedInstallationGeneration: "g1",
        expectedRevision: revision,
        settings,
      },
    });
  }, options);
}
it("commits one competing revision and preserves unrelated metadata without activation", async () => {
  const id = await seed();
  const initial = await read(id);
  const results = await Promise.allSettled([
    save(id, initial.revision, "First"),
    save(id, initial.revision, "Second"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = results.filter((r) => r.status === "rejected");
  expect(rejected).toHaveLength(1);
  const conflict = rejected[0];
  if (conflict.status !== "rejected")
    throw new Error("Expected rejected competing save");
  expect(conflict.reason).toBeInstanceOf(LoyaltyNudgeConflictError);
  const row = await prisma.weleticLoyaltyProgram.findUniqueOrThrow({
    where: { storeId: id },
  });
  expect(row.status).toBe("disabled");
  expect(row.metadata).toMatchObject({
    unrelated: "preserve",
    loyaltyNudgeSequence: 1,
  });
  const current = await read(id);
  expect(current.revision).not.toBe(initial.revision);
  expect(["First", "Second"]).toContain(
    current.settings.policies[0].templates.en.title,
  );
  expect(current.settings.policies.every((p) => !p.enabled)).toBe(true);
});
it("rejects another store's revision without mutating either store", async () => {
  const first = await seed();
  const second = await seed();
  const a = await read(first);
  const b = await read(second);
  await expect(save(second, a.revision, "Foreign")).rejects.toBeInstanceOf(
    LoyaltyNudgeConflictError,
  );
  expect(await read(first)).toEqual(a);
  expect(await read(second)).toEqual(b);
});
it("rejects stale generation after the competing lifecycle writer commits", async () => {
  const id = await seed();
  const initial = await read(id);
  let release!: () => void;
  let acquired!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const lifecycle = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${id} FOR UPDATE`;
    acquired();
    await hold;
    await tx.weleticShopifyStore.update({
      where: { id },
      data: { installationGeneration: "g2" },
    });
  }, options);
  await locked;
  const write = save(id, initial.revision, "Stale");
  const outcome = Promise.allSettled([write]);
  release();
  await lifecycle;
  const result = (await outcome)[0];
  expect(result.status).toBe("rejected");
  if (result.status === "rejected")
    expect(result.reason).toBeInstanceOf(
      ShopifyStoreOperationalWritesBlockedError,
    );
  expect(await read(id)).toEqual(initial);
});
