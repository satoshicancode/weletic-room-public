import { captureHistoricalImportFields } from "@/lib/weletic/loyalty/historical-import-fields";
import { HistoricalImportRollbackContainedError } from "@/lib/weletic/loyalty/historical-import-ledger";
import { prepareHistoricalImportFieldRollback } from "@/lib/weletic/loyalty/historical-import-rollback-fields";
import {
  Prisma,
  type WeleticLoyaltyAccount,
  type WeleticLoyaltyImportRowExecution,
} from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
const raw = vi.fn();
const tier = vi.fn();
const tx = {
  $queryRaw: raw,
  weleticLoyaltyTier: { findFirst: tier },
} as unknown as Prisma.TransactionClient;
const now = new Date("2026-09-09T00:00:00Z");
let account: WeleticLoyaltyAccount;
let execution: WeleticLoyaltyImportRowExecution;
const run = () =>
  prepareHistoricalImportFieldRollback({
    tx,
    account,
    execution,
    installationGeneration: "g1",
  });
beforeEach(() => {
  vi.resetAllMocks();
  account = {
    id: "account",
    storeId: "store",
    programId: "program",
    metadata: { unrelated: "current" },
    currentTierId: null,
    tierExpiresAt: null,
    lastQualifyingActivityAt: null,
    nextExpiryDate: null,
    pointsExpiryPolicyVersion: 0,
    pointsExpiryJobsScheduledAt: null,
    ledgerVersion: 1,
  } as unknown as WeleticLoyaltyAccount;
  execution = {
    id: "execution",
    sourceId: "source",
    snapshotId: "snapshot",
    storeId: "store",
    programId: "program",
    accountId: "account",
    status: "committed",
    ledgerVersionAfter: 1,
    committedAt: now,
    fieldStateBefore: captureHistoricalImportFields(account),
    fieldStateAfter: captureHistoricalImportFields(account),
  } as unknown as WeleticLoyaltyImportRowExecution;
  raw.mockResolvedValue([]);
  tier.mockResolvedValue({ id: "old-tier" });
});
it("preserves unrelated current metadata and avoids invented side effects", async () => {
  expect(await run()).toMatchObject({
    patch: { metadata: { unrelated: "current" }, currentTierId: null },
    tierTransition: null,
    birthdayJobId: null,
  });
});
it.each([
  { accountId: "foreign" },
  { storeId: "foreign" },
  { programId: "foreign" },
  { status: "rolled_back" },
  { ledgerVersionAfter: 2 },
  { fieldStateAfter: {} },
])("contains invalid execution/field ownership %j", async (changed) => {
  Object.assign(execution, changed);
  await expect(run()).rejects.toBeInstanceOf(
    HistoricalImportRollbackContainedError,
  );
});
it("contains later field changes before reading jobs or tier history", async () => {
  account.tierExpiresAt = now;
  await expect(run()).rejects.toBeInstanceOf(
    HistoricalImportRollbackContainedError,
  );
  expect(raw).not.toHaveBeenCalled();
});
function setImportedTier() {
  account.currentTierId = "imported-tier";
  execution.fieldStateAfter = captureHistoricalImportFields(account);
  const history = {
    accountId: account.id,
    sequenceNumber: 1,
    fromTierId: null,
    toTierId: "imported-tier",
    changeReason: "manual_override",
    notes: "Historical import source, row snapshot",
    effectiveAt: now,
  };
  raw.mockResolvedValue([history]);
  return history;
}
it("plans append-only restoration to actual no-tier", async () => {
  setImportedTier();
  expect(await run()).toMatchObject({
    patch: { currentTierId: null },
    tierTransition: {
      fromTierId: "imported-tier",
      toTierId: null,
      sequenceNumber: 2,
    },
  });
});
it("restores an original tier only when it still belongs to this program and is not deleted", async () => {
  const history = setImportedTier();
  execution.fieldStateBefore = captureHistoricalImportFields({
    ...account,
    currentTierId: "old-tier",
  });
  Object.assign(history, { fromTierId: "old-tier" });
  expect(await run()).toMatchObject({
    tierTransition: {
      fromTierId: "imported-tier",
      toTierId: "old-tier",
      sequenceNumber: 2,
    },
  });
  expect(tier).toHaveBeenCalledWith({
    where: { id: "old-tier", programId: "program", deletedAt: null },
    select: { id: true },
  });
  tier.mockResolvedValue(null);
  await expect(run()).rejects.toBeInstanceOf(
    HistoricalImportRollbackContainedError,
  );
});
it.each([
  { notes: "later admin change" },
  { sequenceNumber: null },
  { sequenceNumber: 2147483647 },
  { fromTierId: "other" },
  { toTierId: "other" },
  { effectiveAt: new Date(0) },
])("contains altered or unsequenced tier provenance %j", async (changed) => {
  const history = setImportedTier();
  Object.assign(history, changed);
  await expect(run()).rejects.toBeInstanceOf(
    HistoricalImportRollbackContainedError,
  );
});
it("contains later A-to-B-to-A tier activity even if current tier matches", async () => {
  raw.mockResolvedValue([
    { accountId: account.id, sequenceNumber: 2, effectiveAt: now },
  ]);
  await expect(run()).rejects.toBeInstanceOf(
    HistoricalImportRollbackContainedError,
  );
});
function setBirthdayJob() {
  const birthday = {
    birthDate: "2000-01-15",
    registeredAt: now.toISOString(),
    nextEligibleYear: 2027,
  };
  account.metadata = { unrelated: "current", birthday };
  execution.fieldStateAfter = captureHistoricalImportFields(account);
  const job = {
    id: "birthday-job",
    storeId: "store",
    idempotencyKey: "birthday_reward:account:2027",
    jobType: "BIRTHDAY_REWARD",
    status: "pending",
    lockedAt: null,
    lockedBy: null,
    payload: {
      accountId: "account",
      birthDate: birthday.birthDate,
      registeredAt: birthday.registeredAt,
      calendarYear: 2027,
      installationGeneration: "g1",
    },
  };
  raw.mockImplementation(async (query: Prisma.Sql) =>
    query.sql.includes("WeleticLoyaltyOutboxJob") ? [job] : [],
  );
  return job;
}
it("selects only the owned unclaimed birthday job for cancellation", async () => {
  setBirthdayJob();
  expect(await run()).toMatchObject({
    birthdayJobId: "birthday-job",
    patch: { metadata: { unrelated: "current" } },
  });
});
it.each([
  { status: "processing" },
  { status: "completed" },
  { lockedBy: "worker" },
  { lockedAt: now },
  { storeId: "foreign" },
  { payload: {} },
])("contains changed birthday job ownership %j", async (changed) => {
  Object.assign(setBirthdayJob(), changed);
  await expect(run()).rejects.toBeInstanceOf(
    HistoricalImportRollbackContainedError,
  );
});
it("does not re-cancel an already cancelled owned birthday job", async () => {
  setBirthdayJob().status = "cancelled";
  expect(await run()).toMatchObject({ birthdayJobId: null });
});
