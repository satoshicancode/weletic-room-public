import type { Prisma } from "@prisma/client";
import type { VipAchievementCommunication } from "./vip-achievement-communication-contract";

/** Account ownership must already be established by a scoped active-account
 * read. Admission callers must read the tier and history under the same fence. */
export async function isCurrentVipAchievement({
  db,
  event,
  currentTierId,
}: {
  db: Pick<Prisma.TransactionClient, "weleticLoyaltyTierHistory">;
  event: VipAchievementCommunication;
  currentTierId: string | null;
}) {
  if (currentTierId !== event.toTier.id) return false;
  const latest = await db.weleticLoyaltyTierHistory.findFirst({
    where: { accountId: event.accountId },
    orderBy: { sequenceNumber: "desc" },
    select: {
      id: true,
      sequenceNumber: true,
      fromTierId: true,
      toTierId: true,
      changeReason: true,
      effectiveAt: true,
      fromTier: { select: { programId: true } },
      toTier: { select: { programId: true } },
    },
  });
  return (
    !!latest &&
    latest.id === event.tierHistoryId &&
    latest.sequenceNumber === event.sequenceNumber &&
    latest.fromTierId === event.fromTier.id &&
    latest.toTierId === event.toTier.id &&
    latest.changeReason === "threshold_reached" &&
    latest.effectiveAt.toISOString() === event.occurredAt &&
    latest.fromTier?.programId === event.programId &&
    latest.toTier.programId === event.programId
  );
}
