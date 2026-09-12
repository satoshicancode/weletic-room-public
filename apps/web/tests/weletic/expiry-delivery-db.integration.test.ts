import { prisma } from "@/lib/prisma";
import {
  retainExpiryDeliveryRequest,
  type ExpiryDeliveryClaim,
} from "@/lib/weletic/loyalty/expiry-delivery-snapshot";
import { scrubCustomerContextJsonValue } from "@/lib/weletic/loyalty/shopper-privacy";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const fixtures: string[] = [];
let verified = false;
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.EXPIRY_DELIVERY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    !/^\/weletic_loyalty_it_expiry_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error("Refusing non-isolated expiry delivery database");
  const rows = await prisma.$queryRaw<
    Array<{ databaseName: string; principal: string }>
  >`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`;
  expect(rows).toEqual([
    { databaseName: url.pathname.slice(1), principal: "loyalty_dev@%" },
  ]);
  expect(await prisma.weleticShopifyStore.count()).toBe(0);
  verified = true;
  vi.stubEnv("ENCRYPTION_KEY", "test-only-isolated-expiry-envelope-key");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in expiry DB tests");
    }),
  );
});
afterAll(async () => {
  if (verified && fixtures.length) {
    await prisma.weleticLoyaltyOutboxJob.deleteMany({
      where: { storeId: { in: fixtures } },
    });
    await prisma.weleticLoyaltyAccount.deleteMany({
      where: { storeId: { in: fixtures } },
    });
    await prisma.weleticShopper.deleteMany({
      where: { storeId: { in: fixtures } },
    });
    await prisma.weleticLoyaltyProgram.deleteMany({
      where: { storeId: { in: fixtures } },
    });
    await prisma.weleticShopifyStore.deleteMany({
      where: { id: { in: fixtures } },
    });
    // These fixture-only affiliate parents have no enrollments. Prisma's legacy
    // relation-mode cascade issues a failing enrollment query on this schema;
    // do not change shared schema to clean up a disposable test. Bind only the
    // exact IDs created by this run after deleting their loyalty children.
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
    expect(await prisma.weleticShopifyStore.count()).toBe(0);
    expect(await prisma.weleticLoyaltyOutboxJob.count()).toBe(0);
    expect(await prisma.weleticLoyaltyAccount.count()).toBe(0);
    expect(await prisma.weleticShopper.count()).toBe(0);
    expect(await prisma.weleticLoyaltyProgram.count()).toBe(0);
    expect(await prisma.program.count()).toBe(0);
    expect(await prisma.project.count()).toBe(0);
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await prisma.$disconnect();
});

const request = {
  to: "synthetic@example.com",
  from: "test@example.com",
  subject: "Saved",
  html: "<p>Saved synthetic balance</p>",
};
async function seed() {
  const id = `expiry-${randomUUID()}`;
  fixtures.push(id);
  await prisma.project.create({
    data: { id, name: "Expiry DB fixture", slug: id, billingCycleStart: 1 },
  });
  await prisma.program.create({
    data: {
      id,
      workspaceId: id,
      name: "Expiry DB fixture",
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
    data: { id, storeId: id, status: "active" },
  });
  await prisma.weleticShopper.create({
    data: { id, storeId: id, shopifyCustomerId: id },
  });
  await prisma.weleticLoyaltyAccount.create({
    data: { id, storeId: id, programId: id, shopperId: id, status: "active" },
  });
  const candidate = await prisma.weleticLoyaltyOutboxJob.create({
    data: {
      id,
      storeId: id,
      jobType: "INACTIVITY_EXPIRY",
      status: "processing",
      attempts: 1,
      lockedBy: "fixture-owner",
      lockedAt: new Date(),
      idempotencyKey: `fixture-${id}`,
      payload: {
        accountId: id,
        stage: "warning",
        installationGeneration: "g1",
      },
    },
  });
  const claim: ExpiryDeliveryClaim = {
    candidate,
    ownerToken: candidate.lockedBy!,
    claimedAt: candidate.lockedAt!,
    attempt: 1,
  };
  const prepare = vi.fn().mockResolvedValue(request);
  return {
    id,
    claim,
    args: {
      claim,
      accountId: id,
      expectedInstallationGeneration: "g1",
      recipientEmail: request.to,
      idempotencyKey: `loyalty-expiry-job-${id}`,
      prepare,
    },
  };
}

it("allows one competing claim snapshot and reuses its exact persisted request", async () => {
  const { id, args } = await seed();
  const outcomes = await Promise.allSettled([
    retainExpiryDeliveryRequest(args),
    retainExpiryDeliveryRequest({
      ...args,
      claim: structuredClone(args.claim),
    }),
  ]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(
    1,
  );
  const row = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id },
  });
  expect(JSON.stringify(row.payload)).not.toContain(request.to);
  expect(row.payload).toHaveProperty("expiryDeliverySnapshot");
  const forbiddenPrepare = vi.fn(() => {
    throw new Error("Must reuse persisted request");
  });
  expect(
    await retainExpiryDeliveryRequest({
      ...args,
      claim: { ...args.claim, candidate: row },
      prepare: forbiddenPrepare,
    }),
  ).toEqual(request);
  expect(forbiddenPrepare).not.toHaveBeenCalled();
});

// Hold a real store-row transaction while starting a competing retention call.
// This checks outcomes under overlapping transactions; it does not claim to
// measure MySQL's precise lock-wait duration or distributed worker leases.
async function overlapStoreChange(
  id: string,
  mutate: (tx: Prisma.TransactionClient) => Promise<unknown>,
  retain: () => Promise<unknown>,
) {
  let signalLocked!: () => void;
  let release!: () => void;
  const locked = new Promise<void>((resolve) => {
    signalLocked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const change = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${id} FOR UPDATE`;
    await mutate(tx);
    signalLocked();
    await gate;
  });
  // Surface setup failures instead of leaving the test waiting for a signal.
  await Promise.race([
    locked,
    change.then(() => {
      throw new Error("Unexpected transaction completion");
    }),
  ]);
  const attempt = retain().then(
    () => ({ rejected: false }),
    () => ({ rejected: true }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  await change;
  expect(await attempt).toEqual({ rejected: true });
}

it("rejects the old generation while a reconnect transaction wins", async () => {
  const { id, args } = await seed();
  await overlapStoreChange(
    id,
    (tx) =>
      tx.weleticShopifyStore.update({
        where: { id },
        data: { installationGeneration: "g2" },
      }),
    () => retainExpiryDeliveryRequest(args),
  );
  expect(args.prepare).not.toHaveBeenCalled();
  const row = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id },
  });
  expect(row.payload).not.toHaveProperty("expiryDeliverySnapshot");
});

it("rejects a taken-over worker claim without retaining customer content", async () => {
  const { id, args } = await seed();
  await overlapStoreChange(
    id,
    (tx) =>
      tx.weleticLoyaltyOutboxJob.update({
        where: { id },
        data: { lockedBy: "new-owner", attempts: 2 },
      }),
    () => retainExpiryDeliveryRequest(args),
  );
  expect(args.prepare).not.toHaveBeenCalled();
  const row = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id },
  });
  expect(row.payload).not.toHaveProperty("expiryDeliverySnapshot");
});

it("cannot restore an encrypted envelope after privacy closure erases it", async () => {
  const { id, args } = await seed();
  await retainExpiryDeliveryRequest(args);
  await overlapStoreChange(
    id,
    async (tx) => {
      await tx.weleticLoyaltyAccount.update({
        where: { id },
        data: { status: "closed" },
      });
      const row = await tx.weleticLoyaltyOutboxJob.findUniqueOrThrow({
        where: { id },
      });
      await tx.weleticLoyaltyOutboxJob.update({
        where: { id },
        data: { payload: scrubCustomerContextJsonValue(row.payload!) },
      });
    },
    () => retainExpiryDeliveryRequest(args),
  );
  const row = await prisma.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id },
  });
  expect(row.payload).not.toHaveProperty("expiryDeliverySnapshot");
  expect(args.prepare).toHaveBeenCalledTimes(1);
});
