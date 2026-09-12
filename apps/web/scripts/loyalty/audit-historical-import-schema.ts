import { PrismaClient } from "@prisma/client";
import {
  auditHistoricalImportSchema,
  type ImportSchemaColumn,
  type ImportSchemaIndex,
  type ImportSchemaTable,
} from "../../lib/weletic/loyalty/historical-import-schema-contract";

// No DDL, customer reads, worker startup, or automatic repair. Use a read-only
// account and an explicit environment; never load a neighboring .env file.
async function main() {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (url.protocol !== "mysql:" || !url.pathname.slice(1))
    throw new Error("Explicit MySQL database required");
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const tables = await client.$queryRaw<ImportSchemaTable[]>`
      SELECT TABLE_NAME AS tableName, TABLE_TYPE AS tableType, ENGINE AS engine
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('WeleticLoyaltyImportSource',
          'WeleticLoyaltyImportRowSnapshot', 'WeleticLoyaltyImportRowExecution')
    `;
    const columns = await client.$queryRaw<ImportSchemaColumn[]>`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
        COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
        COLUMN_DEFAULT AS defaultValue, EXTRA AS extra,
        COLLATION_NAME AS collationName
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('WeleticLoyaltyImportSource',
          'WeleticLoyaltyImportRowSnapshot', 'WeleticLoyaltyImportRowExecution',
          'WeleticLoyaltyOutboxJob', 'WeleticLoyaltyTierHistory')
    `;
    const rawIndexes = await client.$queryRaw<
      Array<
        Omit<ImportSchemaIndex, "nonUnique" | "sequence" | "prefixLength"> & {
          nonUnique: bigint;
          sequence: bigint;
          prefixLength: bigint | null;
        }
      >
    >`
      SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
        COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique,
        SEQ_IN_INDEX AS sequence, SUB_PART AS prefixLength
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('WeleticLoyaltyImportSource',
          'WeleticLoyaltyImportRowSnapshot', 'WeleticLoyaltyImportRowExecution')
    `;
    const result = auditHistoricalImportSchema({
      columns,
      tables,
      indexes: rawIndexes.map((index) => ({
        ...index,
        nonUnique: Number(index.nonUnique),
        sequence: Number(index.sequence),
        prefixLength:
          index.prefixLength === null ? null : Number(index.prefixLength),
      })),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}
main().catch(() => {
  // Do not print database URLs, raw driver errors, or credentials.
  console.error("Import schema audit unavailable; release remains blocked.");
  process.exitCode = 1;
});
