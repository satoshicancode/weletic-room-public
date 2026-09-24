import { prisma } from "@/lib/prisma";
import { readMerchantPointActivitySeries } from "@/lib/weletic/loyalty/activity-series";
import { deriveMerchantRedemptionRateSeries } from "@/lib/weletic/loyalty/redemption-rate-series";
import { WeleticPointsLedgerEntryType as Entry, Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";

const id = randomUUID().replaceAll("-", "").slice(0, 16);
const projectIds = [0, 1].map((index) => `activity_project_${index}_${id}`);
const programIds = [0, 1].map((index) => `activity_program_${index}_${id}`);
const storeIds = [`activity_store_a_${id}`, `activity_store_b_${id}`];
let initialized = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const target = /^\/weletic_loyalty_it_activity_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    !["3307", "3312"].includes(url.port) ||
    !target ||
    url.username !== `wac_${target[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated activity database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    {
      databaseName: url.pathname.slice(1),
      principal: `${url.username}@%`,
    },
  ]);
  expect(await prisma.weleticPointsLedgerEntry.count()).toBe(0);
  initialized = true;
  for (const [index, storeId] of storeIds.entries()) {
    await prisma.project.create({
      data: {
        id: projectIds[index],
        name: "Activity SQL",
        slug: projectIds[index],
        billingCycleStart: 1,
      },
    });
    await prisma.program.create({
      data: {
        id: programIds[index],
        workspaceId: projectIds[index],
        defaultFolderId: `folder_${index}_${id}`,
        defaultGroupId: `group_${index}_${id}`,
        name: "Activity SQL",
        slug: programIds[index],
      },
    });
    await prisma.weleticShopifyStore.create({
      data: {
        id: storeId,
        projectId: projectIds[index],
        programId: programIds[index],
        shopDomain: `activity-${index}-${id}.myshopify.com`,
        shopCurrency: "USD",
        apiVersion: "2026-07",
      },
    });
    await prisma.weleticLoyaltyProgram.create({
      data: { id: `loyalty_${index}_${id}`, storeId, status: "active" },
    });
    await prisma.weleticShopper.create({
      data: {
        id: `shopper_${index}_${id}`,
        storeId,
        shopifyCustomerId: `customer_${index}_${id}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: `account_${index}_${id}`,
        storeId,
        programId: `loyalty_${index}_${id}`,
        shopperId: `shopper_${index}_${id}`,
      },
    });
  }
});

afterAll(async () => {
  if (initialized) {
    await prisma.weleticPointsLedgerEntry.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await prisma.weleticLoyaltyAccount.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await prisma.weleticShopper.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await prisma.weleticLoyaltyProgram.deleteMany({
      where: { storeId: { in: storeIds } },
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

it("reconciles exact UTC daily movements and excludes another store", async () => {
  const huge = BigInt("9007199254740993");
  const entries = [
    {
      store: 0,
      day: "2026-09-01T00:00:00.000Z",
      type: Entry.BACKFILL,
      delta: huge,
    },
    {
      store: 0,
      day: "2026-09-01T23:59:59.999Z",
      type: Entry.EARN_ORDER,
      delta: BigInt(10),
    },
    {
      store: 0,
      day: "2026-09-01T23:59:59.999Z",
      type: Entry.MANUAL_ADJUSTMENT,
      delta: BigInt(-3),
    },
    {
      store: 0,
      day: "2026-09-02T00:00:00.000Z",
      type: Entry.REDEEM_REWARD,
      delta: BigInt(-5),
    },
    {
      store: 0,
      day: "2026-09-02T12:00:00.000Z",
      type: Entry.REFUND_REVERSAL,
      delta: BigInt(-7),
    },
    {
      store: 1,
      day: "2026-09-01T12:00:00.000Z",
      type: Entry.BACKFILL,
      delta: BigInt(99),
    },
  ];
  await prisma.weleticPointsLedgerEntry.createMany({
    data: entries.map((entry, index) => ({
      id: `entry_${index}_${id}`,
      storeId: storeIds[entry.store],
      accountId: `account_${entry.store}_${id}`,
      sequenceNumber: index + 1,
      entryType: entry.type,
      pointsDelta: entry.delta,
      balanceAfter: entry.delta,
      idempotencyKey: `activity_${index}_${id}`,
      createdAt: new Date(entry.day),
    })),
  });
  const startAt = new Date("2026-09-01T00:00:00.000Z");
  const endAt = new Date("2026-09-03T23:59:59.999Z");
  const plan = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    EXPLAIN SELECT DATE_FORMAT(createdAt, '%Y-%m-%d'), entryType
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeIds[0]} AND createdAt >= ${startAt} AND createdAt <= ${endAt}
    GROUP BY DATE_FORMAT(createdAt, '%Y-%m-%d'), entryType
  `;
  expect(Object.values(plan[0]).map(String).join(" ")).toContain(
    "WeleticPointsLedgerEntry_storeId_createdAt_idx",
  );
  const result = await prisma.$transaction((tx) =>
    readMerchantPointActivitySeries({
      tx,
      storeId: storeIds[0],
      startAt,
      endAt,
    }),
  );
  expect(result.status).toBe("available");
  if (result.status !== "available")
    throw new Error("Activity series unavailable");
  expect(
    result.rows.map(
      ({ date, earned, redeemed, refundReversed, manualDebits }) => ({
        date,
        earned,
        redeemed,
        refundReversed,
        manualDebits,
      }),
    ),
  ).toEqual([
    {
      date: "2026-09-01",
      earned: (huge + BigInt(10)).toString(),
      redeemed: "0",
      refundReversed: "0",
      manualDebits: "3",
    },
    {
      date: "2026-09-02",
      earned: "0",
      redeemed: "5",
      refundReversed: "7",
      manualDebits: "0",
    },
    {
      date: "2026-09-03",
      earned: "0",
      redeemed: "0",
      refundReversed: "0",
      manualDebits: "0",
    },
  ]);
  const independent = await prisma.$queryRaw<Array<{ net: Prisma.Decimal }>>`
    SELECT SUM(CAST(pointsDelta AS DECIMAL(65, 0))) AS net
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeIds[0]} AND createdAt >= ${startAt} AND createdAt <= ${endAt}
  `;
  const net = result.rows.reduce(
    (sum, row) =>
      sum +
      BigInt(row.earned) +
      BigInt(row.manualCredits) -
      BigInt(row.redeemed) -
      BigInt(row.refundReversed) -
      BigInt(row.expired) -
      BigInt(row.backfillCorrected) -
      BigInt(row.manualDebits),
    BigInt(0),
  );
  expect(net.toString()).toBe(independent[0].net.toFixed(0));
  const redemption = deriveMerchantRedemptionRateSeries(result);
  expect(redemption.rows).toEqual([
    {
      month: "2026-09",
      earnedPoints: "10",
      redeemedPoints: "5",
      redemptionRateBasisPoints: "5000",
    },
  ]);
  const independentRate = await prisma.$queryRaw<
    Array<{ earned: Prisma.Decimal; redeemed: Prisma.Decimal }>
  >`
    SELECT SUM(CASE WHEN entryType IN ('EARN_ORDER', 'EARN_REFERRAL', 'EARN_BONUS', 'TIER_BONUS')
                      AND pointsDelta > 0 THEN CAST(pointsDelta AS DECIMAL(65, 0)) ELSE 0 END) AS earned,
           SUM(CASE WHEN entryType = 'REDEEM_REWARD' AND pointsDelta < 0
                    THEN -CAST(pointsDelta AS DECIMAL(65, 0)) ELSE 0 END) AS redeemed
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeIds[0]} AND createdAt >= ${startAt} AND createdAt <= ${endAt}
  `;
  expect(redemption.rows[0].earnedPoints).toBe(
    independentRate[0].earned.toFixed(0),
  );
  expect(redemption.rows[0].redeemedPoints).toBe(
    independentRate[0].redeemed.toFixed(0),
  );
});
