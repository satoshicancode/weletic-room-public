import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { approveReferralFriendClaimAfterReview } from "@/lib/weletic/loyalty/referral-friend-claim";
import {
  DEFAULT_REFERRAL_RULE_CONFIG,
  InvalidReferralRuleConfigurationError,
  parseMaxReferralsPerAdvocate,
} from "@/lib/weletic/loyalty/referral-rule-config";
import {
  ReferralRuleWriteError,
  writeReferralRuleInTransaction,
} from "@/lib/weletic/loyalty/referral-rule-write";
import {
  cancelReferralByMerchant,
  getCanonicalReferralRule,
  unblockReferralAfterReview,
} from "@/lib/weletic/loyalty/referrals";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";

const REFERRAL_RULE_WRITE_RETRIES = 5;

async function runSerializableReferralRuleWrite<T>(
  storeId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  for (let attempt = 1; attempt <= REFERRAL_RULE_WRITE_RETRIES; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          await assertShopifyStoreAcceptsOperationalWrites({
            storeId,
            action: "loyalty_referral_rule_write",
            tx,
          });
          return operation(tx);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        },
      );
    } catch (error) {
      if (error instanceof ReferralRuleWriteError)
        throw new DubApiError({ code: error.code, message: error.message });
      const retryable =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034";
      if (!retryable || attempt === REFERRAL_RULE_WRITE_RETRIES) throw error;
    }
  }

  throw new Error("Referral rule write retry budget exhausted.");
}

function serializeReferralRule(rule: any) {
  const minQualifyingOrderSubtotal =
    rule.minQualifyingOrderSubtotal?.toString() ?? null;
  return {
    id: rule.id,
    advocatePointsReward: rule.advocatePointsReward.toString(),
    refereePointsReward: rule.refereePointsReward.toString(),
    advocateRewardKind: rule.advocateRewardKind,
    refereeRewardKind: rule.refereeRewardKind,
    advocateRewardDefinitionId: rule.advocateRewardDefinitionId,
    refereeRewardDefinitionId: rule.refereeRewardDefinitionId,
    minQualifyingOrderSubtotal,
    minOrderAmount: minQualifyingOrderSubtotal,
    maxReferralsPerAdvocate: rule.maxReferralsPerAdvocate,
    fraudCheckSameIp: rule.fraudCheckSameIp,
    blockSameIp: rule.fraudCheckSameIp,
    isActive: rule.isActive,
  };
}

export const GET = withWorkspace(
  async ({ workspace }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const program = await prisma.weleticLoyaltyProgram.findUnique({
      where: { storeId: store.id },
    });
    const rule = program ? await getCanonicalReferralRule(program.id) : null;
    const [referrals, linksGenerated, refereesBound, qualifiedOrders, totals] =
      await Promise.all([
        prisma.weleticLoyaltyReferral.findMany({
          where: { storeId: store.id },
          orderBy: { createdAt: "desc" },
          take: 50,
          include: {
            advocateAccount: { include: { shopper: true } },
            refereeAccount: { include: { shopper: true } },
          },
        }),
        prisma.link.count({
          where: {
            projectId: store.projectId,
            externalId: { startsWith: "loyalty_referral:" },
          },
        }),
        prisma.weleticLoyaltyReferral.count({
          where: { storeId: store.id },
        }),
        prisma.weleticLoyaltyReferral.count({
          where: {
            storeId: store.id,
            status: { in: ["qualified", "rewarded"] },
          },
        }),
        prisma.weleticLoyaltyReferral.aggregate({
          where: { storeId: store.id },
          _sum: {
            advocatePointsAwarded: true,
            refereePointsAwarded: true,
          },
        }),
      ]);
    const pointsRewarded =
      (totals._sum.advocatePointsAwarded ?? BigInt(0)) +
      (totals._sum.refereePointsAwarded ?? BigInt(0));

    return loyaltySuccessResponse(
      {
        rule: rule
          ? serializeReferralRule(rule)
          : {
              ...DEFAULT_REFERRAL_RULE_CONFIG,
              minOrderAmount:
                DEFAULT_REFERRAL_RULE_CONFIG.minQualifyingOrderSubtotal,
              blockSameIp: DEFAULT_REFERRAL_RULE_CONFIG.fraudCheckSameIp,
            },
        metrics: {
          linksGenerated,
          refereesBound,
          qualifiedOrders,
          pointsRewarded: pointsRewarded.toString(),
        },
        activity: referrals.map((referral) => ({
          id: referral.id,
          status: referral.status,
          advocateName: referral.advocateAccount.shopper.firstName || "Member",
          refereeName:
            referral.refereeAccount?.shopper.firstName ||
            (referral.friendEmailDigest ? "Email friend claim" : "Friend"),
          qualifyingOrderId: referral.qualifyingOrderId,
          advocatePointsAwarded: referral.advocatePointsAwarded.toString(),
          refereePointsAwarded: referral.refereePointsAwarded.toString(),
          fraudReason: referral.fraudReason,
          fraudSignals: referral.fraudSignals,
          refereeOrdersCount:
            referral.refereeAccount?.shopper.ordersCount ?? null,
          claimMode: referral.friendEmailDigest
            ? "anonymous_email"
            : "bound_account",
          friendRewardProvisionedAt: referral.friendRewardProvisionedAt,
          friendRewardEmailedAt: referral.friendRewardEmailedAt,
          friendRewardExpiresAt: referral.friendRewardExpiresAt,
          createdAt: referral.createdAt,
          rewardedAt: referral.rewardedAt,
        })),
        programId: program?.id,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

export const POST = withWorkspace(
  async ({ workspace, req }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const storeId = store.id;
    const body = await parseRequestBody(req);
    const {
      ruleId,
      advocatePointsReward = DEFAULT_REFERRAL_RULE_CONFIG.advocatePointsReward,
      refereePointsReward = DEFAULT_REFERRAL_RULE_CONFIG.refereePointsReward,
      advocateRewardKind = DEFAULT_REFERRAL_RULE_CONFIG.advocateRewardKind,
      refereeRewardKind = DEFAULT_REFERRAL_RULE_CONFIG.refereeRewardKind,
      advocateRewardDefinitionId = DEFAULT_REFERRAL_RULE_CONFIG.advocateRewardDefinitionId,
      refereeRewardDefinitionId = DEFAULT_REFERRAL_RULE_CONFIG.refereeRewardDefinitionId,
      minQualifyingOrderSubtotal = body.minOrderAmount ??
        DEFAULT_REFERRAL_RULE_CONFIG.minQualifyingOrderSubtotal,
      maxReferralsPerAdvocate:
        rawMaxReferralsPerAdvocate = DEFAULT_REFERRAL_RULE_CONFIG.maxReferralsPerAdvocate,
      fraudCheckSameIp = body.blockSameIp ??
        DEFAULT_REFERRAL_RULE_CONFIG.fraudCheckSameIp,
      isActive = DEFAULT_REFERRAL_RULE_CONFIG.isActive,
    } = body;
    let maxReferralsPerAdvocate: number | null;
    try {
      maxReferralsPerAdvocate = parseMaxReferralsPerAdvocate(
        rawMaxReferralsPerAdvocate,
      );
    } catch (error) {
      if (error instanceof InvalidReferralRuleConfigurationError) {
        throw new DubApiError({
          code: "bad_request",
          message: error.message,
        });
      }
      throw error;
    }

    for (const [kind, rewardDefinitionId, side] of [
      [advocateRewardKind, advocateRewardDefinitionId, "advocate"],
      [refereeRewardKind, refereeRewardDefinitionId, "referee"],
    ] as const) {
      if (kind !== "points" && kind !== "coupon") {
        throw new DubApiError({
          code: "bad_request",
          message: `Unsupported ${side} referral reward kind.`,
        });
      }
      if (kind === "coupon") {
        if (!rewardDefinitionId) {
          throw new DubApiError({
            code: "bad_request",
            message: `${side} coupon reward requires a reward definition.`,
          });
        }
      }
    }

    const ruleData = {
      advocatePointsReward: BigInt(advocatePointsReward),
      refereePointsReward: BigInt(refereePointsReward),
      advocateRewardKind,
      refereeRewardKind,
      advocateRewardDefinitionId:
        advocateRewardKind === "coupon" ? advocateRewardDefinitionId : null,
      refereeRewardDefinitionId:
        refereeRewardKind === "coupon" ? refereeRewardDefinitionId : null,
      minQualifyingOrderSubtotal:
        minQualifyingOrderSubtotal !== null
          ? new Prisma.Decimal(minQualifyingOrderSubtotal)
          : null,
      maxReferralsPerAdvocate,
      fraudCheckSameIp: Boolean(fraudCheckSameIp),
      isActive: Boolean(isActive),
    };
    const rule = await runSerializableReferralRuleWrite(storeId, async (tx) => {
      return writeReferralRuleInTransaction({ tx, storeId, ruleId, ruleData });
    });

    return loyaltySuccessResponse(
      {
        success: true,
        rule: serializeReferralRule(rule),
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

export const PATCH = withWorkspace(
  async ({ workspace, req }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });
    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const body = await parseRequestBody(req);
    const referralId =
      typeof body.referralId === "string" ? body.referralId.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim() : "";
    if (!referralId || !["cancel", "unblock"].includes(action)) {
      throw new DubApiError({
        code: "bad_request",
        message: "A referralId and supported review action are required.",
      });
    }

    try {
      const reviewTarget = await prisma.weleticLoyaltyReferral.findFirst({
        where: { id: referralId, storeId: store.id },
        select: { friendEmailDigest: true },
      });
      if (!reviewTarget) {
        throw new Error(`Referral ${referralId} not found.`);
      }
      const referral =
        action === "cancel"
          ? await cancelReferralByMerchant({
              storeId: store.id,
              referralId,
              reason:
                typeof body.reason === "string" && body.reason.trim()
                  ? body.reason
                  : "Rejected during merchant fraud review",
            })
          : reviewTarget.friendEmailDigest
            ? await approveReferralFriendClaimAfterReview({
                storeId: store.id,
                referralId,
                reviewNote:
                  typeof body.note === "string" ? body.note : undefined,
              })
            : await unblockReferralAfterReview({
                storeId: store.id,
                referralId,
                reviewNote:
                  typeof body.note === "string" ? body.note : undefined,
              });
      return loyaltySuccessResponse(
        {
          success: true,
          referral: {
            id: referral.id,
            status: referral.status,
          },
        },
        { headers: COMMON_CORS_HEADERS },
      );
    } catch (error) {
      throw new DubApiError({
        code: "bad_request",
        message:
          error instanceof Error
            ? error.message
            : "Referral review action failed.",
      });
    }
  },
  {
    requiredPermissions: ["loyalty.write"],
    requiredRoles: ["owner"],
  },
);

export const OPTIONS = () => {
  return new Response(null, {
    status: 204,
    headers: COMMON_CORS_HEADERS,
  });
};
