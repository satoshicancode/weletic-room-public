import { enrollHistoricalImportAccountInTransaction } from "@/lib/weletic/loyalty/historical-import-enrollment";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ read: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/historical-import-commit-row", () => ({
  readHistoricalImportCommitRowInTransaction: mocks.read,
}));
const account = {
  id: "account",
  storeId: "store",
  programId: "program",
  shopperId: "shopper",
  status: "active",
  ledgerVersion: 0,
  cachedPointsBalance: BigInt(0),
  cachedPendingPoints: BigInt(0),
  lifetimePointsEarned: BigInt(0),
  lifetimePointsRedeemed: BigInt(0),
};
const lease = { sourceId: "source" };
const validatedRow = {
  lease: { ...lease, storeId: "store", programId: "program" },
  shopper: { id: "shopper" },
  account: null,
  row: { openingBalance: "9007199254740993" },
  balanceAfter: BigInt("9007199254740993"),
};
// No earn, referral, tier, outbox or ledger delegates: this step cannot use them.
const tx = {
  weleticLoyaltyAccount: { create: mocks.create },
} as unknown as Prisma.TransactionClient;
const run = () =>
  enrollHistoricalImportAccountInTransaction({ tx, lease, snapshotId: "row" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(validatedRow);
  mocks.create.mockResolvedValue(account);
});

it("creates a zero-balance account only after locked eligibility validation", async () => {
  const result = await run();
  expect(mocks.read).toHaveBeenCalledWith({ tx, lease, snapshotId: "row" });
  expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.create.mock.invocationCallOrder[0],
  );
  expect(mocks.create).toHaveBeenCalledExactlyOnceWith({
    data: { ...account, id: expect.stringMatching(/^wacc_/) },
  });
  expect(result).toEqual({ ...validatedRow, account, accountCreated: true });
  expect(result.balanceAfter.toString()).toBe("9007199254740993");
});

it("reuses the validated existing account without signup rewards or updates", async () => {
  const existing = {
    ...account,
    ledgerVersion: 4,
    cachedPointsBalance: BigInt(8),
  };
  mocks.read.mockResolvedValue({ ...validatedRow, account: existing });
  const result = await run();
  expect(result.account).toBe(existing);
  expect(result.accountCreated).toBe(false);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("propagates stale lease or privacy conflicts before enrollment", async () => {
  const error = new Error("row unavailable");
  mocks.read.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
  expect(mocks.create).not.toHaveBeenCalled();
});

it("propagates a concurrent unique-account conflict instead of adopting it", async () => {
  const error = new Error("unique shopper constraint");
  mocks.create.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
  expect(mocks.create).toHaveBeenCalledTimes(1);
});

it.each([
  { storeId: "foreign" },
  { programId: "foreign" },
  { shopperId: "foreign" },
  { status: "closed" },
  { ledgerVersion: 1 },
  { cachedPointsBalance: BigInt(1) },
  { cachedPendingPoints: BigInt(1) },
  { lifetimePointsEarned: BigInt(1) },
  { lifetimePointsRedeemed: BigInt(1) },
])(
  "rejects unexpected created state case %# so the caller rolls back",
  async (change) => {
    mocks.create.mockResolvedValue({ ...account, ...change });
    await expect(run()).rejects.toThrow("state changed");
  },
);
