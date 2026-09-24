import type { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";
import { readMerchantOrderEarningSeries } from "../../lib/weletic/loyalty/order-earning-series";

function client(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue(rows);
  return {
    query,
    tx: { $queryRaw: query } as unknown as Prisma.TransactionClient,
  };
}

it("requires an exact bounded UTC range before querying orders", async () => {
  const { tx, query } = client();
  expect(
    await readMerchantOrderEarningSeries({
      tx,
      storeId: "store-a",
      startAt: null,
      endAt: new Date("2026-09-01T00:00:00Z"),
    }),
  ).toMatchObject({ status: "range_required", rows: [] });
  expect(
    await readMerchantOrderEarningSeries({
      tx,
      storeId: "store-a",
      startAt: new Date("2025-01-01T00:00:00Z"),
      endAt: new Date("2026-09-01T00:00:00Z"),
    }),
  ).toMatchObject({ status: "range_too_wide", rows: [] });
  expect(query).not.toHaveBeenCalled();
});

it("computes an exact rate from counts above Number precision", async () => {
  const total = BigInt("9007199254740993");
  const { tx, query } = client([
    {
      day: "2026-09-01",
      recordedOrders: total.toString(),
      earningOrders: (total - BigInt(1)).toString(),
    },
  ]);
  const result = await readMerchantOrderEarningSeries({
    tx,
    storeId: "store-a",
    startAt: new Date("2026-09-01T12:00:00Z"),
    endAt: new Date("2026-09-02T11:00:00Z"),
  });
  expect(result.rows).toEqual([
    {
      date: "2026-09-01",
      recordedOrders: total.toString(),
      earningOrders: (total - BigInt(1)).toString(),
      rateBasisPoints: "10000",
    },
    {
      date: "2026-09-02",
      recordedOrders: "0",
      earningOrders: "0",
      rateBasisPoints: null,
    },
  ]);
  expect(query).toHaveBeenCalledTimes(1);
});

it("fails closed on a query result outside the authorized day or denominator", async () => {
  const inputs = [
    { day: "2026-08-31", recordedOrders: "1", earningOrders: "1" },
    { day: "2026-09-01", recordedOrders: "1", earningOrders: "2" },
  ];
  for (const row of inputs) {
    const { tx } = client([row]);
    await expect(
      readMerchantOrderEarningSeries({
        tx,
        storeId: "store-a",
        startAt: new Date("2026-09-01T00:00:00Z"),
        endAt: new Date("2026-09-01T23:59:59.999Z"),
      }),
    ).rejects.toThrow();
  }
});
