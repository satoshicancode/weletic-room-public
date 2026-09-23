import { Prisma, type WeleticPointsLedgerEntry } from "@prisma/client";
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
  const executionsByAccount = new Map<string, typeof executions>();
  for (const execution of executions) {
    const group = executionsByAccount.get(execution.accountId);
    if (group) group.push(execution);
    else executionsByAccount.set(execution.accountId, [execution]);
  }
  const accountIds = [...executionsByAccount.keys()];
  const snapshotsById = new Map(snapshots.map((row) => [row.id, row]));
  for (let offset = 0; offset < accountIds.length; offset += 1000) {
    const ids = accountIds.slice(offset, offset + 1000);
    const accounts = await tx.weleticLoyaltyAccount.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        storeId: true,
        programId: true,
        shopper: {
          select: { storeId: true, shopifyCustomerId: true },
        },
      },
    });
    const owners = new Map(accounts.map((account) => [account.id, account]));
    for (const accountId of ids) {
      const account = owners.get(accountId);
      const shopper = account?.shopper;
      if (
        !shopper ||
        shopper.storeId !== storeId ||
        !account ||
        account.storeId !== storeId ||
        account.programId !== programId
      )
        throw new HistoricalImportIntegrityError();
      // Visit each execution once, not the entire source for every 1,000-account
      // query. Still validate every snapshot if malformed rows share an account.
      for (const execution of executionsByAccount.get(accountId)!) {
        const snapshot = snapshotsById.get(execution.snapshotId)!;
        if (
          ![
            snapshot.shopifyCustomerId,
            snapshot.shopifyCustomerId.slice("gid://shopify/Customer/".length),
          ].includes(shopper.shopifyCustomerId)
        )
          throw new HistoricalImportIntegrityError();
      }
    }
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
  const maximumSourceEntries = snapshots.length * 2;
  // The first predicate matches the additive generated-column index. Force it because
  // small-table statistics can choose a full scan; the release schema gate
  // must apply the index before this reader is deployed. Keep the exact
  // JSON string predicate too: a cast may truncate malformed long values and
  // must never broaden the source evidence set. This discovery is global so a
  // foreign-store orphan cannot be hidden by a tenant filter.
  const discovered = await tx.$queryRaw<WeleticPointsLedgerEntry[]>(Prisma.sql`
    SELECT * FROM WeleticPointsLedgerEntry FORCE INDEX (wl_import_metadata_source_idx)
    WHERE importSourceId = ${sourceId}
      AND JSON_CONTAINS(metadata, JSON_QUOTE(${sourceId}), '$.sourceId')
    LIMIT ${maximumSourceEntries + 1}
  `);
  if (discovered.length > maximumSourceEntries)
    throw new HistoricalImportIntegrityError();
  const byEntryId = new Map(discovered.map((entry) => [entry.id, entry]));
  const references = [...snapshotIds];
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
  // Discover every reference globally, including orphan/foreign writes, but
  // avoid retransferring full JSON evidence already loaded by another path.
  // Keep the source-wide sentinel: one corrupt reference can have many entries.
  {
    const ids = references;
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const chunk = ids.slice(offset, offset + 1000);
      const selected = await tx.weleticPointsLedgerEntry.findMany({
        where: {
          referenceId: { in: chunk },
          referenceType: {
            in: ["LOYALTY_IMPORT_OPENING_BALANCE", "LOYALTY_IMPORT_ROLLBACK"],
          },
        },
        select: { id: true },
        take: snapshots.length * 2 + 1,
        orderBy: { id: "asc" },
      });
      const discoveredIds = selected.map((entry) => entry.id);
      if (
        new Set([...byEntryId.keys(), ...discoveredIds]).size >
        snapshots.length * 2
      )
        throw new HistoricalImportIntegrityError();
      await loadMissingEntries(discoveredIds);
      if (discoveredIds.some((id) => !byEntryId.has(id)))
        throw new HistoricalImportIntegrityError();
    }
  }
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
