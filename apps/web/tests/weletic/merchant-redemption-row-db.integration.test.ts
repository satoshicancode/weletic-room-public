import { prisma } from "@/lib/prisma";
import { readShopifyMerchantRedemptionRowExportInTransaction } from "@/lib/weletic/shopify/merchant-redemption-row-export";
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
  project: `redemption_export_project_${index}_${suffix}`,
  program: `redemption_export_program_${index}_${suffix}`,
  store: `redemption_export_store_${index}_${suffix}`,
  loyalty: `redemption_export_loyalty_${index}_${suffix}`,
  reward: `redemption_export_reward_${index}_${suffix}`,
}));
const accounts = [0, 1, 2].map(
  (index) => `redemption_export_account_${index}_${suffix}`,
);
const shoppers = [0, 1, 2].map(
  (index) => `redemption_export_shopper_${index}_${suffix}`,
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
      readShopifyMerchantRedemptionRowExportInTransaction({
        tx,
        envelope: { signed: true },
        request,
      }),
    { timeout: 20_000 },
  );
let initialized = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const target = /^\/weletic_loyalty_it_redemption_rows_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_REDEMPTION_ROW_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3315" ||
    !target ||
    url.username !== `wrr_${target[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated redemption-row database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    { databaseName: url.pathname.slice(1), principal: `${url.username}@%` },
  ]);
  expect(await prisma.weleticRewardRedemption.count()).toBe(0);
  initialized = true;
  for (const [index, item] of ids.entries()) {
    await prisma.project.create({
      data: {
        id: item.project,
        name: "Redemption export SQL",
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
        name: "Redemption export SQL",
        slug: item.program,
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        id: item.store,
        projectId: item.project,
        programId: item.program,
        shopDomain: `redemption-export-${index}-${suffix}.myshopify.com`,
        shopCurrency: "USD",
        apiVersion: "2026-07",
      },
    });
    await prisma.weleticLoyaltyProgram.create({
      data: { id: item.loyalty, storeId: item.store, status: "active" },
    });
    await prisma.weleticRewardDefinition.create({
      data: {
        id: item.reward,
        storeId: item.store,
        name: "Fixture discount",
        rewardType: "amount_off",
        pointsCost: BigInt(3),
      },
    });
  }
  for (const [index, accountId] of accounts.entries()) {
    const storeIndex = index === 2 ? 1 : 0;
    await prisma.weleticShopper.create({
      data: {
        id: shoppers[index],
        storeId: ids[storeIndex].store,
        shopifyCustomerId: `redemption_export_customer_${index}_${suffix}`,
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
  await prisma.weleticRewardRedemption.createMany({
    data: [
      {
        id: `a_001_${suffix}`,
        storeId: ids[0].store,
        accountId: accounts[0],
        rewardDefinitionId: ids[0].reward,
        pointsSpent: BigInt("9007199254740997"),
        shopifyDiscountCode: `private_code_1_${suffix}`,
        shopifyDiscountCodeCanonical: `PRIVATE_CODE_1_${suffix.toUpperCase()}`,
        status: "used",
        usedAt: new Date("2026-10-02T12:00:00Z"),
        orderId: "private_order",
        createdAt: instant,
      },
      {
        id: `a_002_${suffix}`,
        storeId: ids[0].store,
        accountId: accounts[0],
        rewardDefinitionId: ids[0].reward,
        pointsSpent: BigInt(5),
        shopifyDiscountCode: `private_code_2_${suffix}`,
        shopifyDiscountCodeCanonical: `PRIVATE_CODE_2_${suffix.toUpperCase()}`,
        status: "cancelled",
        createdAt: instant,
      },
      {
        id: `z_001_${suffix}`,
        storeId: ids[0].store,
        accountId: accounts[1],
        rewardDefinitionId: ids[0].reward,
        pointsSpent: BigInt(3),
        shopifyDiscountCode: `private_code_3_${suffix}`,
        shopifyDiscountCodeCanonical: `PRIVATE_CODE_3_${suffix.toUpperCase()}`,
        status: "issued",
        createdAt: instant,
      },
      {
        id: `m_001_${suffix}`,
        storeId: ids[1].store,
        accountId: accounts[2],
        rewardDefinitionId: ids[1].reward,
        pointsSpent: BigInt(99),
        shopifyDiscountCode: `private_code_4_${suffix}`,
        shopifyDiscountCodeCanonical: `PRIVATE_CODE_4_${suffix.toUpperCase()}`,
        status: "used",
        createdAt: instant,
      },
      {
        id: `direct_001_${suffix}`,
        storeId: ids[0].store,
        shopperId: shoppers[0],
        rewardDefinitionId: ids[0].reward,
        pointsSpent: BigInt(0),
        shopifyDiscountCode: `private_direct_${suffix}`,
        shopifyDiscountCodeCanonical: `PRIVATE_DIRECT_${suffix.toUpperCase()}`,
        status: "issued",
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
    await prisma.weleticRewardRedemption.deleteMany({
      where: { storeId: { in: ids.map(({ store }) => store) } },
    });
    await prisma.weleticRewardDefinition.deleteMany({
      where: { id: { in: ids.map(({ reward }) => reward) } },
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

it("exports exact retained redemptions by store, suppresses redacted accounts and refuses a partial cap", async () => {
  const first = await readExport();
  expect(first.status).toBe("available");
  expect(first.rows).toHaveLength(3);
  expect(first.rows[0]).toMatchObject({
    currentStatus: "used",
    pointsSpent: "9007199254740997",
    usedAt: "2026-10-02T12:00:00.000Z",
  });
  expect(first.rows[1]).toMatchObject({
    currentStatus: "cancelled",
    pointsSpent: "5",
    usedAt: null,
  });
  expect(first.rows[0].accountPseudonym).toBe(first.rows[1].accountPseudonym);
  expect(first.rows[0].redemptionPseudonym).not.toBe(
    first.rows[1].redemptionPseudonym,
  );
  expect(first.rows[2].accountPseudonym).not.toBe(
    first.rows[0].accountPseudonym,
  );
  expect(JSON.stringify(first)).not.toMatch(
    /private_code|private_order|redemption_export_account|foreign_store|direct_001/,
  );
  const independent = await prisma.$queryRaw<
    Array<{ entryCount: bigint; total: string }>
  >`SELECT COUNT(*) AS entryCount, CAST(SUM(pointsSpent) AS CHAR) AS total
      FROM WeleticRewardRedemption
      WHERE storeId = ${ids[0].store} AND accountId IS NOT NULL AND pointsSpent > 0`;
  expect(Number(independent[0].entryCount)).toBe(3);
  expect(independent[0].total).toBe("9007199254741005");
  expect(
    first.rows
      .reduce((sum, row) => sum + BigInt(row.pointsSpent), BigInt(0))
      .toString(),
  ).toBe(independent[0].total);

  await prisma.weleticRewardRedemption.createMany({
    data: Array.from({ length: 1_998 }, (_, index) => ({
      id: `a_${String(index + 3).padStart(4, "0")}_${suffix}`,
      storeId: ids[0].store,
      accountId: accounts[0],
      rewardDefinitionId: ids[0].reward,
      pointsSpent: BigInt(1),
      shopifyDiscountCode: `extra_${index}_${suffix}`,
      shopifyDiscountCodeCanonical: `EXTRA_${index}_${suffix.toUpperCase()}`,
      status: "issued" as const,
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
  expect(afterRedaction.rows[0].pointsSpent).toBe("3");
});

it("waits for an in-flight erasure before returning rows", async () => {
  await prisma.weleticRewardRedemption.deleteMany({
    where: {
      storeId: ids[0].store,
      id: { startsWith: "a_" },
      pointsSpent: BigInt(1),
    },
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
