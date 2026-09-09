import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { HISTORICAL_IMPORT_MAX_SOURCE_ROWS } from "./historical-import-contract";
import {
  assertHistoricalImportExecutionLeaseInTransaction,
  renewHistoricalImportExecutionLeaseInTransaction,
} from "./historical-import-execution-lease";
import { finalizeHistoricalImportExecution } from "./historical-import-finalization";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { executeHistoricalImportRow } from "./historical-import-row-execution";

/** Internal bounded worker step. Source/snapshot/execution rows are the durable
 * progress journal; no in-memory cursor is treated as completion evidence.
 * Return lease material only to the trusted supervisor. On failure, propagate;
 * a later expired-lease recovery must reverify evidence, not retry this old token.
 * Called by the claimed outbox handler; never expose this private primitive
 * through a public gateway. Deployment and merchant activation remain gated.
 */
export async function processHistoricalImportCommitBatch({
  lease,
  maxRows = 50,
}: {
  lease: unknown;
  maxRows?: number;
}) {
  const limit = z.number().int().min(1).max(100).parse(maxRows);
  let token = lease;
  let processed = 0;
  let afterRowNumber = 0;
  while (processed < limit) {
    const next = await prisma.$transaction(
      async (tx) => {
        const current = await assertHistoricalImportExecutionLeaseInTransaction(
          { tx, lease: token },
        );
        const scope = current.lease;
        if (scope.phase !== "committing")
          throw new HistoricalImportConflictError();
        const rows = await tx.$queryRaw<
          Array<{ id: string; rowNumber: number }>
        >(Prisma.sql`
        SELECT s.id, s.rowNumber FROM WeleticLoyaltyImportRowSnapshot s
        LEFT JOIN WeleticLoyaltyImportRowExecution e ON e.snapshotId = s.id
        WHERE s.sourceId = ${scope.sourceId} AND s.storeId = ${scope.storeId} AND s.programId = ${scope.programId}
          AND s.rowNumber > ${afterRowNumber}
          AND (e.id IS NULL OR e.status <> 'committed' OR e.sourceId <> s.sourceId
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
        // Renew after selection so lock/query time doesn't consume the new TTL.
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
      return { processed, completed: true as const, lease: null };
    }
    // This owns a separate atomic row transaction and rechecks the renewed
    // token; expiry/containment between selection and execution fails closed.
    await executeHistoricalImportRow({
      lease: token,
      snapshotId: next.snapshotId,
    });
    // Optimization only: advance after atomic success, reset for each batch.
    // Independent final reconciliation, never this cursor, proves completion.
    afterRowNumber = next.rowNumber!;
    processed++;
  }
  return { processed, completed: false as const, lease: token };
}
