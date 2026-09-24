import { prisma } from "@/lib/prisma";
import { readMerchantPointActivitySeries } from "@/lib/weletic/loyalty/activity-series";
import { readMerchantFirstRecordedEarnersSeries } from "@/lib/weletic/loyalty/first-recorded-earners-series";
import { readMerchantLedgerNetSeries } from "@/lib/weletic/loyalty/ledger-net-series";
import { readMerchantRecordedTierChangeSeries } from "@/lib/weletic/loyalty/recorded-tier-change-series";
import { deriveMerchantRedemptionRateSeries } from "@/lib/weletic/loyalty/redemption-rate-series";
import {
  WeleticPointsLedgerEntryType as Entry,
  Prisma,
  WeleticLoyaltyTierChangeReason as TierReason,
} from "@prisma/client";
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
    await prisma.weleticLoyaltyTierHistory.deleteMany({
      where: {
        accountId: {
          in: [
            `account_0_${id}`,
            `account_1_${id}`,
            `earn_account_1_${id}`,
            `earn_account_2_${id}`,
          ],
        },
      },
    });
    await prisma.weleticPointsLedgerEntry.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await prisma.weleticLoyaltyAccount.deleteMany({
      where: { storeId: { in: storeIds } },
    });
    await prisma.weleticLoyaltyTier.deleteMany({
      where: { programId: { in: [`loyalty_0_${id}`, `loyalty_1_${id}`] } },
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
  const netStart = new Date("2026-09-01T12:00:00.000Z");
  const openingPlan = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    EXPLAIN SELECT SUM(CAST(pointsDelta AS DECIMAL(65, 0)))
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeIds[0]} AND createdAt < ${netStart}
  `;
  expect(Object.values(openingPlan[0]).map(String).join(" ")).toContain(
    "WeleticPointsLedgerEntry_storeId_createdAt_idx",
  );
  const ledgerNet = await prisma.$transaction((tx) =>
    readMerchantLedgerNetSeries({
      tx,
      storeId: storeIds[0],
      startAt: netStart,
      endAt,
    }),
  );
  expect(ledgerNet).toEqual({
    status: "available",
    bucket: "utc_day",
    coverage: "recorded_ledger_net_only",
    openingNetPoints: huge.toString(),
    rows: [
      {
        date: "2026-09-01",
        netChangePoints: "7",
        cumulativeNetPoints: (huge + BigInt(7)).toString(),
      },
      {
        date: "2026-09-02",
        netChangePoints: "-12",
        cumulativeNetPoints: (huge - BigInt(5)).toString(),
      },
      {
        date: "2026-09-03",
        netChangePoints: "0",
        cumulativeNetPoints: (huge - BigInt(5)).toString(),
      },
    ],
  });
  const independentOpening = await prisma.$queryRaw<
    Array<{ net: Prisma.Decimal }>
  >`
    SELECT SUM(CAST(pointsDelta AS DECIMAL(65, 0))) AS net
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeIds[0]} AND createdAt < ${netStart}
  `;
  expect(ledgerNet.openingNetPoints).toBe(independentOpening[0].net.toFixed(0));
  const independentWindow = await prisma.$queryRaw<
    Array<{ net: Prisma.Decimal }>
  >`
    SELECT SUM(CAST(pointsDelta AS DECIMAL(65, 0))) AS net
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeIds[0]} AND createdAt >= ${netStart} AND createdAt <= ${endAt}
  `;
  expect(ledgerNet.rows.at(-1)?.cumulativeNetPoints).toBe(
    (
      BigInt(independentOpening[0].net.toFixed(0)) +
      BigInt(independentWindow[0].net.toFixed(0))
    ).toString(),
  );
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
  for (const suffix of [1, 2]) {
    await prisma.weleticShopper.create({
      data: {
        id: `earn_shopper_${suffix}_${id}`,
        storeId: storeIds[0],
        shopifyCustomerId: `earn_customer_${suffix}_${id}`,
      },
    });
    await prisma.weleticLoyaltyAccount.create({
      data: {
        id: `earn_account_${suffix}_${id}`,
        storeId: storeIds[0],
        programId: `loyalty_0_${id}`,
        shopperId: `earn_shopper_${suffix}_${id}`,
      },
    });
  }
  const cohortEntries = [
    {
      store: 0,
      accountId: `account_0_${id}`,
      sequenceNumber: 6,
      at: "2026-09-02T13:00:00Z",
    },
    {
      store: 0,
      accountId: `earn_account_1_${id}`,
      sequenceNumber: 1,
      at: "2026-09-02T14:00:00Z",
    },
    {
      store: 0,
      accountId: `earn_account_1_${id}`,
      sequenceNumber: 2,
      at: "2026-10-01T10:00:00Z",
    },
    {
      store: 0,
      accountId: `earn_account_2_${id}`,
      sequenceNumber: 1,
      at: "2026-09-02T11:00:00Z",
    },
    {
      store: 0,
      accountId: `earn_account_2_${id}`,
      sequenceNumber: 2,
      at: "2026-09-02T15:00:00Z",
    },
    {
      store: 1,
      accountId: `account_1_${id}`,
      sequenceNumber: 7,
      at: "2026-09-02T13:00:00Z",
    },
  ];
  await prisma.weleticPointsLedgerEntry.createMany({
    data: cohortEntries.map((entry, index) => ({
      id: `cohort_entry_${index}_${id}`,
      storeId: storeIds[entry.store],
      accountId: entry.accountId,
      sequenceNumber: entry.sequenceNumber,
      entryType: Entry.EARN_ORDER,
      pointsDelta: BigInt(1),
      balanceAfter: BigInt(1),
      idempotencyKey: `cohort_${index}_${id}`,
      createdAt: new Date(entry.at),
    })),
  });
  const cohortStart = new Date("2026-09-02T12:00:00Z");
  const cohortEnd = new Date("2026-10-02T23:59:59.999Z");
  const cohorts = await prisma.$transaction((tx) =>
    readMerchantFirstRecordedEarnersSeries({
      tx,
      storeId: storeIds[0],
      startAt: cohortStart,
      endAt: cohortEnd,
    }),
  );
  expect(cohorts).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_qualifying_ledger_accounts_only",
    rows: [
      {
        month: "2026-09",
        activeAccounts: "3",
        firstRecordedAccounts: "1",
        returningAccounts: "2",
      },
      {
        month: "2026-10",
        activeAccounts: "1",
        firstRecordedAccounts: "0",
        returningAccounts: "1",
      },
    ],
  });
  const independentCohort = await prisma.$queryRaw<
    Array<{ accountId: string; firstAt: Date }>
  >`
    SELECT accountId, MIN(createdAt) AS firstAt
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeIds[0]}
      AND entryType IN ('EARN_ORDER', 'EARN_REFERRAL', 'EARN_BONUS', 'TIER_BONUS')
      AND pointsDelta > 0
    GROUP BY accountId ORDER BY accountId
  `;
  expect(
    independentCohort.map(({ accountId, firstAt }) => [
      accountId,
      firstAt.toISOString(),
    ]),
  ).toEqual([
    [`account_0_${id}`, "2026-09-01T23:59:59.999Z"],
    [`earn_account_1_${id}`, "2026-09-02T14:00:00.000Z"],
    [`earn_account_2_${id}`, "2026-09-02T11:00:00.000Z"],
  ]);

  const tierIds = [
    `tier_bronze_${id}`,
    `tier_silver_${id}`,
    `tier_other_${id}`,
  ];
  await prisma.weleticLoyaltyTier.createMany({
    data: [
      {
        id: tierIds[0],
        programId: `loyalty_0_${id}`,
        name: "Bronze",
        slug: "bronze",
        tierOrder: 1,
      },
      {
        id: tierIds[1],
        programId: `loyalty_0_${id}`,
        name: "Silver",
        slug: "silver",
        tierOrder: 2,
      },
      {
        id: tierIds[2],
        programId: `loyalty_1_${id}`,
        name: "Other Bronze",
        slug: "bronze",
        tierOrder: 1,
      },
    ],
  });
  const events = [
    {
      accountId: `account_0_${id}`,
      sequenceNumber: 1,
      fromTierId: tierIds[1],
      toTierId: tierIds[0],
      reason: TierReason.grace_period_expired,
      at: "2026-09-02T11:00:00Z",
    },
    {
      accountId: `account_0_${id}`,
      sequenceNumber: 2,
      fromTierId: tierIds[0],
      toTierId: tierIds[1],
      reason: TierReason.threshold_reached,
      at: "2026-09-02T14:00:00Z",
    },
    {
      accountId: `account_0_${id}`,
      sequenceNumber: 3,
      fromTierId: tierIds[1],
      toTierId: tierIds[1],
      reason: TierReason.manual_override,
      at: "2026-09-03T10:00:00Z",
    },
    {
      accountId: `account_0_${id}`,
      sequenceNumber: 4,
      fromTierId: tierIds[1],
      toTierId: tierIds[0],
      reason: TierReason.annual_downgrade,
      at: "2026-10-01T10:00:00Z",
    },
    {
      accountId: `earn_account_1_${id}`,
      sequenceNumber: 1,
      fromTierId: null,
      toTierId: tierIds[0],
      reason: TierReason.program_activation,
      at: "2026-09-02T13:00:00Z",
    },
    {
      accountId: `earn_account_1_${id}`,
      sequenceNumber: 2,
      fromTierId: tierIds[0],
      toTierId: tierIds[1],
      reason: TierReason.bonus_promotion,
      at: "2026-10-01T11:00:00Z",
    },
    {
      accountId: `account_1_${id}`,
      sequenceNumber: 1,
      fromTierId: tierIds[2],
      toTierId: tierIds[2],
      reason: TierReason.threshold_reached,
      at: "2026-09-02T15:00:00Z",
    },
  ];
  await prisma.weleticLoyaltyTierHistory.createMany({
    data: events.map((event, index) => ({
      id: `tier_event_${index}_${id}`,
      accountId: event.accountId,
      sequenceNumber: event.sequenceNumber,
      fromTierId: event.fromTierId,
      toTierId: event.toTierId,
      changeReason: event.reason,
      effectiveAt: new Date(event.at),
    })),
  });
  const tierChanges = await prisma.$transaction((tx) =>
    readMerchantRecordedTierChangeSeries({
      tx,
      storeId: storeIds[0],
      startAt: cohortStart,
      endAt: cohortEnd,
    }),
  );
  expect(tierChanges).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_tier_change_reasons_only",
    rows: [
      {
        month: "2026-09",
        totalChanges: "3",
        thresholdReached: "1",
        bonusPromotion: "0",
        annualDowngrade: "0",
        gracePeriodExpired: "0",
        programActivation: "1",
        manualOverride: "1",
        otherReasons: "0",
      },
      {
        month: "2026-10",
        totalChanges: "2",
        thresholdReached: "0",
        bonusPromotion: "1",
        annualDowngrade: "1",
        gracePeriodExpired: "0",
        programActivation: "0",
        manualOverride: "0",
        otherReasons: "0",
      },
    ],
  });
  const independentTierEvents = await prisma.$queryRaw<
    Array<{ id: string; changeReason: string }>
  >`
    SELECT h.id, h.changeReason
    FROM WeleticLoyaltyTierHistory h
    JOIN WeleticLoyaltyAccount a ON a.id = h.accountId
    WHERE a.storeId = ${storeIds[0]}
      AND h.effectiveAt >= ${cohortStart} AND h.effectiveAt <= ${cohortEnd}
    ORDER BY h.id
  `;
  expect(independentTierEvents).toEqual(
    [1, 2, 3, 4, 5].map((index) => ({
      id: `tier_event_${index}_${id}`,
      changeReason: events[index].reason,
    })),
  );
});
