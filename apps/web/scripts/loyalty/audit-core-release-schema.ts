import { Prisma, PrismaClient } from "@prisma/client";
/** Metadata only. Deferred tables remain included because shared cleanup and
 * privacy readers still use them. Not a substitute for type/index/DDL review. */
async function main() {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  if (url.protocol !== "mysql:" || !url.pathname.slice(1))
    throw new Error("Explicit target required");
  const db = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    const columns = await db.$queryRaw<
      Array<{ tableName: string; columnName: string }>
    >(
      Prisma.sql`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()`,
    );
    const models = Prisma.dmmf.datamodel.models;
    const missing: string[] = [];
    for (const model of models) {
      const table = model.dbName ?? model.name;
      for (const field of model.fields.filter(
        (field) => field.kind !== "object",
      )) {
        const column = field.dbName ?? field.name;
        if (
          !columns.some(
            (row) => row.tableName === table && row.columnName === column,
          )
        )
          missing.push(`${table}.${column}`);
      }
    }
    const index = await db.$queryRaw<
      Array<{
        columnName: string;
        sequence: bigint | number;
        nonUnique: bigint | number;
        prefixLength: bigint | number | null;
      }>
    >(
      Prisma.sql`SELECT COLUMN_NAME AS columnName, SEQ_IN_INDEX AS sequence, NON_UNIQUE AS nonUnique, SUB_PART AS prefixLength FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='WeleticShopifySubscriptionSnapshot' AND INDEX_NAME='shopify_subscription_installation_key' ORDER BY SEQ_IN_INDEX`,
    );
    const unique =
      index.length === 3 &&
      index.every(
        (row, i) =>
          row.columnName ===
            ["appId", "pendingInstallationId", "installationGeneration"][i] &&
          Number(row.nonUnique) === 0 &&
          row.prefixLength === null,
      );
    const ready = missing.length === 0 && unique;
    console.log(
      JSON.stringify(
        {
          ready,
          missingColumns: missing,
          subscriptionUniqueIndex: unique,
          sharedSchemaApplied: false,
          deploymentAuthorized: false,
          requiresTypeAndEnumAudit: true,
        },
        null,
        2,
      ),
    );
    if (!ready) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  console.error("Core schema inventory unavailable; release remains blocked.");
  process.exitCode = 1;
});
