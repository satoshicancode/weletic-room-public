import { prisma } from "@/lib/prisma";
import { readShopifyMerchantTierHistoryExportInTransaction } from "@/lib/weletic/shopify/merchant-tier-history-export";
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
const projectIds = [0, 1].map(
  (index) => `tier_export_project_${index}_${suffix}`,
);
const programIds = [0, 1].map(
  (index) => `tier_export_program_${index}_${suffix}`,
);
const storeIds = [0, 1].map((index) => `tier_export_store_${index}_${suffix}`);
const loyaltyIds = [0, 1].map(
  (index) => `tier_export_loyalty_${index}_${suffix}`,
);
const accountIds = [0, 1, 2].map(
  (index) => `tier_export_account_${index}_${suffix}`,
);
const tierIds = [0, 1].map((index) => `tier_export_tier_${index}_${suffix}`);
const extraHistoryIds = Array.from(
  { length: 1_800 },
  (_, index) => `a_${String(index + 201).padStart(4, "0")}_${suffix}`,
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
      readShopifyMerchantTierHistoryExportInTransaction({
        tx,
        envelope: { signed: true },
        request,
      }),
    { timeout: 20_000 },
  );
let initialized = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const target = /^\/weletic_loyalty_it_tier_history_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_TIER_HISTORY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3312" ||
    !target ||
    url.username !== `wth_${target[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated tier-history database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    { databaseName: url.pathname.slice(1), principal: `${url.username}@%` },
  ]);
  expect(await prisma.weleticLoyaltyTierHistory.count()).toBe(0);
  initialized = true;
  for (const [index, storeId] of storeIds.entries()) {
    await prisma.project.create({
      data: {
        id: projectIds[index],
        name: "Tier export SQL",
        slug: projectIds[index],
        billingCycleStart: 1,
      },
    });
    await prisma.program.create({
      data: {
        id: programIds[index],
        workspaceId: projectIds[index],
        defaultFolderId: `folder_${index}_${suffix}`,
        defaultGroupId: `group_${index}_${suffix}`,
        name: "Tier export SQL",
        slug: programIds[index],
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        id: storeId,
        projectId: projectIds[index],
        programId: programIds[index],
        shopDomain: `tier-export-${index}-${suffix}.myshopify.com`,
        shopCurrency: "USD",
        apiVersion: "2026-07",
      },
    });
    await prisma.weleticLoyaltyProgram.create({
      data: { id: loyaltyIds[index], storeId, status: "active" },
    });
    await prisma.weleticLoyaltyTier.create({
      data: {
        id: tierIds[index],
        programId: loyaltyIds[index],
        name: "Gold",
        slug: "gold",
      },
    });
  }
  for (const [index, accountId] of accountIds.entries()) {
    const storeIndex = index === 2 ? 1 : 0;
    await prisma.weleticShopper.create({
      data: {
        id: `tier_export_shopper_${index}_${suffix}`,
        storeId: storeIds[storeIndex],
        shopifyCustomerId: `tier_export_customer_${index}_${suffix}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: accountId,
        storeId: storeIds[storeIndex],
        programId: loyaltyIds[storeIndex],
        shopperId: `tier_export_shopper_${index}_${suffix}`,
      },
    });
  }
  await prisma.weleticLoyaltyTierHistory.createMany({
    data: [
      ...Array.from({ length: 201 }, (_, index) => ({
        id: `a_${String(index).padStart(3, "0")}_${suffix}`,
        accountId: accountIds[0],
        sequenceNumber: index + 1,
        toTierId: tierIds[0],
        changeReason: "threshold_reached" as const,
        notes: "private note",
        effectiveAt: instant,
      })),
      {
        id: `z_000_${suffix}`,
        accountId: accountIds[1],
        sequenceNumber: 1,
        toTierId: tierIds[0],
        changeReason: "manual_override" as const,
        effectiveAt: instant,
      },
      {
        id: `m_000_${suffix}`,
        accountId: accountIds[2],
        sequenceNumber: 1,
        toTierId: tierIds[1],
        changeReason: "manual_override" as const,
        effectiveAt: instant,
      },
    ],
  });
  auth.authorize.mockResolvedValue({
    owner: true,
    storeId: storeIds[0],
    installationGeneration: "generation-sql",
  });
});

afterAll(async () => {
  if (initialized) {
    await prisma.weleticLoyaltyTierHistory.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await prisma.weleticLoyaltyAccount.deleteMany({
      where: { id: { in: accountIds } },
    });
    await prisma.weleticShopper.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await prisma.weleticLoyaltyTier.deleteMany({
      where: { id: { in: tierIds } },
    });
    await prisma.weleticLoyaltyProgram.deleteMany({
      where: { id: { in: loyaltyIds } },
    });
    await prisma.weleticShopifyStore.deleteMany({
      where: { id: { in: storeIds } },
    });
    for (const programId of programIds)
      await prisma.$executeRaw`DELETE FROM Program WHERE id = ${programId}`;
    for (const projectId of projectIds)
      await prisma.$executeRaw`DELETE FROM Project WHERE id = ${projectId}`;
  }
  await prisma.$disconnect();
});

it("exports one authorized snapshot, fails closed above the cap and respects erasure", async () => {
  const first = await readExport();
  expect(first.status).toBe("available");
  expect(first.rows).toHaveLength(202);
  expect(first.rows[200].accountPseudonym).toBe(first.rows[0].accountPseudonym);
  expect(first.rows[201].accountPseudonym).not.toBe(
    first.rows[0].accountPseudonym,
  );
  expect(JSON.stringify(first)).not.toMatch(
    /private note|tier_export_account|tier_export_store/,
  );
  expect(
    await prisma.weleticLoyaltyTierHistory.count({
      where: { accountId: { in: accountIds.slice(0, 2) } },
    }),
  ).toBe(202);
  await prisma.weleticLoyaltyTierHistory.createMany({
    data: extraHistoryIds.map((id, index) => ({
      id,
      accountId: accountIds[0],
      sequenceNumber: index + 202,
      toTierId: tierIds[0],
      changeReason: "threshold_reached" as const,
      effectiveAt: instant,
    })),
  });
  const overLimit = await readExport();
  expect(overLimit.status).toBe("too_large");
  expect(overLimit.rows).toEqual([]);
  await prisma.weleticLoyaltyAccount.update({
    where: { id: accountIds[0] },
    data: { metadata: { shopifyCustomerRedaction: { status: "redacted" } } },
  });
  await prisma.weleticLoyaltyTier.update({
    where: { id: tierIds[0] },
    data: { name: "Current Gold" },
  });
  const afterRedaction = await readExport();
  expect(afterRedaction.status).toBe("available");
  expect(afterRedaction.rows).toHaveLength(1);
  expect(afterRedaction.rows[0].toTierCurrentName).toBe("Current Gold");
  await prisma.weleticLoyaltyTierHistory.deleteMany({
    where: { id: { in: extraHistoryIds } },
  });
});

it("waits for an in-flight account erasure before returning export rows", async () => {
  await prisma.weleticLoyaltyAccount.update({
    where: { id: accountIds[0] },
    data: { metadata: { temporaryTestState: true } },
  });
  let lockReady!: () => void;
  let unlock!: () => void;
  const locked = new Promise<void>((resolve) => (lockReady = resolve));
  const release = new Promise<void>((resolve) => (unlock = resolve));
  const erasure = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM WeleticLoyaltyAccount WHERE id = ${accountIds[0]} FOR UPDATE`;
      lockReady();
      await release;
      await tx.weleticLoyaltyAccount.update({
        where: { id: accountIds[0] },
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
