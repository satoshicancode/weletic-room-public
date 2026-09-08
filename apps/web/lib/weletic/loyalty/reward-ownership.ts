/**
 * Legacy exchanges and referral coupons belong to a loyalty account. Direct
 * shopper incentives must never enter code that refunds/debits account points.
 * Keep this runtime check at financial boundaries, not just in query filters.
 */
export function assertAccountBackedReward<
  T extends { accountId: string | null; fulfillmentSource?: string | null },
>(reward: T): asserts reward is T & { accountId: string } {
  if (!reward.accountId || reward.fulfillmentSource != null) {
    throw new Error(
      "This reward requires the direct shopper fulfillment path.",
    );
  }
}

export function assertRewardAccountRelation<
  T extends { account: object | null },
>(reward: T): asserts reward is T & { account: NonNullable<T["account"]> } {
  if (!reward.account) {
    throw new Error(
      "This reward has no loyalty account; points operations are forbidden.",
    );
  }
}
import type { Prisma } from "@prisma/client";

export const DIRECT_REVIEW_REWARD_SOURCE = "review_incentive_v1";

/** Both ownership variants are independently store- and shopper-scoped. */
export function shopperRewardOwnershipWhere({
  storeId,
  shopperId,
  accountId,
}: {
  storeId: string;
  shopperId: string;
  accountId: string | null;
}): Prisma.WeleticRewardRedemptionWhereInput {
  return {
    storeId,
    OR: [
      ...(accountId
        ? [
            {
              accountId,
              fulfillmentSource: null,
              account: { storeId, shopperId },
            },
          ]
        : []),
      {
        accountId: null,
        shopperId,
        shopper: { storeId, id: shopperId },
        fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
        fulfillmentReference: { not: null },
        pointsSpent: BigInt(0),
        ledgerEntryId: null,
        artifactKind: "discount_code",
      },
    ],
  };
}
