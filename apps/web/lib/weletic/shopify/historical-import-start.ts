import { prisma } from "@/lib/prisma";
import {
  historicalImportCommitStartSchema,
  historicalImportRollbackStartSchema,
} from "@/lib/weletic/loyalty/historical-import-contract";
import {
  queueHistoricalImportCommitInTransaction,
  queueHistoricalImportRollbackInTransaction,
} from "@/lib/weletic/loyalty/historical-import-dispatch";
import { HistoricalImportConflictError } from "@/lib/weletic/loyalty/historical-import-persistence";
import { lockLoyaltyProgramRow } from "@/lib/weletic/loyalty/program-write-fence";
import { Prisma } from "@prisma/client";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
export {
  historicalImportCommitStartSchema,
  historicalImportRollbackStartSchema,
} from "@/lib/weletic/loyalty/historical-import-contract";

/** Internal signed-gateway service, not an HTTP authenticator. Caller MUST
 * verify the signature over the complete actor + operation body first.
 * Authorization, source claim and durable job creation share one transaction.
 * Returns only public source state, never private worker lease material.
 * The signed import route calls this service without nesting its transaction.
 */
type StartRequest = { envelope: unknown; request: unknown };
export function startShopifyHistoricalImportCommit(args: StartRequest) {
  return startShopifyHistoricalImportOperation({
    ...args,
    operation: "commit",
  });
}
export function startShopifyHistoricalImportRollback(args: StartRequest) {
  return startShopifyHistoricalImportOperation({
    ...args,
    operation: "rollback",
  });
}
async function startShopifyHistoricalImportOperation({
  envelope,
  request,
  operation,
}: StartRequest & { operation: "commit" | "rollback" }) {
  const input = (
    operation === "commit"
      ? historicalImportCommitStartSchema
      : historicalImportRollbackStartSchema
  ).parse(request);
  return prisma.$transaction(
    async (tx) => {
      // Authorization acquires the shared store row lock before its first
      // consistent read. All import row writers acquire that same store fence,
      // so this fresh snapshot cannot predate concurrent row completion.
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope,
        permission: "loyalty.configure",
      });
      if (actor.installationGeneration !== input.expectedInstallationGeneration)
        throw new HistoricalImportConflictError();
      const program = await lockLoyaltyProgramRow({
        tx,
        storeId: actor.storeId,
        mode: "active",
      });
      if (program.storeId !== actor.storeId)
        throw new HistoricalImportConflictError();
      const sources = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
      SELECT status FROM WeleticLoyaltyImportSource
      WHERE id = ${input.sourceId} AND storeId = ${actor.storeId} AND programId = ${program.id}
      FOR UPDATE
    `);
      // Merchant start is not worker recovery. Reclaims use a separate audited
      // worker path; an already-started source cannot be restarted from this call.
      if (
        sources.length !== 1 ||
        sources[0].status !== (operation === "commit" ? "preview" : "committed")
      )
        throw new HistoricalImportConflictError();
      const enqueue =
        operation === "commit"
          ? queueHistoricalImportCommitInTransaction
          : queueHistoricalImportRollbackInTransaction;
      const queued = await enqueue({
        tx,
        request: {
          sourceId: input.sourceId,
          storeId: actor.storeId,
          programId: program.id,
          installationGeneration: actor.installationGeneration,
          expectedRevision: input.expectedRevision,
        },
      });
      return {
        ...queued,
        operation,
        storeId: actor.storeId,
        installationGeneration: actor.installationGeneration,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}
