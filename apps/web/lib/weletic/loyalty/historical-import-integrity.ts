import type {
  Prisma,
  WeleticLoyaltyImportRowSnapshot,
  WeleticLoyaltyImportSource,
} from "@prisma/client";
import { historicalImportSourceSchema } from "./historical-import-contract";
import {
  HISTORICAL_IMPORT_MAX_SOURCE_ROWS,
  proveHistoricalImportRows,
} from "./historical-import-source";

export class HistoricalImportIntegrityError extends Error {
  constructor() {
    super("Historical import evidence is unavailable or inconsistent");
    this.name = "HistoricalImportIntegrityError";
  }
}

/**
 * Checks stored normalized evidence, not the original file (which is not kept).
 * No hash is an authorization credential. Caller still fences lifecycle/state.
 */
export function verifyHistoricalImportSnapshots({
  source,
  snapshots,
  storeId,
  programId,
}: {
  source: WeleticLoyaltyImportSource;
  snapshots: WeleticLoyaltyImportRowSnapshot[];
  storeId: string;
  programId: string;
}) {
  try {
    if (
      source.storeId !== storeId ||
      source.programId !== programId ||
      source.sourceVersion !== 1 ||
      !Number.isInteger(source.rowCount) ||
      source.rowCount < 1 ||
      source.rowCount > HISTORICAL_IMPORT_MAX_SOURCE_ROWS ||
      snapshots.length !== source.rowCount ||
      !source.totalOpeningBalance.isInteger() ||
      !/^[a-f0-9]{64}$/.test(source.normalizedSha256)
    )
      throw new HistoricalImportIntegrityError();
    historicalImportSourceSchema.parse({
      format: source.sourceFormat,
      sha256: source.sourceSha256,
    });
    const snapshotIds = new Set<string>();
    const rows = snapshots.map((snapshot, index) => {
      if (
        snapshot.storeId !== storeId ||
        snapshot.programId !== programId ||
        snapshot.sourceId !== source.id ||
        snapshot.rowNumber !== index + 1 ||
        snapshot.redactedAt !== null ||
        !snapshot.id ||
        snapshotIds.has(snapshot.id) ||
        (snapshot.birthdayMonth === null) !== (snapshot.birthdayDay === null)
      )
        throw new HistoricalImportIntegrityError();
      snapshotIds.add(snapshot.id);
      return {
        shopifyCustomerId: snapshot.shopifyCustomerId,
        openingBalance: snapshot.openingBalance.toString(),
        ...(snapshot.birthdayMonth === null
          ? {}
          : {
              birthday: {
                month: snapshot.birthdayMonth,
                day: snapshot.birthdayDay,
              },
            }),
        ...(snapshot.tierId === null ? {} : { tierId: snapshot.tierId }),
      };
    });
    const proof = proveHistoricalImportRows(rows);
    if (
      proof.normalizedSha256 !== source.normalizedSha256 ||
      proof.totalOpeningBalance !== source.totalOpeningBalance.toFixed(0)
    )
      throw new HistoricalImportIntegrityError();
    return proof;
  } catch {
    // Zod errors and damaged record exceptions must not expose stored identities.
    throw new HistoricalImportIntegrityError();
  }
}

/** Bounded read inside the caller's transaction; never returns unverified rows. */
export async function readVerifiedHistoricalImportInTransaction({
  tx,
  sourceId,
  storeId,
  programId,
}: {
  tx: Prisma.TransactionClient;
  sourceId: string;
  storeId: string;
  programId: string;
}) {
  const source = await tx.weleticLoyaltyImportSource.findFirst({
    where: { id: sourceId, storeId, programId },
  });
  if (!source) throw new HistoricalImportIntegrityError();
  const snapshots = await tx.weleticLoyaltyImportRowSnapshot.findMany({
    where: { sourceId },
    orderBy: { rowNumber: "asc" },
    take: HISTORICAL_IMPORT_MAX_SOURCE_ROWS + 1,
  });
  // Deliberately include all source rows in verification so foreign-owner or
  // extra rows are detected rather than hidden by an ownership query filter.
  const proof = verifyHistoricalImportSnapshots({
    source,
    snapshots,
    storeId,
    programId,
  });
  return { source, snapshots, proof };
}
