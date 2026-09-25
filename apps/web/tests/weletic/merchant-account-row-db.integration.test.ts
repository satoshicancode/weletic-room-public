import { prisma } from "@/lib/prisma";
import { readShopifyMerchantAccountRowExportInTransaction } from "@/lib/weletic/shopify/merchant-account-row-export";
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
  project: `account_export_project_${index}_${suffix}`,
  program: `account_export_program_${index}_${suffix}`,
  store: `account_export_store_${index}_${suffix}`,
  loyalty: `account_export_loyalty_${index}_${suffix}`,
}));
const accounts = [0, 1, 2].map((index) => `account_export_${index}_${suffix}`);
const shoppers = [0, 1, 2].map((index) => `account_shopper_${index}_${suffix}`);
const tierId = `account_export_tier_${suffix}`;
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
      readShopifyMerchantAccountRowExportInTransaction({
        tx,
        envelope: { signed: true },
        request,
      }),
    { timeout: 20_000 },
  );
let initialized = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.LOYALTY_ACCOUNT_ROW_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3314" ||
    url.pathname !== "/weletic_loyalty_it_account_rows" ||
    url.username !== "war_account" ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated account-row database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    {
      databaseName: "weletic_loyalty_it_account_rows",
      principal: "war_account@%",
    },
  ]);
  expect(await prisma.weleticLoyaltyAccount.count()).toBe(0);
  initialized = true;
  for (const [index, item] of ids.entries()) {
    await prisma.project.create({
      data: {
        id: item.project,
        name: "Account export SQL",
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
        name: "Account export SQL",
        slug: item.program,
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        id: item.store,
        projectId: item.project,
        programId: item.program,
        shopDomain: `account-export-${index}-${suffix}.myshopify.com`,
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
        shopifyCustomerId: `private_customer_${index}_${suffix}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: accountId,
        storeId: ids[storeIndex].store,
        programId: ids[storeIndex].loyalty,
        shopperId: shoppers[index],
        enrolledAt: new Date(`2026-09-${10 + index}T12:00:00.000Z`),
        cachedPointsBalance:
          index === 0 ? BigInt("9007199254740997") : BigInt("3"),
        cachedPendingPoints: BigInt("2"),
        lifetimePointsEarned: BigInt("9007199254740999"),
        lifetimePointsRedeemed: BigInt("4"),
      },
    });
  }
  await prisma.weleticLoyaltyTier.create({
    data: {
      id: tierId,
      programId: ids[0].loyalty,
      name: "Current tier",
      slug: `current-${suffix}`,
      tierOrder: 2,
    },
  });
  await prisma.weleticLoyaltyAccount.update({
    where: { id: accounts[0] },
    data: { currentTierId: tierId },
  });
  auth.authorize.mockResolvedValue({
    owner: true,
    storeId: ids[0].store,
    installationGeneration: "generation-sql",
  });
});

afterAll(async () => {
  if (initialized) {
    await prisma.weleticLoyaltyAccount.deleteMany({
      where: { id: { in: accounts } },
    });
    await prisma.weleticShopper.deleteMany({
      where: { id: { in: shoppers } },
    });
    await prisma.weleticLoyaltyTier.deleteMany({ where: { id: tierId } });
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

it("exports exact current values for one store without shopper identifiers", async () => {
  const result = await readExport();
  expect(result.status).toBe("available");
  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]).toMatchObject({
    accountStatus: "active",
    currentTierOrder: 2,
    cachedPointsBalance: "9007199254740997",
    cachedPendingPoints: "2",
    lifetimePointsEarned: "9007199254740999",
    lifetimePointsRedeemed: "4",
  });
  expect(JSON.stringify(result)).not.toMatch(
    /account_export_[012]|account_shopper|private_customer|foreign_store/,
  );
  expect(result.rows[0].accountPseudonym).not.toBe(
    result.rows[1].accountPseudonym,
  );
  const again = await readExport();
  expect(again.rows[0].accountPseudonym).toBe(result.rows[0].accountPseudonym);
});

it("waits for an in-flight erasure and excludes the newly redacted account", async () => {
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
  expect(result.rows[0].cachedPointsBalance).toBe("3");
});

it("refuses a partial SQL export at 2,001 eligible accounts", async () => {
  const extraShoppers = Array.from(
    { length: 2_000 },
    (_, index) => `account_cap_shopper_${index}_${suffix}`,
  );
  const extraAccounts = Array.from(
    { length: 2_000 },
    (_, index) => `account_cap_${index}_${suffix}`,
  );
  await prisma.weleticShopper.createMany({
    data: extraShoppers.map((id, index) => ({
      id,
      storeId: ids[0].store,
      shopifyCustomerId: `account_cap_customer_${index}_${suffix}`,
    })),
  });
  try {
    await prisma.weleticLoyaltyAccount.createMany({
      data: extraAccounts.map((id, index) => ({
        id,
        storeId: ids[0].store,
        programId: ids[0].loyalty,
        shopperId: extraShoppers[index],
        enrolledAt: new Date("2026-09-20T00:00:00.000Z"),
      })),
    });
    const result = await readExport();
    expect(result.status).toBe("too_large");
    expect(result.rows).toEqual([]);
  } finally {
    await prisma.weleticLoyaltyAccount.deleteMany({
      where: { id: { in: extraAccounts } },
    });
    await prisma.weleticShopper.deleteMany({
      where: { id: { in: extraShoppers } },
    });
  }
});
