import { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import {
  appendPointsLedgerEntry,
  appendPointsLedgerEntryWithReceipt,
  OptimisticConcurrencyError,
} from "../../lib/weletic/loyalty/ledger";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
const findUnique = vi.fn();
const create = vi.fn();
const updateMany = vi.fn();
const account = vi.fn();
const tx = {
  weleticPointsLedgerEntry: { findUnique, create },
  weleticLoyaltyAccount: { findUnique: account, updateMany },
  weleticLoyaltyProgram: { findUnique: vi.fn(async () => null) },
} as unknown as Prisma.TransactionClient;
const params = {
  storeId: "store",
  accountId: "account",
  entryType: "EARN_ORDER" as const,
  pointsDelta: BigInt(20),
  idempotencyKey: "earn:order",
  referenceType: "COMMERCE_ORDER",
  referenceId: "order",
  tx,
};
const existing = {
  id: "ledger",
  storeId: "store",
  accountId: "account",
  entryType: "EARN_ORDER",
  pointsDelta: BigInt(20),
  pendingDelta: BigInt(0),
  grantId: null,
  referenceType: "COMMERCE_ORDER",
  referenceId: "order",
  balanceAfter: BigInt(30),
};
beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(null);
  create.mockImplementation(async ({ data }) => ({
    ...data,
    createdAt: new Date("2026-09-10T00:00:00Z"),
  }));
  account.mockResolvedValue({
    id: "account",
    storeId: "store",
    cachedPointsBalance: BigInt(10),
    cachedPendingPoints: BigInt(0),
    lifetimePointsEarned: BigInt(10),
    lifetimePointsRedeemed: BigInt(0),
    ledgerVersion: 1,
  });
  updateMany.mockResolvedValue({ count: 1 });
});
it("returns creation evidence only after both entry and balance writes succeed", async () => {
  const result = await appendPointsLedgerEntryWithReceipt(params);
  expect(result.created).toBe(true);
  expect(result.entry.balanceAfter).toBe(BigInt(30));
  expect(result.entry.sequenceNumber).toBe(2);
  expect(create).toHaveBeenCalledTimes(1);
  expect(updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "account", storeId: "store", ledgerVersion: 1 },
    }),
  );
});
it("returns replay evidence without writing the ledger or balance", async () => {
  findUnique.mockResolvedValue(existing);
  expect(await appendPointsLedgerEntryWithReceipt(params)).toEqual({
    entry: existing,
    created: false,
  });
  expect(create).not.toHaveBeenCalled();
  expect(updateMany).not.toHaveBeenCalled();
});
it("does not describe a recovered duplicate insertion as new", async () => {
  findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);
  create.mockRejectedValueOnce(
    new Prisma.PrismaClientKnownRequestError("duplicate", {
      code: "P2002",
      clientVersion: "test",
    }),
  );
  expect(await appendPointsLedgerEntryWithReceipt(params)).toEqual({
    entry: existing,
    created: false,
  });
  expect(updateMany).not.toHaveBeenCalled();
});
it("preserves the old public return shape", async () => {
  findUnique.mockResolvedValue(existing);
  expect(await appendPointsLedgerEntry(params)).toEqual(existing);
});
it("does not return a receipt after a lost balance CAS", async () => {
  updateMany.mockResolvedValue({ count: 0 });
  await expect(
    appendPointsLedgerEntryWithReceipt(params),
  ).rejects.toBeInstanceOf(OptimisticConcurrencyError);
});
it("rejects foreign account ownership before creating an entry", async () => {
  account.mockResolvedValue({ storeId: "foreign" });
  await expect(appendPointsLedgerEntryWithReceipt(params)).rejects.toThrow(
    "does not belong",
  );
  expect(create).not.toHaveBeenCalled();
});
it("does not adopt conflicting replay evidence", async () => {
  findUnique.mockResolvedValue({ ...existing, pointsDelta: BigInt(21) });
  await expect(appendPointsLedgerEntryWithReceipt(params)).rejects.toThrow(
    "idempotency conflict",
  );
});
