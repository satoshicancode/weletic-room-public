import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";

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

const previousValues = [
  "HOLDING_PERIOD_RELEASE",
  "INACTIVITY_EXPIRY",
  "TIER_REVIEW",
  "METAFIELD_SYNC",
  "REDEMPTION_RECOVERY",
  "BIRTHDAY_REWARD",
  "REFERRAL_REWARD_PROVISION",
  "VOUCHER_PRIVACY_CLEANUP",
  "REVIEW_REQUEST_EMAIL",
  "REVIEW_SUMMARY_SYNC",
  "REVIEW_MEDIA_CLEANUP",
  "FLOW_TRIGGER",
  "SHOPPER_REWARD_PROVISION",
  "REVIEW_POINTS_FULFILL",
];
// Retain the pre-existing local-only review value and every enum ordinal.
const nextValues = [
  ...previousValues,
  "HISTORICAL_IMPORT_COMMIT",
  "HISTORICAL_IMPORT_ROLLBACK",
];
const enumType = (values: string[]) =>
  `enum(${values.map((v) => `'${v}'`).join(",")})`;
const enumDdl = `ALTER TABLE \`WeleticLoyaltyOutboxJob\` MODIFY COLUMN \`jobType\` ${enumType(nextValues)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL`;
const tierDdl =
  "ALTER TABLE `WeleticLoyaltyTierHistory` MODIFY COLUMN `toTierId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL";
const ddlSha256 = createHash("sha256")
  .update(`${enumDdl};\n${tierDdl};\n`)
  .digest("hex");
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
  if (
    !jobs ||
    jobs.nullable !== "NO" ||
    ![enumType(previousValues), enumType(nextValues)].includes(jobs.columnType)
  )
    throw new Error("Unexpected outbox enum; refusing schema change");
  if (
    !tier ||
    tier.columnType !== "varchar(191)" ||
    !["YES", "NO"].includes(tier.nullable)
  )
    throw new Error("Unexpected tier-history column; refusing schema change");
  const statements = [
    ...(jobs.columnType === enumType(previousValues) ? [enumDdl] : []),
    ...(tier.nullable === "NO" ? [tierDdl] : []),
  ];
  console.log(
    JSON.stringify({
      database: identity[0].name,
      ddlSha256,
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
      enumType(nextValues) ||
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
