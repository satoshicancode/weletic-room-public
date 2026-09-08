import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  WeleticLoyaltyBackfillJobStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import {
  commitBackfillJob,
  createBackfillJob,
  generateBackfillPreview,
} from "./backfill";
import { appendPointsLedgerEntry } from "./ledger";
import { withActiveStoreLoyaltyMutation } from "./merchant-write-fence";

export type HistoricalBackfillAuditFinding = {
  storeId: string;
  jobId: string;
  ledgerEntryId: string;
  accountId: string;
  points: string;
  status: "repairable" | "replay_pending" | "repaired" | "unresolved";
  reason: string | null;
  repairJobId: string | null;
  correctionLedgerEntryId: string | null;
};

export type HistoricalBackfillAuditReport = {
  generatedAt: string;
  storeId: string | null;
  totals: {
    legacyEntries: number;
    repairable: number;
    replayPending: number;
    repaired: number;
    unresolved: number;
  };
  findings: HistoricalBackfillAuditFinding[];
};

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readRepairJobId(value: Prisma.JsonValue | null) {
  const repairJobId = jsonObject(value).repairJobId;
  return typeof repairJobId === "string" ? repairJobId : null;
}

export async function auditHistoricalBackfill(
  options: {
    storeId?: string;
  } = {},
): Promise<HistoricalBackfillAuditReport> {
  const legacyEntries = await prisma.weleticPointsLedgerEntry.findMany({
    where: {
      ...(options.storeId ? { storeId: options.storeId } : {}),
      entryType: WeleticPointsLedgerEntryType.BACKFILL,
      referenceType: "backfill_job",
      referenceId: { not: null },
    },
    orderBy: [{ storeId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });

  const correctionKeys = legacyEntries.map(
    ({ id }) => `backfill:correction:${id}`,
  );
  const corrections =
    correctionKeys.length === 0
      ? []
      : await prisma.weleticPointsLedgerEntry.findMany({
          where: {
            idempotencyKey: { in: correctionKeys },
          },
        });
  const correctionByKey = new Map(
    corrections.map((entry) => [entry.idempotencyKey, entry]),
  );
  const jobIds = [
    ...new Set(
      legacyEntries
        .map(({ referenceId }) => referenceId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const jobs = await prisma.weleticLoyaltyBackfillJob.findMany({
    where: { id: { in: jobIds } },
  });
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const accountIds = [
    ...new Set(legacyEntries.map(({ accountId }) => accountId)),
  ];
  const accounts = await prisma.weleticLoyaltyAccount.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, storeId: true, status: true, shopperId: true },
  });
  const accountById = new Map(accounts.map((account) => [account.id, account]));

  const repairJobIds = [
    ...new Set(
      corrections
        .map(({ metadata }) => readRepairJobId(metadata))
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const repairJobs = await prisma.weleticLoyaltyBackfillJob.findMany({
    where: { id: { in: repairJobIds } },
    select: { id: true, status: true },
  });
  const repairStatusById = new Map(
    repairJobs.map(({ id, status }) => [id, status]),
  );

  const findings: HistoricalBackfillAuditFinding[] = legacyEntries.map(
    (entry) => {
      const jobId = entry.referenceId as string;
      const correction = correctionByKey.get(`backfill:correction:${entry.id}`);
      const repairJobId = correction
        ? readRepairJobId(correction.metadata)
        : null;
      const repairStatus = repairJobId
        ? repairStatusById.get(repairJobId)
        : undefined;
      const job = jobById.get(jobId);
      const account = accountById.get(entry.accountId);

      let status: HistoricalBackfillAuditFinding["status"] = "repairable";
      let reason: string | null = null;
      if (entry.pointsDelta <= BigInt(0) || entry.pendingDelta !== BigInt(0)) {
        status = "unresolved";
        reason = "legacy_entry_has_invalid_financial_delta";
      } else if (!job || job.storeId !== entry.storeId) {
        status = "unresolved";
        reason = "legacy_job_missing_or_cross_store";
      } else if (
        !account ||
        account.storeId !== entry.storeId ||
        account.status !== "active"
      ) {
        status = "unresolved";
        reason = "active_account_missing";
      } else if (correction) {
        if (
          correction.entryType !==
            WeleticPointsLedgerEntryType.BACKFILL_CORRECTION ||
          correction.pointsDelta !== -entry.pointsDelta ||
          correction.pendingDelta !== BigInt(0) ||
          correction.accountId !== entry.accountId ||
          correction.storeId !== entry.storeId ||
          correction.grantId !== null ||
          correction.referenceType !== "backfill_ledger" ||
          correction.referenceId !== entry.id
        ) {
          status = "unresolved";
          reason = "correction_amount_or_owner_mismatch";
        } else if (!repairJobId || repairStatus === undefined) {
          status = "unresolved";
          reason = "correction_repair_job_missing";
        } else if (repairStatus === WeleticLoyaltyBackfillJobStatus.completed) {
          status = "repaired";
        } else if (
          repairStatus === WeleticLoyaltyBackfillJobStatus.cancelled ||
          repairStatus === WeleticLoyaltyBackfillJobStatus.calculating
        ) {
          status = "unresolved";
          reason = `correction_replay_non_resumable_${repairStatus}`;
        } else {
          status = "replay_pending";
          reason = "correction_exists_but_replay_is_incomplete";
        }
      }

      return {
        storeId: entry.storeId,
        jobId,
        ledgerEntryId: entry.id,
        accountId: entry.accountId,
        points: entry.pointsDelta.toString(),
        status,
        reason,
        repairJobId,
        correctionLedgerEntryId: correction?.id ?? null,
      };
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    storeId: options.storeId ?? null,
    totals: {
      legacyEntries: findings.length,
      repairable: findings.filter(({ status }) => status === "repairable")
        .length,
      replayPending: findings.filter(
        ({ status }) => status === "replay_pending",
      ).length,
      repaired: findings.filter(({ status }) => status === "repaired").length,
      unresolved: findings.filter(({ status }) => status === "unresolved")
        .length,
    },
    findings,
  };
}

async function voidMalformedLegacyBackfillGrants({
  storeId,
  sourceJobId,
}: {
  storeId: string;
  sourceJobId: string;
}) {
  const store = await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: "loyalty_backfill_repair_void_grants",
  });
  if (!store) {
    throw new Error(`Shopify store ${storeId} is unavailable for repair.`);
  }
  const candidates = await prisma.weleticLoyaltyEarnGrant.findMany({
    where: { storeId },
    select: { id: true, metadata: true },
  });
  const grantIds = candidates
    .filter(({ metadata }) => jsonObject(metadata).jobId === sourceJobId)
    .map(({ id }) => id);

  for (const grantId of grantIds) {
    await withActiveStoreLoyaltyMutation({
      storeId,
      action: "loyalty_backfill_repair_void_grant",
      expectedInstallationGeneration: store.installationGeneration,
      operation: async (tx) => {
        const grant = await tx.weleticLoyaltyEarnGrant.findUniqueOrThrow({
          where: { id: grantId },
          include: { lineEarns: true },
        });
        if (grant.status === "voided") return;
        for (const lineEarn of grant.lineEarns) {
          await tx.weleticLoyaltyOrderLineEarn.update({
            where: { id: lineEarn.id },
            data: { reversedPoints: lineEarn.awardedPoints },
          });
        }
        await tx.weleticLoyaltyEarnGrant.update({
          where: { id: grant.id },
          data: {
            status: "voided",
            pendingPoints: BigInt(0),
            settledPoints: BigInt(0),
            reversedPoints: grant.grossPoints,
            voidedAt: new Date(),
            metadata: {
              ...jsonObject(grant.metadata),
              repairVoided: true,
              repairSourceJobId: sourceJobId,
            } as Prisma.InputJsonValue,
          },
        });
      },
    });
  }
}

async function appendExactLegacyCorrections({
  storeId,
  repairJobId,
  findings,
}: {
  storeId: string;
  repairJobId: string;
  findings: HistoricalBackfillAuditFinding[];
}) {
  const store = await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: "loyalty_backfill_repair",
  });
  if (!store) {
    throw new Error(`Shopify store ${storeId} is unavailable for repair.`);
  }
  for (const finding of findings) {
    const legacyEntry = await prisma.weleticPointsLedgerEntry.findUniqueOrThrow(
      {
        where: { id: finding.ledgerEntryId },
      },
    );
    await withActiveStoreLoyaltyMutation({
      storeId,
      action: "loyalty_backfill_repair_correction",
      expectedInstallationGeneration: store.installationGeneration,
      operation: (tx) =>
        appendPointsLedgerEntry({
          storeId,
          accountId: legacyEntry.accountId,
          entryType: WeleticPointsLedgerEntryType.BACKFILL_CORRECTION,
          pointsDelta: -legacyEntry.pointsDelta,
          referenceType: "backfill_ledger",
          referenceId: legacyEntry.id,
          idempotencyKey: `backfill:correction:${legacyEntry.id}`,
          reason: `Append-only correction for legacy aggregate backfill ${finding.jobId}`,
          metadata: {
            legacyJobId: finding.jobId,
            legacyLedgerEntryId: legacyEntry.id,
            repairJobId,
            exactReversal: true,
          },
          tx,
        }),
    });
  }
}

export async function repairHistoricalBackfillStore(storeId: string) {
  const initial = await auditHistoricalBackfill({ storeId });
  if (initial.totals.unresolved > 0) {
    throw new Error(
      `Backfill repair refused: ${initial.totals.unresolved} unresolved finding(s) require manual investigation.`,
    );
  }

  const sourceJobIds = [
    ...new Set(
      initial.findings
        .filter(({ status }) => status !== "repaired")
        .map(({ jobId }) => jobId),
    ),
  ];
  const repairJobs: string[] = [];

  for (const sourceJobId of sourceJobIds) {
    const sourceFindings = initial.findings.filter(
      (finding) =>
        finding.jobId === sourceJobId && finding.status !== "repaired",
    );
    const sourceJob = await prisma.weleticLoyaltyBackfillJob.findUniqueOrThrow({
      where: { id: sourceJobId },
    });
    let repairJobId = sourceFindings.find(
      ({ repairJobId }) => repairJobId,
    )?.repairJobId;
    const existingRepairJob = repairJobId
      ? await prisma.weleticLoyaltyBackfillJob.findUnique({
          where: { id: repairJobId },
        })
      : null;
    let repairJobStatus: WeleticLoyaltyBackfillJobStatus | null =
      existingRepairJob?.status ?? null;

    if (!existingRepairJob) {
      const created = await createBackfillJob({
        storeId,
        lookbackDays: sourceJob.lookbackDays,
        lookbackStartDate: sourceJob.lookbackStartDate,
        pointsPerCurrencyUnit: sourceJob.pointsPerCurrencyUnit,
        minOrderAmount: sourceJob.minOrderAmount ?? undefined,
        metadata: {
          repairSourceJobId: sourceJobId,
          repairAccountIds: [
            ...new Set(sourceFindings.map(({ accountId }) => accountId)),
          ],
          auditFirst: true,
        },
      });
      repairJobId = created.id;
      repairJobStatus = created.status;
    }

    if (!repairJobId) {
      throw new Error(`Could not create repair replay for ${sourceJobId}.`);
    }

    if (repairJobStatus === WeleticLoyaltyBackfillJobStatus.pending) {
      repairJobStatus = (await generateBackfillPreview(repairJobId)).status;
    } else if (
      repairJobStatus === WeleticLoyaltyBackfillJobStatus.preview_ready
    ) {
      // This state can mean the prior commit observed an order mutation and
      // deliberately returned the job for a fresh preview.
      repairJobStatus = (await generateBackfillPreview(repairJobId)).status;
    }

    await appendExactLegacyCorrections({
      storeId,
      repairJobId,
      findings: sourceFindings,
    });
    await voidMalformedLegacyBackfillGrants({ storeId, sourceJobId });

    if (repairJobStatus === WeleticLoyaltyBackfillJobStatus.preview_ready) {
      await commitBackfillJob(repairJobId);
    } else if (
      repairJobStatus === WeleticLoyaltyBackfillJobStatus.committing ||
      repairJobStatus === WeleticLoyaltyBackfillJobStatus.failed
    ) {
      await commitBackfillJob(repairJobId);
    } else if (repairJobStatus !== WeleticLoyaltyBackfillJobStatus.completed) {
      throw new Error(
        `Repair replay ${repairJobId} is in non-resumable status '${repairJobStatus}'.`,
      );
    }
    repairJobs.push(repairJobId);
  }

  return {
    repairRunId: createWeleticId("wbackfill_"),
    repairJobs,
    report: await auditHistoricalBackfill({ storeId }),
  };
}
