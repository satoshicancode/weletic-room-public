import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { LOYALTY_MAINTENANCE_METADATA_KEY } from "./maintenance-write-fence";
import { withActiveStoreLoyaltyMutation } from "./merchant-write-fence";
import { enqueueDueRewardExpiryCommunication } from "./reward-expiry-communication-producer";
import { REWARD_EXPIRY_REMINDER_LEAD_MS } from "./reward-expiry-window";

export const REWARD_EXPIRY_SWEEP_KEY = "__weleticRewardExpirySweepV1";
const checkpointSchema = z
  .object({
    installationGeneration: z.string().min(1).max(64),
    lastRedemptionId: z.string().min(1).max(191).nullable(),
    lastScannedAt: z.string().datetime(),
  })
  .strict();

/** A cursor is only scan progress, never economic or authorization evidence.
 * Reinstall or malformed cursor resets the scan, not original reward provenance. */
export function readRewardExpirySweepCursor(
  metadata: Prisma.JsonValue | null,
  generation: string,
) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    return null;
  const parsed = checkpointSchema.safeParse(metadata[REWARD_EXPIRY_SWEEP_KEY]);
  return parsed.success && parsed.data.installationGeneration === generation
    ? parsed.data.lastRedemptionId
    : null;
}
function withCheckpoint(
  metadata: Prisma.JsonValue | null,
  generation: string,
  cursor: string | null,
  now: Date,
): Prisma.InputJsonObject {
  if (
    metadata !== null &&
    (typeof metadata !== "object" || Array.isArray(metadata))
  )
    throw new Error("Reward expiry program metadata unavailable");
  return {
    ...(metadata ?? {}),
    [REWARD_EXPIRY_SWEEP_KEY]: checkpointSchema.parse({
      installationGeneration: generation,
      lastRedemptionId: cursor,
      lastScannedAt: now.toISOString(),
    }),
  };
}

export type RewardExpirySweepResult = {
  programsScanned: number;
  rewardsScanned: number;
  jobsEnqueued: number;
  alreadyQueued: number;
  ineligible: number;
  programFailures: Array<{ storeId: string; checkpointRetained: boolean }>;
};

/** Least-recently-scanned programs receive bounded turns. Per-program keyset
 * progress survives cron restarts and advances past rejected/duplicate rows.
 * At end of the keyspace the next turn wraps, catching late issuance and newly
 * due rewards below the previous cursor. Queue and cursor commit atomically.
 * No provider I/O or financial changes. Existing signed cron invokes this. */
export async function enqueueRewardExpiryReminderJobs({
  now = new Date(),
  batchSize = 50,
}: { now?: Date; batchSize?: number } = {}): Promise<RewardExpirySweepResult> {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid reward expiry sweep clock");
  const budget = Number.isSafeInteger(batchSize)
    ? Math.min(50, Math.max(1, batchSize))
    : 50;
  const programLimit = Math.min(5, budget);
  const scanPath = `$.${REWARD_EXPIRY_SWEEP_KEY}.lastScannedAt`;
  const maintenancePath = `$.${LOYALTY_MAINTENANCE_METADATA_KEY}`;
  const programs = await prisma.$queryRaw<
    Array<{ id: string; storeId: string; installationGeneration: string }>
  >(Prisma.sql`
    SELECT p.id, p.storeId, s.installationGeneration
    FROM WeleticLoyaltyProgram p
    JOIN WeleticShopifyStore s ON s.id = p.storeId
    WHERE p.status = 'active' AND p.killSwitchActive = false
      AND s.storeAccessState = 'active' AND s.complianceState = 'active'
      AND s.installationGeneration IS NOT NULL AND s.installationGeneration <> ''
      AND (p.metadata IS NULL OR JSON_TYPE(p.metadata) = 'OBJECT')
      AND COALESCE(JSON_CONTAINS_PATH(p.metadata, 'one', ${maintenancePath}), 0) = 0
    ORDER BY CASE
      WHEN JSON_UNQUOTE(JSON_EXTRACT(p.metadata, ${scanPath})) <= ${now.toISOString()}
      THEN JSON_UNQUOTE(JSON_EXTRACT(p.metadata, ${scanPath})) ELSE '' END ASC,
      p.storeId ASC
    LIMIT ${programLimit}
  `);
  const result: RewardExpirySweepResult = {
    programsScanned: 0,
    rewardsScanned: 0,
    jobsEnqueued: 0,
    alreadyQueued: 0,
    ineligible: 0,
    programFailures: [],
  };
  const perProgram = Math.min(
    10,
    Math.max(1, Math.floor(budget / Math.max(1, programs.length))),
  );
  for (const candidate of programs) {
    result.programsScanned++;
    try {
      const counts = await withActiveStoreLoyaltyMutation({
        storeId: candidate.storeId,
        expectedInstallationGeneration: candidate.installationGeneration,
        action: "loyalty_reward_expiry_sweep",
        operation: async (tx) => {
          const program = await tx.weleticLoyaltyProgram.findUnique({
            where: { storeId: candidate.storeId },
            select: { id: true, metadata: true },
          });
          if (!program || program.id !== candidate.id)
            throw new Error("Reward expiry program changed");
          const cursor = readRewardExpirySweepCursor(
            program.metadata,
            candidate.installationGeneration,
          );
          const rows = await tx.weleticRewardRedemption.findMany({
            where: {
              storeId: candidate.storeId,
              status: { in: ["issued", "active"] },
              artifactKind: "discount_code",
              accountId: { not: null },
              settlementQuarantinedAt: null,
              expiresAt: {
                gt: now,
                lte: new Date(now.getTime() + REWARD_EXPIRY_REMINDER_LEAD_MS),
              },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: perProgram,
          });
          const counts = {
            rewardsScanned: 0,
            jobsEnqueued: 0,
            alreadyQueued: 0,
            ineligible: 0,
          };
          for (const row of rows) {
            const disposition = await enqueueDueRewardExpiryCommunication({
              tx,
              storeId: candidate.storeId,
              redemptionId: row.id,
              expectedInstallationGeneration: candidate.installationGeneration,
              now,
            });
            counts.rewardsScanned++;
            if (disposition === "enqueued") counts.jobsEnqueued++;
            else if (disposition === "existing") counts.alreadyQueued++;
            else counts.ineligible++;
          }
          await tx.weleticLoyaltyProgram.update({
            where: { id: program.id },
            data: {
              metadata: withCheckpoint(
                program.metadata,
                candidate.installationGeneration,
                rows.length === perProgram ? rows[rows.length - 1].id : null,
                now,
              ),
            },
          });
          return counts;
        },
      });
      result.rewardsScanned += counts.rewardsScanned;
      result.jobsEnqueued += counts.jobsEnqueued;
      result.alreadyQueued += counts.alreadyQueued;
      result.ineligible += counts.ineligible;
    } catch {
      // Preserve retry position after rollback, but give other stores their turn.
      // This still requires the original active-store fence; never bypass a
      // maintenance/compliance freeze merely to update scan bookkeeping.
      let checkpointRetained = false;
      try {
        await withActiveStoreLoyaltyMutation({
          storeId: candidate.storeId,
          expectedInstallationGeneration: candidate.installationGeneration,
          action: "loyalty_reward_expiry_sweep_failure",
          operation: async (tx) => {
            const program = await tx.weleticLoyaltyProgram.findUnique({
              where: { storeId: candidate.storeId },
              select: { id: true, metadata: true },
            });
            if (!program || program.id !== candidate.id)
              throw new Error("Reward expiry program changed");
            await tx.weleticLoyaltyProgram.update({
              where: { id: program.id },
              data: {
                metadata: withCheckpoint(
                  program.metadata,
                  candidate.installationGeneration,
                  readRewardExpirySweepCursor(
                    program.metadata,
                    candidate.installationGeneration,
                  ),
                  now,
                ),
              },
            });
          },
        });
        checkpointRetained = true;
      } catch {
        /* The response exposes the failed checkpoint; no payload or secret is logged. */
      }
      result.programFailures.push({
        storeId: candidate.storeId,
        checkpointRetained,
      });
    }
  }
  return result;
}
