import { readMerchantRedemptionSources } from "@/lib/weletic/loyalty/redemption-sources";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";

const prisma = new PrismaClient();
let initialized = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const target = /^\/weletic_loyalty_it_redemption_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3312" ||
    !target ||
    url.username !== `w26_${target[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated redemption-source database");
  expect(
    await prisma.$queryRaw`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`,
  ).toEqual([
    {
      databaseName: url.pathname.slice(1),
      principal: `${url.username}@%`,
    },
  ]);
  const tables = await prisma.$queryRaw<Array<{ tableName: string }>>`
    SELECT TABLE_NAME AS tableName FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
  `;
  expect(tables).toEqual([]);
  await prisma.$executeRawUnsafe(`CREATE TABLE WeleticPointsLedgerEntry (
    id VARCHAR(64) PRIMARY KEY,
    storeId VARCHAR(191) NOT NULL,
    entryType VARCHAR(32) NOT NULL,
    pointsDelta BIGINT NOT NULL,
    referenceType VARCHAR(64) NULL,
    referenceId VARCHAR(64) NULL,
    metadata JSON NULL,
    createdAt DATETIME(3) NOT NULL,
    INDEX wl_ledger_store_created_idx (storeId, createdAt)
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE WeleticRewardRedemption (
    id VARCHAR(64) NOT NULL,
    storeId VARCHAR(191) NOT NULL,
    ledgerEntryId VARCHAR(64) NULL,
    rewardDefinitionId VARCHAR(64) NOT NULL,
    pointsSpent BIGINT NOT NULL,
    PRIMARY KEY (storeId, id)
  )`);
  initialized = true;
});

afterAll(async () => {
  if (initialized) {
    await prisma.$executeRawUnsafe("DROP TABLE WeleticRewardRedemption");
    await prisma.$executeRawUnsafe("DROP TABLE WeleticPointsLedgerEntry");
  }
  await prisma.$disconnect();
});

it("independently reconciles recorded debits, captured names and unknown provenance", async () => {
  const huge = BigInt("9007199254740993");
  const startAt = new Date("2026-09-01T12:00:00.000Z");
  const endAt = new Date("2026-09-30T10:00:00.000Z");
  const entries = [
    {
      id: "first",
      storeId: "store-a",
      entryType: "REDEEM_REWARD",
      pointsDelta: -huge,
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption-first",
      metadata: JSON.stringify({
        rewardId: "reward-one",
        rewardName: "=Voucher",
        rewardType: "amount_off",
      }),
      createdAt: startAt,
    },
    {
      id: "renamed",
      storeId: "store-a",
      entryType: "REDEEM_REWARD",
      pointsDelta: BigInt(-20),
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption-renamed",
      metadata: JSON.stringify({
        rewardId: "reward-one",
        rewardName: "Renamed voucher",
        rewardType: "amount_off",
      }),
      createdAt: endAt,
    },
    {
      id: "missing",
      storeId: "store-a",
      entryType: "REDEEM_REWARD",
      pointsDelta: BigInt(-50),
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption-missing",
      metadata: JSON.stringify({ rewardId: "reward-one" }),
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
    },
    {
      id: "mismatch",
      storeId: "store-a",
      entryType: "REDEEM_REWARD",
      pointsDelta: BigInt(-30),
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption-mismatch",
      metadata: JSON.stringify({
        rewardId: "wrong-reward",
        rewardName: "Misattributed",
        rewardType: "amount_off",
      }),
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
    },
    {
      id: "wrong-reference-case",
      storeId: "store-a",
      entryType: "REDEEM_REWARD",
      pointsDelta: BigInt(-5),
      referenceType: "reward_redemption",
      referenceId: "redemption-wrong-reference-case",
      metadata: JSON.stringify({
        rewardId: "reward-one",
        rewardName: "Wrong reference case",
        rewardType: "amount_off",
      }),
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
    },
    {
      id: "wrong-type-case",
      storeId: "store-a",
      entryType: "REDEEM_REWARD",
      pointsDelta: BigInt(-7),
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption-wrong-type-case",
      metadata: JSON.stringify({
        rewardId: "reward-one",
        rewardName: "Wrong type case",
        rewardType: "Amount_off",
      }),
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
    },
    {
      id: "foreign",
      storeId: "store-b",
      entryType: "REDEEM_REWARD",
      pointsDelta: BigInt(-1000),
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption-foreign",
      metadata: JSON.stringify({
        rewardId: "reward-one",
        rewardName: "Foreign",
        rewardType: "amount_off",
      }),
      createdAt: startAt,
    },
    {
      id: "before",
      storeId: "store-a",
      entryType: "REDEEM_REWARD",
      pointsDelta: BigInt(-10),
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption-before",
      metadata: JSON.stringify({
        rewardId: "reward-one",
        rewardName: "Before",
        rewardType: "amount_off",
      }),
      createdAt: new Date("2026-09-01T11:59:59.999Z"),
    },
    {
      id: "refund",
      storeId: "store-a",
      entryType: "REFUND_REVERSAL",
      pointsDelta: BigInt(300),
      referenceType: "REWARD_REDEMPTION",
      referenceId: "redemption-first",
      metadata: null,
      createdAt: startAt,
    },
  ];
  for (const entry of entries) {
    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry
        (id, storeId, entryType, pointsDelta, referenceType, referenceId,
         metadata, createdAt)
      VALUES (${entry.id}, ${entry.storeId}, ${entry.entryType},
              ${entry.pointsDelta}, ${entry.referenceType},
              ${entry.referenceId}, ${entry.metadata}, ${entry.createdAt})
    `;
    if (entry.entryType === "REDEEM_REWARD") {
      await prisma.$executeRaw`
        INSERT INTO WeleticRewardRedemption
          (id, storeId, ledgerEntryId, rewardDefinitionId, pointsSpent)
        VALUES (${entry.referenceId}, ${entry.storeId}, ${entry.id},
                ${"reward-one"}, ${-entry.pointsDelta})
      `;
    }
  }
  const result = await prisma.$transaction(
    (tx) =>
      readMerchantRedemptionSources({
        tx,
        storeId: "store-a",
        startAt,
        endAt,
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  expect(result.rows).toEqual([
    {
      rewardDefinitionId: "reward-one",
      capturedName: "=Voucher",
      rewardType: "amount_off",
      eventCount: "1",
      pointsSpent: huge.toString(),
    },
    {
      rewardDefinitionId: "reward-one",
      capturedName: "Renamed voucher",
      rewardType: "amount_off",
      eventCount: "1",
      pointsSpent: "20",
    },
  ]);
  expect(result.unknown).toEqual({ eventCount: "4", pointsSpent: "92" });
  expect(result.other).toEqual({ eventCount: "0", pointsSpent: "0" });
  const [independent] = await prisma.$queryRaw<
    Array<{ eventCount: bigint; pointsSpent: Prisma.Decimal }>
  >`
    SELECT COUNT(*) AS eventCount,
           SUM(-CAST(pointsDelta AS DECIMAL(65, 0))) AS pointsSpent
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${"store-a"}
      AND createdAt >= ${startAt} AND createdAt <= ${endAt}
      AND entryType = 'REDEEM_REWARD' AND pointsDelta < 0
  `;
  expect(result.total).toEqual({
    eventCount: independent.eventCount.toString(),
    pointsSpent: independent.pointsSpent.toString(),
  });
  expect(result.total).toEqual({
    eventCount: "6",
    pointsSpent: (huge + BigInt(112)).toString(),
  });
  for (let index = 0; index < 11; index++) {
    const ledgerId = `overflow-${index}`;
    const redemptionId = `redemption-overflow-${index}`;
    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry
        (id, storeId, entryType, pointsDelta, referenceType, referenceId,
         metadata, createdAt)
      VALUES (${ledgerId}, ${"store-a"}, ${"REDEEM_REWARD"}, ${BigInt(-10)},
              ${"REWARD_REDEMPTION"}, ${redemptionId},
              ${JSON.stringify({
                rewardId: `reward-${index}`,
                rewardName: `Reward ${index}`,
                rewardType: "amount_off",
              })}, ${new Date("2026-09-15T00:00:00.000Z")})
    `;
    await prisma.$executeRaw`
      INSERT INTO WeleticRewardRedemption
        (id, storeId, ledgerEntryId, rewardDefinitionId, pointsSpent)
      VALUES (${redemptionId}, ${"store-a"}, ${ledgerId},
              ${`reward-${index}`}, ${BigInt(10)})
    `;
  }
  const bounded = await prisma.$transaction(
    (tx) =>
      readMerchantRedemptionSources({
        tx,
        storeId: "store-a",
        startAt,
        endAt,
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  expect(bounded.rows).toHaveLength(10);
  expect(bounded.other).toEqual({ eventCount: "3", pointsSpent: "30" });
  expect(bounded.unknown).toEqual({ eventCount: "4", pointsSpent: "92" });
  expect(bounded.total).toEqual({
    eventCount: "17",
    pointsSpent: (huge + BigInt(222)).toString(),
  });
  for (const [index, rewardId] of ["Reward-Case", "reward-case"].entries()) {
    const ledgerId = `case-${index}`;
    const redemptionId = `redemption-case-${index}`;
    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry
        (id, storeId, entryType, pointsDelta, referenceType, referenceId,
         metadata, createdAt)
      VALUES (${ledgerId}, ${"store-c"}, ${"REDEEM_REWARD"}, ${BigInt(-10)},
              ${"REWARD_REDEMPTION"}, ${redemptionId},
              ${JSON.stringify({
                rewardId,
                rewardName: "Case voucher",
                rewardType: "amount_off",
              })}, ${startAt})
    `;
    await prisma.$executeRaw`
      INSERT INTO WeleticRewardRedemption
        (id, storeId, ledgerEntryId, rewardDefinitionId, pointsSpent)
      VALUES (${redemptionId}, ${"store-c"}, ${ledgerId},
              ${rewardId}, ${BigInt(10)})
    `;
  }
  for (const [index, rewardName] of [
    "Cafe voucher",
    "Café voucher",
  ].entries()) {
    const ledgerId = `accent-${index}`;
    const redemptionId = `redemption-accent-${index}`;
    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry
        (id, storeId, entryType, pointsDelta, referenceType, referenceId,
         metadata, createdAt)
      VALUES (${ledgerId}, ${"store-c"}, ${"REDEEM_REWARD"}, ${BigInt(-10)},
              ${"REWARD_REDEMPTION"}, ${redemptionId},
              ${JSON.stringify({
                rewardId: "reward-accent",
                rewardName,
                rewardType: "amount_off",
              })}, ${startAt})
    `;
    await prisma.$executeRaw`
      INSERT INTO WeleticRewardRedemption
        (id, storeId, ledgerEntryId, rewardDefinitionId, pointsSpent)
      VALUES (${redemptionId}, ${"store-c"}, ${ledgerId},
              ${"reward-accent"}, ${BigInt(10)})
    `;
  }
  await prisma.$executeRaw`
    INSERT INTO WeleticPointsLedgerEntry
      (id, storeId, entryType, pointsDelta, referenceType, referenceId,
       metadata, createdAt)
    VALUES (${"case-mismatch"}, ${"store-c"}, ${"REDEEM_REWARD"}, ${BigInt(-5)},
            ${"REWARD_REDEMPTION"}, ${"redemption-case-mismatch"},
            ${JSON.stringify({
              rewardId: "reward-case",
              rewardName: "Case mismatch",
              rewardType: "amount_off",
            })}, ${startAt})
  `;
  await prisma.$executeRaw`
    INSERT INTO WeleticRewardRedemption
      (id, storeId, ledgerEntryId, rewardDefinitionId, pointsSpent)
    VALUES (${"redemption-case-mismatch"}, ${"store-c"}, ${"case-mismatch"},
            ${"Reward-Case"}, ${BigInt(5)})
  `;
  await prisma.$executeRaw`
    INSERT INTO WeleticPointsLedgerEntry
      (id, storeId, entryType, pointsDelta, referenceType, referenceId,
       metadata, createdAt)
    VALUES (${"wrong-entry-case"}, ${"store-c"}, ${"redeem_reward"}, ${BigInt(-11)},
            ${"REWARD_REDEMPTION"}, ${"redemption-wrong-entry-case"},
            ${null}, ${startAt})
  `;
  const caseSensitive = await prisma.$transaction(
    (tx) =>
      readMerchantRedemptionSources({
        tx,
        storeId: "store-c",
        startAt,
        endAt,
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  expect(caseSensitive.rows).toHaveLength(4);
  expect(caseSensitive.rows.map((row) => row.rewardDefinitionId)).toEqual(
    expect.arrayContaining([
      "Reward-Case",
      "reward-case",
      "reward-accent",
      "reward-accent",
    ]),
  );
  expect(caseSensitive.rows.map((row) => row.capturedName)).toEqual(
    expect.arrayContaining(["Cafe voucher", "Café voucher"]),
  );
  expect(caseSensitive.unknown).toEqual({ eventCount: "1", pointsSpent: "5" });
  expect(caseSensitive.total).toEqual({ eventCount: "5", pointsSpent: "45" });
});
