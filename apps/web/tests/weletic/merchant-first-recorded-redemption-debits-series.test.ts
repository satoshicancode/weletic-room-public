import { readMerchantFirstRecordedRedemptionDebitsSeries } from "@/lib/weletic/loyalty/first-recorded-redemption-debits-series";
import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const startAt = new Date("2026-09-15T12:00:00.000Z");
const endAt = new Date("2026-11-02T10:00:00.000Z");
const read = (start: Date | null = startAt, end: Date | null = endAt) =>
  readMerchantFirstRecordedRedemptionDebitsSeries({
    tx,
    storeId: "store-a",
    startAt: start,
    endAt: end,
  });

beforeEach(() => raw.mockReset());

it("requires an explicit bounded UTC range without touching the database", async () => {
  expect(await read(null, endAt)).toMatchObject({
    status: "range_required",
    rows: [],
  });
  expect(await read(startAt, null)).toMatchObject({ status: "range_required" });
  expect(
    await read(startAt, new Date("2028-01-01T00:00:00.000Z")),
  ).toMatchObject({ status: "range_too_wide", rows: [] });
  expect(raw).not.toHaveBeenCalled();
});

it("preserves exact distinct-account counts and zero-filled months", async () => {
  raw.mockResolvedValue([
    {
      month: "2026-09",
      debitAccounts: "9007199254740993",
      firstRecordedDebitAccounts: "9007199254740990",
    },
    {
      month: "2026-11",
      debitAccounts: "2",
      firstRecordedDebitAccounts: "0",
    },
  ]);
  expect(await read()).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_reward_debit_accounts_only",
    rows: [
      {
        month: "2026-09",
        debitAccounts: "9007199254740993",
        firstRecordedDebitAccounts: "9007199254740990",
        returningDebitAccounts: "3",
      },
      {
        month: "2026-10",
        debitAccounts: "0",
        firstRecordedDebitAccounts: "0",
        returningDebitAccounts: "0",
      },
      {
        month: "2026-11",
        debitAccounts: "2",
        firstRecordedDebitAccounts: "0",
        returningDebitAccounts: "2",
      },
    ],
  });
  const sql = (raw.mock.calls[0][0] as TemplateStringsArray).join("?");
  const values = raw.mock.calls[0].slice(1);
  expect(sql).toContain("INNER JOIN WeleticLoyaltyAccount a");
  expect(sql).toContain("JSON_CONTAINS_PATH(a.metadata");
  expect(sql).toContain("h.entryType = 'REDEEM_REWARD'");
  expect(sql).toContain("e.pointsDelta < 0");
  expect(values).toContain('$."shopifyCustomerRedaction"');
  expect(values.filter((value) => value === "store-a")).toHaveLength(4);
});

it("rejects malformed, duplicate or escaped aggregate rows", async () => {
  for (const rows of [
    [{ month: "2026-08", debitAccounts: "1", firstRecordedDebitAccounts: "1" }],
    [
      { month: "2026-09", debitAccounts: "1", firstRecordedDebitAccounts: "1" },
      { month: "2026-09", debitAccounts: "1", firstRecordedDebitAccounts: "1" },
    ],
    [{ month: "2026-09", debitAccounts: "1", firstRecordedDebitAccounts: "2" }],
    [
      {
        month: "2026-09",
        debitAccounts: "-1",
        firstRecordedDebitAccounts: "0",
      },
    ],
  ]) {
    raw.mockReset().mockResolvedValue(rows);
    await expect(read()).rejects.toThrow();
  }
});
