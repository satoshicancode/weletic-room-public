import type { WeleticPointsLedgerEntry } from "@prisma/client";

export type ImportReconciliationRow = {
  snapshotId: string;
  accountId: string;
  openingBalance: bigint;
  status: "pending" | "committed" | "rolled_back" | "contained";
  ledgerEntryId: string | null;
  reversalLedgerEntryId: string | null;
};

/**
 * Independent arithmetic/provenance check. Caller supplies the complete,
 * tenant-scoped ledger selection and verified source/execution rows; an empty
 * or partial selection is not evidence of a completed import.
 */
export function reconcileHistoricalImportLedger({
  storeId,
  sourceId,
  normalizedSha256,
  rows,
  entries,
}: {
  storeId: string;
  sourceId: string;
  normalizedSha256: string;
  rows: ImportReconciliationRow[];
  entries: WeleticPointsLedgerEntry[];
}) {
  const issues = new Set<string>();
  if (!rows.length) issues.add("missing_source_rows");
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) issues.add("duplicate_ledger_identity");
  const used = new Set<string>();
  const snapshots = new Set<string>();
  let expectedNet = BigInt(0);
  let observedNet = BigInt(0);
  let totalImported = BigInt(0);
  let totalReversed = BigInt(0);
  function verify(
    row: ImportReconciliationRow,
    id: string | null,
    reversal: boolean,
  ) {
    if (!id || used.has(id)) {
      issues.add("missing_or_reused_ledger_entry");
      return;
    }
    used.add(id);
    const entry = byId.get(id);
    if (!entry) {
      issues.add("missing_ledger_entry");
      return;
    }
    const metadata = entry.metadata;
    if (
      entry.storeId !== storeId ||
      entry.accountId !== row.accountId ||
      entry.entryType !== "MANUAL_ADJUSTMENT" ||
      entry.referenceType !==
        (reversal
          ? "LOYALTY_IMPORT_ROLLBACK"
          : "LOYALTY_IMPORT_OPENING_BALANCE") ||
      entry.referenceId !== row.snapshotId ||
      entry.pointsDelta !==
        (reversal ? -row.openingBalance : row.openingBalance) ||
      entry.pendingDelta !== BigInt(0) ||
      entry.grantId !== null ||
      entry.idempotencyKey !==
        `loyalty_import_${reversal ? "rollback" : "opening"}:${sourceId}:${row.snapshotId}` ||
      !metadata ||
      typeof metadata !== "object" ||
      Array.isArray(metadata) ||
      metadata.sourceId !== sourceId ||
      metadata.snapshotId !== row.snapshotId ||
      metadata.normalizedSha256 !== normalizedSha256 ||
      (reversal && metadata.originalLedgerEntryId !== row.ledgerEntryId)
    )
      issues.add("ledger_provenance_mismatch");
    if (reversal) {
      const original = row.ledgerEntryId ? byId.get(row.ledgerEntryId) : null;
      if (
        !original ||
        entry.sequenceNumber !== original.sequenceNumber + 1 ||
        entry.balanceAfter !== original.balanceAfter - row.openingBalance
      )
        issues.add("reversal_sequence_or_balance_mismatch");
    }
  }
  for (const row of rows) {
    if (snapshots.has(row.snapshotId)) issues.add("duplicate_snapshot");
    snapshots.add(row.snapshotId);
    if (row.openingBalance < BigInt(0)) issues.add("invalid_opening_balance");
    if (
      (row.status === "pending" &&
        (row.ledgerEntryId || row.reversalLedgerEntryId)) ||
      (row.status === "committed" &&
        (!row.ledgerEntryId || row.reversalLedgerEntryId)) ||
      (row.status === "rolled_back" &&
        (!row.ledgerEntryId || !row.reversalLedgerEntryId)) ||
      (row.status === "contained" && row.reversalLedgerEntryId)
    )
      issues.add("execution_state_mismatch");
    if (row.ledgerEntryId) {
      verify(row, row.ledgerEntryId, false);
      expectedNet += row.openingBalance;
      totalImported += row.openingBalance;
    }
    if (row.reversalLedgerEntryId) {
      verify(row, row.reversalLedgerEntryId, true);
      expectedNet -= row.openingBalance;
      totalReversed += row.openingBalance;
    }
  }
  for (const entry of entries) {
    observedNet += entry.pointsDelta;
    if (!used.has(entry.id)) issues.add("unclaimed_ledger_entry");
  }
  if (observedNet !== expectedNet) issues.add("net_points_mismatch");
  return {
    reconciled: issues.size === 0,
    fullyCommitted:
      issues.size === 0 &&
      rows.length > 0 &&
      rows.every((row) => row.status === "committed"),
    fullyRolledBack:
      issues.size === 0 &&
      rows.length > 0 &&
      rows.every((row) => row.status === "rolled_back"),
    issues: [...issues].sort(),
    importedPoints: totalImported.toString(),
    reversedPoints: totalReversed.toString(),
    expectedNetPoints: expectedNet.toString(),
    observedNetPoints: observedNet.toString(),
  };
}
