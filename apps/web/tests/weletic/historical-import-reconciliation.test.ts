import {
  reconcileHistoricalImportLedger,
  type ImportReconciliationRow,
} from "@/lib/weletic/loyalty/historical-import-reconciliation";
import type { WeleticPointsLedgerEntry } from "@prisma/client";
import { describe, expect, it } from "vitest";

function fixture() {
  const row: ImportReconciliationRow = {
    snapshotId: "snapshot",
    accountId: "account",
    openingBalance: BigInt("9007199254740993"),
    status: "committed",
    ledgerEntryId: "original",
    reversalLedgerEntryId: null,
  };
  const entry: WeleticPointsLedgerEntry = {
    id: "original",
    storeId: "store",
    accountId: "account",
    sequenceNumber: 1,
    entryType: "MANUAL_ADJUSTMENT",
    pointsDelta: row.openingBalance,
    pendingDelta: BigInt(0),
    balanceAfter: row.openingBalance,
    grantId: null,
    referenceType: "LOYALTY_IMPORT_OPENING_BALANCE",
    referenceId: "snapshot",
    idempotencyKey: "loyalty_import_opening:source:snapshot",
    reason: null,
    metadata: {
      sourceId: "source",
      snapshotId: "snapshot",
      normalizedSha256: "a".repeat(64),
    },
    createdAt: new Date(),
  };
  return {
    storeId: "store",
    sourceId: "source",
    normalizedSha256: "a".repeat(64),
    rows: [row],
    entries: [entry],
  };
}
describe("import ledger reconciliation", () => {
  it("reconciles exact integer totals", () => {
    expect(reconcileHistoricalImportLedger(fixture())).toMatchObject({
      reconciled: true,
      fullyCommitted: true,
      expectedNetPoints: "9007199254740993",
      observedNetPoints: "9007199254740993",
    });
  });
  it("reconciles append-only rollback to zero", () => {
    const data = fixture();
    const original = data.entries[0];
    data.rows[0].status = "rolled_back";
    data.rows[0].reversalLedgerEntryId = "reversal";
    data.entries.push({
      ...original,
      id: "reversal",
      sequenceNumber: 2,
      pointsDelta: -original.pointsDelta,
      balanceAfter: BigInt(0),
      referenceType: "LOYALTY_IMPORT_ROLLBACK",
      idempotencyKey: "loyalty_import_rollback:source:snapshot",
      metadata: {
        ...(original.metadata as object),
        originalLedgerEntryId: "original",
      },
    });
    expect(reconcileHistoricalImportLedger(data)).toMatchObject({
      reconciled: true,
      fullyRolledBack: true,
      expectedNetPoints: "0",
      observedNetPoints: "0",
    });
  });
  it.each([
    "missing",
    "extra",
    "wrong_amount",
    "wrong_tenant",
    "wrong_status",
    "duplicate",
  ])("detects %s evidence", (kind) => {
    const data = fixture();
    if (kind === "missing") data.entries = [];
    if (kind === "extra")
      data.entries.push({ ...data.entries[0], id: "extra" });
    if (kind === "wrong_amount") data.entries[0].pointsDelta = BigInt(1);
    if (kind === "wrong_tenant") data.entries[0].storeId = "other";
    if (kind === "wrong_status") data.rows[0].status = "rolled_back";
    if (kind === "duplicate") data.rows.push(data.rows[0]);
    expect(reconcileHistoricalImportLedger(data).reconciled).toBe(false);
  });
  it("does not call pending or empty evidence complete", () => {
    const data = fixture();
    data.rows[0].status = "pending";
    data.rows[0].ledgerEntryId = null;
    data.entries = [];
    expect(reconcileHistoricalImportLedger(data)).toMatchObject({
      reconciled: true,
      fullyCommitted: false,
      fullyRolledBack: false,
    });
    expect(
      reconcileHistoricalImportLedger({ ...data, rows: [] }).reconciled,
    ).toBe(false);
  });
});
