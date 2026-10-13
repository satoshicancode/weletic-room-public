import { trackCommissionStatusUpdate } from "@/lib/api/commissions/track-commission-update-activity-log";
import { createId } from "@/lib/api/create-id";
import { MUTABLE_PAYOUT_STATUSES } from "@/lib/constants/payouts";
import { withCron } from "@/lib/cron/with-cron";
import { prisma } from "@/lib/prisma";
import { createWeleticPayoutQuote } from "@/lib/weletic/payouts/create-quote";
import { chunk } from "@dub/utils";
import {
  Commission,
  CommissionStatus,
  Payout,
  PayoutStatus,
  Prisma,
  Program,
} from "@prisma/client";
import * as z from "zod/v4";
import { logAndRespond } from "../../../utils";

export const maxDuration = 600;
export const dynamic = "force-dynamic";

const BATCH_SIZE = 100;
const MAX_INT32 = 2_147_483_647;
const MAX_PAYOUT_AMOUNT_LIMIT = 2_000_000_000;

const inputSchema = z.object({
  programId: z.string(),
});

// POST /api/cron/payouts/aggregate-due-commissions/process
export const POST = withCron(async ({ rawBody }) => {
  const { programId } = inputSchema.parse(JSON.parse(rawBody));

  const program = await prisma.program.findUnique({
    where: {
      id: programId,
    },
    select: {
      id: true,
      name: true,
      workspaceId: true,
    },
  });

  if (!program) {
    return logAndRespond(`Program ${programId} not found. Skipping...`);
  }

  const partnerGroupsByHoldingPeriod = await prisma.partnerGroup.groupBy({
    by: ["holdingPeriodDays"],
    where: {
      programId,
    },
    _count: {
      id: true,
    },
    orderBy: {
      _count: {
        id: "desc",
      },
    },
  });

  for (const { holdingPeriodDays } of partnerGroupsByHoldingPeriod) {
    const partnerGroups = await prisma.partnerGroup.findMany({
      where: {
        holdingPeriodDays,
        programId,
      },
      select: {
        id: true,
      },
    });

    console.log(
      `Found ${partnerGroups.length} partner groups with holding period days: ${holdingPeriodDays}`,
    );

    // FIN-AUDIT-02: Track partners evaluated in this holding period cycle who resulted in
    // non-positive net earnings, rollbacks, or errors. This unblocks subsequent eligible partners.
    const excludedPartnerIds = new Set<string>();

    while (true) {
      const previousExcludedCount = excludedPartnerIds.size;

      const dueCommissions = await prisma.commission.findMany({
        where: {
          programId,
          status: CommissionStatus.pending,
          ...(excludedPartnerIds.size > 0
            ? {
                partnerId: {
                  notIn: Array.from(excludedPartnerIds),
                },
              }
            : {}),
          programEnrollment: {
            groupId: {
              in: partnerGroups.map((p) => p.id),
            },
          },
          // If holding period days is greater than 0:
          // we only process commissions that were created before the holding period
          // but custom commissions are always included
          ...(holdingPeriodDays > 0
            ? {
                OR: [
                  {
                    type: {
                      // includes manual + referral commissions + clawbacks
                      in: ["custom", "referral"],
                    },
                  },
                  {
                    createdAt: {
                      lt: new Date(
                        Date.now() - holdingPeriodDays * 24 * 60 * 60 * 1000,
                      ),
                    },
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          createdAt: true,
          amount: true,
          earnings: true,
          status: true,
          partnerId: true,
          programId: true,
        },
        orderBy: {
          createdAt: "asc",
        },
        take: BATCH_SIZE,
      });

      if (dueCommissions.length === 0) {
        console.log(
          `No more due commissions found for partner groups with holding period days: ${holdingPeriodDays}. Skipping...`,
        );
        break;
      }

      console.log(
        `Found ${dueCommissions.length} due commissions for partner groups with holding period days: ${holdingPeriodDays}`,
      );

      const commissionsByPartner = dueCommissions.reduce<
        Record<string, typeof dueCommissions>
      >((acc, commission) => {
        if (!acc[commission.partnerId]) {
          acc[commission.partnerId] = [];
        }
        acc[commission.partnerId].push(commission);
        return acc;
      }, {});

      const partnersWithCommissions = Object.entries(commissionsByPartner).map(
        ([partnerId, commissions]) => ({ partnerId, commissions }),
      );

      let batchProcessed = 0;
      const partnerBatches = chunk(partnersWithCommissions, 50);

      for (let i = 0; i < partnerBatches.length; i++) {
        const partnerChunk = partnerBatches[i];

        const existingPendingPayouts = await prisma.payout.findMany({
          where: {
            programId,
            partnerId: {
              in: partnerChunk.map(({ partnerId }) => partnerId),
            },
            status: PayoutStatus.pending,
            amount: {
              lt: MAX_PAYOUT_AMOUNT_LIMIT,
            },
          },
          select: {
            id: true,
            partnerId: true,
            amount: true,
          },
          orderBy: {
            createdAt: "asc",
          },
        });

        const pendingPayoutByPartnerId = new Map<
          string,
          (typeof existingPendingPayouts)[number]
        >();
        for (const payout of existingPendingPayouts) {
          if (!pendingPayoutByPartnerId.has(payout.partnerId)) {
            pendingPayoutByPartnerId.set(payout.partnerId, payout);
          }
        }

        const results = await Promise.allSettled(
          partnerChunk.map(({ partnerId, commissions }) =>
            aggregateDueCommissionsForPartner({
              partnerId,
              program,
              commissions,
              existingPendingPayout: pendingPayoutByPartnerId.get(partnerId),
            }),
          ),
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const partnerId = partnerChunk[j].partnerId;

          if (result.status === "fulfilled" && result.value?.success) {
            if (result.value.claimedCount > 0) {
              batchProcessed++;
            }
            // FIN-AUDIT-03: If commissions were capped or deferred, exclude partner from subsequent
            // while-loop iterations in this cron run to prevent immediate re-attachment or starvation.
            if (result.value.wasCapped) {
              excludedPartnerIds.add(partnerId);
            }
          } else {
            // FIN-AUDIT-02: Non-positive partner rolled back or failed: exclude from subsequent queries
            // in this cron run to allow subsequent positive partners to be processed.
            excludedPartnerIds.add(partnerId);

            if (result.status === "rejected") {
              console.error(
                `Failed to aggregate due commissions for partner ${partnerId}:`,
                result.reason,
              );
            }
          }
        }

        console.log(`Processed chunk ${i + 1} of ${partnerBatches.length}`);
      }

      const successRate =
        (batchProcessed / partnersWithCommissions.length) * 100;

      console.log(
        `Processed ${batchProcessed}/${partnersWithCommissions.length} partners with due commissions for partner groups with holding period days: ${holdingPeriodDays} (${successRate.toFixed(1)}% success rate)`,
      );

      // FIN-AUDIT-02: Defensive termination guard. If no partners were processed into payouts
      // AND no new partners were excluded, break to prevent an infinite loop.
      if (
        batchProcessed === 0 &&
        excludedPartnerIds.size === previousExcludedCount
      ) {
        console.log(
          `No forward progress made for holding period days: ${holdingPeriodDays}. Breaking...`,
        );
        break;
      }
    }
  }

  return logAndRespond(
    "Finished aggregating due commissions into payouts for all batches.",
  );
});

async function aggregateDueCommissionsForPartner({
  partnerId,
  program,
  commissions,
  existingPendingPayout,
}: {
  partnerId: string;
  program: Pick<Program, "id" | "name" | "workspaceId">;
  commissions: Pick<
    Commission,
    "id" | "createdAt" | "amount" | "earnings" | "status"
  >[];
  existingPendingPayout?: Pick<Payout, "id" | "partnerId" | "amount">;
}): Promise<{
  success: boolean;
  wasCapped?: boolean;
  claimedCount: number;
}> {
  // If existing pending payout is already at or above limit, do not claim into it
  if (
    existingPendingPayout &&
    existingPendingPayout.amount >= MAX_PAYOUT_AMOUNT_LIMIT
  ) {
    console.warn(
      `[aggregateDueCommissionsForPartner] Partner ${partnerId} existing pending payout ${existingPendingPayout.id} has reached limit (${existingPendingPayout.amount} >= ${MAX_PAYOUT_AMOUNT_LIMIT}). Deferring.`,
    );
    return { success: true, wasCapped: true, claimedCount: 0 };
  }

  // Sort the commissions by createdAt
  const sortedCommissions = commissions.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );

  // FIN-AUDIT-03: Cap the commissions to prevent Int32 overflow (>2.14B) for high-denomination
  // zero-decimal currencies (VND, JPY). Greedily include commissions up to MAX_PAYOUT_AMOUNT_LIMIT.
  // Remaining commissions stay in 'pending' status for subsequent batches/payouts.
  // Initialize cumulative with existing pending payout balance (if any) to prevent multi-batch overflow.
  let cumulative = BigInt(existingPendingPayout?.amount ?? 0);
  const eligibleCommissions: typeof sortedCommissions = [];
  let wasCapped = false;

  for (const c of sortedCommissions) {
    const nextCumulative = cumulative + c.earnings;
    if (
      cumulative > BigInt(0) &&
      nextCumulative > BigInt(MAX_PAYOUT_AMOUNT_LIMIT)
    ) {
      console.warn(
        `[aggregateDueCommissionsForPartner] Capping commissions for partner ${partnerId} at ${cumulative} to avoid Int32 overflow. Remaining ${sortedCommissions.length - eligibleCommissions.length} commissions deferred.`,
      );
      wasCapped = true;
      break;
    }
    cumulative = nextCumulative;
    eligibleCommissions.push(c);
  }

  wasCapped =
    wasCapped || eligibleCommissions.length < sortedCommissions.length;

  // Defensive guard: If existing pending payout cannot accommodate any new commissions,
  // safely defer all incoming commissions without throwing TypeError on empty eligible array.
  if (eligibleCommissions.length === 0) {
    console.log(
      `[aggregateDueCommissionsForPartner] Partner ${partnerId} existing pending payout is full or cannot accommodate additional commissions within MAX_PAYOUT_AMOUNT_LIMIT (${MAX_PAYOUT_AMOUNT_LIMIT}). Deferring remaining commissions.`,
    );
    return { success: true, wasCapped: true, claimedCount: 0 };
  }

  const commissionIds = eligibleCommissions.map((c) => c.id);
  const periodStart = eligibleCommissions[0].createdAt;
  const periodEnd =
    eligibleCommissions[eligibleCommissions.length - 1].createdAt;

  let payoutToUse = existingPendingPayout
    ? { id: existingPendingPayout.id }
    : null;

  const isReusingPendingPayout = !!payoutToUse;

  if (!payoutToUse) {
    // Amount starts at 0 and is set from actually-claimed commissions below
    payoutToUse = await prisma.payout.create({
      data: {
        id: createId({ prefix: "po_" }),
        programId: program.id,
        partnerId,
        periodStart,
        periodEnd,
        amount: 0,
        description: `Dub Partners payout (${program.name})`,
      },
      select: {
        id: true,
      },
    });
  }

  // FIN-AUDIT-01: SQLite / Cloudflare D1 compatible claim statement.
  // Replaced MySQL `UPDATE Commission c INNER JOIN Payout p` and `NOW()`
  // with SQLite-compatible `UPDATE Commission ... WHERE ... AND EXISTS (...)` and `CURRENT_TIMESTAMP`.
  const updatedCommissions = await prisma.$executeRaw`
    UPDATE Commission
    SET
      status = ${CommissionStatus.processed},
      payoutId = ${payoutToUse.id},
      updatedAt = CURRENT_TIMESTAMP
    WHERE id IN (${Prisma.join(commissionIds)})
      AND programId = ${program.id}
      AND partnerId = ${partnerId}
      AND status = ${CommissionStatus.pending}
      AND EXISTS (
        SELECT 1 FROM Payout
        WHERE id = ${payoutToUse.id}
          AND status IN (${Prisma.join(MUTABLE_PAYOUT_STATUSES)})
      )
  `;

  if (updatedCommissions === 0) {
    console.warn(
      `No commissions were updated for partner ${partnerId}. Skipping...`,
    );

    // Lost race (claim or payout no longer mutable) — only delete if still empty.
    if (!isReusingPendingPayout) {
      await prisma.payout.deleteMany({
        where: {
          id: payoutToUse.id,
          commissions: {
            none: {},
          },
        },
      });
    }

    return { success: false, claimedCount: 0 };
  }

  // Always set amount from DB after claim (create + reuse) so partial claims
  // and concurrent attaches cannot leave a stale precomputed sum.
  const {
    _sum: { earnings: totalEarningsForPayout },
  } = await prisma.commission.aggregate({
    where: {
      payoutId: payoutToUse.id,
    },
    _sum: {
      earnings: true,
    },
  });

  const netEarnings = Number(totalEarningsForPayout ?? 0);
  if (netEarnings <= 0) {
    console.log(
      `[aggregateDueCommissionsForPartner] Partner ${partnerId} has non-positive due commissions (${totalEarningsForPayout}). Rolling back to unassigned pending commissions.`,
    );

    // Rollback claimed commissions back to unassigned pending
    await prisma.commission.updateMany({
      where: {
        payoutId: payoutToUse.id,
      },
      data: {
        payoutId: null,
        status: CommissionStatus.pending,
      },
    });

    // Delete payout record
    await prisma.payout.deleteMany({
      where: {
        id: payoutToUse.id,
        status: {
          in: MUTABLE_PAYOUT_STATUSES,
        },
      },
    });

    return { success: false, claimedCount: 0 };
  }

  // FIN-AUDIT-03: Hard overflow guard for single massive commissions exceeding 2.14B
  if (netEarnings > MAX_INT32) {
    console.error(
      `[aggregateDueCommissionsForPartner] Partner ${partnerId} net earnings (${netEarnings}) exceed Int32 maximum (${MAX_INT32}). Rolling back commissions and flagging for manual review.`,
    );

    await prisma.commission.updateMany({
      where: {
        payoutId: payoutToUse.id,
      },
      data: {
        payoutId: null,
        status: CommissionStatus.pending,
      },
    });

    await prisma.payout.deleteMany({
      where: {
        id: payoutToUse.id,
        status: {
          in: MUTABLE_PAYOUT_STATUSES,
        },
      },
    });

    return { success: false, claimedCount: 0 };
  }

  // FIN-AUDIT-01: SQLite / Cloudflare D1 compatible payout update.
  // Replaced `NOW()` with `CURRENT_TIMESTAMP`.
  const updatedPayout = await prisma.$executeRaw`
    UPDATE Payout
    SET
      amount = ${netEarnings},
      periodEnd = COALESCE(${isReusingPendingPayout ? periodEnd : null}, periodEnd),
      updatedAt = CURRENT_TIMESTAMP
    WHERE id = ${payoutToUse.id}
      AND status IN (${Prisma.join(MUTABLE_PAYOUT_STATUSES)})
  `;

  if (updatedPayout === 0) {
    console.warn(
      `Payout ${payoutToUse.id} is no longer mutable after claim for partner ${partnerId}. Skipping...`,
    );
    return { success: false, claimedCount: 0 };
  }

  // Only activity-log commissions we actually claimed (handles partial races).
  const claimedCommissions = await prisma.commission.findMany({
    where: {
      id: {
        in: commissionIds,
      },
      payoutId: payoutToUse.id,
      status: CommissionStatus.processed,
    },
    select: {
      id: true,
      amount: true,
      earnings: true,
      status: true,
    },
  });

  await trackCommissionStatusUpdate({
    workspaceId: program.workspaceId,
    programId: program.id,
    commissions: claimedCommissions,
    newStatus: CommissionStatus.processed,
  });

  try {
    await createWeleticPayoutQuote({ payoutId: payoutToUse.id });
  } catch (error) {
    console.error(
      `[aggregate-due-commissions] Failed to quote payout ${payoutToUse.id}:`,
      error,
    );
  }

  return {
    success: true,
    wasCapped,
    claimedCount: claimedCommissions.length,
  };
}
