import { prisma } from "@/lib/prisma";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import { isLoyaltyMaintenanceBlockedError } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import {
  calculateNextPointsExpiryDate,
  getPointsExpiryPolicyBaseDate,
  getPointsExpiryStageDate,
  isPointsExpiryEnabled,
  type PointsExpiryStage,
} from "@/lib/weletic/loyalty/points-expiry-policy";
import { ShopifyStoreOperationalWritesBlockedError } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { addDays } from "date-fns";
import { snapshotLoyaltyCommunicationPolicy } from "./communications-service";

export type PointsExpirySweepResult = {
  programsScanned: number;
  programsSkipped: number;
  accountsReconciled: number;
  accountsScheduled: number;
  jobsEnqueued: number;
};

const EXPIRY_STAGES: PointsExpiryStage[] = ["warning", "last_chance", "expire"];

export async function enqueuePointsExpiryLifecycleJobs({
  now = new Date(),
  batchSize = 100,
}: {
  now?: Date;
  batchSize?: number;
} = {}): Promise<PointsExpirySweepResult> {
  const effectiveBatchSize = Math.min(500, Math.max(1, batchSize));
  const result: PointsExpirySweepResult = {
    programsScanned: 0,
    programsSkipped: 0,
    accountsReconciled: 0,
    accountsScheduled: 0,
    jobsEnqueued: 0,
  };

  const programs = await prisma.weleticLoyaltyProgram.findMany({
    where: {
      status: "active",
      killSwitchActive: false,
      OR: [{ pointsExpiryDays: { gt: 0 } }, { pointsExpiryMonths: { gt: 0 } }],
      store: { complianceState: "active" },
    },
    select: { storeId: true },
    orderBy: { storeId: "asc" },
  });

  let remaining = effectiveBatchSize;
  for (const candidate of programs) {
    if (remaining <= 0) break;
    result.programsScanned++;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const resultBeforeAttempt = { ...result };
      const remainingBeforeAttempt = remaining;
      try {
        await withActiveStoreLoyaltyMutation({
          storeId: candidate.storeId,
          action: "loyalty_points_expiry_schedule",
          operation: async (tx) => {
            let program = await tx.weleticLoyaltyProgram.findUnique({
              where: { storeId: candidate.storeId },
              select: {
                id: true,
                metadata: true,
                status: true,
                killSwitchActive: true,
                pointsExpiryDays: true,
                pointsExpiryMonths: true,
                pointsExpiryWarningDays: true,
                pointsExpiryLastChanceDays: true,
                pointsExpiryWarningEnabled: true,
                pointsExpiryLastChanceEnabled: true,
                pointsExpiryPolicyAnchorAt: true,
                pointsExpiryPolicyVersion: true,
                activatedAt: true,
                createdAt: true,
              },
            });
            if (!program || !isPointsExpiryEnabled(program)) return;
            if (!program.pointsExpiryPolicyAnchorAt) {
              const initializedVersion = program.pointsExpiryPolicyVersion + 1;
              await tx.weleticLoyaltyProgram.update({
                where: { id: program.id },
                data: {
                  pointsExpiryPolicyAnchorAt: now,
                  pointsExpiryPolicyVersion: initializedVersion,
                },
              });
              await publishLoyaltyEarnPolicyRevision({
                tx,
                storeId: candidate.storeId,
                programId: program.id,
                effectiveAt: now,
                reason: "points_expiry_anchor_initialized",
              });
              program = {
                ...program,
                pointsExpiryPolicyAnchorAt: now,
                pointsExpiryPolicyVersion: initializedVersion,
              };
            }

            const accountsToReconcile = await tx.weleticLoyaltyAccount.findMany(
              {
                where: {
                  storeId: candidate.storeId,
                  status: "active",
                  pointsExpiryPolicyVersion: {
                    not: program.pointsExpiryPolicyVersion,
                  },
                },
                select: {
                  id: true,
                  cachedPointsBalance: true,
                  lastQualifyingActivityAt: true,
                  pointsExpiryPolicyVersion: true,
                },
                orderBy: { id: "asc" },
                take: remaining,
              },
            );

            for (const account of accountsToReconcile) {
              const nextExpiryDate =
                account.cachedPointsBalance > BigInt(0)
                  ? calculateNextPointsExpiryDate({
                      policy: program,
                      lastActivityAt: account.lastQualifyingActivityAt,
                      fallbackAt: now,
                    })
                  : null;
              const reconciled = await tx.weleticLoyaltyAccount.updateMany({
                where: {
                  id: account.id,
                  storeId: candidate.storeId,
                  status: "active",
                  pointsExpiryPolicyVersion: account.pointsExpiryPolicyVersion,
                },
                data: {
                  nextExpiryDate,
                  pointsExpiryPolicyVersion: program.pointsExpiryPolicyVersion,
                  pointsExpiryJobsScheduledAt: null,
                },
              });
              if (reconciled.count === 1) {
                result.accountsReconciled++;
                remaining--;
              }
              if (remaining <= 0) return;
            }

            const maximumNoticeDays = Math.max(
              program.pointsExpiryWarningEnabled
                ? program.pointsExpiryWarningDays
                : 0,
              program.pointsExpiryLastChanceEnabled
                ? program.pointsExpiryLastChanceDays
                : 0,
              0,
            );
            const schedulingHorizon = addDays(now, maximumNoticeDays);
            const accountsToSchedule = await tx.weleticLoyaltyAccount.findMany({
              where: {
                storeId: candidate.storeId,
                status: "active",
                cachedPointsBalance: { gt: BigInt(0) },
                pointsExpiryPolicyVersion: program.pointsExpiryPolicyVersion,
                pointsExpiryJobsScheduledAt: null,
                nextExpiryDate: { not: null, lte: schedulingHorizon },
              },
              select: {
                id: true,
                cachedPointsBalance: true,
                lastQualifyingActivityAt: true,
                nextExpiryDate: true,
              },
              orderBy: [{ nextExpiryDate: "asc" }, { id: "asc" }],
              take: remaining,
            });

            for (const account of accountsToSchedule) {
              const expiryAt = account.nextExpiryDate;
              if (!expiryAt) continue;
              const baseDate = getPointsExpiryPolicyBaseDate({
                policy: program,
                lastActivityAt: account.lastQualifyingActivityAt,
                fallbackAt: now,
              });
              if (!baseDate) continue;

              for (const stage of EXPIRY_STAGES) {
                if (
                  stage === "warning" &&
                  !program.pointsExpiryWarningEnabled
                ) {
                  continue;
                }
                if (
                  stage === "last_chance" &&
                  !program.pointsExpiryLastChanceEnabled
                ) {
                  continue;
                }
                const scheduledFor = getPointsExpiryStageDate({
                  policy: program,
                  expiryAt,
                  stage,
                });
                if (stage !== "expire" && scheduledFor <= baseDate) {
                  continue;
                }
                await enqueueOutboxJobFromProgramTransaction({
                  storeId: candidate.storeId,
                  jobType: "INACTIVITY_EXPIRY",
                  payload: {
                    accountId: account.id,
                    lastActivityAt: baseDate.toISOString(),
                    expiryDays: program.pointsExpiryDays,
                    expiryMonths: program.pointsExpiryMonths,
                    expiryAt: expiryAt.toISOString(),
                    stage,
                    policyVersion: program.pointsExpiryPolicyVersion,
                    ...(stage === "expire"
                      ? {}
                      : {
                          communicationSnapshot:
                            snapshotLoyaltyCommunicationPolicy({
                              storeId: candidate.storeId,
                              programId: program.id,
                              metadata: program.metadata ?? null,
                              journey:
                                stage === "warning"
                                  ? "points_warning"
                                  : "points_last_chance",
                            }),
                        }),
                  },
                  scheduledFor: scheduledFor < now ? now : scheduledFor,
                  // Policy version is part of the identity because threshold-only
                  // changes keep the same expiry date but must replace every stale
                  // notification and expiry job from the previous configuration.
                  idempotencyKey: `inactivity_expiry:${stage}:${account.id}:${expiryAt.toISOString()}:v${program.pointsExpiryPolicyVersion}`,
                  tx,
                });
                result.jobsEnqueued++;
                if (stage !== "expire") {
                  await enqueueFlowTriggerJob({
                    storeId: candidate.storeId,
                    eventId: `${stage}:${account.id}:${expiryAt.toISOString()}:v${program.pointsExpiryPolicyVersion}`,
                    payload: {
                      accountId: account.id,
                      handle: "weletic-points-expiring-soon",
                      pointsExpiring: account.cachedPointsBalance.toString(),
                      expiryDate: expiryAt.toISOString(),
                      urgency: stage,
                      policyVersion: program.pointsExpiryPolicyVersion,
                    },
                    scheduledFor: scheduledFor < now ? now : scheduledFor,
                    tx,
                  });
                  result.jobsEnqueued++;
                }
              }

              const marked = await tx.weleticLoyaltyAccount.updateMany({
                where: {
                  id: account.id,
                  storeId: candidate.storeId,
                  status: "active",
                  nextExpiryDate: expiryAt,
                  pointsExpiryJobsScheduledAt: null,
                },
                data: { pointsExpiryJobsScheduledAt: expiryAt },
              });
              if (marked.count === 1) {
                result.accountsScheduled++;
                remaining--;
              }
              if (remaining <= 0) return;
            }
          },
        });
        break;
      } catch (error) {
        Object.assign(result, resultBeforeAttempt);
        remaining = remainingBeforeAttempt;
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2034";
        if (retryable && attempt < 3) continue;
        if (
          isLoyaltyMaintenanceBlockedError(error) ||
          error instanceof ShopifyStoreOperationalWritesBlockedError
        ) {
          result.programsSkipped++;
          break;
        }
        throw error;
      }
    }
  }

  return result;
}
