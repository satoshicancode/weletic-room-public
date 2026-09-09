import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { prisma as database } from "../../lib/prisma";
import { processHistoricalImportCommitBatch } from "../../lib/weletic/loyalty/historical-import-commit-batch";
import { continueHistoricalImportCommit } from "../../lib/weletic/loyalty/historical-import-continuation";
import {
  queueHistoricalImportCommitInTransaction,
  queueHistoricalImportRollbackInTransaction,
} from "../../lib/weletic/loyalty/historical-import-dispatch";
import {
  assertHistoricalImportExecutionLeaseInTransaction,
  claimHistoricalImportExecutionLeaseInTransaction,
} from "../../lib/weletic/loyalty/historical-import-execution-lease";
import { finalizeHistoricalImportExecution } from "../../lib/weletic/loyalty/historical-import-finalization";
import {
  HistoricalImportConflictError,
  historicalImportRevision,
  inspectHistoricalImportSourceInTransaction,
  stageHistoricalImportInTransaction,
} from "../../lib/weletic/loyalty/historical-import-persistence";
import { readHistoricalImportExecutionProofInTransaction } from "../../lib/weletic/loyalty/historical-import-reconciliation-service";
import {
  recoverHistoricalImportCommit,
  recoverHistoricalImportCommitFromOutbox,
} from "../../lib/weletic/loyalty/historical-import-recovery";
import { rollbackHistoricalImportRow } from "../../lib/weletic/loyalty/historical-import-rollback-row";
import { executeHistoricalImportRow } from "../../lib/weletic/loyalty/historical-import-row-execution";
import { proveHistoricalImportRows } from "../../lib/weletic/loyalty/historical-import-source";
import { appendPointsLedgerEntry } from "../../lib/weletic/loyalty/ledger";
import { processOutboxJobsBatch } from "../../lib/weletic/loyalty/outbox-worker";

const finalInsertFailure = vi.hoisted(() => ({
  duplicateId: null as string | null,
  reached: false,
}));
vi.mock("@/lib/weletic/ids", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/weletic/ids")>();
  return {
    ...actual,
    createWeleticId: (...args: Parameters<typeof actual.createWeleticId>) => {
      if (args[0] === "wlimpr_" && finalInsertFailure.duplicateId) {
        finalInsertFailure.reached = true;
        return finalInsertFailure.duplicateId;
      }
      return actual.createWeleticId(...args);
    },
  };
});

// Separate opt-in suite. It NEVER creates or applies a database schema.
const stores: string[] = [];
let safeToClean = false;
const options = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: 20_000,
};
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (
    process.env.HISTORICAL_IMPORT_SOURCE_DATABASE_INTEGRATION !== "1" ||
    url.protocol !== "mysql:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "3307" ||
    url.username !== "loyalty_dev" ||
    url.pathname !== "/weletic_loyalty_dev"
  )
    throw new Error("Refusing non-isolated import source database");
  expect(
    await database.$queryRaw`SELECT DATABASE() AS name, CURRENT_USER() AS principal`,
  ).toEqual([{ name: "weletic_loyalty_dev", principal: "loyalty_dev@%" }]);
  const tables = await database.$queryRaw<Array<{ name: string }>>`
    SELECT TABLE_NAME AS name FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN
      ('WeleticLoyaltyImportSource', 'WeleticLoyaltyImportRowSnapshot', 'WeleticLoyaltyImportRowExecution')
  `;
  expect(tables.map(({ name }) => name).sort()).toEqual([
    "WeleticLoyaltyImportRowExecution",
    "WeleticLoyaltyImportRowSnapshot",
    "WeleticLoyaltyImportSource",
  ]);
  safeToClean = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External network forbidden in source DB tests");
    }),
  );
});
afterAll(async () => {
  if (safeToClean && stores.length) {
    const where = { storeId: { in: stores } };
    await database.weleticLoyaltyImportRowExecution.deleteMany({ where });
    await database.weleticLoyaltyImportRowSnapshot.deleteMany({ where });
    await database.weleticLoyaltyImportSource.deleteMany({ where });
    await database.weleticLoyaltyOutboxJob.deleteMany({ where });
    await database.weleticPointsLedgerEntry.deleteMany({ where });
    await database.weleticLoyaltyEarnGrant.deleteMany({ where });
    const accounts = await database.weleticLoyaltyAccount.findMany({
      where,
      select: { id: true },
    });
    await database.weleticLoyaltyTierHistory.deleteMany({
      where: { accountId: { in: accounts.map(({ id }) => id) } },
    });
    await database.weleticLoyaltyAccount.deleteMany({ where });
    await database.weleticShopper.deleteMany({ where });
    await database.weleticLoyaltyTier.deleteMany({
      where: {
        programId: { in: stores.map((storeId) => `program-${storeId}`) },
      },
    });
    await database.weleticLoyaltyProgram.deleteMany({ where });
    await database.weleticShopifyStore.deleteMany({
      where: { id: { in: stores } },
    });
  }
  vi.unstubAllGlobals();
  await database.$disconnect();
});
async function seedStore() {
  const storeId = `import-source-db-${randomUUID()}`;
  stores.push(storeId);
  const programId = `program-${storeId}`;
  await database.weleticShopifyStore.create({
    data: {
      id: storeId,
      projectId: `workspace-${storeId}`,
      programId: `affiliate-${storeId}`,
      shopDomain: `${storeId}.myshopify.com`,
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date(),
      apiVersion: "2026-07",
      installationGeneration: "g1",
    },
  });
  await database.weleticLoyaltyProgram.create({
    data: {
      id: programId,
      storeId,
      name: "Isolated source test",
      status: "active",
      killSwitchActive: false,
    },
  });
  return { storeId, programId };
}
async function seed(withBirthday = false, rowCount = 1, withTier = false) {
  const { storeId, programId } = await seedStore();
  const tierId = withTier ? `tier-imported-${storeId}` : null;
  if (tierId)
    await database.weleticLoyaltyTier.create({
      data: {
        id: tierId,
        programId,
        name: "Imported tier",
        slug: "imported",
        tierOrder: 1,
        entryBonusPoints: BigInt(100),
      },
    });
  const proof = proveHistoricalImportRows(
    Array.from({ length: rowCount }, (_, index) => ({
      shopifyCustomerId: `gid://shopify/Customer/${123 + index}`,
      openingBalance: "9007199254740993",
      ...(tierId ? { tierId } : {}),
      ...(withBirthday ? { birthday: { month: 1, day: 15 } } : {}),
    })),
  );
  const source = await database.weleticLoyaltyImportSource.create({
    data: {
      id: `source-${storeId}`,
      storeId,
      programId,
      installationGeneration: "g1",
      sourceSha256: "a".repeat(64),
      normalizedSha256: proof.normalizedSha256,
      sourceFormat: "json",
      rowCount,
      totalOpeningBalance: proof.totalOpeningBalance,
      createdByStaffId: "isolated-fixture-staff",
    },
  });
  const snapshot = await database.weleticLoyaltyImportRowSnapshot.create({
    data: {
      id: `snapshot-${storeId}`,
      sourceId: source.id,
      storeId,
      programId,
      rowNumber: 1,
      shopifyCustomerId: "gid://shopify/Customer/123",
      openingBalance: BigInt("9007199254740993"),
      tierId,
      ...(withBirthday ? { birthdayMonth: 1, birthdayDay: 15 } : {}),
    },
  });
  for (let offset = 1; offset < rowCount; offset += 1000)
    await database.weleticLoyaltyImportRowSnapshot.createMany({
      data: Array.from(
        { length: Math.min(1000, rowCount - offset) },
        (_, index) => ({
          id: `snapshot-${offset + index + 1}-${storeId}`,
          sourceId: source.id,
          storeId,
          programId,
          rowNumber: offset + index + 1,
          shopifyCustomerId: `gid://shopify/Customer/${123 + offset + index}`,
          openingBalance: BigInt("9007199254740993"),
          tierId,
          ...(withBirthday ? { birthdayMonth: 1, birthdayDay: 15 } : {}),
        }),
      ),
    });
  const request = {
    sourceId: source.id,
    storeId,
    programId,
    installationGeneration: "g1",
    phase: "committing" as const,
    expectedRevision: historicalImportRevision({
      storeId,
      programId,
      installationGeneration: "g1",
      normalizedSha256: source.normalizedSha256,
      source,
    }),
  };
  return { source, snapshot, request };
}
it.skipIf(process.env.HISTORICAL_IMPORT_LARGE_SOURCE_INTEGRATION !== "1")(
  "verifies and claims a real 50,000-row pending manifest without fabricating ledger history",
  async () => {
    const fixture = await seed(false, 50_000);
    const started = performance.now();
    const claimed = await database.$transaction(
      (tx) =>
        claimHistoricalImportExecutionLeaseInTransaction({
          tx,
          request: fixture.request,
        }),
      { ...options, timeout: 30_000 },
    );
    const claimMs = performance.now() - started;
    expect(claimed.lease.phase).toBe("committing");
    const proofStarted = performance.now();
    const proof = await database.$transaction(
      (tx) =>
        readHistoricalImportExecutionProofInTransaction({
          tx,
          sourceId: fixture.source.id,
          storeId: fixture.source.storeId,
          programId: fixture.source.programId,
        }),
      { ...options, timeout: 30_000 },
    );
    expect(proof.rowStates).toEqual(["pending"]);
    expect(proof.summary).toMatchObject({
      rowCount: 50_000,
      reconciled: true,
      fullyCommitted: false,
      observedNetPoints: "0",
      importedPoints: "0",
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: fixture.source.storeId },
      }),
    ).toBe(0);
    console.log(
      JSON.stringify({
        event: "isolated_pending_manifest_load",
        rows: 50_000,
        claimMs: Math.round(claimMs),
        proofMs: Math.round(performance.now() - proofStarted),
      }),
    );
  },
  60_000,
);
async function seedExecutableRow(withBirthday = false, withTier = false) {
  const fixture = await seed(withBirthday, 1, withTier);
  const shopper = await database.weleticShopper.create({
    data: {
      id: `shopper-${fixture.source.storeId}`,
      storeId: fixture.source.storeId,
      shopifyCustomerId: "123",
    },
  });
  const claimed = await database.$transaction(
    (tx) =>
      claimHistoricalImportExecutionLeaseInTransaction({
        tx,
        request: fixture.request,
      }),
    options,
  );
  return { ...fixture, shopper, lease: claimed.lease };
}

async function rollbackFixture(withFields = false) {
  const fixture = await seedExecutableRow(withFields, withFields);
  await executeHistoricalImportRow({
    lease: fixture.lease,
    snapshotId: fixture.snapshot.id,
  });
  await finalizeHistoricalImportExecution({ lease: fixture.lease });
  const source = await database.weleticLoyaltyImportSource.findUniqueOrThrow({
    where: { id: fixture.source.id },
  });
  const claimed = await database.$transaction(
    (tx) =>
      claimHistoricalImportExecutionLeaseInTransaction({
        tx,
        request: {
          ...fixture.request,
          phase: "rolling_back",
          expectedRevision: historicalImportRevision({
            storeId: source.storeId,
            programId: source.programId,
            installationGeneration: source.installationGeneration,
            normalizedSha256: source.normalizedSha256,
            source,
          }),
        },
      }),
    options,
  );
  const execution =
    await database.weleticLoyaltyImportRowExecution.findFirstOrThrow({
      where: { sourceId: source.id },
    });
  return { ...fixture, source, execution, lease: claimed.lease };
}
it("atomically reverses the opening entry, birthday job and tier placement back to true no-tier", async () => {
  const fixture = await rollbackFixture(true);
  const result = await rollbackHistoricalImportRow({
    lease: fixture.lease,
    snapshotId: fixture.snapshot.id,
  });
  expect(result).toMatchObject({ contained: false, replayed: false });
  const account = await database.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: fixture.execution.accountId },
  });
  expect(account).toMatchObject({
    cachedPointsBalance: BigInt(0),
    ledgerVersion: 2,
    currentTierId: null,
    lastQualifyingActivityAt: null,
  });
  expect(account.metadata).toBeNull();
  const entries = await database.weleticPointsLedgerEntry.findMany({
    where: { accountId: account.id },
    orderBy: { sequenceNumber: "asc" },
  });
  expect(entries.map((entry) => entry.pointsDelta)).toEqual([
    BigInt("9007199254740993"),
    -BigInt("9007199254740993"),
  ]);
  const history = await database.weleticLoyaltyTierHistory.findMany({
    where: { accountId: account.id },
    orderBy: { sequenceNumber: "asc" },
  });
  expect(history).toHaveLength(2);
  expect(history[1]).toMatchObject({
    fromTierId: fixture.snapshot.tierId,
    toTierId: null,
    sequenceNumber: 2,
    changeReason: "manual_override",
  });
  expect(
    await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId: fixture.source.storeId, jobType: "BIRTHDAY_REWARD" },
    }),
  ).toMatchObject({ status: "cancelled" });
  await expect(
    rollbackHistoricalImportRow({
      lease: fixture.lease,
      snapshotId: fixture.snapshot.id,
    }),
  ).resolves.toMatchObject({ replayed: true, contained: false });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { accountId: account.id },
    }),
  ).toBe(2);
  await expect(
    finalizeHistoricalImportExecution({ lease: fixture.lease }),
  ).resolves.toEqual({ finalized: true, status: "rolled_back" });
});
it("serializes competing rollback deliveries into one correction and one replay", async () => {
  const fixture = await rollbackFixture(true);
  const outcomes = await Promise.allSettled([
    rollbackHistoricalImportRow({
      lease: fixture.lease,
      snapshotId: fixture.snapshot.id,
    }),
    rollbackHistoricalImportRow({
      lease: fixture.lease,
      snapshotId: fixture.snapshot.id,
    }),
  ]);
  expect(outcomes.every((result) => result.status === "fulfilled")).toBe(true);
  const results = outcomes.map(
    (result) =>
      (
        result as PromiseFulfilledResult<
          Awaited<ReturnType<typeof rollbackHistoricalImportRow>>
        >
      ).value,
  );
  expect(results.filter((result) => result.replayed)).toHaveLength(1);
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { accountId: fixture.execution.accountId },
    }),
  ).toBe(2);
  expect(
    await database.weleticLoyaltyTierHistory.count({
      where: { accountId: fixture.execution.accountId },
    }),
  ).toBe(2);
});
it("contains an owned birthday job already claimed by another worker without cancelling it", async () => {
  const fixture = await rollbackFixture(true);
  const job = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
    where: { storeId: fixture.source.storeId, jobType: "BIRTHDAY_REWARD" },
  });
  const claimed = await database.weleticLoyaltyOutboxJob.update({
    where: { id: job.id },
    data: {
      status: "processing",
      lockedAt: new Date(),
      lockedBy: "birthday-worker",
      attempts: 1,
    },
  });
  await expect(
    rollbackHistoricalImportRow({
      lease: fixture.lease,
      snapshotId: fixture.snapshot.id,
    }),
  ).resolves.toMatchObject({ contained: true });
  expect(
    await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id: job.id },
    }),
  ).toEqual(claimed);
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { accountId: fixture.execution.accountId },
    }),
  ).toBe(1);
  expect(
    await database.weleticLoyaltyTierHistory.count({
      where: { accountId: fixture.execution.accountId },
    }),
  ).toBe(1);
});

it("contains later ledger activity without reversing it or altering the opening entry", async () => {
  const fixture = await rollbackFixture();
  await appendPointsLedgerEntry({
    storeId: fixture.source.storeId,
    accountId: fixture.execution.accountId,
    entryType: "MANUAL_ADJUSTMENT",
    pointsDelta: 1,
    pendingDelta: 0,
    idempotencyKey: `later-${fixture.source.id}`,
  });
  await expect(
    rollbackHistoricalImportRow({
      lease: fixture.lease,
      snapshotId: fixture.snapshot.id,
    }),
  ).resolves.toMatchObject({ contained: true });
  expect(
    await database.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: fixture.execution.accountId },
    }),
  ).toMatchObject({
    cachedPointsBalance: BigInt("9007199254740994"),
    ledgerVersion: 2,
  });
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: fixture.source.id },
    }),
  ).toMatchObject({ status: "contained", leaseId: null });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { accountId: fixture.execution.accountId },
    }),
  ).toBe(2);
  expect(
    await database.weleticLoyaltyImportRowExecution.findUniqueOrThrow({
      where: { id: fixture.execution.id },
    }),
  ).toMatchObject({ status: "contained", reversalLedgerEntryId: null });
});
it("aborts financial and field rollback when append-only tier-history insertion fails", async () => {
  const fixture = await rollbackFixture(true);
  const accountBefore = await database.weleticLoyaltyAccount.findUniqueOrThrow({
    where: { id: fixture.execution.accountId },
  });
  const existingHistory =
    await database.weleticLoyaltyTierHistory.findFirstOrThrow({
      where: { accountId: accountBefore.id },
    });
  const idModule = await import("../../lib/weletic/ids");
  const original = idModule.createWeleticId;
  const collision = vi
    .spyOn(idModule, "createWeleticId")
    .mockImplementation((prefix) =>
      prefix === "wtier_" ? existingHistory.id : original(prefix),
    );
  try {
    await expect(
      rollbackHistoricalImportRow({
        lease: fixture.lease,
        snapshotId: fixture.snapshot.id,
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  } finally {
    collision.mockRestore();
  }
  expect(
    await database.weleticLoyaltyAccount.findUniqueOrThrow({
      where: { id: accountBefore.id },
    }),
  ).toEqual(accountBefore);
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { accountId: accountBefore.id },
    }),
  ).toBe(1);
  expect(
    await database.weleticLoyaltyImportRowExecution.findUniqueOrThrow({
      where: { id: fixture.execution.id },
    }),
  ).toEqual(fixture.execution);
  expect(
    await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
      where: { storeId: fixture.source.storeId, jobType: "BIRTHDAY_REWARD" },
    }),
  ).toMatchObject({ status: "pending" });
  await expect(
    rollbackHistoricalImportRow({
      lease: fixture.lease,
      snapshotId: fixture.snapshot.id,
    }),
  ).resolves.toMatchObject({ contained: false });
});

async function uploadFixture() {
  const { storeId, programId } = await seedStore();
  await database.weleticShopper.create({
    data: {
      id: `shopper-${storeId}`,
      storeId,
      shopifyCustomerId: "123",
    },
  });
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      {
        shopifyCustomerId: "gid://shopify/Customer/123",
        openingBalance: "9007199254740993",
        birthday: { month: 2, day: 29 },
      },
    ]),
  );
  const source = {
    format: "json" as const,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  // Exercise the real inspection service, not a manufactured revision.
  const preview = await database.$transaction(
    (tx) =>
      inspectHistoricalImportSourceInTransaction({
        tx,
        storeId,
        installationGeneration: "g1",
        bytes,
        request: {
          operation: "inspect",
          expectedInstallationGeneration: "g1",
          source,
        },
      }),
    options,
  );
  expect(preview.valid).toBe(true);
  expect(
    await database.weleticLoyaltyImportSource.count({ where: { storeId } }),
  ).toBe(0);
  const stage = () =>
    database.$transaction(
      (tx) =>
        stageHistoricalImportInTransaction({
          tx,
          storeId,
          installationGeneration: "g1",
          staffId: "isolated-fixture-staff",
          bytes,
          request: {
            operation: "stage",
            expectedInstallationGeneration: "g1",
            expectedRevision: preview.revision,
            source,
          },
        }),
      options,
    );
  return { storeId, programId, source, stage };
}

async function queuedWorkerFixture(rowCount = 1, withFields = false) {
  const fixture = await seed(withFields, rowCount, withFields);
  const { source, request } = fixture;
  await database.weleticShopper.create({
    data: {
      id: `shopper-${source.storeId}`,
      storeId: source.storeId,
      shopifyCustomerId: "123",
    },
  });
  if (rowCount > 1)
    await database.weleticShopper.createMany({
      data: Array.from({ length: rowCount - 1 }, (_, index) => ({
        id: `shopper-${index + 2}-${source.storeId}`,
        storeId: source.storeId,
        shopifyCustomerId: String(124 + index),
      })),
    });
  await database.$transaction(
    (tx) => queueHistoricalImportCommitInTransaction({ tx, request }),
    options,
  );
  const job = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
    where: { storeId: source.storeId },
  });
  const claimedAt = new Date();
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: job.id },
    data: {
      status: "processing",
      lockedBy: "isolated-owner",
      lockedAt: claimedAt,
      attempts: 1,
    },
  });
  // Advance only this disposable fixture's source expiry, never the database
  // clock or worker's notion of time. This is claim-fence proof, not scheduler proof.
  await database.weleticLoyaltyImportSource.update({
    where: { id: source.id },
    data: { leaseExpiresAt: new Date(0) },
  });
  const scope = {
    storeId: source.storeId,
    programId: source.programId,
    sourceId: source.id,
    installationGeneration: "g1",
  };
  const claim = {
    jobId: job.id,
    ownerToken: "isolated-owner",
    claimedAt,
    attempt: 1,
    sourceRevision: 1,
  };
  return { ...fixture, job, scope, claim };
}
async function releaseFixtureJobToRealWorker(jobId: string) {
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: jobId },
    data: {
      status: "pending",
      scheduledFor: new Date(0),
      lockedAt: null,
      lockedBy: null,
      attempts: 0,
    },
  });
}
async function queuedRollbackWorkerFixture(rowCount = 1, withFields = false) {
  const fixture = await queuedWorkerFixture(rowCount, withFields);
  await releaseFixtureJobToRealWorker(fixture.job.id);
  const runCommit = () =>
    processOutboxJobsBatch({
      storeId: fixture.source.storeId,
      jobIds: [fixture.job.id],
    });
  const first = await runCommit();
  if (first.succeeded !== 1)
    expect(await runCommit()).toMatchObject({ succeeded: 1 });
  const source = await database.weleticLoyaltyImportSource.findUniqueOrThrow({
    where: { id: fixture.source.id },
  });
  const request = {
    sourceId: source.id,
    storeId: source.storeId,
    programId: source.programId,
    installationGeneration: source.installationGeneration,
    expectedRevision: historicalImportRevision({
      storeId: source.storeId,
      programId: source.programId,
      installationGeneration: source.installationGeneration,
      normalizedSha256: source.normalizedSha256,
      source,
    }),
  };
  await database.$transaction(
    (tx) => queueHistoricalImportRollbackInTransaction({ tx, request }),
    options,
  );
  const job = await database.weleticLoyaltyOutboxJob.findFirstOrThrow({
    where: { storeId: source.storeId, jobType: "HISTORICAL_IMPORT_ROLLBACK" },
  });
  await database.weleticLoyaltyImportSource.update({
    where: { id: source.id },
    data: { leaseExpiresAt: new Date(0) },
  });
  await releaseFixtureJobToRealWorker(job.id);
  const run = () =>
    processOutboxJobsBatch({
      storeId: source.storeId,
      jobIds: [job.id],
      workerId: "isolated-rollback-worker",
    });
  return { ...fixture, source, job, run };
}
it.skipIf(process.env.HISTORICAL_IMPORT_WORKER_LOAD_INTEGRATION !== "1")(
  "commits and rolls back 500 real rows across durable worker continuations",
  async () => {
    const fixture = await queuedWorkerFixture(500);
    await releaseFixtureJobToRealWorker(fixture.job.id);
    const runPhase = async (
      jobId: string,
      terminal: "committed" | "rolled_back",
    ) => {
      const started = performance.now();
      const batchTimes: number[] = [];
      for (let batch = 0; batch <= 10; batch++) {
        const batchStarted = performance.now();
        const result = await processOutboxJobsBatch({
          storeId: fixture.source.storeId,
          jobIds: [jobId],
          workerId: "isolated-load-worker",
        });
        batchTimes.push(Math.round(performance.now() - batchStarted));
        expect(result).toMatchObject({
          processed: 1,
          failed: 0,
          deadLettered: 0,
          succeeded: batch === 10 ? 1 : 0,
        });
        const job = await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
          where: { id: jobId },
        });
        expect(job.status).toBe(batch === 10 ? "completed" : "pending");
        if (batch < 10) expect(job.attempts).toBe(0);
        const source =
          await database.weleticLoyaltyImportSource.findUniqueOrThrow({
            where: { id: fixture.source.id },
          });
        expect(source.status).toBe(
          batch === 10
            ? terminal
            : terminal === "committed"
              ? "committing"
              : "rolling_back",
        );
      }
      console.log(
        JSON.stringify({
          event: "isolated_worker_load",
          phase: terminal,
          rows: 500,
          batches: 11,
          totalMs: Math.round(performance.now() - started),
          batchMs: batchTimes,
        }),
      );
    };
    await runPhase(fixture.job.id, "committed");
    const source = await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: fixture.source.id },
    });
    const proof = await database.$transaction(
      (tx) =>
        readHistoricalImportExecutionProofInTransaction({
          tx,
          sourceId: source.id,
          storeId: source.storeId,
          programId: source.programId,
        }),
      options,
    );
    expect(proof.summary).toMatchObject({
      fullyCommitted: true,
      observedNetPoints: (BigInt(500) * BigInt("9007199254740993")).toString(),
    });
    await database.$transaction(
      (tx) =>
        queueHistoricalImportRollbackInTransaction({
          tx,
          request: {
            ...fixture.request,
            expectedRevision: historicalImportRevision({
              storeId: source.storeId,
              programId: source.programId,
              installationGeneration: source.installationGeneration,
              normalizedSha256: source.normalizedSha256,
              source,
            }),
          },
        }),
      options,
    );
    const rollbackJob = await database.weleticLoyaltyOutboxJob.findFirstOrThrow(
      {
        where: {
          storeId: source.storeId,
          jobType: "HISTORICAL_IMPORT_ROLLBACK",
        },
      },
    );
    // Initial eligibility only. Subsequent batches use the real durable schedule.
    await database.weleticLoyaltyImportSource.update({
      where: { id: source.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    await releaseFixtureJobToRealWorker(rollbackJob.id);
    await runPhase(rollbackJob.id, "rolled_back");
    const after = await database.$transaction(
      (tx) =>
        readHistoricalImportExecutionProofInTransaction({
          tx,
          sourceId: source.id,
          storeId: source.storeId,
          programId: source.programId,
        }),
      options,
    );
    expect(after.summary).toMatchObject({
      fullyRolledBack: true,
      observedNetPoints: "0",
    });
    expect(
      await database.weleticPointsLedgerEntry.count({
        where: { storeId: source.storeId },
      }),
    ).toBe(1000);
    expect(
      await database.weleticLoyaltyAccount.count({
        where: {
          storeId: source.storeId,
          cachedPointsBalance: BigInt(0),
          ledgerVersion: 2,
        },
      }),
    ).toBe(500);
  },
  300_000,
);
it("dispatches rollback through the real worker and acknowledges terminal replay without another correction", async () => {
  const fixture = await queuedRollbackWorkerFixture(1, true);
  expect(await fixture.run()).toMatchObject({
    succeeded: 1,
    deadLettered: 0,
    failed: 0,
  });
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: fixture.source.id },
    }),
  ).toMatchObject({ status: "rolled_back" });
  const account = await database.weleticLoyaltyAccount.findFirstOrThrow({
    where: { storeId: fixture.source.storeId },
  });
  expect(account).toMatchObject({
    currentTierId: null,
    cachedPointsBalance: BigInt(0),
    ledgerVersion: 2,
  });
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: fixture.job.id },
    data: {
      status: "failed",
      completedAt: null,
      processedAt: null,
      nextRetryAt: null,
    },
  });
  expect(await fixture.run()).toMatchObject({ succeeded: 1 });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: fixture.source.storeId },
    }),
  ).toBe(2);
  expect(
    await database.weleticLoyaltyTierHistory.count({
      where: { accountId: account.id },
    }),
  ).toBe(2);
});
it("continues a real 50-row rollback without treating the partial source as complete", async () => {
  const fixture = await queuedRollbackWorkerFixture(50);
  expect(await fixture.run()).toMatchObject({
    processed: 1,
    succeeded: 0,
    deadLettered: 0,
    jobs: [{ id: fixture.job.id, status: "pending" }],
  });
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: fixture.source.id },
    }),
  ).toMatchObject({ status: "rolling_back" });
  expect(await fixture.run()).toMatchObject({ succeeded: 1, failed: 0 });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: fixture.source.storeId },
    }),
  ).toBe(100);
  const balances = await database.weleticLoyaltyAccount.aggregate({
    where: { storeId: fixture.source.storeId },
    _sum: { cachedPointsBalance: true },
  });
  expect(balances._sum.cachedPointsBalance).toBe(BigInt(0));
}, 60000);
it("dead letters a contained rollback immediately instead of acknowledging or automatically retrying it", async () => {
  const fixture = await queuedRollbackWorkerFixture();
  const account = await database.weleticLoyaltyAccount.findFirstOrThrow({
    where: { storeId: fixture.source.storeId },
  });
  await appendPointsLedgerEntry({
    storeId: fixture.source.storeId,
    accountId: account.id,
    entryType: "MANUAL_ADJUSTMENT",
    pointsDelta: 1,
    pendingDelta: 0,
    idempotencyKey: `later-worker-${fixture.source.id}`,
  });
  expect(await fixture.run()).toMatchObject({
    succeeded: 0,
    deadLettered: 1,
    failed: 0,
  });
  expect(
    await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    }),
  ).toMatchObject({
    status: "dead_letter",
    attempts: 1,
    lastError:
      "Historical import execution is contained; manual reconciliation is required.",
  });
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: fixture.source.id },
    }),
  ).toMatchObject({ status: "contained" });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: fixture.source.storeId },
    }),
  ).toBe(2);
});
it("runs the real outbox claim/dispatch/acknowledgement and safely replays after source completion", async () => {
  const { source, job } = await queuedWorkerFixture();
  await releaseFixtureJobToRealWorker(job.id);
  const run = () =>
    processOutboxJobsBatch({
      storeId: source.storeId,
      jobIds: [job.id],
      workerId: "isolated-import-worker",
    });
  expect(await run()).toMatchObject({
    processed: 1,
    succeeded: 1,
    failed: 0,
    deadLettered: 0,
  });
  const finished = await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(finished.status).toBe("completed");
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(1);
  // Model a lost queue acknowledgement after source finalization. Replay must
  // prove committed source/ledger evidence, not require a now-cleared lease.
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: job.id },
    data: {
      status: "failed",
      completedAt: null,
      processedAt: null,
      nextRetryAt: null,
    },
  });
  expect(await run()).toMatchObject({
    succeeded: 1,
    failed: 0,
    deadLettered: 0,
  });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(1);
});
it("keeps a 50-row continuation pending until the real worker proves terminal completion", async () => {
  const { source, job } = await queuedWorkerFixture(50);
  await releaseFixtureJobToRealWorker(job.id);
  const run = () =>
    processOutboxJobsBatch({
      storeId: source.storeId,
      jobIds: [job.id],
      workerId: "isolated-import-batch-worker",
    });
  expect(await run()).toMatchObject({
    processed: 1,
    succeeded: 0,
    failed: 0,
    deadLettered: 0,
    jobs: [{ id: job.id, status: "pending" }],
  });
  expect(
    await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
      where: { id: job.id },
    }),
  ).toMatchObject({ status: "pending", attempts: 0, completedAt: null });
  expect(await run()).toMatchObject({ processed: 1, succeeded: 1, failed: 0 });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(50);
  const balances = await database.weleticLoyaltyAccount.aggregate({
    where: { storeId: source.storeId },
    _sum: { cachedPointsBalance: true },
  });
  expect(balances._sum.cachedPointsBalance).toBe(
    BigInt(50) * BigInt("9007199254740993"),
  );
});
it("defers a still-live source lease without consuming the remaining failure budget", async () => {
  const { source, job } = await queuedWorkerFixture();
  await releaseFixtureJobToRealWorker(job.id);
  const expiresAt = new Date(Date.now() + 60000);
  await database.weleticLoyaltyImportSource.update({
    where: { id: source.id },
    data: { leaseExpiresAt: expiresAt },
  });
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: job.id },
    data: {
      status: "failed",
      attempts: 4,
      maxAttempts: 5,
      lastError: "previous real failure",
    },
  });
  const run = () =>
    processOutboxJobsBatch({ storeId: source.storeId, jobIds: [job.id] });
  expect(await run()).toMatchObject({
    processed: 0,
    skipped: 1,
    deadLettered: 0,
    failed: 0,
  });
  const deferred = await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(deferred).toMatchObject({
    status: "failed",
    attempts: 4,
    nextRetryAt: expiresAt,
    lastError: "previous real failure",
    lockedAt: null,
    lockedBy: null,
  });
  expect((await run()).processed).toBe(0);
  await database.weleticLoyaltyImportSource.update({
    where: { id: source.id },
    data: { leaseExpiresAt: new Date(0) },
  });
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: job.id },
    data: { nextRetryAt: new Date(0) },
  });
  expect(await run()).toMatchObject({
    succeeded: 1,
    deadLettered: 0,
    failed: 0,
  });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(1);
});

it("dead letters invalid scoped work without financial writes or private error details", async () => {
  const { source, job } = await queuedWorkerFixture();
  await releaseFixtureJobToRealWorker(job.id);
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: job.id },
    data: {
      maxAttempts: 1,
      payload: {
        sourceId: "foreign-source",
        programId: source.programId,
        installationGeneration: "g1",
        sourceRevision: 1,
      },
    },
  });
  expect(
    await processOutboxJobsBatch({ storeId: source.storeId, jobIds: [job.id] }),
  ).toMatchObject({ succeeded: 0, deadLettered: 1 });
  const failed = await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(failed.status).toBe("dead_letter");
  expect(failed.lastError).toBe(
    "Historical import commit execution failed; reconcile the source before redrive.",
  );
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(0);
});

it("recovers queued ownership and retains it through row execution and final reconciliation", async () => {
  const { scope, claim, source } = await queuedWorkerFixture();
  const { lease } = await recoverHistoricalImportCommitFromOutbox({
    scope,
    claim,
  });
  const result = await processHistoricalImportCommitBatch({ lease });
  expect(result).toEqual({ processed: 1, completed: true, lease: null });
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: source.id },
    }),
  ).toMatchObject({ status: "committed", leaseId: null });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(1);
});
it("aborts recovered source ownership for a stale queue owner and rejects replacement between rows", async () => {
  const { scope, claim, source, snapshot, job } = await queuedWorkerFixture();
  const before = await database.weleticLoyaltyImportSource.findUniqueOrThrow({
    where: { id: source.id },
  });
  await expect(
    recoverHistoricalImportCommitFromOutbox({
      scope,
      claim: { ...claim, ownerToken: "stale-owner" },
    }),
  ).rejects.toBeInstanceOf(HistoricalImportConflictError);
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: source.id },
    }),
  ).toEqual(before);
  const { lease } = await recoverHistoricalImportCommitFromOutbox({
    scope,
    claim,
  });
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: job.id },
    data: { lockedBy: "replacement", attempts: 2 },
  });
  await expect(
    executeHistoricalImportRow({ lease, snapshotId: snapshot.id }),
  ).rejects.toBeInstanceOf(HistoricalImportConflictError);
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(0);
  expect(
    await database.weleticLoyaltyAccount.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(0);
});

it("durably requeues a bounded batch, rejects the old token and resumes to independent completion", async () => {
  const { scope, claim, source, job } = await queuedWorkerFixture();
  const { lease } = await recoverHistoricalImportCommitFromOutbox({
    scope,
    claim,
  });
  const batch = await processHistoricalImportCommitBatch({ lease, maxRows: 1 });
  expect(batch.completed).toBe(false);
  expect(batch.processed).toBe(1);
  await expect(
    continueHistoricalImportCommit({ lease: batch.lease }),
  ).resolves.toEqual({ continued: true });
  const queued = await database.weleticLoyaltyOutboxJob.findUniqueOrThrow({
    where: { id: job.id },
  });
  expect(queued).toMatchObject({
    status: "pending",
    attempts: 0,
    lockedBy: null,
    lockedAt: null,
    payload: job.payload,
    completedAt: null,
  });
  await expect(
    database.$transaction(
      (tx) =>
        assertHistoricalImportExecutionLeaseInTransaction({
          tx,
          lease: batch.lease,
        }),
      options,
    ),
  ).rejects.toBeInstanceOf(HistoricalImportConflictError);
  const nextClaim = {
    ...claim,
    ownerToken: "next-worker",
    claimedAt: new Date(),
  };
  await database.weleticLoyaltyOutboxJob.update({
    where: { id: job.id },
    data: {
      status: "processing",
      attempts: 1,
      lockedBy: nextClaim.ownerToken,
      lockedAt: nextClaim.claimedAt,
    },
  });
  const resumed = await recoverHistoricalImportCommitFromOutbox({
    scope,
    claim: nextClaim,
  });
  await expect(
    processHistoricalImportCommitBatch({ lease: resumed.lease }),
  ).resolves.toEqual({ completed: true, processed: 0, lease: null });
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(1);
});

it("atomically queues one reference-only commit job across competing source starts", async () => {
  const { source, request } = await seed();
  const start = () =>
    database.$transaction(
      (tx) => queueHistoricalImportCommitInTransaction({ tx, request }),
      options,
    );
  const outcomes = await Promise.allSettled([start(), start()]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  const rejected = outcomes.find(
    ({ status }) => status === "rejected",
  ) as PromiseRejectedResult;
  expect(rejected.reason).toBeInstanceOf(HistoricalImportConflictError);
  const current = await database.weleticLoyaltyImportSource.findUniqueOrThrow({
    where: { id: source.id },
  });
  const jobs = await database.weleticLoyaltyOutboxJob.findMany({
    where: { storeId: source.storeId },
  });
  expect(current.status).toBe("committing");
  expect(current.revision).toBe(1);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({
    jobType: "HISTORICAL_IMPORT_COMMIT",
    status: "pending",
    attempts: 0,
    scheduledFor: current.leaseExpiresAt,
    payload: {
      sourceId: source.id,
      programId: source.programId,
      installationGeneration: "g1",
      sourceRevision: 1,
    },
  });
  expect(JSON.stringify(jobs[0].payload)).not.toContain(current.leaseId);
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(0);
});

it("rolls source ownership back if the durable job insert fails, then safely retries", async () => {
  const { source, request } = await seed();
  const sentinel = await database.weleticLoyaltyOutboxJob.create({
    data: {
      id: `outbox-${source.storeId}`,
      storeId: source.storeId,
      jobType: "HISTORICAL_IMPORT_COMMIT",
      status: "cancelled",
      scheduledFor: new Date(),
      payload: {
        sourceId: source.id,
        programId: source.programId,
        installationGeneration: "g1",
        sourceRevision: 0,
      },
    },
  });
  const idModule = await import("../../lib/weletic/ids");
  const original = idModule.createWeleticId;
  const collision = vi
    .spyOn(idModule, "createWeleticId")
    .mockImplementation((prefix) =>
      prefix === "woutbox_" ? sentinel.id : original(prefix),
    );
  try {
    await expect(
      database.$transaction(
        (tx) => queueHistoricalImportCommitInTransaction({ tx, request }),
        options,
      ),
    ).rejects.toMatchObject({ code: "P2002" });
  } finally {
    collision.mockRestore();
  }
  const afterFailure =
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: source.id },
    });
  expect(afterFailure).toMatchObject({
    status: "preview",
    revision: 0,
    leaseId: null,
    leaseExpiresAt: null,
  });
  expect(
    await database.weleticLoyaltyOutboxJob.findMany({
      where: { storeId: source.storeId },
    }),
  ).toEqual([sentinel]);
  await expect(
    database.$transaction(
      (tx) => queueHistoricalImportCommitInTransaction({ tx, request }),
      options,
    ),
  ).resolves.toEqual({ sourceId: source.id, status: "committing" });
  expect(
    await database.weleticLoyaltyOutboxJob.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(2);
});

it("round-trips approved import job enum values and a nullable tier destination", async () => {
  const { source, snapshot, lease } = await seedExecutableRow();
  await executeHistoricalImportRow({ lease, snapshotId: snapshot.id });
  const account = await database.weleticLoyaltyAccount.findFirstOrThrow({
    where: { storeId: source.storeId },
  });
  const tier = await database.weleticLoyaltyTier.create({
    data: {
      id: `tier-${source.storeId}`,
      programId: source.programId,
      name: "Isolated tier",
      slug: "isolated",
      tierOrder: 1,
    },
  });
  const entry = await database.weleticLoyaltyTierHistory.create({
    data: {
      id: `history-${source.storeId}`,
      accountId: account.id,
      sequenceNumber: 1,
      fromTierId: tier.id,
      toTierId: null,
      changeReason: "manual_override",
    },
  });
  const readback = await database.weleticLoyaltyTierHistory.findUniqueOrThrow({
    where: { id: entry.id },
    include: { fromTier: true, toTier: true },
  });
  expect(readback.fromTier?.id).toBe(tier.id);
  expect(readback.toTierId).toBeNull();
  expect(readback.toTier).toBeNull();
  for (const jobType of [
    "HISTORICAL_IMPORT_COMMIT",
    "HISTORICAL_IMPORT_ROLLBACK",
  ] as const) {
    const id = `${jobType}-${source.storeId}`;
    const payload = {
      sourceId: source.id,
      programId: source.programId,
      installationGeneration: "g1",
      sourceRevision: 1,
    };
    // Schema round-trip only: direct fixture insertion, never enqueue/dispatch.
    await database.weleticLoyaltyOutboxJob.create({
      data: {
        id,
        storeId: source.storeId,
        jobType,
        payload,
        status: "cancelled",
        scheduledFor: new Date(),
      },
    });
    expect(
      await database.weleticLoyaltyOutboxJob.findUnique({ where: { id } }),
    ).toMatchObject({ jobType, payload, status: "cancelled" });
  }
  expect(
    await database.weleticPointsLedgerEntry.count({
      where: { storeId: source.storeId },
    }),
  ).toBe(1);
  expect(
    await database.weleticLoyaltyAccount.findUnique({
      where: { id: account.id },
    }),
  ).toEqual(account);
});

it("stages a byte-derived upload once under concurrent delivery without awarding points", async () => {
  const fixture = await uploadFixture();
  const outcomes = await Promise.allSettled([fixture.stage(), fixture.stage()]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(
    HistoricalImportConflictError,
  );
  const where = { storeId: fixture.storeId };
  const sources = await database.weleticLoyaltyImportSource.findMany({ where });
  expect(sources).toHaveLength(1);
  expect(sources[0]).toMatchObject({
    programId: fixture.programId,
    sourceSha256: fixture.source.sha256,
    sourceFormat: "json",
    sourceVersion: 1,
    installationGeneration: "g1",
    createdByStaffId: "isolated-fixture-staff",
    status: "preview",
    revision: 0,
    rowCount: 1,
  });
  expect(sources[0].totalOpeningBalance.toFixed(0)).toBe("9007199254740993");
  const rows = await database.weleticLoyaltyImportRowSnapshot.findMany({
    where,
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    sourceId: sources[0].id,
    programId: fixture.programId,
    rowNumber: 1,
    shopifyCustomerId: "gid://shopify/Customer/123",
    openingBalance: BigInt("9007199254740993"),
    birthdayMonth: 2,
    birthdayDay: 29,
  });
  expect(await database.weleticLoyaltyAccount.count({ where })).toBe(0);
  expect(await database.weleticPointsLedgerEntry.count({ where })).toBe(0);
  expect(await database.weleticLoyaltyOutboxJob.count({ where })).toBe(0);
  expect(await database.weleticLoyaltyImportRowExecution.count({ where })).toBe(
    0,
  );
  await expect(fixture.stage()).rejects.toBeInstanceOf(
    HistoricalImportConflictError,
  );
  expect(await database.weleticLoyaltyImportSource.findMany({ where })).toEqual(
    sources,
  );
  expect(
    await database.weleticLoyaltyImportRowSnapshot.findMany({ where }),
  ).toEqual(rows);
});

it("rolls back the source when snapshot insertion fails and permits an unchanged upload retry", async () => {
  const existing = await seed();
  const fixture = await uploadFixture();
  // Force an actual primary-key collision after source creation. The existing
  // snapshot belongs to another isolated fixture and must remain unchanged.
  finalInsertFailure.duplicateId = existing.snapshot.id;
  finalInsertFailure.reached = false;
  try {
    await expect(fixture.stage()).rejects.toMatchObject({ code: "P2002" });
    expect(finalInsertFailure.reached).toBe(true);
  } finally {
    finalInsertFailure.duplicateId = null;
  }
  const where = { storeId: fixture.storeId };
  expect(await database.weleticLoyaltyImportSource.count({ where })).toBe(0);
  expect(await database.weleticLoyaltyImportRowSnapshot.count({ where })).toBe(
    0,
  );
  expect(await database.weleticLoyaltyAccount.count({ where })).toBe(0);
  expect(await database.weleticPointsLedgerEntry.count({ where })).toBe(0);
  expect(
    await database.weleticLoyaltyImportRowSnapshot.findUnique({
      where: { id: existing.snapshot.id },
    }),
  ).toEqual(existing.snapshot);
  const result = await fixture.stage();
  expect(result.status).toBe("preview");
  expect(await database.weleticLoyaltyImportSource.count({ where })).toBe(1);
  expect(await database.weleticLoyaltyImportRowSnapshot.count({ where })).toBe(
    1,
  );
});

it("executes competing row deliveries exactly once and finalizes from durable evidence", async () => {
  const { source, snapshot, shopper, lease } = await seedExecutableRow();
  // Drain both transactions even on failure before assertions or fixture cleanup.
  const outcomes = await Promise.allSettled([
    executeHistoricalImportRow({ lease, snapshotId: snapshot.id }),
    executeHistoricalImportRow({ lease, snapshotId: snapshot.id }),
  ]);
  const results = outcomes.map((outcome) => {
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
  expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
  expect(new Set(results.map(({ executionId }) => executionId)).size).toBe(1);
  const where = { storeId: source.storeId };
  const accounts = await database.weleticLoyaltyAccount.findMany({ where });
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({
    programId: source.programId,
    shopperId: shopper.id,
    cachedPointsBalance: BigInt("9007199254740993"),
    cachedPendingPoints: BigInt(0),
    lifetimePointsEarned: BigInt(0),
    lifetimePointsRedeemed: BigInt(0),
    ledgerVersion: 1,
  });
  const entries = await database.weleticPointsLedgerEntry.findMany({ where });
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    accountId: accounts[0].id,
    entryType: "MANUAL_ADJUSTMENT",
    pointsDelta: snapshot.openingBalance,
    balanceAfter: snapshot.openingBalance,
    pendingDelta: BigInt(0),
    grantId: null,
    referenceType: "LOYALTY_IMPORT_OPENING_BALANCE",
    referenceId: snapshot.id,
    sequenceNumber: 1,
  });
  const executions = await database.weleticLoyaltyImportRowExecution.findMany({
    where,
  });
  expect(executions).toHaveLength(1);
  expect(executions[0]).toMatchObject({
    id: results[0].executionId,
    sourceId: source.id,
    snapshotId: snapshot.id,
    accountId: accounts[0].id,
    status: "committed",
    ledgerEntryId: entries[0].id,
    ledgerVersionBefore: 0,
    ledgerVersionAfter: 1,
    reversalLedgerEntryId: null,
  });
  expect(await database.weleticLoyaltyEarnGrant.count({ where })).toBe(0);
  expect(await database.weleticLoyaltyOutboxJob.count({ where })).toBe(0);
  await expect(finalizeHistoricalImportExecution({ lease })).resolves.toEqual({
    finalized: true,
    status: "committed",
  });
  const completed = await database.weleticLoyaltyImportSource.findUniqueOrThrow(
    {
      where: { id: source.id },
    },
  );
  expect(completed).toMatchObject({
    status: "committed",
    revision: lease.revision + 1,
    leaseId: null,
    leaseExpiresAt: null,
  });
  expect(completed.completedAt).toBeInstanceOf(Date);
  await expect(
    executeHistoricalImportRow({ lease, snapshotId: snapshot.id }),
  ).rejects.toBeInstanceOf(HistoricalImportConflictError);
  expect(await database.weleticPointsLedgerEntry.count({ where })).toBe(1);
});

it("rolls back enrollment, birthday scheduling and ledger when the final execution insert collides", async () => {
  const existing = await seedExecutableRow();
  const committed = await executeHistoricalImportRow({
    lease: existing.lease,
    snapshotId: existing.snapshot.id,
  });
  const originalRecord =
    await database.weleticLoyaltyImportRowExecution.findUniqueOrThrow({
      where: { id: committed.executionId },
    });
  const fixture = await seedExecutableRow(true);
  const sourceBefore =
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: fixture.source.id },
    });
  finalInsertFailure.duplicateId = committed.executionId;
  finalInsertFailure.reached = false;
  try {
    // Only ID generation is controlled. The real final INSERT must fail in
    // MySQL after the actual enrollment, field, outbox and ledger operations.
    await expect(
      executeHistoricalImportRow({
        lease: fixture.lease,
        snapshotId: fixture.snapshot.id,
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    expect(finalInsertFailure.reached).toBe(true);
  } finally {
    finalInsertFailure.duplicateId = null;
  }
  const where = { storeId: fixture.source.storeId };
  expect(await database.weleticLoyaltyAccount.count({ where })).toBe(0);
  expect(await database.weleticPointsLedgerEntry.count({ where })).toBe(0);
  expect(await database.weleticLoyaltyOutboxJob.count({ where })).toBe(0);
  expect(await database.weleticLoyaltyEarnGrant.count({ where })).toBe(0);
  expect(await database.weleticLoyaltyImportRowExecution.count({ where })).toBe(
    0,
  );
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: fixture.source.id },
    }),
  ).toEqual(sourceBefore);
  expect(
    await database.weleticLoyaltyImportRowExecution.findUniqueOrThrow({
      where: { id: committed.executionId },
    }),
  ).toEqual(originalRecord);
  // The failed row remains retryable under its original lease, without
  // orphan-ledger adoption or a stranded birthday idempotency key.
  await expect(
    executeHistoricalImportRow({
      lease: fixture.lease,
      snapshotId: fixture.snapshot.id,
    }),
  ).resolves.toMatchObject({ replayed: false });
  expect(await database.weleticLoyaltyAccount.count({ where })).toBe(1);
  expect(await database.weleticPointsLedgerEntry.count({ where })).toBe(1);
  expect(await database.weleticLoyaltyImportRowExecution.count({ where })).toBe(
    1,
  );
  expect(
    await database.weleticLoyaltyOutboxJob.count({
      where: { ...where, jobType: "BIRTHDAY_REWARD" },
    }),
  ).toBe(1);
});

it("rejects a foreign snapshot without enrolling or crediting either store", async () => {
  const own = await seedExecutableRow();
  const other = await seedExecutableRow();
  await expect(
    executeHistoricalImportRow({
      lease: own.lease,
      snapshotId: other.snapshot.id,
    }),
  ).rejects.toBeInstanceOf(HistoricalImportConflictError);
  const where = { storeId: { in: [own.source.storeId, other.source.storeId] } };
  expect(await database.weleticLoyaltyAccount.count({ where })).toBe(0);
  expect(await database.weleticPointsLedgerEntry.count({ where })).toBe(0);
  expect(await database.weleticLoyaltyImportRowExecution.count({ where })).toBe(
    0,
  );
  for (const fixture of [own, other]) {
    expect(
      await database.weleticLoyaltyImportSource.findUniqueOrThrow({
        where: { id: fixture.source.id },
      }),
    ).toMatchObject({
      status: "committing",
      revision: fixture.lease.revision,
      leaseId: fixture.lease.leaseId,
    });
  }
});

it("allows exactly one concurrent source claimant", async () => {
  const { source, request } = await seed();
  const results = await Promise.allSettled(
    [1, 2].map(() =>
      database.$transaction(
        (tx) =>
          claimHistoricalImportExecutionLeaseInTransaction({ tx, request }),
        options,
      ),
    ),
  );
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const current = await database.weleticLoyaltyImportSource.findUniqueOrThrow({
    where: { id: source.id },
  });
  expect(current.status).toBe("committing");
  expect(current.revision).toBe(1);
  const winner = results.find((result) => result.status === "fulfilled");
  const loser = results.find((result) => result.status === "rejected");
  if (
    !winner ||
    winner.status !== "fulfilled" ||
    !loser ||
    loser.status !== "rejected"
  )
    throw new Error("Expected one winner and one fenced claimant");
  expect(loser.reason).toBeInstanceOf(HistoricalImportConflictError);
  expect(current.leaseId).toBe(winner.value.lease.leaseId);
  expect(current.leaseExpiresAt).toEqual(winner.value.expiresAt);
  expect(
    await database.weleticLoyaltyImportRowExecution.count({
      where: { sourceId: source.id },
    }),
  ).toBe(0);
});
it("rolls back source state and lease if the initiating transaction aborts", async () => {
  const { source, request } = await seed();
  await expect(
    database.$transaction(async (tx) => {
      await claimHistoricalImportExecutionLeaseInTransaction({ tx, request });
      throw new Error("forced transaction abort");
    }, options),
  ).rejects.toThrow("forced transaction abort");
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: source.id },
    }),
  ).toMatchObject({
    status: "preview",
    revision: 0,
    leaseId: null,
    leaseExpiresAt: null,
  });
});
it("rejects damaged immutable rows before source mutation", async () => {
  const { source, snapshot, request } = await seed();
  await database.weleticLoyaltyImportRowSnapshot.update({
    where: { id: snapshot.id },
    data: { openingBalance: { increment: BigInt(1) } },
  });
  await expect(
    database.$transaction(
      (tx) => claimHistoricalImportExecutionLeaseInTransaction({ tx, request }),
      options,
    ),
  ).rejects.toThrow();
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: source.id },
    }),
  ).toMatchObject({ status: "preview", revision: 0, leaseId: null });
});
it("rejects an old owner after expiry and verified reclaim", async () => {
  const { source, request } = await seed();
  const first = await database.$transaction(
    (tx) => claimHistoricalImportExecutionLeaseInTransaction({ tx, request }),
    options,
  );
  const expired = await database.weleticLoyaltyImportSource.update({
    where: { id: source.id },
    data: { leaseExpiresAt: new Date("2000-01-01") },
  });
  const expectedRevision = historicalImportRevision({
    ...request,
    normalizedSha256: expired.normalizedSha256,
    source: expired,
  });
  const second = await database.$transaction(
    (tx) =>
      claimHistoricalImportExecutionLeaseInTransaction({
        tx,
        request: { ...request, expectedRevision },
      }),
    options,
  );
  expect(second.lease.leaseId).not.toBe(first.lease.leaseId);
  await expect(
    database.$transaction(
      (tx) =>
        assertHistoricalImportExecutionLeaseInTransaction({
          tx,
          lease: first.lease,
        }),
      options,
    ),
  ).rejects.toThrow();
  await expect(
    database.$transaction(
      (tx) =>
        assertHistoricalImportExecutionLeaseInTransaction({
          tx,
          lease: second.lease,
        }),
      options,
    ),
  ).resolves.toMatchObject({ lease: second.lease });
});
it("allows exactly one recovery wrapper to replace an expired owner", async () => {
  const { source, request } = await seed();
  const first = await database.$transaction(
    (tx) => claimHistoricalImportExecutionLeaseInTransaction({ tx, request }),
    options,
  );
  await database.weleticLoyaltyImportSource.update({
    where: { id: source.id },
    data: { leaseExpiresAt: new Date("2000-01-01") },
  });
  const scope = {
    sourceId: source.id,
    storeId: source.storeId,
    programId: source.programId,
    installationGeneration: source.installationGeneration,
  };
  const results = await Promise.allSettled([
    recoverHistoricalImportCommit({ scope }),
    recoverHistoricalImportCommit({ scope }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const winner = results.find((result) => result.status === "fulfilled");
  const loser = results.find((result) => result.status === "rejected");
  if (
    !winner ||
    winner.status !== "fulfilled" ||
    !loser ||
    loser.status !== "rejected"
  )
    throw new Error("Expected one recovery winner and one fenced recovery");
  expect(loser.reason).toBeInstanceOf(HistoricalImportConflictError);
  expect(winner.value.lease.leaseId).not.toBe(first.lease.leaseId);
  expect(winner.value.lease.revision).toBe(first.lease.revision + 1);
  const current = await database.weleticLoyaltyImportSource.findUniqueOrThrow({
    where: { id: source.id },
  });
  expect(current.leaseId).toBe(winner.value.lease.leaseId);
  expect(current.leaseExpiresAt).toEqual(winner.value.expiresAt);
  await expect(
    database.$transaction(
      (tx) =>
        assertHistoricalImportExecutionLeaseInTransaction({
          tx,
          lease: first.lease,
        }),
      options,
    ),
  ).rejects.toBeInstanceOf(HistoricalImportConflictError);
  await expect(
    database.$transaction(
      (tx) =>
        assertHistoricalImportExecutionLeaseInTransaction({
          tx,
          lease: winner.value.lease,
        }),
      options,
    ),
  ).resolves.toMatchObject({ lease: winner.value.lease });
});
it("recovery wrapper cannot start preview work or replace a live owner", async () => {
  const { source, request } = await seed();
  const scope = {
    sourceId: source.id,
    storeId: source.storeId,
    programId: source.programId,
    installationGeneration: source.installationGeneration,
  };
  await expect(recoverHistoricalImportCommit({ scope })).rejects.toBeInstanceOf(
    HistoricalImportConflictError,
  );
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: source.id },
    }),
  ).toMatchObject({
    status: "preview",
    revision: 0,
    leaseId: null,
    leaseExpiresAt: null,
  });
  const first = await database.$transaction(
    (tx) => claimHistoricalImportExecutionLeaseInTransaction({ tx, request }),
    options,
  );
  await expect(recoverHistoricalImportCommit({ scope })).rejects.toBeInstanceOf(
    HistoricalImportConflictError,
  );
  expect(
    await database.weleticLoyaltyImportSource.findUniqueOrThrow({
      where: { id: source.id },
    }),
  ).toMatchObject({
    status: "committing",
    revision: first.lease.revision,
    leaseId: first.lease.leaseId,
    leaseExpiresAt: first.expiresAt,
  });
});
it("rejects a worker from an older installation generation", async () => {
  const { source, request } = await seed();
  const first = await database.$transaction(
    (tx) => claimHistoricalImportExecutionLeaseInTransaction({ tx, request }),
    options,
  );
  await database.weleticShopifyStore.update({
    where: { id: source.storeId },
    data: { installationGeneration: "g2" },
  });
  await expect(
    database.$transaction(
      (tx) =>
        assertHistoricalImportExecutionLeaseInTransaction({
          tx,
          lease: first.lease,
        }),
      options,
    ),
  ).rejects.toThrow();
});
