import { Prisma } from "@prisma/client";
import {
  HISTORICAL_IMPORT_HISTORY_PAGE_SIZE,
  historicalImportHistoryRequestSchema,
  historicalImportPreparationRequestSchema,
  historicalImportReconciliationRequestSchema,
  historicalImportStatusRequestSchema,
  historicalImportStatusResponseSchema,
  verifyHistoricalImportHistoryResponse,
  verifyHistoricalImportReconciliationResponse,
} from "../loyalty/historical-import-contract";
import {
  HistoricalImportConflictError,
  historicalImportRevision,
  inspectHistoricalImportSourceInTransaction,
  stageHistoricalImportInTransaction,
} from "../loyalty/historical-import-persistence";
import { readHistoricalImportReconciliationInTransaction } from "../loyalty/historical-import-reconciliation-service";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

export { historicalImportPreparationRequestSchema } from "../loyalty/historical-import-contract";

/** Reuses the current actor's status fence, then independently checks ledger
 * provenance in the SAME repeatable-read transaction. Does not audit wallet caches. */
export async function reconcileShopifyHistoricalImportInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const input = historicalImportReconciliationRequestSchema.parse(request);
  const status = await readShopifyImportStatusInTransaction({
    tx,
    envelope,
    request: {
      operation: "status",
      sourceId: input.sourceId,
      expectedInstallationGeneration: input.expectedInstallationGeneration,
    },
  });
  if (status.revision !== input.expectedRevision)
    throw new HistoricalImportConflictError();
  const source = await tx.weleticLoyaltyImportSource.findFirst({
    where: { id: input.sourceId, storeId: status.storeId },
    select: { programId: true },
  });
  if (!source) throw new HistoricalImportConflictError();
  const evidence = await readHistoricalImportReconciliationInTransaction({
    tx,
    sourceId: input.sourceId,
    storeId: status.storeId,
    programId: source.programId,
  });
  if (
    evidence.rowCount !== status.rowCount ||
    evidence.sourceStatus !== status.status
  )
    throw new HistoricalImportConflictError();
  const {
    sourceStatus: _sourceStatus,
    rowCount: _rowCount,
    ...summary
  } = evidence;
  return verifyHistoricalImportReconciliationResponse(input, {
    ...status,
    ...summary,
    verification: "ledger_provenance",
  });
}
const statusSelect = {
  id: true,
  storeId: true,
  programId: true,
  installationGeneration: true,
  normalizedSha256: true,
  revision: true,
  status: true,
  rowCount: true,
  totalOpeningBalance: true,
  createdAt: true,
  completedAt: true,
} as const;

export async function readShopifyImportHistoryInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const input = historicalImportHistoryRequestSchema.parse(request);
  const context = await readShopifyImportContextInTransaction({ tx, envelope });
  if (context.installationGeneration !== input.expectedInstallationGeneration)
    throw new HistoricalImportConflictError();
  const boundary = input.before
    ? Prisma.sql`AND (
    createdAt < ${new Date(input.before.createdAt)} OR
    (createdAt = ${new Date(input.before.createdAt)} AND BINARY id < BINARY ${input.before.sourceId})
  )`
    : Prisma.empty;
  // Explicit byte ordering prevents mixed-case IDs from inheriting the
  // deployment's text collation. Fetch metadata separately for Prisma Decimal.
  const selected = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticLoyaltyImportSource
    WHERE storeId = ${context.storeId} ${boundary}
    ORDER BY createdAt DESC, BINARY id DESC
    LIMIT ${HISTORICAL_IMPORT_HISTORY_PAGE_SIZE + 1}
  `);
  const ids = selected.map((row) => row.id);
  if (
    ids.length > HISTORICAL_IMPORT_HISTORY_PAGE_SIZE + 1 ||
    new Set(ids).size !== ids.length
  )
    throw new HistoricalImportConflictError();
  const fetched = ids.length
    ? await tx.weleticLoyaltyImportSource.findMany({
        where: { storeId: context.storeId, id: { in: ids } },
        take: HISTORICAL_IMPORT_HISTORY_PAGE_SIZE + 1,
        select: statusSelect,
      })
    : [];
  const byId = new Map(fetched.map((source) => [source.id, source]));
  if (
    fetched.length !== ids.length ||
    byId.size !== ids.length ||
    ids.some((id) => !byId.has(id))
  )
    throw new HistoricalImportConflictError();
  const records = ids.map((id) => byId.get(id)!);
  if (records.some((source) => source.storeId !== context.storeId))
    throw new HistoricalImportConflictError();
  const programIds = [...new Set(records.map((source) => source.programId))];
  const programs = programIds.length
    ? await tx.weleticLoyaltyProgram.findMany({
        where: { storeId: context.storeId, id: { in: programIds } },
        select: { id: true },
      })
    : [];
  const owned = new Set(programs.map((program) => program.id));
  if (programIds.some((id) => !owned.has(id)))
    throw new HistoricalImportConflictError();
  const sources = records
    .slice(0, HISTORICAL_IMPORT_HISTORY_PAGE_SIZE)
    .map((source) => serializeImportStatus(source, context));
  const last = sources.at(-1);
  return verifyHistoricalImportHistoryResponse(input, {
    storeId: context.storeId,
    installationGeneration: context.installationGeneration,
    sources,
    nextCursor:
      records.length > HISTORICAL_IMPORT_HISTORY_PAGE_SIZE && last
        ? { sourceId: last.sourceId, createdAt: last.createdAt }
        : null,
  });
}

/** Read source-record state only, not proof of ledger reconciliation. Historical
 * installations remain readable; this operation never resumes their writers. */
export async function readShopifyImportStatusInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const input = historicalImportStatusRequestSchema.parse(request);
  const context = await readShopifyImportContextInTransaction({ tx, envelope });
  if (context.installationGeneration !== input.expectedInstallationGeneration)
    throw new HistoricalImportConflictError();
  const source = await tx.weleticLoyaltyImportSource.findFirst({
    where: { id: input.sourceId, storeId: context.storeId },
    select: statusSelect,
  });
  if (
    !source ||
    source.id !== input.sourceId ||
    source.storeId !== context.storeId
  )
    throw new HistoricalImportConflictError();
  const program = await tx.weleticLoyaltyProgram.findFirst({
    where: { id: source.programId, storeId: context.storeId },
    select: { id: true },
  });
  if (!program) throw new HistoricalImportConflictError();
  return serializeImportStatus(source, context);
}
function serializeImportStatus(
  source: Prisma.WeleticLoyaltyImportSourceGetPayload<{
    select: typeof statusSelect;
  }>,
  context: { storeId: string; installationGeneration: string },
) {
  return historicalImportStatusResponseSchema.parse({
    storeId: context.storeId,
    installationGeneration: context.installationGeneration,
    sourceInstallationGeneration: source.installationGeneration,
    sourceId: source.id,
    revision: historicalImportRevision({
      storeId: context.storeId,
      programId: source.programId,
      installationGeneration: context.installationGeneration,
      normalizedSha256: source.normalizedSha256,
      source,
    }),
    status: source.status,
    rowCount: source.rowCount,
    totalOpeningBalance: source.totalOpeningBalance.toFixed(),
    createdAt: source.createdAt.toISOString(),
    completedAt: source.completedAt?.toISOString() ?? null,
    verification: "source_record_only",
  });
}

export async function readShopifyImportContextInTransaction({
  tx,
  envelope,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
}) {
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "loyalty.configure",
  });
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: { projectId: true },
  });
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId: actor.storeId,
    expectedInstallationGeneration: actor.installationGeneration,
    action: "loyalty_import_context",
  });
  return {
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    configure: true as const,
  };
}

/** Internal gateway primitive. Caller verifies the signature over actor,
 * operation and upload bytes, then runs this inside one transaction.
 * Staging grants no authority to commit balances.
 */
export async function prepareShopifyHistoricalImportInTransaction({
  tx,
  envelope,
  request,
  bytes,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
  bytes: Uint8Array;
}) {
  const data = historicalImportPreparationRequestSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "loyalty.configure",
  });
  if (data.expectedInstallationGeneration !== actor.installationGeneration)
    throw new HistoricalImportConflictError();
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: { projectId: true },
  });
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  // Even inspection must not become a way to resolve shopper data for frozen
  // installations. Both operations recheck the current lifecycle fence.
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId: actor.storeId,
    expectedInstallationGeneration: actor.installationGeneration,
    action: "loyalty_import_preparation",
  });
  const scope = {
    tx,
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    request: data,
    bytes,
  };
  const result =
    data.operation === "inspect"
      ? await inspectHistoricalImportSourceInTransaction(scope)
      : await stageHistoricalImportInTransaction({
          ...scope,
          staffId: actor.shopifyUserId,
        });
  return {
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    ...result,
  };
}
