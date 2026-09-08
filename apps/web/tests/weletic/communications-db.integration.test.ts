import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  readLoyaltyCommunicationsInTransaction,
  saveLoyaltyCommunicationsInTransaction,
} from "../../lib/weletic/loyalty/communications-service";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";

const database = new PrismaClient();
const stores: string[] = [];
let safeToClean = false;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.COMMUNICATIONS_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    url.pathname !== "/weletic_loyalty_dev"
  )
    throw new Error("Refusing non-isolated communications database");
  expect(
    await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
  ).toEqual([{ name: "weletic_loyalty_dev", principal: "loyalty_dev@%" }]);
  safeToClean = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in communications DB tests");
    }),
  );
});
afterAll(async () => {
  if (safeToClean && stores.length) {
    await database.weleticLoyaltyProgram.deleteMany({
      where: { storeId: { in: stores } },
    });
    await database.weleticShopifyStore.deleteMany({
      where: { id: { in: stores } },
    });
  }
  vi.unstubAllGlobals();
  await database.$disconnect();
});
async function seed() {
  const id = `communications-${randomUUID()}`;
  stores.push(id);
  await database.weleticShopifyStore.create({
    data: {
      id,
      projectId: `workspace-${id}`,
      programId: `affiliate-${id}`,
      shopDomain: `${id}.myshopify.com`,
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date(),
      apiVersion: "2026-07",
      installationGeneration: "g1",
    },
  });
  return id;
}
const read = (storeId: string) =>
  database.$transaction((tx) =>
    readLoyaltyCommunicationsInTransaction(tx, storeId),
  );
async function save(
  storeId: string,
  revision: string,
  subject: string,
  expectedGeneration = "g1",
) {
  return database.$transaction(
    async (tx) => {
      // Same store -> program order as authenticated merchant lifecycle locking.
      const rows = await tx.$queryRaw<
        Array<{ installationGeneration: string }>
      >(
        Prisma.sql`SELECT installationGeneration FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`,
      );
      if (!rows[0]) throw new Error("Missing fixture store");
      const policy = createDefaultLoyaltyCommunicationPolicy("points_earned");
      policy.templates.en.subject = subject;
      return saveLoyaltyCommunicationsInTransaction({
        tx,
        storeId,
        installationGeneration: rows[0].installationGeneration,
        request: {
          operation: "save",
          expectedRevision: revision,
          expectedInstallationGeneration: expectedGeneration,
          policy,
        },
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
it("allows one winner when two editors concurrently create the initial policy", async () => {
  const store = await seed();
  const initial = await read(store);
  const outcomes = await Promise.allSettled([
    save(store, initial.revision, "First"),
    save(store, initial.revision, "Second"),
  ]);
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  const loser = outcomes.find(
    (outcome) => outcome.status === "rejected",
  ) as PromiseRejectedResult;
  expect(loser.reason.message).toBe("Loyalty communications state changed");
  expect(
    await database.weleticLoyaltyProgram.count({ where: { storeId: store } }),
  ).toBe(1);
  expect(
    (
      await database.weleticLoyaltyProgram.findUniqueOrThrow({
        where: { storeId: store },
      })
    ).status,
  ).toBe("draft");
});
it("allows one winner on existing policy and preserves unrelated current metadata", async () => {
  const store = await seed();
  const first = await save(store, (await read(store)).revision, "Initial");
  const program = await database.weleticLoyaltyProgram.findUniqueOrThrow({
    where: { storeId: store },
  });
  await database.weleticLoyaltyProgram.update({
    where: { id: program.id },
    data: {
      metadata: {
        ...(program.metadata as Prisma.JsonObject),
        unrelatedWriter: { marker: "preserve" },
      },
    },
  });
  const outcomes = await Promise.allSettled([
    save(store, first.revision, "One"),
    save(store, first.revision, "Two"),
  ]);
  expect(
    outcomes.filter((outcome) => outcome.status === "fulfilled"),
  ).toHaveLength(1);
  const current = await database.weleticLoyaltyProgram.findUniqueOrThrow({
    where: { storeId: store },
  });
  expect((current.metadata as Prisma.JsonObject).unrelatedWriter).toEqual({
    marker: "preserve",
  });
  expect(
    (
      (current.metadata as Prisma.JsonObject)
        .loyaltyCommunications as Prisma.JsonObject
    ).sequence,
  ).toBe(2);
});
it("rejects a prior installation generation without changing policy", async () => {
  const store = await seed();
  const initial = await read(store);
  await database.weleticShopifyStore.update({
    where: { id: store },
    data: { installationGeneration: "g2" },
  });
  await expect(save(store, initial.revision, "Stale")).rejects.toThrow(
    "state changed",
  );
  expect(await read(store)).toEqual(initial);
});
it("rejects another tenant revision without creating a program", async () => {
  const first = await seed();
  const second = await seed();
  await expect(
    save(second, (await read(first)).revision, "Cross store"),
  ).rejects.toThrow("state changed");
  expect(
    await database.weleticLoyaltyProgram.count({ where: { storeId: second } }),
  ).toBe(0);
});
