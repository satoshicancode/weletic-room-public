import { prisma } from "@/lib/prisma";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  enqueueOutboxJob,
  enqueueOutboxJobFromProgramTransaction,
} from "@/lib/weletic/loyalty/outbox";
import type { Prisma } from "@prisma/client";

export type TierReviewSweepResult = {
  programsScanned: number;
  programsSkipped: number;
  accountsEvaluated: number;
  jobsEnqueued: number;
  programFailures: Array<{ storeId: string; error: string }>;
};

export async function scheduleTierReviewAfterQualifyingActivity({
  storeId,
  accountId,
  activityKey,
  reason,
  loyaltyMaintenancePermit,
  tx,
}: {
  storeId: string;
  accountId: string;
  activityKey: string;
  reason: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx: Prisma.TransactionClient;
}) {
  return enqueueOutboxJob({
    storeId,
    jobType: "TIER_REVIEW",
    payload: {
      accountId,
      reason,
    },
    idempotencyKey: `tier_review:${accountId}:${activityKey}`,
    priority: 5,
    loyaltyMaintenancePermit,
    tx,
  });
}

export async function enqueueTierReviewSweepJobs({
  now = new Date(),
  batchSize = 100,
}: {
  now?: Date;
  batchSize?: number;
} = {}): Promise<TierReviewSweepResult> {
  const effectiveBatchSize = Math.min(500, Math.max(1, batchSize));
  const result: TierReviewSweepResult = {
    programsScanned: 0,
    programsSkipped: 0,
    accountsEvaluated: 0,
    jobsEnqueued: 0,
    programFailures: [],
  };

  const programs = await prisma.weleticLoyaltyProgram.findMany({
    where: {
      status: "active",
      killSwitchActive: false,
      vipAutoDowngradeEnabled: true,
      tiers: { some: {} },
      store: { complianceState: "active" },
    },
    select: {
      storeId: true,
      vipTimeframe: true,
      vipDowngradeGraceDays: true,
    },
    orderBy: { storeId: "asc" },
  });

  let remaining = effectiveBatchSize;
  for (const program of programs) {
    if (remaining <= 0) break;
    result.programsScanned++;

    try {
      const programResult = await withActiveStoreLoyaltyMutation({
        storeId: program.storeId,
        action: "loyalty_tier_review_sweep",
        operation: async (tx) => {
          let programRemaining = remaining;
          let accountsEvaluated = 0;
          let jobsEnqueued = 0;
          let cursor: { id: string; tierExpiresAt: Date } | null = null;
          while (programRemaining > 0) {
            const queryTake = Math.min(100, Math.max(programRemaining, 25));
            const candidateAccounts = await tx.weleticLoyaltyAccount.findMany({
              where: {
                storeId: program.storeId,
                status: "active",
                currentTierId: { not: null },
                tierExpiresAt: { lte: now, not: null },
                ...(cursor
                  ? {
                      OR: [
                        { tierExpiresAt: { gt: cursor.tierExpiresAt } },
                        {
                          tierExpiresAt: cursor.tierExpiresAt,
                          id: { gt: cursor.id },
                        },
                      ],
                    }
                  : {}),
              },
              select: {
                id: true,
                tierExpiresAt: true,
              },
              take: queryTake,
              orderBy: [{ tierExpiresAt: "asc" }, { id: "asc" }],
            });
            if (candidateAccounts.length === 0) break;
            accountsEvaluated += candidateAccounts.length;

            for (const account of candidateAccounts) {
              const tierExpiresAt = account.tierExpiresAt;
              if (!tierExpiresAt) continue;
              cursor = { id: account.id, tierExpiresAt };
              const idempotencyKey = `tier_review_sweep:${account.id}:${tierExpiresAt.getTime()}`;

              const enqueueResult =
                await enqueueOutboxJobFromProgramTransaction({
                  storeId: program.storeId,
                  jobType: "TIER_REVIEW",
                  payload: {
                    accountId: account.id,
                    reviewPeriod: program.vipTimeframe,
                    gracePeriodDays: program.vipDowngradeGraceDays,
                    reason: "sweep_tier_expiry",
                  },
                  idempotencyKey,
                  priority: 5,
                  tx,
                });

              if (enqueueResult.created) {
                jobsEnqueued++;
                programRemaining--;
                if (programRemaining <= 0) break;
              }
            }
            if (candidateAccounts.length < queryTake) break;
          }

          return { accountsEvaluated, jobsEnqueued };
        },
      });
      result.accountsEvaluated += programResult.accountsEvaluated;
      result.jobsEnqueued += programResult.jobsEnqueued;
      remaining -= programResult.jobsEnqueued;
    } catch (error) {
      result.programsSkipped++;
      result.programFailures.push({
        storeId: program.storeId,
        error: error instanceof Error ? error.message : "Unknown sweep error",
      });
    }
  }

  return result;
}
