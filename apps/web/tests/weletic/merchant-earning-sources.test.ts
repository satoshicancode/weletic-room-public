import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { readMerchantEarningSources } from "../../lib/weletic/loyalty/earning-sources";

const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const startAt = new Date("2026-09-01T12:00:00.000Z");
const endAt = new Date("2026-09-30T10:00:00.000Z");
const read = (start: Date | null = startAt, end: Date | null = endAt) =>
  readMerchantEarningSources({
    tx,
    storeId: "store-a",
    startAt: start,
    endAt: end,
  });

beforeEach(() => raw.mockReset());

it("ranks exact gross points, ties by source, and scopes both selected instants", async () => {
  raw.mockResolvedValue([
    { entryType: "TIER_BONUS", eventCount: "2", pointsEarned: "4" },
    {
      entryType: "EARN_ORDER",
      eventCount: "9007199254740993",
      pointsEarned: "9007199254740994",
    },
    { entryType: "EARN_BONUS", eventCount: "1", pointsEarned: "4" },
  ]);
  expect(await read()).toEqual({
    coverage: "retained_positive_earning_ledger_only",
    rows: [
      {
        entryType: "EARN_ORDER",
        eventCount: "9007199254740993",
        pointsEarned: "9007199254740994",
      },
      { entryType: "EARN_BONUS", eventCount: "1", pointsEarned: "4" },
      { entryType: "TIER_BONUS", eventCount: "2", pointsEarned: "4" },
    ],
  });
  const query = raw.mock.calls[0][0] as Prisma.Sql;
  expect(query.values).toEqual(["store-a", startAt, endAt]);
  expect(query.sql).toContain("pointsDelta > 0");
  expect(query.sql).toContain(
    "'EARN_ORDER', 'EARN_REFERRAL', 'EARN_BONUS', 'TIER_BONUS'",
  );
});

it("allows an all-history owner read without changing store scope", async () => {
  raw.mockResolvedValue([]);
  expect(await read(null, null)).toEqual({
    coverage: "retained_positive_earning_ledger_only",
    rows: [],
  });
  expect((raw.mock.calls[0][0] as Prisma.Sql).values).toEqual(["store-a"]);
});

it("rejects unknown, duplicate or invalid aggregate rows", async () => {
  for (const rows of [
    [{ entryType: "BACKFILL", eventCount: "1", pointsEarned: "2" }],
    [
      { entryType: "EARN_ORDER", eventCount: "1", pointsEarned: "2" },
      { entryType: "EARN_ORDER", eventCount: "1", pointsEarned: "2" },
    ],
    [{ entryType: "EARN_ORDER", eventCount: "0", pointsEarned: "2" }],
    [{ entryType: "EARN_ORDER", eventCount: "1", pointsEarned: "-2" }],
  ]) {
    raw.mockReset().mockResolvedValue(rows);
    await expect(read()).rejects.toThrow();
  }
});
