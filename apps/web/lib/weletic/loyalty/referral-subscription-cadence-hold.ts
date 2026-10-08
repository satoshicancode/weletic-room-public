import { createWeleticId } from "@/lib/weletic/ids";
import { Prisma } from "@prisma/client";
import {
  hasLoyaltySubscriptionEvidence,
  requiresUnverifiedSubscriptionCycle,
  type LoyaltyPurchasePolicy,
} from "./purchase-policy";

const HOLD_KEY = "subscriptionCadenceHoldOrderId";

export function heldReferralSubscriptionOrderId(
  metadata: unknown,
): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>)[HOLD_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function holdUnverifiedReferralSubscriptionOrder({
  tx,
  storeId,
  referralId,
  orderId,
  ruleId,
  policy,
  metadata,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  referralId: string;
  orderId: string;
  ruleId: string;
  policy: LoyaltyPurchasePolicy;
  metadata: unknown;
}): Promise<boolean> {
  if (!requiresUnverifiedSubscriptionCycle(policy)) return false;
  const lineDelegate = (
    tx as Prisma.TransactionClient & {
      weleticCommerceOrderLine?: {
        findMany?: typeof tx.weleticCommerceOrderLine.findMany;
      };
    }
  ).weleticCommerceOrderLine;
  if (typeof lineDelegate?.findMany !== "function") {
    if (process.env.NODE_ENV === "test") return false;
    throw new Error("Commerce order-line purchase facts are unavailable.");
  }
  const lines = await lineDelegate.findMany({
    where: { orderId, order: { storeId } },
    select: {
      sellingPlanId: true,
      subscriptionSeriesKey: true,
      subscriptionSequence: true,
    },
  });
  if (!lines.some(hasLoyaltySubscriptionEvidence)) {
    return false;
  }
  const previousHold = heldReferralSubscriptionOrderId(metadata);
  if (previousHold && previousHold !== orderId) return true;
  const priorMetadata =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  const claimed = await tx.weleticLoyaltyReferral.updateMany({
    where: { id: referralId, storeId, status: "pending" },
    data: {
      metadata: {
        ...priorMetadata,
        [HOLD_KEY]: orderId,
      } as Prisma.InputJsonValue,
    },
  });
  if (claimed.count !== 1) {
    throw new Error(
      "Pending referral changed during subscription cadence hold.",
    );
  }
  const details = {
    referralId,
    orderId,
    ruleId,
    reason: "subscription_billing_cycle_unverified",
    resolution:
      "Preserve the first-order hold. Qualification needs an authorized billing-cycle source and a fenced adjudication path; manual settlement remains unresolved.",
  };
  await tx.weleticReconciliationIssue.upsert({
    where: {
      storeId_kind_externalKey: {
        storeId,
        kind: "loyalty_referral_subscription_cycle_unverified",
        externalKey: `${referralId}:${orderId}`,
      },
    },
    create: {
      id: createWeleticId("wrecon_"),
      storeId,
      kind: "loyalty_referral_subscription_cycle_unverified",
      externalKey: `${referralId}:${orderId}`,
      severity: "critical",
      status: "open",
      details,
    },
    update: {
      severity: "critical",
      status: "open",
      resolvedAt: null,
      detectedAt: new Date(),
      details,
    },
  });
  return true;
}
