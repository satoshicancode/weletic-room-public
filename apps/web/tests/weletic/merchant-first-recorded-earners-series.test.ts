import { readMerchantFirstRecordedEarnersSeries } from "@/lib/weletic/loyalty/first-recorded-earners-series";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const storeId = "store-a";
const startAt = new Date("2026-09-15T12:00:00.000Z");
const endAt = new Date("2026-11-02T10:00:00.000Z");
const read = (start: Date | null, end: Date | null) =>
  readMerchantFirstRecordedEarnersSeries({
    tx,
    storeId,
    startAt: start,
    endAt: end,
  });

beforeEach(() => raw.mockReset());

it("requires a bounded explicit UTC interval before querying account history", async () => {
  expect(await read(null, endAt)).toEqual({
    status: "range_required",
    bucket: "utc_month",
    coverage: "retained_qualifying_ledger_accounts_only",
    rows: [],
  });
  expect(await read(startAt, new Date("2027-10-01T00:00:00Z"))).toEqual({
    status: "range_too_wide",
    bucket: "utc_month",
    coverage: "retained_qualifying_ledger_accounts_only",
    rows: [],
  });
  expect(raw).not.toHaveBeenCalled();
});

it("returns distinct account cohorts with quiet months and exact counts", async () => {
  raw.mockResolvedValue([
    {
      month: "2026-09",
      activeAccounts: "9007199254740993",
      firstRecordedAccounts: "9007199254740990",
    },
    {
      month: "2026-11",
      activeAccounts: "2",
      firstRecordedAccounts: "0",
    },
  ]);
  expect(await read(startAt, endAt)).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_qualifying_ledger_accounts_only",
    rows: [
      {
        month: "2026-09",
        activeAccounts: "9007199254740993",
        firstRecordedAccounts: "9007199254740990",
        returningAccounts: "3",
      },
      {
        month: "2026-10",
        activeAccounts: "0",
        firstRecordedAccounts: "0",
        returningAccounts: "0",
      },
      {
        month: "2026-11",
        activeAccounts: "2",
        firstRecordedAccounts: "0",
        returningAccounts: "2",
      },
    ],
  });
  expect(raw).toHaveBeenCalledOnce();
  expect(raw.mock.calls[0].slice(1)).toEqual([
    storeId,
    startAt,
    startAt,
    storeId,
    startAt,
    endAt,
  ]);
});

it("rejects duplicate, foreign-month and inconsistent aggregate rows", async () => {
  for (const rows of [
    [
      {
        month: "2026-09",
        activeAccounts: "1",
        firstRecordedAccounts: "1",
      },
      {
        month: "2026-09",
        activeAccounts: "1",
        firstRecordedAccounts: "1",
      },
    ],
    [
      {
        month: "2026-08",
        activeAccounts: "1",
        firstRecordedAccounts: "1",
      },
    ],
    [
      {
        month: "2026-09",
        activeAccounts: "1",
        firstRecordedAccounts: "2",
      },
    ],
  ]) {
    raw.mockReset().mockResolvedValue(rows);
    await expect(read(startAt, endAt)).rejects.toThrow();
  }
});
