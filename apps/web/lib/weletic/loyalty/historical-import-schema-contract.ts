// Read-only release preflight. Never use schema absence as a privacy no-op.
export const IMPORT_SCHEMA_TABLES = [
  "WeleticLoyaltyImportSource",
  "WeleticLoyaltyImportRowSnapshot",
  "WeleticLoyaltyImportRowExecution",
] as const;

export const HISTORICAL_OUTBOX_VALUES = [
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
] as const;
const importValues = ["HISTORICAL_IMPORT_COMMIT", "HISTORICAL_IMPORT_ROLLBACK"];
export const sqlEnum = (values: readonly string[]) =>
  `enum(${values.map((value) => `'${value}'`).join(",")})`;

/** Explicit known lineages only. Append missing labels without renumbering any
 * existing value, including the isolated database's local-only review label.
 * This returns a proposal, not authorization to apply DDL.
 */
export function planImportOutboxEnum(columnType: string) {
  const suffixes = [
    [],
    ["LOYALTY_COMMUNICATION"],
    [...importValues],
    ["LOYALTY_COMMUNICATION", ...importValues],
    [...importValues, "LOYALTY_COMMUNICATION"],
  ];
  const known = [[], ["REVIEW_POINTS_FULFILL"]].flatMap((local) =>
    suffixes.map((suffix) => [
      ...HISTORICAL_OUTBOX_VALUES,
      ...local,
      ...suffix,
    ]),
  );
  const current = known.find((values) => sqlEnum(values) === columnType);
  if (!current) throw new Error("Unrecognized import outbox enum lineage");
  const missing = ["LOYALTY_COMMUNICATION", ...importValues].filter(
    (value) => !current.includes(value),
  );
  return {
    current,
    proposed: [...current, ...missing],
    ready: missing.length === 0,
  };
}

export type ImportSchemaColumn = {
  tableName: string;
  columnName: string;
  columnType: string;
  nullable: string;
  defaultValue: string | null;
  extra: string;
  collationName: string | null;
};
export type ImportSchemaIndex = {
  tableName: string;
  indexName: string;
  columnName: string | null;
  nonUnique: number;
  sequence: number;
  prefixLength: number | null;
};
export type ImportSchemaTable = {
  tableName: string;
  tableType: string;
  engine: string | null;
};
type ExpectedColumn = {
  type: string;
  nullable: string;
  defaultValue: string | null;
};
const col = (
  type: string,
  nullable = false,
  defaultValue: string | null = null,
): ExpectedColumn => ({
  type,
  nullable: nullable ? "YES" : "NO",
  defaultValue,
});
const string = () => col("varchar(191)");
const date = (nullable = false) => col("datetime(3)", nullable);
const created = () => col("datetime(3)", false, "current_timestamp(3)");
export const IMPORT_SCHEMA_COLUMNS: Record<
  string,
  Record<string, ExpectedColumn>
> = {
  WeleticLoyaltyImportSource: {
    id: string(),
    storeId: string(),
    programId: string(),
    installationGeneration: string(),
    sourceSha256: col("varchar(64)"),
    normalizedSha256: col("varchar(64)"),
    sourceFormat: col("varchar(8)"),
    sourceVersion: col("int", false, "1"),
    rowCount: col("int"),
    totalOpeningBalance: col("decimal(30,0)"),
    createdByStaffId: string(),
    status: col(
      sqlEnum([
        "preview",
        "committing",
        "committed",
        "rolling_back",
        "rolled_back",
        "contained",
        "cancelled",
      ]),
      false,
      "preview",
    ),
    revision: col("int", false, "0"),
    leaseId: col("varchar(64)", true),
    leaseExpiresAt: date(true),
    createdAt: created(),
    updatedAt: date(),
    completedAt: date(true),
  },
  WeleticLoyaltyImportRowSnapshot: {
    id: string(),
    sourceId: string(),
    storeId: string(),
    programId: string(),
    rowNumber: col("int"),
    shopifyCustomerId: string(),
    openingBalance: col("bigint"),
    birthdayMonth: col("int", true),
    birthdayDay: col("int", true),
    tierId: col("varchar(191)", true),
    createdAt: created(),
    redactedAt: date(true),
  },
  WeleticLoyaltyImportRowExecution: {
    id: string(),
    sourceId: string(),
    snapshotId: string(),
    storeId: string(),
    programId: string(),
    accountId: string(),
    status: col(
      sqlEnum(["pending", "committed", "rolled_back", "contained"]),
      false,
      "pending",
    ),
    ledgerEntryId: col("varchar(191)", true),
    reversalLedgerEntryId: col("varchar(191)", true),
    ledgerVersionBefore: col("int"),
    ledgerVersionAfter: col("int", true),
    fieldStateBefore: col("json", true),
    fieldStateAfter: col("json", true),
    containmentCode: col("varchar(64)", true),
    committedAt: date(true),
    rolledBackAt: date(true),
    createdAt: created(),
    updatedAt: date(),
  },
};
export const IMPORT_SCHEMA_INDEXES: Record<
  string,
  { unique: boolean; columns: string[] }[]
> = {
  WeleticLoyaltyImportSource: [
    { unique: true, columns: ["id"] },
    { unique: true, columns: ["storeId", "programId", "normalizedSha256"] },
    { unique: false, columns: ["storeId", "createdAt", "id"] },
    { unique: false, columns: ["storeId", "status", "createdAt"] },
    { unique: false, columns: ["status", "leaseExpiresAt"] },
  ],
  WeleticLoyaltyImportRowSnapshot: [
    { unique: true, columns: ["id"] },
    { unique: true, columns: ["sourceId", "rowNumber"] },
    { unique: true, columns: ["sourceId", "shopifyCustomerId"] },
    { unique: false, columns: ["storeId", "shopifyCustomerId"] },
  ],
  WeleticLoyaltyImportRowExecution: [
    { unique: true, columns: ["id"] },
    { unique: true, columns: ["snapshotId"] },
    { unique: true, columns: ["ledgerEntryId"] },
    { unique: true, columns: ["reversalLedgerEntryId"] },
    { unique: false, columns: ["storeId", "accountId"] },
    { unique: false, columns: ["sourceId", "status"] },
  ],
};

export function auditHistoricalImportSchema({
  columns,
  indexes,
  tables,
}: {
  columns: ImportSchemaColumn[];
  indexes: ImportSchemaIndex[];
  tables: ImportSchemaTable[];
}) {
  const issues: string[] = [];
  for (const table of IMPORT_SCHEMA_TABLES) {
    const metadata = tables.filter((item) => item.tableName === table);
    if (
      metadata.length !== 1 ||
      metadata[0].tableType !== "BASE TABLE" ||
      metadata[0].engine !== "InnoDB"
    )
      issues.push(`table:${table}:innodb_required`);
    for (const column of columns.filter((item) => item.tableName === table)) {
      if (!Object.hasOwn(IMPORT_SCHEMA_COLUMNS[table], column.columnName))
        issues.push(`column:${table}:unexpected_column`);
    }
    for (const [name, expected] of Object.entries(
      IMPORT_SCHEMA_COLUMNS[table],
    )) {
      const found = columns.filter(
        (column) => column.tableName === table && column.columnName === name,
      );
      const column = found[0];
      if (
        found.length !== 1 ||
        column.columnType.toLowerCase() !== expected.type ||
        column.nullable !== expected.nullable ||
        column.defaultValue?.toLowerCase() !==
          expected.defaultValue?.toLowerCase() ||
        !["", "DEFAULT_GENERATED"].includes(column.extra) ||
        ((expected.type.startsWith("varchar") ||
          expected.type.startsWith("enum")) &&
          column.collationName !== "utf8mb4_unicode_ci")
      ) {
        issues.push(`column:${table}.${name}`);
      }
    }
    const groups = new Map<string, ImportSchemaIndex[]>();
    for (const index of indexes.filter((index) => index.tableName === table)) {
      groups.set(index.indexName, [
        ...(groups.get(index.indexName) ?? []),
        index,
      ]);
    }
    for (const group of groups.values()) {
      if (group.some((index) => index.nonUnique === 0)) {
        const signature = [...group]
          .sort((a, b) => a.sequence - b.sequence)
          .map((index) => index.columnName)
          .join("+");
        if (
          group.some(
            (index) => index.prefixLength !== null || index.nonUnique !== 0,
          ) ||
          [...group]
            .sort((a, b) => a.sequence - b.sequence)
            .some((index, position) => index.sequence !== position + 1) ||
          !IMPORT_SCHEMA_INDEXES[table].some(
            (expected) =>
              expected.unique && expected.columns.join("+") === signature,
          )
        )
          issues.push(`index:${table}:unexpected_unique`);
      }
    }
    for (const expected of IMPORT_SCHEMA_INDEXES[table]) {
      const matches = [...groups.values()].some((group) => {
        const sorted = [...group].sort((a, b) => a.sequence - b.sequence);
        return (
          sorted.length === expected.columns.length &&
          sorted.every(
            (index, position) =>
              index.sequence === position + 1 &&
              index.columnName === expected.columns[position] &&
              index.nonUnique === (expected.unique ? 0 : 1) &&
              index.prefixLength === null,
          )
        );
      });
      if (!matches) issues.push(`index:${table}.${expected.columns.join("+")}`);
    }
  }
  const jobs = columns.find(
    (column) =>
      column.tableName === "WeleticLoyaltyOutboxJob" &&
      column.columnName === "jobType",
  );
  try {
    if (
      !jobs ||
      jobs.nullable !== "NO" ||
      jobs.defaultValue !== null ||
      jobs.extra !== "" ||
      jobs.collationName !== "utf8mb4_unicode_ci" ||
      !planImportOutboxEnum(jobs.columnType).ready
    )
      issues.push("outbox:missing_import_or_communication_labels");
  } catch {
    issues.push("outbox:unknown_lineage");
  }
  const tier = columns.find(
    (column) =>
      column.tableName === "WeleticLoyaltyTierHistory" &&
      column.columnName === "toTierId",
  );
  if (
    !tier ||
    tier.columnType !== "varchar(191)" ||
    tier.nullable !== "YES" ||
    tier.defaultValue !== null ||
    tier.extra !== "" ||
    tier.collationName !== "utf8mb4_unicode_ci"
  )
    issues.push("tier_history:nullable_destination_required");
  return { ready: issues.length === 0, issues };
}
