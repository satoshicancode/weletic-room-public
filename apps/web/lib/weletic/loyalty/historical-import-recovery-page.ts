import { z } from "zod";
import { processHistoricalImportCommitBatch } from "./historical-import-commit-batch";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { recoverHistoricalImportCommit } from "./historical-import-recovery";
import { discoverHistoricalImportCommitRecovery } from "./historical-import-recovery-discovery";

type Outcome =
  | { sourceId: string; status: "completed"; processed: number }
  | {
      sourceId: string;
      status: "continuation";
      processed: number;
      lease: unknown;
    }
  | {
      sourceId: string;
      status: "conflict" | "failed";
      stage: "recovery" | "execution";
      progress: "unknown";
    };

/** Internal supervisor page; never expose this result through a merchant API.
 * Discovery is read-only; each recovery and each row owns its fenced transaction.
 * Failed candidates do not prevent later candidates/pages from being attempted.
 * A failed batch can have committed earlier rows, so no zero-progress claim is
 * made on errors. No retries, retry classification or containment writes happen
 * here. The supervisor must persist/report failures before scheduling retries.
 * Private continuation leases must be revalidated by every follow-up batch;
 * earlier candidates' leases may expire while later candidates are processed.
 * If the process dies, durable source/row state survives for expired recovery.
 * No scheduler invokes this until schema, race and supervision gates pass.
 */
export async function processHistoricalImportRecoveryPage({
  request,
  maxRowsPerSource = 50,
}: {
  request: unknown;
  maxRowsPerSource?: number;
}) {
  const limit = z.number().int().min(1).max(100).parse(maxRowsPerSource);
  // Discovery failures are page-level failures, not a successful empty sweep.
  const page = await discoverHistoricalImportCommitRecovery(request);
  const outcomes: Outcome[] = [];
  for (const scope of page.candidates) {
    let stage: "recovery" | "execution" = "recovery";
    try {
      const recovered = await recoverHistoricalImportCommit({ scope });
      stage = "execution";
      const batch = await processHistoricalImportCommitBatch({
        lease: recovered.lease,
        maxRows: limit,
      });
      if (batch.completed) {
        outcomes.push({
          sourceId: scope.sourceId,
          status: "completed",
          processed: batch.processed,
        });
      } else {
        outcomes.push({
          sourceId: scope.sourceId,
          status: "continuation",
          processed: batch.processed,
          lease: batch.lease,
        });
      }
    } catch (error) {
      outcomes.push({
        sourceId: scope.sourceId,
        status:
          error instanceof HistoricalImportConflictError
            ? "conflict"
            : "failed",
        stage,
        progress: "unknown",
      });
    }
  }
  return { outcomes, nextCursor: page.nextCursor };
}
