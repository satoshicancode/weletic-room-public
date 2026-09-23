import { readMerchantPointActivitySeries } from "@/lib/weletic/loyalty/activity-series";
import { WeleticPointsLedgerEntryType as Entry, Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const storeId = "store-a";
const startAt = new Date("2026-09-01T00:00:00.000Z");
const endAt = new Date("2026-09-02T23:59:59.999Z");
const read = (start: Date | null, end: Date | null) =>
  readMerchantPointActivitySeries({ tx, storeId, startAt: start, endAt: end });
const amount = (value: string) => new Prisma.Decimal(value);

beforeEach(() => {
  raw.mockReset().mockResolvedValue([]);
});

it("requires a bounded explicit UTC range before reading the ledger", async () => {
  expect(await read(null, endAt)).toEqual({
    status: "range_required",
    bucket: "utc_day",
    rows: [],
  });
  expect(await read(startAt, new Date("2027-10-01T00:00:00Z"))).toEqual({
    status: "range_too_wide",
    bucket: "utc_day",
    rows: [],
  });
  expect(raw).not.toHaveBeenCalled();
});

it("groups exact ledger categories by UTC date and fills quiet days", async () => {
  const huge = "9007199254740993";
  raw.mockResolvedValue([
    {
      day: "2026-09-01",
      entryType: Entry.BACKFILL,
      positive: amount(huge),
      negative: amount("0"),
    },
    {
      day: "2026-09-01",
      entryType: Entry.MANUAL_ADJUSTMENT,
      positive: amount("7"),
      negative: amount("3"),
    },
    {
      day: "2026-09-01",
      entryType: Entry.REDEEM_REWARD,
      positive: amount("0"),
      negative: amount("5"),
    },
  ]);
  const result = await read(startAt, endAt);
  expect(result.status).toBe("available");
  expect(result.rows).toEqual([
    {
      date: "2026-09-01",
      earned: huge,
      redeemed: "5",
      refundReversed: "0",
      expired: "0",
      backfilled: huge,
      backfillCorrected: "0",
      manualCredits: "7",
      manualDebits: "3",
    },
    {
      date: "2026-09-02",
      earned: "0",
      redeemed: "0",
      refundReversed: "0",
      expired: "0",
      backfilled: "0",
      backfillCorrected: "0",
      manualCredits: "0",
      manualDebits: "0",
    },
  ]);
  expect(raw).toHaveBeenCalledOnce();
  expect(raw.mock.calls[0].slice(1)).toEqual([storeId, startAt, endAt]);
});

it("normalizes offset instants to UTC buckets without shifting the query window", async () => {
  const start = new Date("2026-09-02T00:30:00+09:00");
  const end = new Date("2026-09-02T01:30:00+09:00");
  const result = await read(start, end);
  expect(result.rows.map((row) => row.date)).toEqual(["2026-09-01"]);
  expect(raw.mock.calls[0].slice(1)).toEqual([storeId, start, end]);
});
