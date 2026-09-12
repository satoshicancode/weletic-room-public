import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  planImportOutboxEnum,
  sqlEnum,
} from "../../lib/weletic/loyalty/historical-import-schema-contract";

// Narrow ADR 0023 local DDL. Never use prisma db push for this operation.
const url = new URL(process.env.DATABASE_URL || "invalid:");
if (
  url.protocol !== "mysql:" ||
  url.hostname !== "127.0.0.1" ||
  url.port !== "3307" ||
  url.username !== "loyalty_dev" ||
  url.pathname !== "/weletic_loyalty_dev" ||
  url.search ||
  url.hash
)
  throw new Error("Refusing non-isolated import execution schema target");

const tierDdl =
  "ALTER TABLE `WeleticLoyaltyTierHistory` MODIFY COLUMN `toTierId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL";
const client = new PrismaClient({ datasourceUrl: url.toString() });
type Column = {
  tableName: string;
  columnName: string;
  columnType: string;
  nullable: string;
  defaultValue: string | null;
  collationName: string;
  extra: string;
  comment: string;
};
async function readColumns() {
  return client.$queryRaw<Column[]>`
    SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName,
      COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable,
      COLUMN_DEFAULT AS defaultValue, COLLATION_NAME AS collationName,
      EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
      AND ((TABLE_NAME = 'WeleticLoyaltyOutboxJob' AND COLUMN_NAME = 'jobType')
        OR (TABLE_NAME = 'WeleticLoyaltyTierHistory' AND COLUMN_NAME = 'toTierId'))
  `;
}
async function main() {
  const identity = await client.$queryRaw<
    Array<{ name: string; principal: string }>
  >`
    SELECT DATABASE() AS name, CURRENT_USER() AS principal
  `;
  if (
    identity.length !== 1 ||
    identity[0].name !== "weletic_loyalty_dev" ||
    identity[0].principal !== "loyalty_dev@%"
  )
    throw new Error("Unexpected database identity");
  const columns = await readColumns();
  if (
    columns.length !== 2 ||
    columns.some(
      (c) =>
        c.defaultValue !== null ||
        c.collationName !== "utf8mb4_unicode_ci" ||
        c.extra !== "" ||
        c.comment !== "",
    )
  )
    throw new Error("Unexpected column attributes; refusing schema change");
  const jobs = columns.find((c) => c.tableName === "WeleticLoyaltyOutboxJob");
  const tier = columns.find((c) => c.tableName === "WeleticLoyaltyTierHistory");
  if (!jobs || jobs.nullable !== "NO")
    throw new Error("Unexpected outbox enum; refusing schema change");
  // Preserve every ordinal from a recognized lineage. Never overwrite newer
  // communication jobs with the old import-only enum definition.
  const plan = planImportOutboxEnum(jobs.columnType);
  const enumDdl = `ALTER TABLE \`WeleticLoyaltyOutboxJob\` MODIFY COLUMN \`jobType\` ${sqlEnum(plan.proposed)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL`;
  if (
    !tier ||
    tier.columnType !== "varchar(191)" ||
    !["YES", "NO"].includes(tier.nullable)
  )
    throw new Error("Unexpected tier-history column; refusing schema change");
  const statements = [
    ...(!plan.ready ? [enumDdl] : []),
    ...(tier.nullable === "NO" ? [tierDdl] : []),
  ];
  console.log(
    JSON.stringify({
      database: identity[0].name,
      ddlSha256: createHash("sha256")
        .update(statements.join(";\n"))
        .digest("hex"),
      statements,
      apply: process.env.LOYALTY_IMPORT_EXECUTION_SCHEMA_APPLY === "1",
    }),
  );
  if (process.env.LOYALTY_IMPORT_EXECUTION_SCHEMA_APPLY !== "1") return;
  // MySQL DDL implicitly commits. Each independent statement is additive and
  // recognized above on rerun; never claim transactional rollback of this DDL.
  for (const statement of statements) await client.$executeRawUnsafe(statement);
  const after = await readColumns();
  if (
    after.find((c) => c.tableName === "WeleticLoyaltyOutboxJob")?.columnType !==
      sqlEnum(plan.proposed) ||
    after.find((c) => c.tableName === "WeleticLoyaltyTierHistory")?.nullable !==
      "YES"
  )
    throw new Error("Schema readback failed");
  console.log(
    "Verified isolated import execution schema; no application workers started.",
  );
}
main()
  .catch(() => {
    // Prisma errors can embed connection details. Keep CLI errors non-sensitive.
    console.error(
      "Isolated import execution schema check/apply failed. Inspect the validated target before retrying.",
    );
    process.exitCode = 1;
  })
  .finally(() => client.$disconnect());
