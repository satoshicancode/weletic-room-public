import { z } from "zod";

export const HISTORICAL_IMPORT_MAX_ROWS = 1000;
// Whole-source validation and reconciliation require more than the default
// five-second transaction window. Outer deadlines retain authentication and
// response headroom; none of these operations retries a write automatically.
export const HISTORICAL_IMPORT_TRANSACTION_TIMEOUT_MS = 30_000;
export const HISTORICAL_IMPORT_GATEWAY_TIMEOUT_MS = 35_000;
export const HISTORICAL_IMPORT_CLIENT_TIMEOUT_MS = 40_000;
export const historicalImportContextRequestSchema = z
  .object({ operation: z.literal("context") })
  .strict();
export const historicalImportContextResponseSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(191),
    configure: z.literal(true),
  })
  .strict();
export const HISTORICAL_IMPORT_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const HISTORICAL_IMPORT_MAX_SOURCE_ROWS = 50000;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(191);
export const historicalImportCommitStartSchema = z
  .object({
    operation: z.literal("commit"),
    sourceId: identifier,
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: digest,
  })
  .strict();
export const historicalImportRollbackStartSchema =
  historicalImportCommitStartSchema
    .extend({ operation: z.literal("rollback") })
    .strict();
export const historicalImportExecutionRequestSchema = z.discriminatedUnion(
  "operation",
  [historicalImportCommitStartSchema, historicalImportRollbackStartSchema],
);
export const historicalImportExecutionResponseSchema = z
  .object({
    operation: z.enum(["commit", "rollback"]),
    sourceId: identifier,
    storeId: identifier,
    installationGeneration: z.string().min(1).max(64),
    status: z.enum(["committing", "rolling_back"]),
  })
  .strict();
export function verifyHistoricalImportExecutionResponse(
  request: unknown,
  value: unknown,
) {
  const input = historicalImportExecutionRequestSchema.parse(request);
  const result = historicalImportExecutionResponseSchema.parse(value);
  if (
    result.operation !== input.operation ||
    result.sourceId !== input.sourceId ||
    result.installationGeneration !== input.expectedInstallationGeneration ||
    result.status !==
      (input.operation === "commit" ? "committing" : "rolling_back")
  )
    throw new Error("Invalid import execution acknowledgement");
  return result;
}
export const historicalImportStatusRequestSchema = z
  .object({
    operation: z.literal("status"),
    sourceId: identifier,
    expectedInstallationGeneration: identifier,
  })
  .strict();
export const historicalImportStatusResponseSchema = z
  .object({
    storeId: identifier,
    installationGeneration: identifier,
    sourceInstallationGeneration: identifier,
    sourceId: identifier,
    revision: digest,
    status: z.enum([
      "preview",
      "committing",
      "committed",
      "rolling_back",
      "rolled_back",
      "contained",
      "cancelled",
    ]),
    rowCount: z.number().int().min(1).max(HISTORICAL_IMPORT_MAX_SOURCE_ROWS),
    totalOpeningBalance: z.string().regex(/^(0|[1-9][0-9]{0,29})$/),
    createdAt: z.string().datetime(),
    completedAt: z.string().datetime().nullable(),
    verification: z.literal("source_record_only"),
  })
  .strict();
export function verifyHistoricalImportStatusResponse(
  request: unknown,
  value: unknown,
) {
  const input = historicalImportStatusRequestSchema.parse(request);
  const result = historicalImportStatusResponseSchema.parse(value);
  if (
    result.sourceId !== input.sourceId ||
    result.installationGeneration !== input.expectedInstallationGeneration
  )
    throw new Error("Invalid import status response");
  return result;
}
export const HISTORICAL_IMPORT_HISTORY_PAGE_SIZE = 20;
export const historicalImportReconciliationRequestSchema =
  historicalImportStatusRequestSchema
    .extend({
      operation: z.literal("reconcile"),
      expectedRevision: digest,
    })
    .strict();
const exactAggregate = z.string().regex(/^(0|-?[1-9][0-9]{0,29})$/);
export const historicalImportReconciliationResponseSchema =
  historicalImportStatusResponseSchema
    .extend({
      verification: z.literal("ledger_provenance"),
      reconciled: z.boolean(),
      fullyCommitted: z.boolean(),
      fullyRolledBack: z.boolean(),
      issues: z
        .array(
          z.enum([
            "missing_source_rows",
            "duplicate_ledger_identity",
            "missing_or_reused_ledger_entry",
            "missing_ledger_entry",
            "ledger_provenance_mismatch",
            "reversal_sequence_or_balance_mismatch",
            "duplicate_snapshot",
            "invalid_opening_balance",
            "execution_state_mismatch",
            "unclaimed_ledger_entry",
            "net_points_mismatch",
            "source_state_mismatch",
          ]),
        )
        .max(12),
      importedPoints: exactAggregate,
      reversedPoints: exactAggregate,
      expectedNetPoints: exactAggregate,
      observedNetPoints: exactAggregate,
    })
    .strict();
export function verifyHistoricalImportReconciliationResponse(
  request: unknown,
  value: unknown,
) {
  const input = historicalImportReconciliationRequestSchema.parse(request);
  const result = historicalImportReconciliationResponseSchema.parse(value);
  const imported = BigInt(result.importedPoints);
  const reversed = BigInt(result.reversedPoints);
  const expected = BigInt(result.expectedNetPoints);
  const observed = BigInt(result.observedNetPoints);
  const total = BigInt(result.totalOpeningBalance);
  if (
    result.sourceId !== input.sourceId ||
    result.installationGeneration !== input.expectedInstallationGeneration ||
    result.revision !== input.expectedRevision ||
    result.reconciled !== (result.issues.length === 0) ||
    new Set(result.issues).size !== result.issues.length ||
    imported < BigInt(0) ||
    reversed < BigInt(0) ||
    expected !== imported - reversed ||
    (result.reconciled &&
      (expected !== observed || imported > total || reversed > imported)) ||
    (result.reconciled &&
      result.status === "committed" &&
      !result.fullyCommitted) ||
    (result.reconciled &&
      result.status === "rolled_back" &&
      !result.fullyRolledBack) ||
    (result.reconciled &&
      ["preview", "cancelled"].includes(result.status) &&
      (imported !== BigInt(0) || reversed !== BigInt(0))) ||
    (result.fullyCommitted &&
      (!result.reconciled ||
        result.status !== "committed" ||
        imported !== total ||
        reversed !== BigInt(0))) ||
    (result.fullyRolledBack &&
      (!result.reconciled ||
        result.status !== "rolled_back" ||
        imported !== total ||
        reversed !== imported))
  )
    throw new Error("Invalid import reconciliation response");
  return result;
}
const historyCursorSchema = z
  .object({ createdAt: z.string().datetime(), sourceId: identifier })
  .strict();
export const historicalImportHistoryRequestSchema = z
  .object({
    operation: z.literal("history"),
    expectedInstallationGeneration: identifier,
    before: historyCursorSchema.optional(),
  })
  .strict();
export const historicalImportHistoryResponseSchema = z
  .object({
    storeId: identifier,
    installationGeneration: identifier,
    sources: z
      .array(historicalImportStatusResponseSchema)
      .max(HISTORICAL_IMPORT_HISTORY_PAGE_SIZE),
    nextCursor: historyCursorSchema.nullable(),
  })
  .strict();
export function verifyHistoricalImportHistoryResponse(
  request: unknown,
  value: unknown,
) {
  const input = historicalImportHistoryRequestSchema.parse(request);
  const result = historicalImportHistoryResponseSchema.parse(value);
  const last = result.sources.at(-1);
  const precedes = (
    row: { createdAt: string; sourceId: string },
    boundary: { createdAt: string; sourceId: string },
  ) => {
    const time = Date.parse(row.createdAt) - Date.parse(boundary.createdAt);
    if (time !== 0) return time < 0;
    // Match MySQL BINARY UTF-8 ordering, independent of text collation.
    const a = new TextEncoder().encode(row.sourceId);
    const b = new TextEncoder().encode(boundary.sourceId);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      if (a[index] !== b[index]) return a[index] < b[index];
    }
    return a.length < b.length;
  };
  if (
    result.installationGeneration !== input.expectedInstallationGeneration ||
    result.sources.some(
      (source) =>
        source.storeId !== result.storeId ||
        source.installationGeneration !== result.installationGeneration,
    ) ||
    new Set(result.sources.map((source) => source.sourceId)).size !==
      result.sources.length ||
    result.sources.some(
      (source, index) =>
        (input.before && !precedes(source, input.before)) ||
        (index > 0 && !precedes(source, result.sources[index - 1])),
    ) ||
    (result.nextCursor &&
      (result.sources.length !== HISTORICAL_IMPORT_HISTORY_PAGE_SIZE ||
        result.nextCursor.sourceId !== last?.sourceId ||
        result.nextCursor.createdAt !== last?.createdAt))
  )
    throw new Error("Invalid import history response");
  return result;
}

// Decimal strings preserve precision through JSON and the signed gateway.
// The commit service must additionally check the resulting account balance.
const openingBalance = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      value.length < 19 ||
      (value.length === 19 && value <= "9223372036854775807"),
    {
      message: "Opening balance exceeds signed 64-bit storage",
    },
  );

export const historicalImportBirthdaySchema = z
  .object({
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1),
  })
  .strict()
  .refine(
    ({ month, day }) =>
      day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1],
    {
      message: "Invalid birthday",
    },
  );

export const historicalImportRowSchema = z
  .object({
    shopifyCustomerId: z
      .string()
      .regex(/^gid:\/\/shopify\/Customer\/[1-9][0-9]{0,19}$/),
    openingBalance,
    birthday: historicalImportBirthdaySchema.optional(),
    tierId: identifier.optional(),
  })
  .strict();

export const historicalImportSourceSchema = z
  .object({
    // Hash of the uploaded source bytes, not a filename containing customer data.
    sha256: digest,
    format: z.enum(["csv", "json"]),
  })
  .strict();

export const historicalImportStageRequestSchema = z
  .object({
    operation: z.literal("stage"),
    expectedInstallationGeneration: identifier,
    expectedRevision: digest,
    source: historicalImportSourceSchema,
  })
  .strict();

export const historicalImportInspectRequestSchema = z
  .object({
    operation: z.literal("inspect"),
    expectedInstallationGeneration: identifier,
    source: historicalImportSourceSchema,
  })
  .strict();

export const historicalImportPreviewRequestSchema = z
  .object({
    operation: z.literal("preview"),
    expectedInstallationGeneration: identifier,
    expectedRevision: digest,
    source: historicalImportSourceSchema,
    rows: z
      .array(historicalImportRowSchema)
      .min(1)
      .max(HISTORICAL_IMPORT_MAX_ROWS),
  })
  .strict()
  .superRefine(({ rows }, context) => {
    const customers = new Set<string>();
    rows.forEach((row, index) => {
      if (customers.has(row.shopifyCustomerId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", index, "shopifyCustomerId"],
          message: "Duplicate customer in import",
        });
      }
      customers.add(row.shopifyCustomerId);
    });
  });

export type HistoricalImportRow = z.infer<typeof historicalImportRowSchema>;

export const historicalImportPreparationRequestSchema = z.discriminatedUnion(
  "operation",
  [historicalImportInspectRequestSchema, historicalImportStageRequestSchema],
);
export const historicalImportUploadSchema = z
  .object({
    request: historicalImportPreparationRequestSchema,
    sourceBase64: z
      .string()
      .min(4)
      .max(Math.ceil(HISTORICAL_IMPORT_MAX_SOURCE_BYTES / 3) * 4),
  })
  .strict();
export const historicalImportMerchantRequestSchema = z.union([
  historicalImportUploadSchema,
  z.object({ request: historicalImportContextRequestSchema }).strict(),
  z.object({ request: historicalImportStatusRequestSchema }).strict(),
  z.object({ request: historicalImportHistoryRequestSchema }).strict(),
  z.object({ request: historicalImportReconciliationRequestSchema }).strict(),
  z.object({ request: historicalImportExecutionRequestSchema }).strict(),
]);
const preparationBase = {
  storeId: identifier,
  installationGeneration: identifier,
  revision: digest,
  rowCount: z.number().int().min(1).max(HISTORICAL_IMPORT_MAX_SOURCE_ROWS),
  totalOpeningBalance: z.string().regex(/^(0|[1-9][0-9]{0,29})$/),
};
const signedBalance = z
  .string()
  .refine(
    (value) =>
      /^(0|-?[1-9][0-9]{0,18})$/.test(value) &&
      BigInt(value) >= BigInt("-9223372036854775808") &&
      BigInt(value) <= BigInt("9223372036854775807"),
  );
const previewRow = z
  .object({
    rowNumber: z.number().int().min(1),
    issues: z.array(
      z.enum([
        "customer_unavailable",
        "account_unavailable",
        "tier_unavailable",
        "birthday_conflict",
        "balance_overflow",
      ]),
    ),
    wouldEnroll: z.boolean(),
    balanceBefore: signedBalance.nullable(),
    balanceAfter: signedBalance.nullable(),
  })
  .strict();
const inspectionResponse = z
  .object({
    ...preparationBase,
    source: historicalImportSourceSchema,
    valid: z.boolean(),
    rows: z.array(previewRow).max(HISTORICAL_IMPORT_MAX_SOURCE_ROWS),
  })
  .strict();
const stageResponse = z
  .object({
    ...preparationBase,
    sourceId: identifier,
    source: historicalImportSourceSchema,
    status: z.literal("preview"),
  })
  .strict();
export function verifyHistoricalImportPreparationResponse(
  request: z.infer<typeof historicalImportPreparationRequestSchema>,
  value: unknown,
) {
  if (request.operation === "stage") {
    const result = stageResponse.parse(value);
    if (
      result.installationGeneration !==
        request.expectedInstallationGeneration ||
      result.revision === request.expectedRevision ||
      result.source.sha256 !== request.source.sha256 ||
      result.source.format !== request.source.format
    )
      throw new Error("Invalid import acknowledgement");
    return result;
  }
  const result = inspectionResponse.parse(value);
  if (
    result.installationGeneration !== request.expectedInstallationGeneration ||
    result.source.sha256 !== request.source.sha256 ||
    result.source.format !== request.source.format ||
    result.rows.length !== result.rowCount ||
    result.valid !== result.rows.every((row) => !row.issues.length) ||
    result.rows.some(
      (row, index) =>
        row.rowNumber !== index + 1 ||
        (row.issues.length > 0
          ? row.wouldEnroll ||
            row.balanceBefore !== null ||
            row.balanceAfter !== null
          : row.balanceBefore === null || row.balanceAfter === null),
    )
  )
    throw new Error("Invalid import preview");
  const validRows = result.rows.filter((row) => !row.issues.length);
  const deltas = validRows.map(
    (row) => BigInt(row.balanceAfter!) - BigInt(row.balanceBefore!),
  );
  if (
    deltas.some(
      (delta) => delta < BigInt(0) || delta > BigInt("9223372036854775807"),
    ) ||
    (result.valid &&
      deltas.reduce((sum, delta) => sum + delta, BigInt(0)) !==
        BigInt(result.totalOpeningBalance))
  )
    throw new Error("Invalid import preview accounting");
  return result;
}
export type HistoricalImportPreviewRequest = z.infer<
  typeof historicalImportPreviewRequestSchema
>;
