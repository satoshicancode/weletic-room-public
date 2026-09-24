import { Prisma, PrismaClient } from "@prisma/client";
import {
  auditReviewReleaseSchema,
  REVIEW_RELEASE_MODELS,
  REVIEW_RELEASE_TABLES,
  type ReviewSchemaColumn,
  type ReviewSchemaIndex,
  type ReviewSchemaTable,
} from "../../lib/weletic/reviews/schema-preflight";

/** Metadata-only release check. Use an explicit read-only principal and target.
 * It never applies migrations, starts workers, or reads customer rows.
 */
async function main() {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (url.protocol !== "mysql:" || !url.pathname.slice(1))
    throw new Error("Explicit MySQL database required");
  const client = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const names = [...REVIEW_RELEASE_TABLES];
    const tables = await client.$queryRaw<ReviewSchemaTable[]>(Prisma.sql`
      SELECT TABLE_NAME AS tableName, TABLE_TYPE AS tableType, ENGINE AS engine
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${Prisma.join(names)})
    `);
    const columns = await client.$queryRaw<ReviewSchemaColumn[]>(Prisma.sql`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
        COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
        COLUMN_DEFAULT AS defaultValue
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${Prisma.join(names)})
    `);
    const rawIndexes = await client.$queryRaw<
      Array<
        Omit<ReviewSchemaIndex, "nonUnique" | "sequence" | "prefixLength"> & {
          nonUnique: bigint;
          sequence: bigint;
          prefixLength: bigint | null;
        }
      >
    >(Prisma.sql`
      SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName,
        COLUMN_NAME AS columnName, NON_UNIQUE AS nonUnique,
        SEQ_IN_INDEX AS sequence, SUB_PART AS prefixLength
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${Prisma.join(names)})
    `);
    const modelColumns: Record<string, string[]> = {};
    for (const model of Prisma.dmmf.datamodel.models) {
      const table = model.dbName ?? model.name;
      if (!REVIEW_RELEASE_MODELS.some((name) => name === table)) continue;
      modelColumns[table] = model.fields
        .filter((field) => field.kind !== "object")
        .map((field) => field.dbName ?? field.name);
    }
    const result = auditReviewReleaseSchema({
      tables,
      columns,
      indexes: rawIndexes.map((row) => ({
        ...row,
        nonUnique: Number(row.nonUnique),
        sequence: Number(row.sequence),
        prefixLength:
          row.prefixLength === null ? null : Number(row.prefixLength),
      })),
      modelColumns,
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  } finally {
    await client.$disconnect();
  }
}

main().catch(() => {
  // Driver errors can contain credentials or target names.
  console.error(
    "Review release schema audit unavailable; release remains blocked.",
  );
  process.exitCode = 1;
});
