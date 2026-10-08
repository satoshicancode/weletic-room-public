import { readMerchantRetainedEnrollmentSeries } from "@/lib/weletic/loyalty/retained-enrollment-series";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, expect, it } from "vitest";

const prisma = new PrismaClient();
let initialized = false;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const target = /^\/weletic_loyalty_it_members_([a-f0-9]{12})$/.exec(
    url.pathname,
  );
  if (
    process.env.LOYALTY_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3313" ||
    !target ||
    url.username !== `w27_${target[1]}` ||
    !url.password ||
    url.hash ||
    [...url.searchParams].some(
      ([key, value]) =>
        key !== "connection_limit" || !/^(?:[1-9]|1[0-9]|20)$/.test(value),
    )
  )
    throw new Error("Refusing non-isolated retained-enrollment database");
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
    enrolledAt DATETIME(3) NOT NULL,
    metadata JSON NULL,
    INDEX wl_account_store_status_idx (storeId, status)
  )`);
  initialized = true;
});

afterAll(async () => {
  if (initialized)
    await prisma.$executeRawUnsafe("DROP TABLE WeleticLoyaltyAccount");
  await prisma.$disconnect();
});

it("reconciles retained enrollments across partial months and isolated stores", async () => {
  const startAt = new Date("2026-09-15T12:00:00.000Z");
  const endAt = new Date("2026-11-02T10:00:00.000Z");
  const rows = [
    ["prior", "store-a", "inactive", "2026-09-15T11:59:59.999Z"],
    ["prior-erased", "store-a", "closed", "2026-09-14T00:00:00.000Z"],
    ["start", "store-a", "active", "2026-09-15T12:00:00.000Z"],
    ["september", "store-a", "active", "2026-09-30T23:59:59.999Z"],
    ["closed-retained", "store-a", "closed", "2026-10-01T00:00:00.000Z"],
    ["end", "store-a", "active", "2026-11-02T10:00:00.000Z"],
    ["after", "store-a", "active", "2026-11-02T10:00:00.001Z"],
    ["foreign", "store-b", "active", "2026-10-01T00:00:00.000Z"],
    ["case-foreign", "Store-A", "active", "2026-10-01T00:00:00.000Z"],
    ["customer-erased", "store-a", "closed", "2026-10-01T00:00:00.000Z"],
    ["shop-erased", "store-a", "closed", "2026-10-02T00:00:00.000Z"],
  ] as const;
  for (const [id, storeId, status, at] of rows)
    await prisma.$executeRaw`
      INSERT INTO WeleticLoyaltyAccount (id, storeId, status, enrolledAt)
      VALUES (${id}, ${storeId}, ${status}, ${new Date(at)})
    `;
  for (const id of ["prior-erased", "customer-erased", "shop-erased"])
    await prisma.$executeRaw`
      UPDATE WeleticLoyaltyAccount
      SET metadata = JSON_OBJECT(
        'shopifyCustomerRedaction', JSON_OBJECT(
          'status', 'redacted',
          'redactedAt', '2026-11-03T00:00:00.000Z',
          'source', 'shopify_customers_redact'
        )
      )
      WHERE id = ${id}
    `;
  const result = await prisma.$transaction(
    (tx) =>
      readMerchantRetainedEnrollmentSeries({
        tx,
        storeId: "store-a",
        startAt,
        endAt,
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  expect(result).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_account_enrollments_only",
    openingRetainedAccounts: "1",
    rows: [
      {
        month: "2026-09",
        newRetainedAccounts: "2",
        cumulativeRetainedAccounts: "3",
      },
      {
        month: "2026-10",
        newRetainedAccounts: "1",
        cumulativeRetainedAccounts: "4",
      },
      {
        month: "2026-11",
        newRetainedAccounts: "1",
        cumulativeRetainedAccounts: "5",
      },
    ],
  });
  const [independent] = await prisma.$queryRaw<Array<{ total: bigint }>>`
    SELECT COUNT(*) AS total FROM WeleticLoyaltyAccount
    WHERE id IN ('prior', 'start', 'september', 'closed-retained', 'end')
  `;
  expect(result.rows.at(-1)?.cumulativeRetainedAccounts).toBe(
    independent.total.toString(),
  );
});
