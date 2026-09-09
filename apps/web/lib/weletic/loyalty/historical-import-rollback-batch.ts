import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { HISTORICAL_IMPORT_MAX_SOURCE_ROWS } from "./historical-import-contract";
import {
  assertHistoricalImportExecutionLeaseInTransaction,
  renewHistoricalImportExecutionLeaseInTransaction,
} from "./historical-import-execution-lease";
import { finalizeHistoricalImportExecution } from "./historical-import-finalization";
import { HISTORICAL_IMPORT_BATCH_TARGET_MS } from "./historical-import-job-contract";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { rollbackHistoricalImportRow } from "./historical-import-rollback-row";

/** Bounded rollback step. Durable row evidence is the cursor; independent
 * reconciliation is the completion condition. Containment stops the source and
 * returns no usable lease; it must never be requeued as successful progress.
 */
export async function processHistoricalImportRollbackBatch({
  lease,
  maxRows = 50,
}: {
  lease: unknown;
  maxRows?: number;
}) {
  const limit = z.number().int().min(1).max(100).parse(maxRows);
  const startedAt = performance.now();
  let token = lease;
  let processed = 0;
  let afterRowNumber = 0;
  while (
    processed < limit &&
    (processed === 0 ||
      performance.now() - startedAt < HISTORICAL_IMPORT_BATCH_TARGET_MS)
  ) {
    const next = await prisma.$transaction(
      async (tx) => {
        const current = await assertHistoricalImportExecutionLeaseInTransaction(
          { tx, lease: token },
        );
        const scope = current.lease;
        if (scope.phase !== "rolling_back")
          throw new HistoricalImportConflictError();
        const rows = await tx.$queryRaw<
          Array<{ id: string; rowNumber: number }>
        >(Prisma.sql`
        SELECT s.id, s.rowNumber FROM WeleticLoyaltyImportRowSnapshot s
        LEFT JOIN WeleticLoyaltyImportRowExecution e ON e.snapshotId = s.id
        WHERE s.sourceId = ${scope.sourceId} AND s.storeId = ${scope.storeId} AND s.programId = ${scope.programId}
          AND s.rowNumber > ${afterRowNumber}
          AND (e.id IS NULL OR e.status <> 'rolled_back' OR e.sourceId <> s.sourceId
            OR e.storeId <> s.storeId OR e.programId <> s.programId)
        ORDER BY s.rowNumber ASC LIMIT 1 FOR UPDATE
      `);
        if (
          rows.length > 1 ||
          (rows.length === 1 &&
            (!z.string().min(1).max(191).safeParse(rows[0].id).success ||
              !Number.isInteger(rows[0].rowNumber) ||
              rows[0].rowNumber <= afterRowNumber ||
              rows[0].rowNumber > HISTORICAL_IMPORT_MAX_SOURCE_ROWS))
        )
          throw new HistoricalImportConflictError();
        const renewed = await renewHistoricalImportExecutionLeaseInTransaction({
          tx,
          lease: scope,
        });
        return {
          lease: renewed.lease,
          snapshotId: rows[0]?.id ?? null,
          rowNumber: rows[0]?.rowNumber ?? null,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000,
      },
    );
    token = next.lease;
    if (next.snapshotId === null) {
      const result = await finalizeHistoricalImportExecution({ lease: token });
      if (!result.finalized) throw new HistoricalImportConflictError();
      return {
        processed,
        completed: true as const,
        contained: false as const,
        lease: null,
      };
    }
    const result = await rollbackHistoricalImportRow({
      lease: token,
      snapshotId: next.snapshotId,
    });
    if (result.contained)
      return {
        processed,
        completed: false as const,
        contained: true as const,
        lease: null,
      };
    processed++;
    afterRowNumber = next.rowNumber!;
  }
  return {
    processed,
    completed: false as const,
    contained: false as const,
    lease: token,
  };
}
