import { createWeleticId } from "@/lib/weletic/ids";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  HISTORICAL_IMPORT_MAX_ROWS,
  historicalImportInspectRequestSchema,
  historicalImportStageRequestSchema,
} from "./historical-import-contract";
import { inspectHistoricalImportPreview } from "./historical-import-preview";
import { parseHistoricalImportSource } from "./historical-import-source";
import { lockLoyaltyProgramRow } from "./program-write-fence";

export class HistoricalImportConflictError extends Error {
  constructor() {
    super("Historical import state changed");
    this.name = "HistoricalImportConflictError";
  }
}

type SourceState = {
  id: string;
  revision: number;
  status: string;
  installationGeneration: string;
} | null;

/** Authenticated caller holds the store/session fence; no source or wallet write. */
export async function inspectHistoricalImportSourceInTransaction({
  tx,
  storeId,
  installationGeneration,
  request,
  bytes,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string;
  request: unknown;
  bytes: Uint8Array;
}) {
  const input = historicalImportInspectRequestSchema.parse(request);
  if (input.expectedInstallationGeneration !== installationGeneration)
    throw new HistoricalImportConflictError();
  const parsed = parseHistoricalImportSource({ bytes, source: input.source });
  const program = await lockLoyaltyProgramRow({ tx, storeId, mode: "active" });
  const where = {
    storeId,
    programId: program.id,
    normalizedSha256: parsed.normalizedSha256,
  };
  const existing = await tx.weleticLoyaltyImportSource.findUnique({
    where: { storeId_programId_normalizedSha256: where },
  });
  const revision = historicalImportRevision({
    ...where,
    installationGeneration,
    source: existing,
  });
  // Do not expose an earlier source's state or offer to overwrite its provenance.
  if (existing) throw new HistoricalImportConflictError();
  const results: Awaited<
    ReturnType<typeof inspectHistoricalImportPreview>
  >["rows"] = [];
  for (
    let offset = 0;
    offset < parsed.rows.length;
    offset += HISTORICAL_IMPORT_MAX_ROWS
  ) {
    const preview = await inspectHistoricalImportPreview({
      tx,
      storeId,
      programId: program.id,
      request: {
        operation: "preview",
        expectedInstallationGeneration: installationGeneration,
        expectedRevision: revision,
        source: input.source,
        rows: parsed.rows.slice(offset, offset + HISTORICAL_IMPORT_MAX_ROWS),
      },
    });
    results.push(
      ...preview.rows.map((row) => ({
        ...row,
        rowNumber: row.rowNumber + offset,
      })),
    );
  }
  return {
    revision,
    source: parsed.source,
    rowCount: parsed.rows.length,
    totalOpeningBalance: parsed.totalOpeningBalance,
    valid: results.every((row) => !row.issues.length),
    rows: results,
  };
}
export function historicalImportRevision({
  storeId,
  programId,
  installationGeneration,
  normalizedSha256,
  source,
}: {
  storeId: string;
  programId: string;
  installationGeneration: string;
  normalizedSha256: string;
  source: SourceState;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        storeId,
        programId,
        installationGeneration,
        normalizedSha256,
        source: source
          ? {
              id: source.id,
              revision: source.revision,
              status: source.status,
              installationGeneration: source.installationGeneration,
            }
          : null,
      }),
    )
    .digest("hex");
}

/**
 * Caller holds the authenticated store/session lifecycle lock in one transaction
 * and has authorized loyalty configuration plus operational writes. This service
 * locks store -> program, stages only source evidence, and never posts points.
 */
export async function stageHistoricalImportInTransaction({
  tx,
  storeId,
  installationGeneration,
  staffId,
  request,
  bytes,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string;
  staffId: string;
  request: unknown;
  bytes: Uint8Array;
}) {
  const input = historicalImportStageRequestSchema.parse(request);
  if (input.expectedInstallationGeneration !== installationGeneration)
    throw new HistoricalImportConflictError();
  if (!staffId || staffId.length > 191)
    throw new Error("Historical import staff authority unavailable");
  // Derive every stored value from verified bytes, never from browser row arrays.
  const parsed = parseHistoricalImportSource({ bytes, source: input.source });
  const program = await lockLoyaltyProgramRow({ tx, storeId, mode: "active" });
  const where = {
    storeId,
    programId: program.id,
    normalizedSha256: parsed.normalizedSha256,
  };
  const existing = await tx.weleticLoyaltyImportSource.findUnique({
    where: { storeId_programId_normalizedSha256: where },
  });
  const currentRevision = historicalImportRevision({
    ...where,
    installationGeneration,
    source: existing,
  });
  // A repeat upload must not overwrite the first file's source provenance.
  if (existing || currentRevision !== input.expectedRevision)
    throw new HistoricalImportConflictError();

  // Do not persist customer identities/birthdays that privacy handling excludes.
  // Caller transaction must roll back if any batch fails; no partial upload exists.
  for (
    let offset = 0;
    offset < parsed.rows.length;
    offset += HISTORICAL_IMPORT_MAX_ROWS
  ) {
    const preview = await inspectHistoricalImportPreview({
      tx,
      storeId,
      programId: program.id,
      request: {
        operation: "preview",
        expectedInstallationGeneration: installationGeneration,
        expectedRevision: currentRevision,
        source: input.source,
        rows: parsed.rows.slice(offset, offset + HISTORICAL_IMPORT_MAX_ROWS),
      },
    });
    if (!preview.valid)
      throw new Error("Historical import contains unavailable rows");
  }
  const sourceId = createWeleticId("wlimp_");
  const stored = await tx.weleticLoyaltyImportSource.create({
    data: {
      id: sourceId,
      ...where,
      installationGeneration,
      sourceSha256: parsed.source.sha256,
      sourceFormat: parsed.source.format,
      sourceVersion: 1,
      rowCount: parsed.rows.length,
      totalOpeningBalance: parsed.totalOpeningBalance,
      createdByStaffId: staffId,
      status: "preview",
      revision: 0,
    },
  });
  for (
    let offset = 0;
    offset < parsed.rows.length;
    offset += HISTORICAL_IMPORT_MAX_ROWS
  ) {
    const rows = parsed.rows.slice(offset, offset + HISTORICAL_IMPORT_MAX_ROWS);
    const result = await tx.weleticLoyaltyImportRowSnapshot.createMany({
      data: rows.map((row, index) => ({
        id: createWeleticId("wlimpr_"),
        sourceId,
        storeId,
        programId: program.id,
        rowNumber: offset + index + 1,
        shopifyCustomerId: row.shopifyCustomerId,
        openingBalance: BigInt(row.openingBalance),
        birthdayMonth: row.birthday?.month ?? null,
        birthdayDay: row.birthday?.day ?? null,
        tierId: row.tierId ?? null,
      })),
    });
    if (result.count !== rows.length)
      throw new Error("Historical import snapshot incomplete");
  }
  return {
    sourceId,
    source: parsed.source,
    rowCount: parsed.rows.length,
    totalOpeningBalance: parsed.totalOpeningBalance,
    revision: historicalImportRevision({
      ...where,
      installationGeneration,
      source: stored,
    }),
    status: "preview" as const,
  };
}
