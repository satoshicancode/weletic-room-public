import { applyHistoricalImportFieldsInTransaction } from "@/lib/weletic/loyalty/historical-import-apply-fields";
import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  enqueue: vi.fn(),
  update: vi.fn(),
  history: vi.fn(),
  raw: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/historical-import-commit-row", () => ({
  readHistoricalImportCommitRowInTransaction: mocks.read,
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: mocks.enqueue,
}));
const account = {
  id: "account",
  storeId: "store",
  programId: "program",
  shopperId: "shopper",
  ledgerVersion: 4,
  metadata: { unrelated: "preserved" },
  currentTierId: null,
  tierExpiresAt: null,
  lastQualifyingActivityAt: null,
  nextExpiryDate: null,
  pointsExpiryPolicyVersion: 0,
  pointsExpiryJobsScheduledAt: null,
  tierSpendRolling12Months: BigInt(123),
  tierPointsRolling12Months: BigInt(456),
};
const now = new Date("2026-09-09T00:00:00.000Z");
const lease = { storeId: "store", programId: "program", sourceId: "source" };
const base = {
  account,
  lease,
  now,
  row: {},
  snapshot: { id: "snapshot" },
  shopper: { id: "shopper" },
  birthday: { metadata: account.metadata, schedule: null },
};
const schedule = {
  birthDate: "2000-02-29",
  registeredAt: now.toISOString(),
  calendarYear: 2027,
  scheduledFor: new Date("2027-02-28T00:00:00.000Z"),
};
const birthday = {
  metadata: {
    ...account.metadata,
    birthday: {
      birthDate: schedule.birthDate,
      registeredAt: schedule.registeredAt,
      nextEligibleYear: 2027,
    },
  },
  schedule,
};
const tx = {
  $queryRaw: mocks.raw,
  weleticLoyaltyAccount: { updateMany: mocks.update },
  weleticLoyaltyTierHistory: { create: mocks.history },
} as unknown as Prisma.TransactionClient;
const run = () =>
  applyHistoricalImportFieldsInTransaction({
    tx,
    lease,
    snapshotId: "snapshot",
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockResolvedValue(base);
  mocks.raw.mockResolvedValue([]);
  mocks.update.mockResolvedValue({ count: 1 });
  mocks.enqueue.mockResolvedValue({ created: true });
});
it("preserves fields and existing schedules when nothing changes", async () => {
  const result = await run();
  expect(result.before).toEqual(result.afterFields);
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.history).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("records imported tier placement without threshold rewards or counter changes", async () => {
  mocks.read.mockResolvedValue({ ...base, row: { tierId: "tier" } });
  mocks.raw.mockResolvedValue([{ sequenceNumber: 3 }]);
  const result = await run();
  expect(result.before.currentTierId).toBeNull();
  expect(result.afterFields.currentTierId).toBe("tier");
  expect(mocks.update.mock.calls[0][0]).toEqual({
    where: {
      id: "account",
      storeId: "store",
      programId: "program",
      shopperId: "shopper",
      status: "active",
      ledgerVersion: 4,
    },
    data: { currentTierId: "tier", tierExpiresAt: null },
  });
  expect(mocks.history.mock.calls[0][0].data).toMatchObject({
    sequenceNumber: 4,
    fromTierId: null,
    toTierId: "tier",
    changeReason: "manual_override",
    effectiveAt: now,
    qualifyingSpendSnapshot: BigInt(123),
    qualifyingPointsSnapshot: BigInt(456),
  });
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.raw.mock.calls[0][0].sql).toContain("FOR UPDATE");
});
it("does not reset grace or emit history when the imported tier is unchanged", async () => {
  const tierExpiresAt = new Date("2026-12-01");
  mocks.read.mockResolvedValue({
    ...base,
    account: { ...account, currentTierId: "tier", tierExpiresAt },
    row: { tierId: "tier" },
  });
  const result = await run();
  expect(result.afterFields.tierExpiresAt).toBe(tierExpiresAt.toISOString());
  expect(mocks.update).not.toHaveBeenCalled();
  expect(mocks.raw).not.toHaveBeenCalled();
});
it("schedules a newly registered birthday in the same transaction and preserves metadata", async () => {
  mocks.read.mockResolvedValue({ ...base, birthday });
  const result = await run();
  expect(result.before.birthday).toEqual({ present: false });
  expect(result.afterFields.birthday).toEqual({
    present: true,
    value: birthday.metadata.birthday,
  });
  expect(mocks.update.mock.calls[0][0].data).toEqual({
    metadata: birthday.metadata,
  });
  expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith({
    tx,
    storeId: "store",
    jobType: "BIRTHDAY_REWARD",
    payload: {
      accountId: "account",
      birthDate: schedule.birthDate,
      registeredAt: schedule.registeredAt,
      calendarYear: 2027,
    },
    scheduledFor: schedule.scheduledFor,
    idempotencyKey: "birthday_reward:account:2027",
  });
});
it.each([null, 0, -1, 1.5, 2147483647])(
  "rejects unusable history sequence %s before mutations",
  async (sequenceNumber) => {
    mocks.read.mockResolvedValue({ ...base, row: { tierId: "tier" } });
    mocks.raw.mockResolvedValue([{ sequenceNumber }]);
    await expect(run()).rejects.toThrow("state changed");
    expect(mocks.update).not.toHaveBeenCalled();
  },
);
it("requires prior enrollment", async () => {
  mocks.read.mockResolvedValue({ ...base, account: null });
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.update).not.toHaveBeenCalled();
});
it.each(["cancelled", "completed", "pending"])(
  "rejects an existing %s annual job instead of adopting a prior registration",
  async (status) => {
    mocks.read.mockResolvedValue({ ...base, birthday });
    mocks.enqueue.mockResolvedValue({
      created: false,
      job: { status, payload: { registeredAt: "2025-01-01T00:00:00.000Z" } },
    });
    await expect(run()).rejects.toThrow("state changed");
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  },
);
it("propagates update and enqueue failures to abort the caller transaction", async () => {
  mocks.read.mockResolvedValue({ ...base, birthday });
  mocks.update.mockResolvedValue({ count: 0 });
  await expect(run()).rejects.toThrow("state changed");
  expect(mocks.enqueue).not.toHaveBeenCalled();
  mocks.update.mockResolvedValue({ count: 1 });
  const error = new Error("outbox unavailable");
  mocks.enqueue.mockRejectedValue(error);
  await expect(run()).rejects.toBe(error);
});
