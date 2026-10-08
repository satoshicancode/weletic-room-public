import { readMerchantFirstRecordedConfirmedIssuancesSeries } from "@/lib/weletic/loyalty/first-recorded-confirmed-issuances-series";
import { readMerchantFirstRecordedEarnersSeries } from "@/lib/weletic/loyalty/first-recorded-earners-series";
import { readMerchantFirstRecordedRedemptionDebitsSeries } from "@/lib/weletic/loyalty/first-recorded-redemption-debits-series";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";

const prisma = new PrismaClient();
let initialized = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const target = /^\/weletic_loyalty_it_cohorts_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3314" ||
    !target ||
    url.username !== `w22_${target[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated recorded-cohort database");
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
  await prisma.$executeRawUnsafe(`CREATE TABLE WeleticLoyaltyAccount (
    id VARCHAR(64) PRIMARY KEY,
    storeId VARCHAR(191) NOT NULL,
    status VARCHAR(32) NOT NULL,
    metadata JSON NULL,
    INDEX wl_account_store_status_idx (storeId, status)
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE WeleticPointsLedgerEntry (
    id VARCHAR(64) PRIMARY KEY,
    storeId VARCHAR(191) NOT NULL,
    accountId VARCHAR(64) NOT NULL,
    createdAt DATETIME(3) NOT NULL,
    entryType VARCHAR(32) NOT NULL,
    pointsDelta BIGINT NOT NULL,
    INDEX wl_ledger_store_created_idx (storeId, createdAt),
    INDEX wl_ledger_account_created_idx (accountId, createdAt)
  )`);
  await prisma.$executeRawUnsafe(`CREATE TABLE WeleticRewardRedemption (
    id VARCHAR(64) PRIMARY KEY,
    storeId VARCHAR(191) NOT NULL,
    accountId VARCHAR(64) NULL,
    issuanceConfirmedAt DATETIME(3) NULL,
    pointsSpent BIGINT NOT NULL,
    INDEX wl_reward_issuance_idx (storeId, issuanceConfirmedAt)
  )`);
  initialized = true;
});

afterAll(async () => {
  if (initialized) {
    await prisma.$executeRawUnsafe("DROP TABLE WeleticRewardRedemption");
    await prisma.$executeRawUnsafe("DROP TABLE WeleticPointsLedgerEntry");
    await prisma.$executeRawUnsafe("DROP TABLE WeleticLoyaltyAccount");
  }
  await prisma.$disconnect();
});

it("reconciles retained earned and redemption-debit cohorts without redacted or foreign accounts", async () => {
  const accounts = [
    ["prior", "store-a", "active"],
    ["new", "store-a", "active"],
    ["compensated", "store-a", "active"],
    ["closed", "store-a", "closed"],
    ["redacted", "store-a", "closed"],
    ["foreign", "store-b", "active"],
    ["case-foreign", "Store-A", "active"],
  ] as const;
  for (const [id, storeId, status] of accounts)
    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyAccount (id, storeId, status)
      VALUES (${id}, ${storeId}, ${status})
    `;
  await prisma.$executeRaw`
    UPDATE WeleticLoyaltyAccount
    SET metadata = JSON_OBJECT(
      'shopifyCustomerRedaction', JSON_OBJECT(
        'status', 'redacted',
        'redactedAt', '2026-11-03T00:00:00.000Z',
        'source', 'shopify_customers_redact'
      )
    )
    WHERE id = ${"redacted"}
  `;
  const ledger = [
    [
      "prior-before",
      "prior",
      "store-a",
      "2026-09-15T11:59:59.999Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "prior-in",
      "prior",
      "store-a",
      "2026-09-15T12:00:00.000Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "new-first",
      "new",
      "store-a",
      "2026-09-16T00:00:00.000Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "new-second-debit",
      "new",
      "store-a",
      "2026-09-17T00:00:00.000Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "compensated-debit",
      "compensated",
      "store-a",
      "2026-09-18T00:00:00.000Z",
      "REDEEM_REWARD",
      -10,
    ],
    [
      "compensating-adjustment",
      "compensated",
      "store-a",
      "2026-09-19T00:00:00.000Z",
      "MANUAL_ADJUSTMENT",
      10,
    ],
    [
      "new-repeat",
      "new",
      "store-a",
      "2026-10-01T00:00:00.000Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "closed-debit",
      "closed",
      "store-a",
      "2026-09-20T00:00:00.000Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "redacted-debit",
      "redacted",
      "store-a",
      "2026-09-21T00:00:00.000Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "foreign-debit",
      "foreign",
      "store-b",
      "2026-09-22T00:00:00.000Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "case-debit",
      "case-foreign",
      "Store-A",
      "2026-09-23T00:00:00.000Z",
      "REDEEM_REWARD",
      -1,
    ],
    [
      "zero-debit",
      "new",
      "store-a",
      "2026-09-24T00:00:00.000Z",
      "REDEEM_REWARD",
      0,
    ],
    [
      "wrong-type",
      "new",
      "store-a",
      "2026-09-25T00:00:00.000Z",
      "MANUAL_ADJUSTMENT",
      -1,
    ],
    [
      "prior-earn-before",
      "prior",
      "store-a",
      "2026-09-15T11:59:59.999Z",
      "EARN_ORDER",
      1,
    ],
    [
      "prior-earn-in",
      "prior",
      "store-a",
      "2026-09-15T12:00:00.000Z",
      "EARN_ORDER",
      1,
    ],
    ["new-earn", "new", "store-a", "2026-09-16T00:00:00.000Z", "EARN_ORDER", 1],
    [
      "new-earn-repeat",
      "new",
      "store-a",
      "2026-10-01T00:00:00.000Z",
      "EARN_ORDER",
      1,
    ],
    [
      "closed-earn",
      "closed",
      "store-a",
      "2026-09-20T00:00:00.000Z",
      "EARN_ORDER",
      1,
    ],
    [
      "redacted-earn",
      "redacted",
      "store-a",
      "2026-09-21T00:00:00.000Z",
      "EARN_ORDER",
      1,
    ],
  ] as const;
  for (const [id, accountId, storeId, at, entryType, pointsDelta] of ledger)
    await prisma.$executeRaw`
      INSERT INTO WeleticPointsLedgerEntry
        (id, accountId, storeId, createdAt, entryType, pointsDelta)
      VALUES (${id}, ${accountId}, ${storeId}, ${new Date(at)}, ${entryType}, ${pointsDelta})
    `;
  const startAt = new Date("2026-09-15T12:00:00.000Z");
  const endAt = new Date("2026-11-02T10:00:00.000Z");
  const [debits, earns] = await prisma.$transaction(
    (tx) =>
      Promise.all([
        readMerchantFirstRecordedRedemptionDebitsSeries({
          tx,
          storeId: "store-a",
          startAt,
          endAt,
        }),
        readMerchantFirstRecordedEarnersSeries({
          tx,
          storeId: "store-a",
          startAt,
          endAt,
        }),
      ]),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  expect(debits).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_reward_debit_accounts_only",
    rows: [
      {
        month: "2026-09",
        debitAccounts: "4",
        firstRecordedDebitAccounts: "3",
        returningDebitAccounts: "1",
      },
      {
        month: "2026-10",
        debitAccounts: "1",
        firstRecordedDebitAccounts: "0",
        returningDebitAccounts: "1",
      },
      {
        month: "2026-11",
        debitAccounts: "0",
        firstRecordedDebitAccounts: "0",
        returningDebitAccounts: "0",
      },
    ],
  });
  expect(earns).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_qualifying_ledger_accounts_only",
    rows: [
      {
        month: "2026-09",
        activeAccounts: "3",
        firstRecordedAccounts: "2",
        returningAccounts: "1",
      },
      {
        month: "2026-10",
        activeAccounts: "1",
        firstRecordedAccounts: "0",
        returningAccounts: "1",
      },
      {
        month: "2026-11",
        activeAccounts: "0",
        firstRecordedAccounts: "0",
        returningAccounts: "0",
      },
    ],
  });
  const [redactedRetained] = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*) AS count FROM WeleticLoyaltyAccount
    WHERE id = ${"redacted"} AND status = ${"closed"}
  `;
  expect(redactedRetained.count).toBe(BigInt(1));
});

it("classifies retained confirmed point issuances across range, month, tenant and privacy boundaries", async () => {
  const accounts = [
    ["issued-prior", "store-a", "active"],
    ["issued-new", "store-a", "active"],
    ["issued-legacy-unknown", "store-a", "active"],
    ["issued-redacted", "store-a", "closed"],
    ["issued-foreign", "store-b", "active"],
    ["issued-case-foreign", "Store-A", "active"],
  ] as const;
  for (const [id, storeId, status] of accounts)
    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyAccount (id, storeId, status)
      VALUES (${id}, ${storeId}, ${status})
    `;
  await prisma.$executeRaw`
    UPDATE WeleticLoyaltyAccount
    SET metadata = JSON_OBJECT('shopifyCustomerRedaction', JSON_OBJECT('status', 'redacted'))
    WHERE id = ${"issued-redacted"}
  `;
  const redemptions = [
    ["prior-before", "issued-prior", "store-a", "2026-09-15T11:59:59.999Z", 1],
    ["prior-in", "issued-prior", "store-a", "2026-09-15T12:00:00.000Z", 1],
    ["new-first", "issued-new", "store-a", "2026-09-16T00:00:00.000Z", 1],
    ["new-again", "issued-new", "store-a", "2026-09-18T00:00:00.000Z", 2],
    ["new-next-month", "issued-new", "store-a", "2026-10-01T00:00:00.000Z", 1],
    ["unknown-legacy", "issued-legacy-unknown", "store-a", null, 1],
    [
      "unknown-in",
      "issued-legacy-unknown",
      "store-a",
      "2026-09-17T00:00:00.000Z",
      1,
    ],
    ["zero-points", "issued-new", "store-a", "2026-09-17T00:00:00.000Z", 0],
    [
      "redacted-in",
      "issued-redacted",
      "store-a",
      "2026-09-17T00:00:00.000Z",
      1,
    ],
    ["foreign-in", "issued-foreign", "store-b", "2026-09-17T00:00:00.000Z", 1],
    [
      "case-foreign-in",
      "issued-case-foreign",
      "Store-A",
      "2026-09-17T00:00:00.000Z",
      1,
    ],
    ["outside-end", "issued-prior", "store-a", "2026-11-02T10:00:00.001Z", 1],
  ] as const;
  for (const [id, accountId, storeId, at, pointsSpent] of redemptions)
    await prisma.$executeRaw`
      INSERT INTO WeleticRewardRedemption
        (id, accountId, storeId, issuanceConfirmedAt, pointsSpent)
      VALUES (${id}, ${accountId}, ${storeId}, ${at ? new Date(at) : null}, ${pointsSpent})
    `;
  await prisma.$executeRaw`
    INSERT INTO WeleticRewardRedemption
      (id, accountId, storeId, issuanceConfirmedAt, pointsSpent)
    VALUES (${"direct-no-account"}, NULL, ${"store-a"}, ${new Date("2026-09-17T00:00:00.000Z")}, ${1})
  `;

  const series = await prisma.$transaction(
    (tx) =>
      readMerchantFirstRecordedConfirmedIssuancesSeries({
        tx,
        storeId: "store-a",
        startAt: new Date("2026-09-15T12:00:00.000Z"),
        endAt: new Date("2026-11-02T10:00:00.000Z"),
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  expect(series).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_confirmed_point_issuance_accounts_only",
    rows: [
      {
        month: "2026-09",
        confirmedAccounts: "3",
        firstRecordedConfirmedAccounts: "2",
        returningConfirmedAccounts: "1",
      },
      {
        month: "2026-10",
        confirmedAccounts: "1",
        firstRecordedConfirmedAccounts: "0",
        returningConfirmedAccounts: "1",
      },
      {
        month: "2026-11",
        confirmedAccounts: "0",
        firstRecordedConfirmedAccounts: "0",
        returningConfirmedAccounts: "0",
      },
    ],
  });
});
