import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { scheduleTierReviewAfterQualifyingActivity } from "@/lib/weletic/loyalty/tier-review-scheduling";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { z } from "zod";

export const reviewRewardConditionsSchema = z.object({
  provider: z.enum(["native", "judgeme"]).default("native"),
  minContentLength: z.number().int().min(0).max(10_000).default(20),
  photoBonusPoints: z.number().int().min(0).max(1_000_000).default(0),
  videoBonusPoints: z.number().int().min(0).max(1_000_000).default(0),
});

export type ReviewProvider = "native" | "judgeme";
// Missing provider belongs to the pre-native Judge.me contract. New native
// rules explicitly persist their provider instead of reinterpreting old rows.
function parseStoredConditions(conditions: Prisma.JsonValue | null) {
  if (
    conditions !== null &&
    (typeof conditions !== "object" || Array.isArray(conditions))
  )
    return reviewRewardConditionsSchema.safeParse(conditions);
  return reviewRewardConditionsSchema.safeParse({
    provider: "judgeme",
    ...(conditions ?? {}),
  });
}
export type ReviewRewardEvidence = {
  id: string;
  body: string;
  rating: number;
  productId: string | null;
  hasPhoto: boolean;
  hasVideo: boolean;
  verifiedStatus: string;
};

export type ReviewAwardResult =
  | { status: "awarded"; pointsAwarded: string; accountId: string }
  | { status: "duplicate" | "ignored" | "limit_reached"; reason: string };

export type ReviewClawbackResult =
  | {
      status: "clawed_back";
      pointsReversed: string;
      balanceAfter: string;
      accountId: string;
    }
  | {
      status: "duplicate";
      reason: "already_clawed_back";
      pointsReversed: string;
      balanceAfter: string;
      accountId: string;
    }
  | { status: "ignored"; reason: string };

export const reviewAwardKey = (
  storeId: string,
  provider: ReviewProvider,
  reviewId: string,
) => `review:${provider}:${storeId}:${reviewId}`;

const referenceType = (provider: ReviewProvider) =>
  provider === "native" ? "REVIEW_NATIVE" : "REVIEW_JUDGEME";

/** Caller verifies provenance and holds the store/program mutation fence. */
export async function awardVerifiedReviewPoints({
  tx,
  storeId,
  provider,
  review,
  accountIdentity,
  now = new Date(),
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  provider: ReviewProvider;
  review: ReviewRewardEvidence;
  accountIdentity: { shopperId: string } | { email: string };
  now?: Date;
}): Promise<ReviewAwardResult> {
  const idempotencyKey = reviewAwardKey(storeId, provider, review.id);
  const existing = await tx.weleticPointsLedgerEntry.findUnique({
    where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
  });
  if (existing)
    return { status: "duplicate", reason: "review_already_rewarded" };

  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: {
      storeId,
      status: "active",
      ...("shopperId" in accountIdentity
        ? { shopperId: accountIdentity.shopperId }
        : { shopper: { email: accountIdentity.email } }),
    },
    include: {
      program: {
        include: {
          earningRules: {
            where: {
              triggerCode: "product_review",
              ruleType: "fixed_points",
              isActive: true,
              deletedAt: null,
              OR: [{ startAt: null }, { startAt: { lte: now } }],
              AND: [{ OR: [{ endAt: null }, { endAt: { gt: now } }] }],
            },
            orderBy: [
              { priority: "desc" },
              { createdAt: "asc" },
              { id: "asc" },
            ],
          },
        },
      },
    },
  });
  if (
    !account ||
    account.program.status !== "active" ||
    account.program.killSwitchActive
  ) {
    return { status: "ignored", reason: "account_or_rule_unavailable" };
  }
  const rule = account.program.earningRules.find((candidate) => {
    const parsed = parseStoredConditions(candidate.conditions);
    if (!parsed.success || parsed.data.provider !== provider) return false;
    const tiers = candidate.eligibleTierIds;
    return (
      !Array.isArray(tiers) ||
      tiers.length === 0 ||
      (account.currentTierId !== null && tiers.includes(account.currentTierId))
    );
  });
  if (!rule?.fixedPoints || rule.fixedPoints <= BigInt(0)) {
    return { status: "ignored", reason: "account_or_rule_unavailable" };
  }
  const parsedConditions = parseStoredConditions(rule.conditions);
  if (!parsedConditions.success)
    return { status: "ignored", reason: "account_or_rule_unavailable" };
  const config = parsedConditions.data;
  if (review.body.trim().length < config.minContentLength) {
    return { status: "ignored", reason: "review_content_too_short" };
  }
  const periodStart =
    rule.limitInterval === "lifetime"
      ? null
      : rule.limitInterval === "calendar_year"
        ? new Date(Date.UTC(now.getUTCFullYear(), 0, 1))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const count = await tx.weleticPointsLedgerEntry.count({
    where: {
      storeId,
      accountId: account.id,
      referenceType: { in: ["REVIEW_NATIVE", "REVIEW_JUDGEME"] },
      pointsDelta: { gt: BigInt(0) },
      ...(periodStart ? { createdAt: { gte: periodStart, lte: now } } : {}),
    },
  });
  if (count >= Math.max(1, Math.min(100, rule.maxEventsPerCustomer ?? 2))) {
    return { status: "limit_reached", reason: "review_velocity_limit" };
  }
  const mediaBonus = Math.max(
    review.hasPhoto ? config.photoBonusPoints : 0,
    review.hasVideo ? config.videoBonusPoints : 0,
  );
  let points = rule.fixedPoints + BigInt(mediaBonus);
  if (rule.maxPointsPerEvent !== null && rule.maxPointsPerEvent !== undefined) {
    points = points < rule.maxPointsPerEvent ? points : rule.maxPointsPerEvent;
  }
  if (points <= BigInt(0))
    return { status: "ignored", reason: "zero_review_reward" };
  // Rating is audit evidence only. It must never affect reward eligibility/value.
  const entry = await appendPointsLedgerEntry({
    storeId,
    accountId: account.id,
    entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
    pointsDelta: points,
    referenceType: referenceType(provider),
    referenceId: review.id,
    idempotencyKey,
    reason: rule.name,
    metadata: {
      provider,
      reviewId: review.id,
      earningRuleId: rule.id,
      productId: review.productId,
      rating: review.rating,
      hasPhoto: review.hasPhoto,
      hasVideo: review.hasVideo,
      verifiedStatus: review.verifiedStatus,
    },
    tx,
  });
  await enqueueFlowTriggerJob({
    storeId,
    eventId: entry.id,
    payload: {
      accountId: account.id,
      handle: "weletic-points-earned",
      pointsDelta: entry.pointsDelta.toString(),
      pointsBalance: entry.balanceAfter.toString(),
      reason: "verified_review",
      orderId: null,
    },
    tx,
  });
  await scheduleTierReviewAfterQualifyingActivity({
    storeId,
    accountId: account.id,
    activityKey: idempotencyKey,
    reason: "verified_review_points_earned",
    tx,
  });
  return {
    status: "awarded",
    pointsAwarded: entry.pointsDelta.toString(),
    accountId: account.id,
  };
}

/** Exact append-only reversal; the ledger deliberately permits a negative balance. */
export async function reverseReviewPoints({
  tx,
  storeId,
  provider,
  reviewId,
  reason,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  provider: ReviewProvider;
  reviewId: string;
  reason?: string;
}): Promise<ReviewClawbackResult> {
  const idempotencyKey = `review_clawback:${provider}:${storeId}:${reviewId}`;
  const existing = await tx.weleticPointsLedgerEntry.findUnique({
    where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
  });
  if (existing)
    return {
      status: "duplicate",
      reason: "already_clawed_back",
      pointsReversed: (-existing.pointsDelta).toString(),
      balanceAfter: existing.balanceAfter.toString(),
      accountId: existing.accountId,
    };
  const award = await tx.weleticPointsLedgerEntry.findUnique({
    where: {
      storeId_idempotencyKey: {
        storeId,
        idempotencyKey: reviewAwardKey(storeId, provider, reviewId),
      },
    },
  });
  if (!award || award.pointsDelta <= BigInt(0))
    return { status: "ignored", reason: "no_prior_award_found" };
  const entry = await appendPointsLedgerEntry({
    storeId,
    accountId: award.accountId,
    entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
    pointsDelta: -award.pointsDelta,
    referenceType: `${referenceType(provider)}_CLAWBACK`,
    referenceId: reviewId,
    idempotencyKey,
    reason:
      reason ?? "Points clawback for moderated, deleted, or unverified review",
    metadata: {
      provider,
      reviewId,
      originalAwardEntryId: award.id,
      clawbackReason: reason ?? "review_deleted_or_moderated",
    },
    tx,
  });
  await scheduleTierReviewAfterQualifyingActivity({
    storeId,
    accountId: award.accountId,
    activityKey: idempotencyKey,
    reason: "review_points_clawed_back",
    tx,
  });
  return {
    status: "clawed_back",
    pointsReversed: award.pointsDelta.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    accountId: award.accountId,
  };
}
