/** Read-only, necessary release checks for the three PR #101 additive migrations.
 * A passing result still requires target-specific DDL review, mixed-version
 * worker rehearsal and application-level SQL acceptance before writers start.
 */
export const REVIEW_RELEASE_MODELS = [
  "WeleticStoreReviewSettings",
  "WeleticStoreReviewRequest",
  "WeleticStoreReviewRequestLine",
  "WeleticStoreReview",
  "WeleticStoreReviewModerationAudit",
  "WeleticReviewReminder",
  "WeleticShopperDeliveryReservation",
  "WeleticShopperDeliveryIdentity",
] as const;

export const REVIEW_RELEASE_TABLES = [
  ...REVIEW_RELEASE_MODELS,
  "WeleticReviewSettings",
  "WeleticReviewRequest",
  "WeleticMerchantSettings",
  "WeleticLoyaltyOutboxJob",
] as const;

export type ReviewSchemaTable = {
  tableName: string;
  tableType: string;
  engine: string | null;
};
export type ReviewSchemaColumn = {
  tableName: string;
  columnName: string;
  columnType: string;
  nullable: string;
  defaultValue: string | null;
};
export type ReviewSchemaIndex = {
  tableName: string;
  indexName: string;
  columnName: string | null;
  nonUnique: number;
  sequence: number;
  prefixLength: number | null;
};

const additiveColumns: Record<
  string,
  Record<string, { type: string; nullable: string; defaultValue?: string }>
> = {
  WeleticReviewSettings: {
    collectionRevision: { type: "int", nullable: "NO", defaultValue: "0" },
    reminderAfterDays: { type: "json", nullable: "YES" },
  },
  WeleticReviewRequest: {
    reminderSnapshot: { type: "json", nullable: "YES" },
    encryptedReminderToken: { type: "text", nullable: "YES" },
  },
  WeleticMerchantSettings: {
    shopperDeliveryPolicy: { type: "json", nullable: "YES" },
  },
};

const criticalColumns: Record<
  string,
  Record<string, { type: string; nullable: string; defaultValue?: string }>
> = {
  WeleticStoreReviewSettings: {
    enabled: { type: "tinyint(1)", nullable: "NO", defaultValue: "0" },
    requestEmailEnabled: {
      type: "tinyint(1)",
      nullable: "NO",
      defaultValue: "0",
    },
  },
  WeleticStoreReviewRequest: {
    installationGeneration: { type: "varchar(64)", nullable: "NO" },
    status: {
      type: "enum('queued','sending','sent','submitted','expired','cancelled','failed')",
      nullable: "NO",
    },
    tokenHash: { type: "varchar(64)", nullable: "YES" },
    encryptedDeliverySnapshot: { type: "mediumtext", nullable: "YES" },
  },
  WeleticStoreReview: {
    shopperId: { type: "varchar(191)", nullable: "YES" },
    requestId: { type: "varchar(191)", nullable: "YES" },
    source: { type: "enum('invitation','open','imported')", nullable: "NO" },
    status: {
      type: "enum('pending','published','hidden','rejected','redacted')",
      nullable: "NO",
    },
    body: { type: "text", nullable: "NO" },
    merchantReply: { type: "text", nullable: "YES" },
    verifiedPurchase: { type: "tinyint(1)", nullable: "NO", defaultValue: "0" },
    incentivized: { type: "tinyint(1)", nullable: "NO", defaultValue: "0" },
    rewardStatus: {
      type: "enum('pending','awarded','ineligible','reversed','invalidated','recovery_pending','unrecoverable')",
      nullable: "NO",
      defaultValue: "ineligible",
    },
    redactedAt: { type: "datetime(3)", nullable: "YES" },
  },
  WeleticStoreReviewModerationAudit: {
    fromStatus: {
      type: "enum('pending','published','hidden','rejected','redacted')",
      nullable: "NO",
    },
    toStatus: {
      type: "enum('pending','published','hidden','rejected','redacted')",
      nullable: "NO",
    },
  },
  WeleticReviewReminder: {
    encryptedDeliverySnapshot: { type: "mediumtext", nullable: "YES" },
    leaseToken: { type: "varchar(64)", nullable: "YES" },
  },
  WeleticShopperDeliveryReservation: {
    installationGeneration: { type: "varchar(64)", nullable: "NO" },
    contentDigest: { type: "varchar(64)", nullable: "NO" },
    state: {
      type: "enum('attempted','sent')",
      nullable: "NO",
      defaultValue: "attempted",
    },
  },
  WeleticShopperDeliveryIdentity: {
    identityKind: {
      type: "enum('customer_id','customer_email')",
      nullable: "NO",
    },
    identityKeyId: { type: "varchar(64)", nullable: "NO" },
    customerDigest: { type: "varchar(64)", nullable: "NO" },
  },
};

const requiredIndexes: Record<
  string,
  { columns: string[]; unique: boolean }[]
> = {
  WeleticStoreReviewSettings: [{ columns: ["storeId"], unique: true }],
  WeleticStoreReviewRequest: [
    { columns: ["storeId", "orderId"], unique: true },
    { columns: ["storeId", "id"], unique: true },
    { columns: ["tokenHash"], unique: true },
    { columns: ["orderId"], unique: false },
    { columns: ["storeId", "shopperId"], unique: false },
    { columns: ["storeId", "incentivePolicyId"], unique: false },
    { columns: ["storeId", "status", "sendAt", "id"], unique: false },
    { columns: ["status", "deliveryLeaseExpiresAt"], unique: false },
    { columns: ["expiresAt", "id"], unique: false },
  ],
  WeleticStoreReviewRequestLine: [
    { columns: ["requestId", "orderLineId"], unique: true },
    { columns: ["storeId", "requestId"], unique: false },
    { columns: ["orderLineId"], unique: false },
  ],
  WeleticStoreReview: [
    { columns: ["requestId"], unique: true },
    { columns: ["storeId", "id"], unique: true },
    { columns: ["storeId", "requestId"], unique: true },
    { columns: ["storeId", "shopperId"], unique: false },
    { columns: ["storeId", "status", "createdAt", "id"], unique: false },
    { columns: ["storeId", "redactedAt", "id"], unique: false },
  ],
  WeleticStoreReviewModerationAudit: [
    { columns: ["storeId", "reviewId", "toVersion"], unique: true },
    { columns: ["storeId", "createdAt", "id"], unique: false },
    { columns: ["storeId", "redactedAt", "id"], unique: false },
  ],
  WeleticReviewReminder: [
    { columns: ["storeId", "requestId", "sequence"], unique: true },
    { columns: ["status", "scheduledFor", "id"], unique: false },
    { columns: ["status", "updatedAt", "id"], unique: false },
    { columns: ["storeId", "requestId", "status"], unique: false },
  ],
  WeleticShopperDeliveryReservation: [
    { columns: ["storeId", "id"], unique: true },
    { columns: ["storeId", "capacityAt", "id"], unique: false },
  ],
  WeleticShopperDeliveryIdentity: [
    {
      columns: ["storeId", "reservationId", "identityKind", "identityKeyId"],
      unique: true,
    },
    {
      columns: ["storeId", "identityKind", "identityKeyId", "customerDigest"],
      unique: false,
    },
  ],
};

const outboxLabels = [
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
  "LOYALTY_COMMUNICATION",
  "HISTORICAL_IMPORT_COMMIT",
  "HISTORICAL_IMPORT_ROLLBACK",
  "REVIEW_POINTS_RECOVERY",
  "ANONYMOUS_REFERRAL_EMAIL",
];
export const REVIEW_RELEASE_OUTBOX_ENUM = `enum(${outboxLabels.map((label) => `'${label}'`).join(",")})`;

export function auditReviewReleaseSchema({
  tables,
  columns,
  indexes,
  modelColumns,
}: {
  tables: ReviewSchemaTable[];
  columns: ReviewSchemaColumn[];
  indexes: ReviewSchemaIndex[];
  modelColumns: Record<string, string[]>;
}) {
  const issues: string[] = [];
  for (const table of REVIEW_RELEASE_TABLES) {
    const found = tables.filter((row) => row.tableName === table);
    if (
      found.length !== 1 ||
      found[0].tableType !== "BASE TABLE" ||
      found[0].engine?.toLowerCase() !== "innodb"
    ) {
      issues.push(`table:${table}:innodb_required`);
      continue;
    }
    const present = new Set(
      columns
        .filter((row) => row.tableName === table)
        .map((row) => row.columnName),
    );
    if (
      REVIEW_RELEASE_MODELS.includes(
        table as (typeof REVIEW_RELEASE_MODELS)[number],
      ) &&
      !modelColumns[table]
    )
      issues.push(`model:${table}:unavailable`);
    for (const column of modelColumns[table] ?? [])
      if (!present.has(column))
        issues.push(`column:${table}:${column}:missing`);
    for (const [name, spec] of Object.entries({
      ...additiveColumns[table],
      ...criticalColumns[table],
    })) {
      const matching = columns.filter(
        (row) => row.tableName === table && row.columnName === name,
      );
      if (
        matching.length !== 1 ||
        matching[0].columnType.toLowerCase() !== spec.type ||
        matching[0].nullable !== spec.nullable ||
        (spec.defaultValue !== undefined &&
          matching[0].defaultValue !== spec.defaultValue)
      )
        issues.push(`column:${table}:${name}:incompatible`);
    }
  }
  const outbox = columns.filter(
    (row) =>
      row.tableName === "WeleticLoyaltyOutboxJob" &&
      row.columnName === "jobType",
  );
  if (
    outbox.length !== 1 ||
    outbox[0].columnType !== REVIEW_RELEASE_OUTBOX_ENUM ||
    outbox[0].nullable !== "NO"
  )
    issues.push("outbox:jobType:unknown_lineage");
  for (const [table, additional] of Object.entries(requiredIndexes)) {
    const expected = [{ columns: ["id"], unique: true }, ...additional];
    const groups = new Map<string, ReviewSchemaIndex[]>();
    for (const row of indexes.filter((item) => item.tableName === table))
      groups.set(row.indexName, [...(groups.get(row.indexName) ?? []), row]);
    const actual = Array.from(groups.values(), (rows) => ({
      columns: [...rows]
        .sort((a, b) => a.sequence - b.sequence)
        .map((row) => row.columnName),
      unique: rows.every((row) => row.nonUnique === 0),
      full: rows.every((row) => row.prefixLength === null),
    }));
    for (const wanted of expected)
      if (
        !actual.some(
          (candidate) =>
            candidate.full &&
            candidate.unique === wanted.unique &&
            candidate.columns.join("\0") === wanted.columns.join("\0"),
        )
      )
        issues.push(
          `index:${table}:${wanted.columns.join(",")}:missing_or_incompatible`,
        );
  }
  return { ready: issues.length === 0, issues };
}
