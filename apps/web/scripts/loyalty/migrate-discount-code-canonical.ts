import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { canonicalizeLoyaltyDiscountCode } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

const COLLISION_ISSUE_KIND = "loyalty_discount_code_canonical_collision";
const INVALID_ISSUE_KIND = "loyalty_discount_code_canonical_invalid";
const CANONICAL_MIGRATION_ISSUE_KINDS = [
  COLLISION_ISSUE_KIND,
  INVALID_ISSUE_KIND,
] as const;
const CANONICAL_WRITE_OUTBOX_JOB_TYPES = [
  "REDEMPTION_RECOVERY",
  "REFERRAL_REWARD_PROVISION",
  "VOUCHER_PRIVACY_CLEANUP",
] as const;
const BLOCKING_OUTBOX_JOB_STATUSES = [
  "pending",
  "processing",
  "failed",
  "dead_letter",
] as const;
export const DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE =
  "loyalty-writers-paused-and-drained";

export type DiscountCodeMigrationRow = {
  id: string;
  storeId: string;
  shopifyDiscountCode: string;
  shopifyDiscountCodeCanonical?: string | null;
  settlementQuarantinedAt?: Date | null;
  settlementQuarantineReason?: string | null;
};

export type DiscountCodeAuditGroup = {
  storeId: string;
  canonicalCode: string;
  redemptionIds: string[];
};

export function auditCanonicalDiscountCodes(
  rows: readonly DiscountCodeMigrationRow[],
) {
  const groups = new Map<string, DiscountCodeAuditGroup>();
  const canonicalByRedemptionId = new Map<string, string>();
  const invalidRows: Array<{ id: string; storeId: string; error: string }> = [];

  for (const row of rows) {
    let canonicalCode: string;
    try {
      canonicalCode = canonicalizeLoyaltyDiscountCode(row.shopifyDiscountCode);
    } catch (error) {
      invalidRows.push({
        id: row.id,
        storeId: row.storeId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    canonicalByRedemptionId.set(row.id, canonicalCode);
    const key = JSON.stringify([row.storeId, canonicalCode]);
    const group = groups.get(key) ?? {
      storeId: row.storeId,
      canonicalCode,
      redemptionIds: [],
    };
    group.redemptionIds.push(row.id);
    groups.set(key, group);
  }

  const sortedGroups = [...groups.values()]
    .map((group) => ({
      ...group,
      redemptionIds: [...group.redemptionIds].sort(),
    }))
    .sort((a, b) =>
      `${a.storeId}\0${a.canonicalCode}`.localeCompare(
        `${b.storeId}\0${b.canonicalCode}`,
      ),
    );
  const persistedCanonicalNullRows = rows
    .filter((row) => row.shopifyDiscountCodeCanonical == null)
    .map(({ id, storeId }) => ({ id, storeId }));
  const persistedCanonicalMismatches = rows.flatMap((row) => {
    const expectedCanonical = canonicalByRedemptionId.get(row.id);
    if (
      !expectedCanonical ||
      row.shopifyDiscountCodeCanonical == null ||
      row.shopifyDiscountCodeCanonical === expectedCanonical
    ) {
      return [];
    }
    return [
      {
        id: row.id,
        storeId: row.storeId,
        expectedCanonical,
        persistedCanonical: row.shopifyDiscountCodeCanonical,
      },
    ];
  });
  const persistedGroups = new Map<string, DiscountCodeAuditGroup>();
  for (const row of rows) {
    if (row.shopifyDiscountCodeCanonical == null) continue;
    const key = JSON.stringify([row.storeId, row.shopifyDiscountCodeCanonical]);
    const group = persistedGroups.get(key) ?? {
      storeId: row.storeId,
      canonicalCode: row.shopifyDiscountCodeCanonical,
      redemptionIds: [],
    };
    group.redemptionIds.push(row.id);
    persistedGroups.set(key, group);
  }
  const persistedCanonicalDuplicates = [...persistedGroups.values()]
    .filter(({ redemptionIds }) => redemptionIds.length > 1)
    .map((group) => ({
      ...group,
      redemptionIds: [...group.redemptionIds].sort(),
    }))
    .sort((a, b) =>
      `${a.storeId}\0${a.canonicalCode}`.localeCompare(
        `${b.storeId}\0${b.canonicalCode}`,
      ),
    );
  const persistedQuarantineRows = rows
    .filter(
      (row) =>
        row.settlementQuarantinedAt != null ||
        row.settlementQuarantineReason != null,
    )
    .map(({ id, storeId }) => ({ id, storeId }));
  return {
    cleanGroups: sortedGroups.filter(
      ({ redemptionIds }) => redemptionIds.length === 1,
    ),
    collisions: sortedGroups.filter(
      ({ redemptionIds }) => redemptionIds.length > 1,
    ),
    invalidRows,
    persistedCanonicalNullRows,
    persistedCanonicalMismatches,
    persistedCanonicalDuplicates,
    persistedQuarantineRows,
  };
}

async function loadRows(storeId?: string) {
  const rows: DiscountCodeMigrationRow[] = [];
  let cursor: string | undefined;
  do {
    // The stage-one migration deliberately leaves this column nullable while
    // the generated final Prisma client declares it required. Reading a NULL
    // through that model can fail with P2032 before the backfill starts, so
    // every staged-schema row read must use a nullable raw result type.
    const selectBatch = Prisma.sql`SELECT id,
        storeId,
        shopifyDiscountCode,
        shopifyDiscountCodeCanonical,
        settlementQuarantinedAt,
        settlementQuarantineReason
      FROM WeleticRewardRedemption`;
    let batch: DiscountCodeMigrationRow[];
    if (storeId && cursor) {
      batch = await prisma.$queryRaw<DiscountCodeMigrationRow[]>(
        Prisma.sql`${selectBatch}
          WHERE storeId = ${storeId} AND id > ${cursor}
          ORDER BY id ASC
          LIMIT 500`,
      );
    } else if (storeId) {
      batch = await prisma.$queryRaw<DiscountCodeMigrationRow[]>(
        Prisma.sql`${selectBatch}
          WHERE storeId = ${storeId}
          ORDER BY id ASC
          LIMIT 500`,
      );
    } else if (cursor) {
      batch = await prisma.$queryRaw<DiscountCodeMigrationRow[]>(
        Prisma.sql`${selectBatch}
          WHERE id > ${cursor}
          ORDER BY id ASC
          LIMIT 500`,
      );
    } else {
      batch = await prisma.$queryRaw<DiscountCodeMigrationRow[]>(
        Prisma.sql`${selectBatch}
          ORDER BY id ASC
          LIMIT 500`,
      );
    }
    rows.push(...batch);
    cursor = batch.length === 500 ? batch[batch.length - 1].id : undefined;
  } while (cursor);
  return rows;
}

async function assertMaintenanceFence({
  storeId,
  maintenanceFence,
}: {
  storeId?: string;
  maintenanceFence?: string;
}) {
  if (maintenanceFence !== DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE) {
    throw new Error(
      `Refusing canonical discount-code writes without --maintenance-fence=${DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE}.`,
    );
  }

  const storeFilter = storeId ? { storeId } : {};
  const [
    writeEnabledPrograms,
    provisioningRedemptions,
    writeProducingOutboxJobs,
  ] = await Promise.all([
    prisma.weleticLoyaltyProgram.count({
      where: {
        ...storeFilter,
        status: "active",
        killSwitchActive: false,
      },
    }),
    prisma.weleticRewardRedemption.count({
      where: { ...storeFilter, status: "provisioning" },
    }),
    prisma.weleticLoyaltyOutboxJob.count({
      where: {
        ...storeFilter,
        status: { in: [...BLOCKING_OUTBOX_JOB_STATUSES] },
        jobType: {
          in: [...CANONICAL_WRITE_OUTBOX_JOB_TYPES],
        },
      },
    }),
  ]);

  if (
    writeEnabledPrograms > 0 ||
    provisioningRedemptions > 0 ||
    writeProducingOutboxJobs > 0
  ) {
    throw new Error(
      `Canonical discount-code migration fence is not drained (writeEnabledPrograms=${writeEnabledPrograms}, provisioningRedemptions=${provisioningRedemptions}, writeProducingOutboxJobs=${writeProducingOutboxJobs}).`,
    );
  }
}

async function countBlockingCanonicalReconciliationIssues(storeId?: string) {
  return prisma.weleticReconciliationIssue.count({
    where: {
      ...(storeId ? { storeId } : {}),
      kind: { in: [...CANONICAL_MIGRATION_ISSUE_KINDS] },
      // "ignored" is an operator disposition, not proof that the ambiguous
      // Shopify identity was reconciled. Only an explicitly resolved issue is
      // compatible with the final NOT NULL + UNIQUE constraint.
      status: { in: ["open", "ignored"] },
    },
  });
}

function collisionExternalKey(group: DiscountCodeAuditGroup) {
  return createHash("sha256")
    .update(JSON.stringify([group.storeId, group.canonicalCode]))
    .digest("hex");
}

async function markCollisionQuarantined(
  group: DiscountCodeAuditGroup,
  rowsById: ReadonlyMap<string, DiscountCodeMigrationRow>,
) {
  const detectedAt = new Date();
  const reason =
    "Canonical Shopify discount code collision; automatic settlement disabled pending exact remote reconciliation.";

  await prisma.$transaction(async (tx) => {
    for (const redemptionId of group.redemptionIds) {
      const row = rowsById.get(redemptionId);
      if (!row) {
        throw new Error(
          `Canonical collision row ${redemptionId} disappeared before quarantine.`,
        );
      }
      // Stage one intentionally creates this column as nullable. Every member
      // of an ambiguous group remains NULL so the final NOT NULL + UNIQUE gate
      // cannot pass until an operator resolves the remote identity. Raw codes,
      // financial status, ledger links, and amounts are never mutated here.
      const updated = await tx.$executeRaw(
        Prisma.sql`UPDATE WeleticRewardRedemption
          SET shopifyDiscountCodeCanonical = NULL,
              settlementQuarantinedAt = COALESCE(settlementQuarantinedAt, ${detectedAt}),
              settlementQuarantineReason = COALESCE(settlementQuarantineReason, ${reason})
          WHERE id = ${redemptionId}
            AND storeId = ${group.storeId}
            AND shopifyDiscountCode = ${row.shopifyDiscountCode}
            AND shopifyDiscountCodeCanonical <=> ${row.shopifyDiscountCodeCanonical ?? null}
            AND settlementQuarantinedAt <=> ${row.settlementQuarantinedAt ?? null}
            AND settlementQuarantineReason <=> ${row.settlementQuarantineReason ?? null}`,
      );
      if (Number(updated) !== 1) {
        throw new Error(
          `Canonical collision row ${redemptionId} changed during quarantine.`,
        );
      }
    }

    await tx.weleticReconciliationIssue.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId: group.storeId,
          kind: COLLISION_ISSUE_KIND,
          externalKey: collisionExternalKey(group),
        },
      },
      create: {
        id: createWeleticId("wrecon_"),
        storeId: group.storeId,
        externalKey: collisionExternalKey(group),
        kind: COLLISION_ISSUE_KIND,
        severity: "critical",
        status: "open",
        detectedAt,
        details: {
          canonicalCode: group.canonicalCode,
          redemptionIds: group.redemptionIds,
          resolutionMarker:
            "operator_must_reconcile_exact_shopify_discount_identity",
        } satisfies Prisma.InputJsonObject,
      },
      update: {
        severity: "critical",
        status: "open",
        detectedAt,
        resolvedAt: null,
        details: {
          canonicalCode: group.canonicalCode,
          redemptionIds: group.redemptionIds,
          resolutionMarker:
            "operator_must_reconcile_exact_shopify_discount_identity",
        } satisfies Prisma.InputJsonObject,
      },
    });
  });
}

async function markInvalidRowQuarantined(
  row: DiscountCodeMigrationRow,
  error: string,
) {
  const detectedAt = new Date();
  const reason = `Invalid canonical Shopify discount code; automatic settlement disabled pending exact remote reconciliation. ${error}`;
  const externalKey = createHash("sha256")
    .update(JSON.stringify([row.storeId, row.id]))
    .digest("hex");

  await prisma.$transaction(async (tx) => {
    const updated = await tx.$executeRaw(
      Prisma.sql`UPDATE WeleticRewardRedemption
        SET shopifyDiscountCodeCanonical = NULL,
            settlementQuarantinedAt = COALESCE(settlementQuarantinedAt, ${detectedAt}),
            settlementQuarantineReason = COALESCE(settlementQuarantineReason, ${reason})
        WHERE id = ${row.id}
          AND storeId = ${row.storeId}
          AND shopifyDiscountCode = ${row.shopifyDiscountCode}
          AND shopifyDiscountCodeCanonical <=> ${row.shopifyDiscountCodeCanonical ?? null}
          AND settlementQuarantinedAt <=> ${row.settlementQuarantinedAt ?? null}
          AND settlementQuarantineReason <=> ${row.settlementQuarantineReason ?? null}`,
    );
    if (Number(updated) !== 1) {
      throw new Error(
        `Invalid canonical discount-code row ${row.id} changed during quarantine.`,
      );
    }

    await tx.weleticReconciliationIssue.upsert({
      where: {
        storeId_kind_externalKey: {
          storeId: row.storeId,
          kind: INVALID_ISSUE_KIND,
          externalKey,
        },
      },
      create: {
        id: createWeleticId("wrecon_"),
        storeId: row.storeId,
        externalKey,
        kind: INVALID_ISSUE_KIND,
        severity: "critical",
        status: "open",
        detectedAt,
        details: {
          redemptionId: row.id,
          validationError: error,
          resolutionMarker:
            "operator_must_reconcile_exact_shopify_discount_identity",
        } satisfies Prisma.InputJsonObject,
      },
      update: {
        severity: "critical",
        status: "open",
        detectedAt,
        resolvedAt: null,
        details: {
          redemptionId: row.id,
          validationError: error,
          resolutionMarker:
            "operator_must_reconcile_exact_shopify_discount_identity",
        } satisfies Prisma.InputJsonObject,
      },
    });
  });
}

export async function migrateCanonicalDiscountCodes({
  apply = false,
  storeId,
  maintenanceFence,
}: {
  apply?: boolean;
  storeId?: string;
  maintenanceFence?: string;
} = {}) {
  if (apply) {
    await assertMaintenanceFence({ storeId, maintenanceFence });
  }
  const initialRows = await loadRows(storeId);
  const initialAudit = auditCanonicalDiscountCodes(initialRows);
  const rowsById = new Map(initialRows.map((row) => [row.id, row]));

  if (apply) {
    for (const group of initialAudit.cleanGroups) {
      const redemptionId = group.redemptionIds[0];
      const row = rowsById.get(redemptionId);
      if (!row) {
        throw new Error(
          `Canonical discount-code row ${redemptionId} disappeared before backfill.`,
        );
      }
      // The stage-one database column is nullable while the generated final
      // Prisma client already models it as required. Raw SQL is therefore
      // necessary for a truthful null-safe CAS against the staged schema.
      const updated = await prisma.$executeRaw(
        Prisma.sql`UPDATE WeleticRewardRedemption
          SET shopifyDiscountCodeCanonical = ${group.canonicalCode}
          WHERE id = ${redemptionId}
            AND storeId = ${group.storeId}
            AND shopifyDiscountCode = ${row.shopifyDiscountCode}
            AND shopifyDiscountCodeCanonical <=> ${row.shopifyDiscountCodeCanonical ?? null}
            AND settlementQuarantinedAt <=> ${row.settlementQuarantinedAt ?? null}
            AND settlementQuarantineReason <=> ${row.settlementQuarantineReason ?? null}`,
      );
      if (Number(updated) !== 1) {
        throw new Error(
          `Canonical discount-code row ${redemptionId} changed during backfill.`,
        );
      }
    }
    for (const collision of initialAudit.collisions) {
      await markCollisionQuarantined(collision, rowsById);
    }
    for (const invalid of initialAudit.invalidRows) {
      const row = rowsById.get(invalid.id);
      if (!row) {
        throw new Error(
          `Invalid canonical discount-code row ${invalid.id} disappeared before quarantine.`,
        );
      }
      await markInvalidRowQuarantined(row, invalid.error);
    }
  }

  // Never infer stage-two readiness from the pre-write snapshot. Reload every
  // persisted field so NULLs, stale canonical values, surviving quarantine, or
  // a writer racing the maintenance fence all fail the final release gate.
  const finalRows = await loadRows(storeId);
  const maintenanceAcknowledged =
    maintenanceFence === DISCOUNT_CODE_MIGRATION_MAINTENANCE_FENCE;
  if (maintenanceAcknowledged) {
    // Re-inspect the database-backed fence after the persisted reload. This is
    // deliberately separate from the pre-write check so a queued/replayed job
    // appearing during the migration prevents stage-two readiness.
    await assertMaintenanceFence({ storeId, maintenanceFence });
  }
  const audit = auditCanonicalDiscountCodes(finalRows);
  const blockingReconciliationIssues =
    await countBlockingCanonicalReconciliationIssues(storeId);
  const scopedAuditOnly = Boolean(storeId);

  return {
    dryRun: !apply,
    scope: storeId ? { storeId } : "all_stores",
    totalRows: finalRows.length,
    cleanRows: audit.cleanGroups.length,
    collisionGroups: audit.collisions.length,
    collisionRows: audit.collisions.reduce(
      (total, group) => total + group.redemptionIds.length,
      0,
    ),
    invalidRows: audit.invalidRows,
    collisions: audit.collisions,
    persistedCanonicalNullRows: audit.persistedCanonicalNullRows,
    persistedCanonicalMismatches: audit.persistedCanonicalMismatches,
    persistedCanonicalDuplicates: audit.persistedCanonicalDuplicates,
    persistedQuarantineRows: audit.persistedQuarantineRows,
    blockingReconciliationIssues,
    maintenanceAcknowledged,
    scopedAuditOnly,
    readyForFinalConstraint:
      maintenanceAcknowledged &&
      !scopedAuditOnly &&
      audit.collisions.length === 0 &&
      audit.invalidRows.length === 0 &&
      audit.persistedCanonicalNullRows.length === 0 &&
      audit.persistedCanonicalMismatches.length === 0 &&
      audit.persistedCanonicalDuplicates.length === 0 &&
      audit.persistedQuarantineRows.length === 0 &&
      blockingReconciliationIssues === 0,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const storeArg = args.find((arg) => arg.startsWith("--store="));
  const storeId = storeArg?.slice("--store=".length) || undefined;
  const maintenanceFenceArg = args.find((arg) =>
    arg.startsWith("--maintenance-fence="),
  );
  const maintenanceFence =
    maintenanceFenceArg?.slice("--maintenance-fence=".length) || undefined;

  migrateCanonicalDiscountCodes({ apply, storeId, maintenanceFence })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      if (!result.readyForFinalConstraint) process.exitCode = 2;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
