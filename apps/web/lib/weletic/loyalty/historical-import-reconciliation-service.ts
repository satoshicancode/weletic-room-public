import { Prisma } from "@prisma/client";
import {
  HistoricalImportIntegrityError,
  readVerifiedHistoricalImportInTransaction,
} from "./historical-import-integrity";
import {
  reconcileHistoricalImportLedger,
  type ImportReconciliationRow,
} from "./historical-import-reconciliation";

/** Internal evidence reader. Caller owns authorization and a coherent transaction.
 * Row completion is separate from source status so a fenced finalizer can verify
 * all rows BEFORE marking a source terminal. Never expose these raw flags as
 * merchant-facing completion claims. */
export async function readHistoricalImportExecutionProofInTransaction({
  tx,
  sourceId,
  storeId,
  programId,
}: {
  tx: Prisma.TransactionClient;
  sourceId: string;
  storeId: string;
  programId: string;
}) {
  const { source, snapshots } = await readVerifiedHistoricalImportInTransaction(
    { tx, sourceId, storeId, programId },
  );
  const executions = await tx.weleticLoyaltyImportRowExecution.findMany({
    where: { sourceId },
    take: snapshots.length + 1,
    // Field restoration JSON is checked by the row handler, not this proof.
    select: {
      snapshotId: true,
      sourceId: true,
      storeId: true,
      programId: true,
      accountId: true,
      status: true,
      ledgerEntryId: true,
      reversalLedgerEntryId: true,
    },
  });
  const snapshotIds = new Set(snapshots.map((row) => row.id));
  const bySnapshot = new Map(executions.map((row) => [row.snapshotId, row]));
  if (
    executions.length > snapshots.length ||
    bySnapshot.size !== executions.length ||
    executions.some(
      (row) =>
        row.storeId !== storeId ||
        row.programId !== programId ||
        row.sourceId !== sourceId ||
        !snapshotIds.has(row.snapshotId) ||
        !row.accountId,
    )
  )
    throw new HistoricalImportIntegrityError();
  const snapshotsById = new Map(snapshots.map((row) => [row.id, row]));
  // Read one owner projection per execution in the same coherent transaction.
  // The source index bounds this join; selecting by account IDs in 1,000-row
  // chunks made every full-source rollback proof spend most of its time in
  // repeated account/shopper round trips at 50,000 rows.
  const owners = await tx.$queryRaw<
    Array<{
      snapshotId: string;
      accountId: string;
      accountStoreId: string | null;
      accountProgramId: string | null;
      shopperStoreId: string | null;
      shopifyCustomerId: string | null;
    }>
  >(Prisma.sql`
    SELECT e.snapshotId, e.accountId,
      a.storeId AS accountStoreId, a.programId AS accountProgramId,
      s.storeId AS shopperStoreId, s.shopifyCustomerId
    FROM WeleticLoyaltyImportRowExecution e
    LEFT JOIN WeleticLoyaltyAccount a ON a.id = e.accountId
    LEFT JOIN WeleticShopper s ON s.id = a.shopperId
    WHERE e.sourceId = ${sourceId}
    LIMIT ${snapshots.length + 1}
  `);
  const seenOwners = new Set<string>();
  if (owners.length !== executions.length)
    throw new HistoricalImportIntegrityError();
  for (const owner of owners) {
    const execution = bySnapshot.get(owner.snapshotId);
    const snapshot = snapshotsById.get(owner.snapshotId);
    if (
      !execution ||
      !snapshot ||
      seenOwners.has(owner.snapshotId) ||
      owner.accountId !== execution.accountId ||
      owner.accountStoreId !== storeId ||
      owner.accountProgramId !== programId ||
      owner.shopperStoreId !== storeId ||
      ![
        snapshot.shopifyCustomerId,
        snapshot.shopifyCustomerId.slice("gid://shopify/Customer/".length),
      ].includes(owner.shopifyCustomerId ?? "")
    )
      throw new HistoricalImportIntegrityError();
    seenOwners.add(owner.snapshotId);
  }
  const rows: ImportReconciliationRow[] = snapshots.map((snapshot) => {
    const execution = bySnapshot.get(snapshot.id);
    return {
      snapshotId: snapshot.id,
      accountId: execution?.accountId ?? "",
      openingBalance: snapshot.openingBalance,
      status: execution?.status ?? "pending",
      ledgerEntryId: execution?.ledgerEntryId ?? null,
      reversalLedgerEntryId: execution?.reversalLedgerEntryId ?? null,
    };
  });
  const claimedIds = executions.flatMap((row) =>
    [row.ledgerEntryId, row.reversalLedgerEntryId].filter(
      (id): id is string => id !== null,
    ),
  );
  // Select both claims and source-related entries, so an orphan write cannot be
  // hidden merely by omitting its execution record. Source/snapshot IDs are
  // globally unique. Discover foreign stray writes too, only after source
  // ownership validation; the checker rejects them without returning row data.
  const discovered = await tx.weleticPointsLedgerEntry.findMany({
    where: { metadata: { path: "$.sourceId", equals: sourceId } },
    take: snapshots.length * 2 + 1,
    orderBy: { id: "asc" },
  });
  const byEntryId = new Map(discovered.map((entry) => [entry.id, entry]));
  if (byEntryId.size > snapshots.length * 2)
    throw new HistoricalImportIntegrityError();
  async function loadMissingEntries(ids: string[]) {
    const missing = [...new Set(ids)].filter((id) => !byEntryId.has(id));
    for (let offset = 0; offset < missing.length; offset += 1000) {
      const selected = await tx.weleticPointsLedgerEntry.findMany({
        where: { id: { in: missing.slice(offset, offset + 1000) } },
        take: snapshots.length * 2 + 1,
        orderBy: { id: "asc" },
      });
      for (const entry of selected) byEntryId.set(entry.id, entry);
      if (byEntryId.size > snapshots.length * 2)
        throw new HistoricalImportIntegrityError();
    }
  }
  // The same coherent transaction already loaded metadata-linked entries.
  // Claims still discover entries whose metadata is absent or corrupt.
  await loadMissingEntries(claimedIds);
  // Discover every source snapshot's reference globally, including orphan and
  // foreign writes with missing metadata or claims. The join uses the source
  // and reference indexes rather than fifty separate IN-list round trips.
  // Keep the source-wide sentinel: a corrupt reference may have many entries.
  const referenced = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT l.id FROM WeleticLoyaltyImportRowSnapshot s
    JOIN WeleticPointsLedgerEntry l ON l.referenceId = s.id
      AND l.referenceType IN ('LOYALTY_IMPORT_OPENING_BALANCE', 'LOYALTY_IMPORT_ROLLBACK')
    WHERE s.sourceId = ${sourceId}
    LIMIT ${snapshots.length * 2 + 1}
  `);
  const discoveredIds = referenced.map((entry) => entry.id);
  if (
    new Set([...byEntryId.keys(), ...discoveredIds]).size >
    snapshots.length * 2
  )
    throw new HistoricalImportIntegrityError();
  await loadMissingEntries(discoveredIds);
  if (discoveredIds.some((id) => !byEntryId.has(id)))
    throw new HistoricalImportIntegrityError();
  const entries = [...byEntryId.values()];
  // Do not expose another tenant's amounts, even inside a failed summary.
  if (entries.some((entry) => entry.storeId !== storeId))
    throw new HistoricalImportIntegrityError();
  const result = reconcileHistoricalImportLedger({
    storeId,
    sourceId,
    normalizedSha256: source.normalizedSha256,
    rows,
    entries,
  });
  const stateMatches =
    (source.status !== "committed" || result.fullyCommitted) &&
    (source.status !== "rolled_back" || result.fullyRolledBack) &&
    (!["preview", "cancelled"].includes(source.status) ||
      rows.every(
        (row) =>
          row.status === "pending" &&
          !row.ledgerEntryId &&
          !row.reversalLedgerEntryId,
      ));
  const issues = [
    ...result.issues,
    ...(!stateMatches ? ["source_state_mismatch"] : []),
  ];
  return {
    sourceRevision: source.revision,
    sourceInstallationGeneration: source.installationGeneration,
    normalizedSha256: source.normalizedSha256,
    rowStates: [...new Set(rows.map((row) => row.status))],
    rowsFullyCommitted: result.fullyCommitted,
    rowsFullyRolledBack: result.fullyRolledBack,
    summary: {
      ...result,
      reconciled: result.reconciled && stateMatches,
      fullyCommitted: result.fullyCommitted && source.status === "committed",
      fullyRolledBack:
        result.fullyRolledBack && source.status === "rolled_back",
      issues: issues.sort(),
      rowCount: snapshots.length,
      sourceStatus: source.status,
    },
  };
}

/** Merchant read keeps its existing source-state-aware response contract. */
export async function readHistoricalImportReconciliationInTransaction(
  params: Parameters<typeof readHistoricalImportExecutionProofInTransaction>[0],
) {
  return (await readHistoricalImportExecutionProofInTransaction(params))
    .summary;
}
