import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma, type WeleticLoyaltyImportStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  HistoricalImportExecutionContainedError,
  HistoricalImportJobPayloadSchema,
  HistoricalImportLeasePendingError,
  HistoricalImportOutboxClaimSchema,
  type HistoricalImportOutboxClaim,
} from "./historical-import-job-contract";
import {
  HistoricalImportConflictError,
  historicalImportRevision,
} from "./historical-import-persistence";
import { readHistoricalImportExecutionProofInTransaction } from "./historical-import-reconciliation-service";
import { lockLoyaltyProgramRow } from "./program-write-fence";

const identifier = z.string().min(1).max(191);
const scopeSchema = z
  .object({
    storeId: identifier,
    programId: identifier,
    sourceId: identifier,
    installationGeneration: identifier,
  })
  .strict();
const phaseSchema = z.enum(["committing", "rolling_back"]);
const leaseSchema = scopeSchema
  .extend({
    phase: phaseSchema,
    leaseId: z.string().uuid(),
    revision: z.number().int().min(0).max(2147483647),
    outboxClaim: HistoricalImportOutboxClaimSchema.optional(),
  })
  .strict();
export type HistoricalImportExecutionLease = z.infer<typeof leaseSchema>;
const claimSchema = scopeSchema
  .extend({
    phase: phaseSchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const LEASE_MS = 60_000;
type LockedSource = {
  id: string;
  storeId: string;
  programId: string;
  installationGeneration: string;
  normalizedSha256: string;
  status: WeleticLoyaltyImportStatus;
  revision: number;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
};

/** Current locking reads only. All callers retain store -> program -> source
 * locks through their transaction; do not reuse this evidence after commit. */
async function lockSource(
  tx: Prisma.TransactionClient,
  scope: z.infer<typeof scopeSchema>,
) {
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId: scope.storeId,
    expectedInstallationGeneration: scope.installationGeneration,
    action: "loyalty_import_execution",
  });
  const program = await lockLoyaltyProgramRow({
    tx,
    storeId: scope.storeId,
    mode: "active",
  });
  if (program.id !== scope.programId || program.storeId !== scope.storeId)
    throw new HistoricalImportConflictError();
  const sources = await tx.$queryRaw<LockedSource[]>(Prisma.sql`
    SELECT id, storeId, programId, installationGeneration, normalizedSha256,
      status, revision, leaseId, leaseExpiresAt
    FROM WeleticLoyaltyImportSource
    WHERE id = ${scope.sourceId} AND storeId = ${scope.storeId} AND programId = ${scope.programId}
    FOR UPDATE
  `);
  const source = sources[0];
  if (
    sources.length !== 1 ||
    source.id !== scope.sourceId ||
    source.storeId !== scope.storeId ||
    source.programId !== scope.programId ||
    source.installationGeneration !== scope.installationGeneration ||
    !Number.isInteger(source.revision) ||
    source.revision < 0 ||
    source.revision > 2147483647 ||
    (source.leaseId !== null &&
      !z.string().uuid().safeParse(source.leaseId).success) ||
    !/^[a-f0-9]{64}$/.test(source.normalizedSha256) ||
    (source.leaseId === null) !== (source.leaseExpiresAt === null)
  )
    throw new HistoricalImportConflictError();
  // Read DB time AFTER locks, so waiting to acquire them cannot age this clock.
  const clocks = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT UTC_TIMESTAMP(3) AS now`,
  );
  const now = clocks[0]?.now;
  if (
    clocks.length !== 1 ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    (source.leaseExpiresAt !== null &&
      (!(source.leaseExpiresAt instanceof Date) ||
        !Number.isFinite(source.leaseExpiresAt.getTime())))
  )
    throw new HistoricalImportConflictError();
  return { source, now };
}

/** Internal execution primitive, NOT merchant authorization or a commit permit.
 * The orchestrator must authorize the initiating operation and arrange durable
 * work in this same transaction. This claim verifies immutable snapshots and
 * existing ledger evidence before changing source state. No ledger,
 * enrollment, birthday, tier or outbox changes happen here.
 * Call in a FRESH transaction before any consistent read: source revision does
 * not advance per row, so it cannot detect an older execution-row MVCC snapshot.
 */
export async function claimHistoricalImportExecutionLeaseInTransaction({
  tx,
  request,
}: {
  tx: Prisma.TransactionClient;
  request: unknown;
}) {
  const input = claimSchema.parse(request);
  const scope = {
    storeId: input.storeId,
    programId: input.programId,
    sourceId: input.sourceId,
    installationGeneration: input.installationGeneration,
  };
  const { source, now } = await lockSource(tx, scope);
  const revision = historicalImportRevision({
    ...scope,
    normalizedSha256: source.normalizedSha256,
    source,
  });
  if (input.expectedRevision !== revision)
    throw new HistoricalImportConflictError();
  if (source.revision >= 2147483647) throw new HistoricalImportConflictError();
  const initial = input.phase === "committing" ? "preview" : "committed";
  const starting = source.status === initial && source.leaseId === null;
  const reclaiming =
    source.status === input.phase &&
    source.leaseId !== null &&
    source.leaseExpiresAt !== null &&
    source.leaseExpiresAt <= now;
  if (!starting && !reclaiming) throw new HistoricalImportConflictError();
  const proof = await readHistoricalImportExecutionProofInTransaction({
    tx,
    sourceId: scope.sourceId,
    storeId: scope.storeId,
    programId: scope.programId,
  });
  const allowedStates =
    input.phase === "committing"
      ? starting
        ? ["pending"]
        : ["pending", "committed"]
      : starting
        ? ["committed"]
        : ["committed", "rolled_back"];
  if (
    !proof.summary.reconciled ||
    proof.summary.issues.length ||
    proof.summary.sourceStatus !== source.status ||
    proof.summary.rowCount < 1 ||
    proof.sourceRevision !== source.revision ||
    proof.sourceInstallationGeneration !== scope.installationGeneration ||
    proof.normalizedSha256 !== source.normalizedSha256 ||
    !proof.rowStates.length ||
    proof.rowStates.some((state) => !allowedStates.includes(state)) ||
    (input.phase === "rolling_back" && starting && !proof.rowsFullyCommitted)
  )
    throw new HistoricalImportConflictError();
  // Full-file proof may be slow. Start the lease lifetime from a fresh database
  // clock under the same locks, not the time before manifest reconciliation.
  const refreshed = await lockSource(tx, scope);
  const leaseId = randomUUID();
  const expiresAt = new Date(refreshed.now.getTime() + LEASE_MS);
  const updated = await tx.weleticLoyaltyImportSource.updateMany({
    where: {
      id: scope.sourceId,
      storeId: scope.storeId,
      programId: scope.programId,
      installationGeneration: scope.installationGeneration,
      revision: source.revision,
      status: source.status,
      leaseId: source.leaseId,
      leaseExpiresAt: source.leaseExpiresAt,
    },
    data: {
      status: input.phase,
      revision: { increment: 1 },
      leaseId,
      leaseExpiresAt: expiresAt,
    },
  });
  if (updated.count !== 1) throw new HistoricalImportConflictError();
  return {
    lease: {
      ...scope,
      phase: input.phase,
      leaseId,
      revision: source.revision + 1,
    } satisfies HistoricalImportExecutionLease,
    expiresAt,
  };
}

/** Trusted supervisor recovery only. Never starts preview work or rollback.
 * Caller must own a fresh transaction before any consistent read and arrange
 * durable continuation. The current locked source supplies the revision; lost
 * worker tokens and client-supplied revisions are not recovery authority.
 */
export function recoverHistoricalImportCommitLeaseInTransaction(args: {
  tx: Prisma.TransactionClient;
  scope: unknown;
}) {
  return recoverHistoricalImportExecutionLeaseInTransaction({
    ...args,
    phase: "committing",
  });
}
export function recoverHistoricalImportRollbackLeaseInTransaction(args: {
  tx: Prisma.TransactionClient;
  scope: unknown;
}) {
  return recoverHistoricalImportExecutionLeaseInTransaction({
    ...args,
    phase: "rolling_back",
  });
}
async function recoverHistoricalImportExecutionLeaseInTransaction({
  tx,
  scope,
  phase,
}: {
  tx: Prisma.TransactionClient;
  scope: unknown;
  phase: "committing" | "rolling_back";
}) {
  const input = scopeSchema.parse(scope);
  const { source, now } = await lockSource(tx, input);
  if (
    source.status !== phase ||
    source.leaseId === null ||
    source.leaseExpiresAt === null ||
    source.leaseExpiresAt > now
  )
    throw new HistoricalImportConflictError();
  return claimHistoricalImportExecutionLeaseInTransaction({
    tx,
    request: {
      ...input,
      phase,
      expectedRevision: historicalImportRevision({
        ...input,
        normalizedSha256: source.normalizedSha256,
        source,
      }),
    },
  });
}

/** Call BEFORE account/ledger access in EACH row transaction. Matching a token
 * from a previous transaction is insufficient: the current source must agree. */
export async function assertHistoricalImportExecutionLeaseInTransaction({
  tx,
  lease,
}: {
  tx: Prisma.TransactionClient;
  lease: unknown;
}) {
  const input = leaseSchema.parse(lease);
  const scope = {
    storeId: input.storeId,
    programId: input.programId,
    sourceId: input.sourceId,
    installationGeneration: input.installationGeneration,
  };
  const { source, now } = await lockSource(tx, scope);
  if (
    source.status !== input.phase ||
    source.revision !== input.revision ||
    source.leaseId !== input.leaseId ||
    !source.leaseExpiresAt ||
    source.leaseExpiresAt <= now
  )
    throw new HistoricalImportConflictError();
  if (input.outboxClaim) {
    const checkedAt = await assertBoundOutboxClaim({
      tx,
      input,
      claim: input.outboxClaim,
    });
    if (source.leaseExpiresAt <= checkedAt)
      throw new HistoricalImportConflictError();
    return { lease: input, source, now: checkedAt };
  }
  return { lease: input, source, now };
}

async function assertBoundOutboxClaim({
  tx,
  input,
  claim,
  allowCurrentRevision = false,
}: {
  tx: Prisma.TransactionClient;
  input: z.infer<typeof scopeSchema> & {
    phase: "committing" | "rolling_back";
    revision: number;
  };
  claim: HistoricalImportOutboxClaim;
  allowCurrentRevision?: boolean;
}) {
  // Retain store -> program -> source -> outbox locks until the row write
  // commits. An ordinary MVCC read here could observe a replaced owner.
  const jobs = await tx.$queryRaw<
    Array<{
      id: string;
      storeId: string;
      jobType: string;
      status: string;
      lockedBy: string | null;
      lockedAt: Date | null;
      attempts: number;
      payload: unknown;
    }>
  >(Prisma.sql`
      SELECT id, storeId, jobType, status, lockedBy, lockedAt, attempts, payload
      FROM WeleticLoyaltyOutboxJob
      WHERE id = ${claim.jobId} AND storeId = ${input.storeId} FOR UPDATE
    `);
  const job = jobs[0];
  const payload = HistoricalImportJobPayloadSchema.safeParse(job?.payload);
  if (
    jobs.length !== 1 ||
    job.id !== claim.jobId ||
    job.storeId !== input.storeId ||
    job.jobType !==
      (input.phase === "committing"
        ? "HISTORICAL_IMPORT_COMMIT"
        : "HISTORICAL_IMPORT_ROLLBACK") ||
    job.status !== "processing" ||
    job.lockedBy !== claim.ownerToken ||
    !(job.lockedAt instanceof Date) ||
    job.lockedAt.getTime() !== claim.claimedAt.getTime() ||
    job.attempts !== claim.attempt ||
    !payload.success ||
    payload.data.sourceId !== input.sourceId ||
    payload.data.programId !== input.programId ||
    payload.data.installationGeneration !== input.installationGeneration ||
    payload.data.sourceRevision !== claim.sourceRevision ||
    (allowCurrentRevision
      ? claim.sourceRevision > input.revision
      : claim.sourceRevision >= input.revision)
  )
    throw new HistoricalImportConflictError();
  // Waiting for the outbox lock must not extend the source lease's lifetime.
  const clock = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT UTC_TIMESTAMP(3) AS now`,
  );
  if (
    clock.length !== 1 ||
    !(clock[0].now instanceof Date) ||
    !Number.isFinite(clock[0].now.getTime())
  )
    throw new HistoricalImportConflictError();
  return clock[0].now;
}

/** Read-only terminal replay for a worker that crashed after source finalization
 * but before queue acknowledgement. A status flag alone is never enough. The
 * caller owns a fresh transaction; source and queue locks protect the complete
 * immutable manifest/ledger proof until this read returns.
 */
export function verifyHistoricalImportCommitCompletionInTransaction(args: {
  tx: Prisma.TransactionClient;
  scope: unknown;
  claim: unknown;
}) {
  return verifyHistoricalImportExecutionCompletionInTransaction({
    ...args,
    phase: "committing",
  });
}
export function verifyHistoricalImportRollbackCompletionInTransaction(args: {
  tx: Prisma.TransactionClient;
  scope: unknown;
  claim: unknown;
}) {
  return verifyHistoricalImportExecutionCompletionInTransaction({
    ...args,
    phase: "rolling_back",
  });
}
async function verifyHistoricalImportExecutionCompletionInTransaction({
  tx,
  scope,
  claim,
  phase,
}: {
  tx: Prisma.TransactionClient;
  scope: unknown;
  claim: unknown;
  phase: "committing" | "rolling_back";
}) {
  const input = scopeSchema.parse(scope);
  const outboxClaim = HistoricalImportOutboxClaimSchema.parse(claim);
  const { source } = await lockSource(tx, input);
  if (source.status === "contained") {
    await assertBoundOutboxClaim({
      tx,
      input: { ...input, phase, revision: source.revision },
      claim: outboxClaim,
    });
    throw new HistoricalImportExecutionContainedError();
  }
  if (source.status === phase && source.leaseExpiresAt !== null) {
    const checkedAt = await assertBoundOutboxClaim({
      tx,
      input: { ...input, phase, revision: source.revision },
      claim: outboxClaim,
      allowCurrentRevision: true,
    });
    if (source.leaseExpiresAt > checkedAt)
      throw new HistoricalImportLeasePendingError(source.leaseExpiresAt);
  }
  const terminal = phase === "committing" ? "committed" : "rolled_back";
  if (source.status !== terminal) return false;
  if (source.leaseId !== null || source.leaseExpiresAt !== null)
    throw new HistoricalImportConflictError();
  await assertBoundOutboxClaim({
    tx,
    input: { ...input, phase, revision: source.revision },
    claim: outboxClaim,
  });
  const proof = await readHistoricalImportExecutionProofInTransaction({
    tx,
    ...input,
  });
  if (
    !proof.summary.reconciled ||
    proof.summary.issues.length ||
    proof.summary.sourceStatus !== terminal ||
    proof.summary.rowCount < 1 ||
    !(phase === "committing"
      ? proof.rowsFullyCommitted
      : proof.rowsFullyRolledBack) ||
    proof.sourceRevision !== source.revision ||
    proof.sourceInstallationGeneration !== source.installationGeneration ||
    proof.normalizedSha256 !== source.normalizedSha256
  )
    throw new HistoricalImportConflictError();
  return true;
}

/** Renewal rotates the revision; old tokens immediately cease to authorize work. */
export async function renewHistoricalImportExecutionLeaseInTransaction({
  tx,
  lease,
}: {
  tx: Prisma.TransactionClient;
  lease: unknown;
}) {
  const {
    lease: current,
    source,
    now,
  } = await assertHistoricalImportExecutionLeaseInTransaction({ tx, lease });
  if (current.revision >= 2147483647) throw new HistoricalImportConflictError();
  const expiresAt = new Date(now.getTime() + LEASE_MS);
  const updated = await tx.weleticLoyaltyImportSource.updateMany({
    where: {
      id: current.sourceId,
      storeId: current.storeId,
      programId: current.programId,
      installationGeneration: current.installationGeneration,
      status: current.phase,
      revision: current.revision,
      leaseId: current.leaseId,
      leaseExpiresAt: source.leaseExpiresAt,
    },
    data: { revision: { increment: 1 }, leaseExpiresAt: expiresAt },
  });
  if (updated.count !== 1) throw new HistoricalImportConflictError();
  return { lease: { ...current, revision: current.revision + 1 }, expiresAt };
}
