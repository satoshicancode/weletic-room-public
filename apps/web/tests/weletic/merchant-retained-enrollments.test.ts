import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { readMerchantRetainedEnrollmentSeries } from "../../lib/weletic/loyalty/retained-enrollment-series";
import { SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY } from "../../lib/weletic/loyalty/shopper-privacy";

const raw = vi.fn();
const tx = { $queryRaw: raw } as unknown as Prisma.TransactionClient;
const startAt = new Date("2026-09-15T12:00:00.000Z");
const endAt = new Date("2026-11-02T10:00:00.000Z");
const read = (start: Date | null = startAt, end: Date | null = endAt) =>
  readMerchantRetainedEnrollmentSeries({
    tx,
    storeId: "store-a",
    startAt: start,
    endAt: end,
  });

beforeEach(() => raw.mockReset());

it("preserves exact opening and zero-filled UTC months inside partial instants", async () => {
  raw
    .mockResolvedValueOnce([{ openingRetainedAccounts: "9007199254740993" }])
    .mockResolvedValueOnce([
      { month: "2026-09", newRetainedAccounts: "2" },
      { month: "2026-11", newRetainedAccounts: "3" },
    ]);
  expect(await read()).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "retained_account_enrollments_only",
    openingRetainedAccounts: "9007199254740993",
    rows: [
      {
        month: "2026-09",
        newRetainedAccounts: "2",
        cumulativeRetainedAccounts: "9007199254740995",
      },
      {
        month: "2026-10",
        newRetainedAccounts: "0",
        cumulativeRetainedAccounts: "9007199254740995",
      },
      {
        month: "2026-11",
        newRetainedAccounts: "3",
        cumulativeRetainedAccounts: "9007199254740998",
      },
    ],
  });
  for (const [query] of raw.mock.calls as [Prisma.Sql][]) {
    expect(query.values).toContain("store-a");
    expect(query.values).toContain(startAt);
    expect(query.sql).toContain("BINARY storeId = BINARY");
    expect(query.sql).toContain("JSON_CONTAINS_PATH(metadata");
    expect(query.values).toContain(
      `$."${SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY}"`,
    );
  }
  expect((raw.mock.calls[1][0] as Prisma.Sql).values).toContain(endAt);
});

it("requires a bounded range before querying accounts", async () => {
  expect(await read(null, endAt)).toMatchObject({
    status: "range_required",
    openingRetainedAccounts: null,
    rows: [],
  });
  expect(await read(startAt, null)).toMatchObject({
    status: "range_required",
  });
  expect(
    await read(startAt, new Date("2028-01-01T00:00:00.000Z")),
  ).toMatchObject({ status: "range_too_wide", rows: [] });
  expect(raw).not.toHaveBeenCalled();
});

it("rejects malformed or escaped SQL aggregate rows", async () => {
  raw.mockResolvedValueOnce([{ openingRetainedAccounts: "-1" }]);
  await expect(read()).rejects.toThrow();
  for (const rows of [
    [{ month: "2026-12", newRetainedAccounts: "1" }],
    [
      { month: "2026-09", newRetainedAccounts: "1" },
      { month: "2026-09", newRetainedAccounts: "1" },
    ],
    [{ month: "2026-09", newRetainedAccounts: "0" }],
  ]) {
    raw
      .mockReset()
      .mockResolvedValueOnce([{ openingRetainedAccounts: "0" }])
      .mockResolvedValueOnce(rows);
    await expect(read()).rejects.toThrow();
  }
});
