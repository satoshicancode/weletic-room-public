import type { Prisma } from "@prisma/client";

/** Caller holds the store/program fence and has established an active account.
 * Wake pending jobs only: never steal a lease or reset failed/dead-letter work.
 * Remaining jobs keep their existing retry deadline; this is an acceleration,
 * not the only recovery producer or a financial writer.
 */
export async function wakeReviewPointsAfterEnrollment({
  tx,
  storeId,
  shopperId,
  installationGeneration,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  shopperId: string;
  installationGeneration: string;
}) {
  if (!installationGeneration || installationGeneration.length > 64)
    throw new Error("Review recovery wake-up requires installation identity");
  const where = {
    storeId,
    jobType: "REVIEW_POINTS_RECOVERY" as const,
    status: "pending" as const,
    lockedAt: null,
    lockedBy: null,
    AND: [
      { payload: { path: "$.shopperId", equals: shopperId } },
      {
        payload: {
          path: "$.installationGeneration",
          equals: installationGeneration,
        },
      },
    ],
  } satisfies Prisma.WeleticLoyaltyOutboxJobWhereInput;
  const jobs = await tx.weleticLoyaltyOutboxJob.findMany({
    where,
    orderBy: { id: "asc" },
    take: 100,
    select: { id: true },
  });
  if (!jobs.length) return 0;
  const result = await tx.weleticLoyaltyOutboxJob.updateMany({
    where: { ...where, id: { in: jobs.map(({ id }) => id) } },
    data: { scheduledFor: new Date(), nextRetryAt: null },
  });
  return result.count;
}
