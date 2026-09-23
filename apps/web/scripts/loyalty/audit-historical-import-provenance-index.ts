import { PrismaClient } from "@prisma/client";
import {
  auditHistoricalImportProvenanceIndex,
  type ProvenanceLedgerTable,
  type ProvenanceSourceColumn,
  type ProvenanceSourceIndex,
} from "../../lib/weletic/loyalty/historical-import-provenance-index-contract";

// Require a selected database; the operator supplies a read-only credential.
// Never load .env, apply DDL, start a worker, read a customer row, or print a
// driver error.
async function main() {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (url.protocol !== "mysql:" || !url.pathname.slice(1))
    throw new Error("Explicit MySQL database required");
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const tables = await client.$queryRaw<ProvenanceLedgerTable[]>`
      SELECT TABLE_TYPE AS tableType, ENGINE AS engine
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'WeleticPointsLedgerEntry'
    `;
    const columns = await client.$queryRaw<ProvenanceSourceColumn[]>`
      SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
        COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
        COLLATION_NAME AS collationName,
        GENERATION_EXPRESSION AS generationExpression
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'WeleticPointsLedgerEntry'
        AND COLUMN_NAME = 'importSourceId'
    `;
    const rawIndexes = await client.$queryRaw<
      Array<
        Omit<
          ProvenanceSourceIndex,
          "nonUnique" | "sequence" | "prefixLength"
        > & {
          nonUnique: bigint;
          sequence: bigint;
          prefixLength: bigint | null;
        }
      >
    >`
      SELECT COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique,
        SEQ_IN_INDEX AS sequence, SUB_PART AS prefixLength,
        INDEX_TYPE AS indexType, IS_VISIBLE AS visible
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'WeleticPointsLedgerEntry'
        AND INDEX_NAME = 'wl_import_metadata_source_idx'
    `;
    const result = auditHistoricalImportProvenanceIndex({
      tables,
      columns,
      indexes: rawIndexes.map((index) => ({
        ...index,
        nonUnique: Number(index.nonUnique),
        sequence: Number(index.sequence),
        prefixLength:
          index.prefixLength === null ? null : Number(index.prefixLength),
      })),
    });
    if (!result.ready) {
      console.log(JSON.stringify({ ...result, queryPrepared: false }));
      process.exitCode = 1;
      return;
    }
    // LIMIT 0 prepares the exact reader predicate and named index without
    // returning or inspecting customer ledger rows.
    await client.$queryRaw`
      SELECT id FROM WeleticPointsLedgerEntry FORCE INDEX (wl_import_metadata_source_idx)
      WHERE importSourceId = ${"audit-no-match"}
        AND JSON_CONTAINS(metadata, JSON_QUOTE(${"audit-no-match"}), '$.sourceId')
      LIMIT 0
    `;
    console.log(JSON.stringify({ ...result, queryPrepared: true }));
  } finally {
    await client.$disconnect();
  }
}

main().catch(() => {
  console.error("Provenance index audit unavailable; release remains blocked.");
  process.exitCode = 1;
});
