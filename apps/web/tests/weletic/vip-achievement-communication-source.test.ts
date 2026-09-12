import type { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";
import type { VipAchievementCommunication } from "../../lib/weletic/loyalty/vip-achievement-communication-contract";
import { isCurrentVipAchievement } from "../../lib/weletic/loyalty/vip-achievement-communication-source";

it.each(["no-tier-rollback", "missing-tier-relation"])(
  "rejects %s without sending an achievement",
  async (kind) => {
    const event = {
      accountId: "account",
      programId: "program",
      tierHistoryId: "history",
      sequenceNumber: 2,
      fromTier: { id: "bronze" },
      toTier: { id: "gold" },
      occurredAt: "2026-09-12T00:00:00.000Z",
    } as VipAchievementCommunication;
    const findFirst = vi.fn().mockResolvedValue({
      id: "history",
      sequenceNumber: 2,
      fromTierId: "bronze",
      toTierId: kind === "no-tier-rollback" ? null : "gold",
      changeReason: "threshold_reached",
      effectiveAt: new Date(event.occurredAt),
      fromTier: { programId: "program" },
      toTier: null,
    });
    const db = {
      weleticLoyaltyTierHistory: { findFirst },
    } as unknown as Prisma.TransactionClient;
    await expect(
      isCurrentVipAchievement({ db, event, currentTierId: "gold" }),
    ).resolves.toBe(false);
  },
);
