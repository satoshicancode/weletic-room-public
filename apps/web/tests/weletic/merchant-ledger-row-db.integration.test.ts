import { prisma } from "@/lib/prisma";
import { readShopifyMerchantLedgerRowExportInTransaction } from "@/lib/weletic/shopify/merchant-ledger-row-export";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/weletic/shopify/staff-authorization", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/staff-authorization")
  >()),
  authorizeShopifyMerchantInTransaction: auth.authorize,
}));

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = [0, 1].map((index) => ({
  project: `ledger_export_project_${index}_${suffix}`,
  program: `ledger_export_program_${index}_${suffix}`,
  store: `ledger_export_store_${index}_${suffix}`,
  loyalty: `ledger_export_loyalty_${index}_${suffix}`,
}));
const accounts = [0, 1, 2].map(
  (index) => `ledger_export_account_${index}_${suffix}`,
);
const shoppers = [0, 1, 2].map(
  (index) => `ledger_export_shopper_${index}_${suffix}`,
);
const instant = new Date("2026-09-10T12:00:00.000Z");
const request = {
  filter: {
    startAt: "2026-09-01T00:00:00.000Z",
    endAt: "2026-09-30T23:59:59.999Z",
  },
  expectedInstallationGeneration: "generation-sql",
};
const readExport = () =>
  prisma.$transaction(
    (tx) =>
      readShopifyMerchantLedgerRowExportInTransaction({
        tx,
        envelope: { signed: true },
        request,
      }),
    { timeout: 20_000 },
  );
let initialized = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const target = /^\/weletic_loyalty_it_ledger_rows_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_LEDGER_ROW_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3314" ||
    !target ||
    url.username !== `wlr_${target[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated ledger-row database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    { databaseName: url.pathname.slice(1), principal: `${url.username}@%` },
  ]);
  expect(await prisma.weleticPointsLedgerEntry.count()).toBe(0);
  initialized = true;
  for (const [index, item] of ids.entries()) {
    await prisma.project.create({
      data: {
        id: item.project,
        name: "Ledger export SQL",
        slug: item.project,
        billingCycleStart: 1,
      },
    });
    await prisma.program.create({
      data: {
        id: item.program,
        workspaceId: item.project,
        defaultFolderId: `folder_${index}_${suffix}`,
        defaultGroupId: `group_${index}_${suffix}`,
        name: "Ledger export SQL",
        slug: item.program,
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        id: item.store,
        projectId: item.project,
        programId: item.program,
        shopDomain: `ledger-export-${index}-${suffix}.myshopify.com`,
        shopCurrency: "USD",
        apiVersion: "2026-07",
      },
    });
    await prisma.weleticLoyaltyProgram.create({
      data: { id: item.loyalty, storeId: item.store, status: "active" },
    });
  }
  for (const [index, accountId] of accounts.entries()) {
    const storeIndex = index === 2 ? 1 : 0;
    await prisma.weleticShopper.create({
      data: {
        id: shoppers[index],
        storeId: ids[storeIndex].store,
        shopifyCustomerId: `ledger_export_customer_${index}_${suffix}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: accountId,
        storeId: ids[storeIndex].store,
        programId: ids[storeIndex].loyalty,
        shopperId: shoppers[index],
      },
    });
  }
  await prisma.weleticPointsLedgerEntry.createMany({
    data: [
      {
        id: `a_001_${suffix}`,
        storeId: ids[0].store,
        accountId: accounts[0],
        sequenceNumber: 1,
        entryType: "BACKFILL",
        pointsDelta: BigInt("9007199254740997"),
        balanceAfter: BigInt("9007199254740997"),
        idempotencyKey: `private_backfill_${suffix}`,
        reason: "private source row",
        createdAt: instant,
      },
      {
        id: `a_002_${suffix}`,
        storeId: ids[0].store,
        accountId: accounts[0],
        sequenceNumber: 2,
        entryType: "BACKFILL_CORRECTION",
        pointsDelta: BigInt("-5"),
        balanceAfter: BigInt("9007199254740992"),
        idempotencyKey: `private_correction_${suffix}`,
        referenceId: "private order",
        createdAt: instant,
      },
      {
        id: `z_001_${suffix}`,
        storeId: ids[0].store,
        accountId: accounts[1],
        sequenceNumber: 1,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt("3"),
        balanceAfter: BigInt("3"),
        idempotencyKey: `second_account_${suffix}`,
        createdAt: instant,
      },
      {
        id: `m_001_${suffix}`,
        storeId: ids[1].store,
        accountId: accounts[2],
        sequenceNumber: 1,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt("99"),
        balanceAfter: BigInt("99"),
        idempotencyKey: `foreign_store_${suffix}`,
        createdAt: instant,
      },
    ],
  });
  auth.authorize.mockResolvedValue({
    owner: true,
    storeId: ids[0].store,
    installationGeneration: "generation-sql",
  });
});

afterAll(async () => {
  if (initialized) {
    await prisma.weleticPointsLedgerEntry.deleteMany({
      where: { accountId: { in: accounts } },
    });
    await prisma.weleticLoyaltyAccount.deleteMany({
      where: { id: { in: accounts } },
    });
    await prisma.weleticShopper.deleteMany({
      where: { id: { in: shoppers } },
    });
    await prisma.weleticLoyaltyProgram.deleteMany({
      where: { id: { in: ids.map(({ loyalty }) => loyalty) } },
    });
    await prisma.weleticShopifyStore.deleteMany({
      where: { id: { in: ids.map(({ store }) => store) } },
    });
    for (const item of ids) {
      await prisma.$executeRaw`DELETE FROM Program WHERE id = ${item.program}`;
      await prisma.$executeRaw`DELETE FROM Project WHERE id = ${item.project}`;
    }
  }
  await prisma.$disconnect();
});

it("exports exact retained rows by store, suppresses redacted accounts and refuses a partial cap", async () => {
  const first = await readExport();
  expect(first.status).toBe("available");
  expect(first.rows).toHaveLength(3);
  expect(first.rows[0]).toMatchObject({
    entryType: "BACKFILL",
    pointsDelta: "9007199254740997",
    balanceAfter: "9007199254740997",
  });
  expect(first.rows[1]).toMatchObject({
    entryType: "BACKFILL_CORRECTION",
    pointsDelta: "-5",
    balanceAfter: "9007199254740992",
  });
  expect(first.rows[0].accountPseudonym).toBe(first.rows[1].accountPseudonym);
  expect(first.rows[2].accountPseudonym).not.toBe(
    first.rows[0].accountPseudonym,
  );
  expect(JSON.stringify(first)).not.toMatch(
    /private source row|private order|ledger_export_account|foreign_store/,
  );

  await prisma.weleticPointsLedgerEntry.createMany({
    data: Array.from({ length: 1_998 }, (_, index) => ({
      id: `a_${String(index + 3).padStart(4, "0")}_${suffix}`,
      storeId: ids[0].store,
      accountId: accounts[0],
      sequenceNumber: index + 3,
      entryType: "EARN_ORDER" as const,
      pointsDelta: BigInt("1"),
      balanceAfter: BigInt("9007199254740993") + BigInt(index),
      idempotencyKey: `extra_${index}_${suffix}`,
      createdAt: instant,
    })),
  });
  const overLimit = await readExport();
  expect(overLimit).toMatchObject({ status: "too_large", rows: [] });
  await prisma.weleticLoyaltyAccount.update({
    where: { id: accounts[0] },
    data: { metadata: { shopifyCustomerRedaction: { status: "redacted" } } },
  });
  const afterRedaction = await readExport();
  expect(afterRedaction.status).toBe("available");
  expect(afterRedaction.rows).toHaveLength(1);
  expect(afterRedaction.rows[0].pointsDelta).toBe("3");
});

it("waits for an in-flight erasure before returning rows", async () => {
  await prisma.weleticPointsLedgerEntry.deleteMany({
    where: { accountId: accounts[0], sequenceNumber: { gte: 3 } },
  });
  await prisma.weleticLoyaltyAccount.update({
    where: { id: accounts[0] },
    data: { metadata: { temporaryTestState: true } },
  });
  let lockReady!: () => void;
  let unlock!: () => void;
  const locked = new Promise<void>((resolve) => (lockReady = resolve));
  const release = new Promise<void>((resolve) => (unlock = resolve));
  const erasure = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticLoyaltyAccount WHERE id = ${accounts[0]} FOR UPDATE`;
      lockReady();
      await release;
      await tx.weleticLoyaltyAccount.update({
        where: { id: accounts[0] },
        data: {
          metadata: { shopifyCustomerRedaction: { status: "redacted" } },
        },
      });
    },
    { timeout: 20_000 },
  );
  await locked;
  let completed = false;
  const exportRead = readExport().finally(() => {
    completed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(completed).toBe(false);
  } finally {
    unlock();
  }
  await erasure;
  const result = await exportRead;
  expect(result.status).toBe("available");
  expect(result.rows).toHaveLength(1);
});
