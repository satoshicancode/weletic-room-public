import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ executeRaw: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (operation: any) =>
      operation({ $queryRaw: async () => [], $executeRaw: mocks.executeRaw }),
    $executeRaw: mocks.executeRaw,
    weleticShopifyCustomerPrivacyTombstone: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    weleticShopifyShopPrivacyTombstone: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

import { deleteExpiredShopifyPrivacyTombstonesBatch } from "../../lib/weletic/shopify/compliance-retention";

// Execute only SELECT over inline JSON. No fixture records, table changes,
// external calls or UPDATE/DELETE statements are allowed by this suite.
describe("read-only isolated MySQL referral retention predicates", () => {
  let db: PrismaClient | undefined;
  let predicate: string;
  let parameters: unknown[];
  const base = {
    capturedAt: "2026-09-01T00:00:00.000Z",
    retainUntil: "2026-09-20T00:00:00.000Z",
  };

  beforeAll(async () => {
    if (process.env.REFERRAL_RETENTION_READONLY_DATABASE_INTEGRATION !== "1") {
      throw new Error(
        "Read-only database verification requires explicit opt-in",
      );
    }
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (
      url.protocol !== "mysql:" ||
      url.hostname !== "127.0.0.1" ||
      url.port !== "3307" ||
      url.pathname !== "/weletic_loyalty_dev" ||
      url.username !== "loyalty_dev" ||
      url.search !== ""
    ) {
      throw new Error("Only the exact isolated loyalty database is permitted");
    }
    db = new PrismaClient({ datasourceUrl: url.toString() });
    const identity = await db.$queryRaw<
      Array<{ databaseName: string; principal: string }>
    >`SELECT DATABASE() AS databaseName, CURRENT_USER() AS principal`;
    expect(identity).toEqual([
      { databaseName: "weletic_loyalty_dev", principal: "loyalty_dev@%" },
    ]);
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "10");
    vi.stubEnv("WELETIC_SHOPIFY_CUSTOMER_TOMBSTONE_RETENTION_DAYS", "30");
    await deleteExpiredShopifyPrivacyTombstonesBatch({
      now: new Date("2026-09-09T00:00:00.000Z"),
    });
    const [strings, ...values] = mocks.executeRaw.mock.calls[0];
    const query = Prisma.sql(strings, ...values);
    predicate = query.sql.split("    WHERE ")[1].split("    ORDER BY")[0];
    parameters = query.values.slice(0, -1); // LIMIT does not belong to SELECT.
    expect(parameters).toHaveLength(3);
    expect(predicate).not.toMatch(/UPDATE|DELETE|INSERT|;/);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.$disconnect();
  });

  const cases: Array<[string, unknown, boolean]> = [
    ["valid", base, false],
    [
      "stored expiry",
      { ...base, retainUntil: "2026-09-09T00:00:00.000Z" },
      true,
    ],
    [
      "policy shortened",
      { ...base, capturedAt: "2026-08-30T00:00:00.000Z" },
      true,
    ],
    ["missing dates", {}, true],
    ["null dates", { capturedAt: null, retainUntil: null }, true],
    ["invalid dates", { capturedAt: "invalid", retainUntil: "ZZZ" }, true],
    ["numeric dates", { capturedAt: 12, retainUntil: 24 }, true],
    [
      "noncanonical date",
      { ...base, capturedAt: "2026-09-01T00:00:00Z" },
      true,
    ],
    ["array", ["hmac-only"], true],
    ["null", null, true],
    ["string", "hmac-only", true],
    [
      "future capture",
      { ...base, capturedAt: "2026-09-10T00:00:00.000Z" },
      true,
    ],
    [
      "reversed dates",
      { ...base, retainUntil: "2026-08-31T00:00:00.000Z" },
      true,
    ],
    ["absent snapshot", undefined, false],
  ];
  it.each(cases)(
    "selects the correct outcome for %s",
    async (_name, snapshot, expected) => {
      const metadata = JSON.stringify({
        other: "keep",
        friendPrivacySnapshot: snapshot,
      });
      const rows = await db!.$queryRawUnsafe<
        Array<{ shouldPrune: number | bigint }>
      >(
        `SELECT CASE WHEN ${predicate} THEN 1 ELSE 0 END AS shouldPrune FROM (SELECT CAST(? AS JSON) AS metadata) fixture`,
        ...parameters,
        metadata,
      );
      expect(Boolean(Number(rows[0].shouldPrune))).toBe(expected);
    },
  );
});
