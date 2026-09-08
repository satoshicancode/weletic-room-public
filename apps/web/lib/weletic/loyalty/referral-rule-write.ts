import { createWeleticId } from "@/lib/weletic/ids";
import type { Prisma } from "@prisma/client";
import { publishLoyaltyEarnPolicyRevision } from "./earn-policy-revision";
import { isReferralCouponProvisionable } from "./rewards";

export class ReferralRuleWriteError extends Error {
  readonly code: "not_found" | "bad_request";
  constructor({
    code,
    message,
  }: {
    code: "not_found" | "bad_request";
    message: string;
  }) {
    super(message);
    this.name = "ReferralRuleWriteError";
    this.code = code;
  }
}

/** Caller owns authorization, store fencing and a Serializable transaction.
 * Shared with the legacy API; configuration never issues customer rewards.
 */
export async function writeReferralRuleInTransaction({
  tx,
  storeId,
  ruleId,
  ruleData,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  ruleId?: string | null;
  ruleData: Pick<
    Prisma.WeleticLoyaltyReferralRuleUncheckedCreateInput,
    | "advocatePointsReward"
    | "refereePointsReward"
    | "advocateRewardKind"
    | "refereeRewardKind"
    | "advocateRewardDefinitionId"
    | "refereeRewardDefinitionId"
    | "minQualifyingOrderSubtotal"
    | "maxReferralsPerAdvocate"
    | "fraudCheckSameIp"
    | "purchasePolicy"
    | "isActive"
  >;
}) {
  const {
    advocateRewardKind,
    refereeRewardKind,
    advocateRewardDefinitionId,
    refereeRewardDefinitionId,
  } = ruleData;
  const program = await tx.weleticLoyaltyProgram.upsert({
    where: { storeId },
    create: {
      id: createWeleticId("wprog_"),
      storeId,
      name: "Customer Loyalty Program",
      status: "draft",
    },
    update: {},
  });
  // Serialize every referral-rule writer on the parent program. This
  // closes the create/create and activate/activate races without relying
  // on MySQL partial indexes, which cannot express "one active row".
  const lockedProgram = await tx.weleticLoyaltyProgram.updateMany({
    where: { id: program.id },
    data: { updatedAt: new Date() },
  });
  if (lockedProgram.count !== 1) {
    throw new ReferralRuleWriteError({
      code: "not_found",
      message: "Loyalty program no longer exists.",
    });
  }
  await publishLoyaltyEarnPolicyRevision({
    tx,
    storeId,
    programId: program.id,
    reason: "loyalty_program_initialized_from_referrals",
  });

  // Reward updates/archive operations claim the same store row. Re-read
  // each coupon reward only after this transaction owns the store/program
  // fences so a pre-request snapshot cannot authorize a disabled, deleted,
  // cross-store, or otherwise unprovisionable reward definition.
  for (const [kind, rewardDefinitionId, side] of [
    [advocateRewardKind, advocateRewardDefinitionId, "advocate"],
    [refereeRewardKind, refereeRewardDefinitionId, "referee"],
  ] as const) {
    if (kind !== "coupon" || !rewardDefinitionId) continue;
    const reward = await tx.weleticRewardDefinition.findFirst({
      where: {
        id: rewardDefinitionId,
        storeId,
        status: "active",
        exchangeType: "fixed",
      },
    });
    if (
      !reward ||
      reward.status !== "active" ||
      reward.exchangeType !== "fixed" ||
      !isReferralCouponProvisionable(reward)
    ) {
      throw new ReferralRuleWriteError({
        code: "bad_request",
        message: `${side} coupon reward is invalid, cannot be provisioned, or belongs to another store.`,
      });
    }
  }

  let savedRule;
  if (ruleId) {
    const existing = await tx.weleticLoyaltyReferralRule.findFirst({
      where: { id: ruleId, programId: program.id },
    });
    if (!existing) {
      throw new ReferralRuleWriteError({
        code: "not_found",
        message: `Referral rule '${ruleId}' not found for this store.`,
      });
    }
    savedRule = await tx.weleticLoyaltyReferralRule.update({
      where: { id: ruleId },
      data: ruleData,
    });
  } else {
    savedRule = await tx.weleticLoyaltyReferralRule.create({
      data: {
        id: createWeleticId("wreferral_"),
        programId: program.id,
        ...ruleData,
      },
    });
  }

  if (savedRule.isActive) {
    await tx.weleticLoyaltyReferralRule.updateMany({
      where: {
        programId: program.id,
        isActive: true,
        id: { not: savedRule.id },
      },
      data: { isActive: false },
    });
  } else {
    // The UI toggle is program-wide. In a legacy duplicate-row state,
    // preserving another active row would make the API report disabled
    // while qualification silently remained enabled.
    await tx.weleticLoyaltyReferralRule.updateMany({
      where: { programId: program.id, isActive: true },
      data: { isActive: false },
    });
  }
  return savedRule;
}
