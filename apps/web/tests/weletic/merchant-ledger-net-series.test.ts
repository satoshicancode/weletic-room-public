import { readMerchantLedgerNetSeries } from "@/lib/weletic/loyalty/ledger-net-series";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const storeId = "store-a";
const startAt = new Date("2026-09-01T12:00:00.000Z");
const endAt = new Date("2026-09-03T10:00:00.000Z");
const read = (start: Date | null, end: Date | null) =>
  readMerchantLedgerNetSeries({ tx, storeId, startAt: start, endAt: end });

beforeEach(() => raw.mockReset());

it("requires a bounded explicit range without querying the ledger", async () => {
  expect(await read(null, endAt)).toEqual({
    status: "range_required",
    bucket: "utc_day",
    coverage: "recorded_ledger_net_only",
    openingNetPoints: null,
    rows: [],
  });
  expect(await read(startAt, new Date("2027-10-01T00:00:00Z"))).toEqual({
    status: "range_too_wide",
    bucket: "utc_day",
    coverage: "recorded_ledger_net_only",
    openingNetPoints: null,
    rows: [],
  });
  expect(raw).not.toHaveBeenCalled();
});

it("retains exact signed opening, partial UTC boundary days and quiet days", async () => {
  raw.mockResolvedValueOnce([{ net: "9007199254740993" }]);
  raw.mockResolvedValueOnce([
    { day: "2026-09-01", net: "-7" },
    { day: "2026-09-03", net: "3" },
  ]);
  expect(await read(startAt, endAt)).toEqual({
    status: "available",
    bucket: "utc_day",
    coverage: "recorded_ledger_net_only",
    openingNetPoints: "9007199254740993",
    rows: [
      {
        date: "2026-09-01",
        netChangePoints: "-7",
        cumulativeNetPoints: "9007199254740986",
      },
      {
        date: "2026-09-02",
        netChangePoints: "0",
        cumulativeNetPoints: "9007199254740986",
      },
      {
        date: "2026-09-03",
        netChangePoints: "3",
        cumulativeNetPoints: "9007199254740989",
      },
    ],
  });
  expect(raw.mock.calls[0].slice(1)).toEqual([storeId, startAt]);
  expect(raw.mock.calls[1].slice(1)).toEqual([storeId, startAt, endAt]);
});

it("rejects duplicate, foreign-day and malformed aggregate rows", async () => {
  for (const rows of [
    [
      { day: "2026-09-01", net: "1" },
      { day: "2026-09-01", net: "2" },
    ],
    [{ day: "2026-08-31", net: "1" }],
    [{ day: "2026-09-01", net: "1.5" }],
  ]) {
    raw.mockReset();
    raw.mockResolvedValueOnce([{ net: "0" }]);
    raw.mockResolvedValueOnce(rows);
    await expect(read(startAt, endAt)).rejects.toThrow();
  }
});
