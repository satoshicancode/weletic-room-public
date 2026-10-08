import { readMerchantRecordedTierChangeSeries } from "@/lib/weletic/loyalty/recorded-tier-change-series";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const storeId = "store-a";
const startAt = new Date("2026-09-15T12:00:00.000Z");
const endAt = new Date("2026-11-02T10:00:00.000Z");
const read = (start: Date | null, end: Date | null) =>
  readMerchantRecordedTierChangeSeries({
    tx,
    storeId,
    startAt: start,
    endAt: end,
  });

beforeEach(() => raw.mockReset());

it("requires a bounded explicit UTC interval before reading history", async () => {
  expect(await read(null, endAt)).toEqual({
    status: "range_required",
    bucket: "utc_month",
    coverage: "retained_tier_change_reasons_only",
    rows: [],
  });
  expect(await read(startAt, new Date("2027-10-01T00:00:00Z"))).toEqual({
    status: "range_too_wide",
    bucket: "utc_month",
    coverage: "retained_tier_change_reasons_only",
    rows: [],
  });
  expect(raw).not.toHaveBeenCalled();
});

it("zero-fills quiet months and retains exact reason counts", async () => {
  raw.mockResolvedValue([
    {
      month: "2026-09",
      totalChanges: "9007199254740993",
      thresholdReached: "9007199254740990",
      bonusPromotion: "0",
      annualDowngrade: "0",
      gracePeriodExpired: "0",
      programActivation: "0",
      manualOverride: "3",
      otherReasons: "0",
    },
  ]);
  expect(await read(startAt, endAt)).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_tier_change_reasons_only",
    rows: [
      {
        month: "2026-09",
        totalChanges: "9007199254740993",
        thresholdReached: "9007199254740990",
        bonusPromotion: "0",
        annualDowngrade: "0",
        gracePeriodExpired: "0",
        programActivation: "0",
        manualOverride: "3",
        otherReasons: "0",
      },
      {
        month: "2026-10",
        totalChanges: "0",
        thresholdReached: "0",
        bonusPromotion: "0",
        annualDowngrade: "0",
        gracePeriodExpired: "0",
        programActivation: "0",
        manualOverride: "0",
        otherReasons: "0",
      },
      {
        month: "2026-11",
        totalChanges: "0",
        thresholdReached: "0",
        bonusPromotion: "0",
        annualDowngrade: "0",
        gracePeriodExpired: "0",
        programActivation: "0",
        manualOverride: "0",
        otherReasons: "0",
      },
    ],
  });
  expect(raw.mock.calls[0].slice(1)).toEqual([storeId, startAt, endAt]);
});

it("rejects duplicate, out-of-range, malformed and unreconciled rows", async () => {
  const valid = {
    month: "2026-09",
    totalChanges: "1",
    thresholdReached: "1",
    bonusPromotion: "0",
    annualDowngrade: "0",
    gracePeriodExpired: "0",
    programActivation: "0",
    manualOverride: "0",
    otherReasons: "0",
  };
  for (const rows of [
    [valid, valid],
    [{ ...valid, month: "2026-08" }],
    [{ ...valid, totalChanges: "01" }],
    [{ ...valid, manualOverride: "1" }],
  ]) {
    raw.mockReset().mockResolvedValue(rows);
    await expect(read(startAt, endAt)).rejects.toThrow();
  }
});

it("keeps future recorded reasons visible without losing the total", async () => {
  raw.mockResolvedValue([
    {
      month: "2026-09",
      totalChanges: "1",
      thresholdReached: "0",
      bonusPromotion: "0",
      annualDowngrade: "0",
      gracePeriodExpired: "0",
      programActivation: "0",
      manualOverride: "0",
      otherReasons: "1",
    },
  ]);
  const result = await read(startAt, endAt);
  expect(result.rows[0]).toMatchObject({
    totalChanges: "1",
    otherReasons: "1",
  });
});
