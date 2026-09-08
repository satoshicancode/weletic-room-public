export type OrderAttributionTransition =
  | "create"
  | "attach"
  | "duplicate"
  | "conflict";

export const isExplicitShopifyCommissionRuleKey = (logicalKey: string) =>
  !logicalKey.startsWith("shopify-config:") &&
  !logicalKey.startsWith("dub-sale-reward:");

export function resolveOrderAttributionTransition({
  orderExists,
  existingPartnerId,
  requestedPartnerId,
}: {
  orderExists: boolean;
  existingPartnerId?: string | null;
  requestedPartnerId?: string | null;
}): OrderAttributionTransition {
  if (!orderExists) return "create";
  if (
    existingPartnerId &&
    requestedPartnerId &&
    existingPartnerId !== requestedPartnerId
  ) {
    return "conflict";
  }
  if (!existingPartnerId && requestedPartnerId) return "attach";
  return "duplicate";
}

export function selectEffectiveRuleVersions<
  TRule extends {
    logicalKey: string;
    version: number;
    createdAt: Date;
    expiresAt: Date | null;
  },
>(rules: TRule[], occurredAt: Date) {
  return [
    ...rules
      .reduce((byLogicalKey, rule) => {
        const current = byLogicalKey.get(rule.logicalKey);
        if (
          !current ||
          rule.version > current.version ||
          (rule.version === current.version &&
            rule.createdAt > current.createdAt)
        ) {
          byLogicalKey.set(rule.logicalKey, rule);
        }
        return byLogicalKey;
      }, new Map<string, TRule>())
      .values(),
  ].filter((rule) => !rule.expiresAt || rule.expiresAt > occurredAt);
}

export function classifyLifetimeShopifyCustomerOrder({
  numberOfOrders,
  visibleOrderIds,
  currentOrderId,
}: {
  numberOfOrders: number;
  visibleOrderIds: string[];
  currentOrderId: string;
}) {
  const completeLifetimeHistory = visibleOrderIds.length === numberOfOrders;
  return completeLifetimeHistory && visibleOrderIds[0] === currentOrderId
    ? "new"
    : "returning";
}

export function retainKnownShopifyCustomerSnapshot({
  sequence,
  classification,
}: {
  sequence?: number | null;
  classification?: "new" | "returning" | "unknown" | null;
}) {
  return sequence != null && classification && classification !== "unknown"
    ? { sequence, classification }
    : null;
}

export const shopifyOrderSettlementLockKey = (
  workspaceId: string,
  orderId: string | number,
) => `weletic:shopify:order:${workspaceId}:${String(orderId).split("/").pop()}`;

export function resolveShopifySubscriptionCycle({
  subscriptionSeriesKey,
  priorOrderCount,
}: {
  subscriptionSeriesKey?: string | null;
  priorOrderCount: number;
}) {
  if (!subscriptionSeriesKey) return "not_subscription" as const;
  return priorOrderCount === 0 ? ("first" as const) : ("recurring" as const);
}

export function selectCapturedReward<TReward extends { rewardId: string }>({
  snapshot,
  groupId,
  partnerId,
}: {
  snapshot?: {
    rewards: TReward[];
    groups: Array<{ groupId: string; rewardId: string | null }>;
    enrollmentOverrides?: Array<{ partnerId: string; rewardId: string }>;
  } | null;
  groupId?: string | null;
  partnerId?: string | null;
}) {
  if (!snapshot) return null;
  const rewardId =
    (groupId
      ? snapshot.groups.find((entry) => entry.groupId === groupId)?.rewardId
      : null) ??
    (partnerId
      ? snapshot.enrollmentOverrides?.find(
          (entry) => entry.partnerId === partnerId,
        )?.rewardId
      : null);
  return rewardId
    ? snapshot.rewards.find((reward) => reward.rewardId === rewardId) ?? null
    : null;
}

export function assertRecordedShopifyOrder<T>(
  order: T | null,
  externalOrderId: string | number,
): asserts order is T {
  if (!order) {
    throw new Error(
      `Shopify order ${externalOrderId} is not recorded yet; retry the refund webhook.`,
    );
  }
}
