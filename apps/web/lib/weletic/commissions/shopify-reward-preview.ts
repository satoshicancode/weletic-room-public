import {
  allocateCommissionProportionally,
  divideAndRoundCommission,
} from "@/lib/weletic/commissions/commission-math";
import {
  resolveShopifyEcommerceCommission,
  type ResolvedShopifyCommission,
  type ShopifyRewardSource,
} from "@/lib/weletic/commissions/shopify-reward";
import {
  getShopifyRewardConfigCore,
  ShopifyEcommerceRewardConfigSchema,
  type ShopifyEcommerceRewardConfig,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";

export type ShopifyRewardPreviewCustomer =
  | "new"
  | "returning"
  | "segment_member"
  | "segment_non_member";

export type ShopifyRewardPreviewOrder =
  | { kind: "one_time" }
  | { kind: "first_subscription" }
  | { kind: "renewal"; renewalNumber: number };

export interface ShopifyRewardPreviewLineInput {
  key: string;
  title: string;
  productId?: string | null;
  productExternalId?: string | null;
  variantId?: string | null;
  variantExternalId?: string | null;
  collectionExternalIds?: string[];
  unitAmount: bigint;
  quantity: number;
}

export interface ShopifyRewardPreviewLineResult {
  key: string;
  title: string;
  quantity: number;
  commissionableAmount: bigint;
  commission: bigint;
  source: ResolvedShopifyCommission["source"];
  sourceId: string | null;
  ruleLabel: string;
  type: ResolvedShopifyCommission["type"];
  basisPoints: number | null;
  fixedAmount: bigint | null;
}

export interface ShopifyRewardPreviewResult {
  lines: ShopifyRewardPreviewLineResult[];
  totalCommission: bigint;
}

const PREVIEW_SELLING_PLAN_ID = "preview-selling-plan";

const ruleLabels: Record<ShopifyRewardSource, string> = {
  default_group: "All products",
  collection: "Collection override",
  product: "Product override",
  variant: "Variant override",
  subscription: "Subscription rule",
};

const subscriptionContextFor = (order: ShopifyRewardPreviewOrder) =>
  order.kind === "one_time"
    ? { cycle: "not_subscription" as const }
    : order.kind === "first_subscription"
      ? {
          cycle: "first" as const,
          sellingPlanId: PREVIEW_SELLING_PLAN_ID,
          subscriptionSeriesKey: PREVIEW_SELLING_PLAN_ID,
          sequence: 1,
        }
      : {
          cycle: "recurring" as const,
          sellingPlanId: PREVIEW_SELLING_PLAN_ID,
          subscriptionSeriesKey: PREVIEW_SELLING_PLAN_ID,
          sequence: order.renewalNumber + 1,
        };

const customerContextFor = ({
  config,
  customer,
}: {
  config: ShopifyEcommerceRewardConfig;
  customer: ShopifyRewardPreviewCustomer;
}) => ({
  classification:
    customer === "new" ? ("new" as const) : ("returning" as const),
  segmentIds:
    customer === "segment_member" && config.shopifySegment
      ? [config.shopifySegment.id]
      : [],
});

const fixedRuleKey = (resolved: ResolvedShopifyCommission) =>
  JSON.stringify({
    configHash: resolved.configHash,
    source: resolved.source,
    sourceId: resolved.sourceId,
    fixedAmount: resolved.fixedAmount?.toString() ?? null,
    classification: resolved.customerClassification,
    segmentId: resolved.matchedSegmentId,
    subscriptionCycle:
      resolved.source === "subscription" ? resolved.subscriptionCycle : null,
    sellingPlanId:
      resolved.source === "subscription" ? resolved.sellingPlanId : null,
  });

export function previewShopifyEcommerceReward({
  rawConfig,
  accountingCurrency,
  customer,
  order,
  lines,
}: {
  rawConfig: unknown;
  accountingCurrency: string;
  customer: ShopifyRewardPreviewCustomer;
  order: ShopifyRewardPreviewOrder;
  lines: ShopifyRewardPreviewLineInput[];
}): ShopifyRewardPreviewResult | null {
  const parsed = ShopifyEcommerceRewardConfigSchema.safeParse(rawConfig);
  if (!parsed.success) return null;
  if (
    order.kind === "renewal" &&
    (!Number.isInteger(order.renewalNumber) || order.renewalNumber < 1)
  ) {
    return null;
  }
  if (
    lines.some(
      (line) =>
        line.unitAmount < BigInt(0) ||
        !Number.isInteger(line.quantity) ||
        line.quantity < 1,
    )
  ) {
    return null;
  }

  const config: ShopifyEcommerceRewardConfig = {
    ...getShopifyRewardConfigCore(parsed.data),
    activation: { published: true, startsAt: null, endsAt: null },
  };
  const customerContext = customerContextFor({ config, customer });
  const subscriptionContext = subscriptionContextFor(order);

  const resolvedLines = lines.map((line) => {
    const commissionableAmount = line.unitAmount * BigInt(line.quantity);
    const resolved = resolveShopifyEcommerceCommission({
      rawConfig: config,
      accountingCurrency,
      productContext: {
        productId: line.productId,
        productExternalId: line.productExternalId,
        variantId: line.variantId,
        variantExternalId: line.variantExternalId,
        collectionExternalIds: line.collectionExternalIds,
      },
      customerContext,
      subscriptionContext,
    });

    return { line, commissionableAmount, resolved };
  });

  const completeLines = resolvedLines.filter(
    (item): item is typeof item & { resolved: ResolvedShopifyCommission } =>
      item.resolved !== null,
  );
  if (completeLines.length !== resolvedLines.length) return null;

  const results: ShopifyRewardPreviewLineResult[] = completeLines.map(
    ({ line, commissionableAmount, resolved }) => ({
      key: line.key,
      title: line.title,
      quantity: line.quantity,
      commissionableAmount,
      commission:
        resolved.type === "percentage"
          ? divideAndRoundCommission(
              commissionableAmount * BigInt(resolved.basisPoints ?? 0),
              BigInt(10_000),
            )
          : BigInt(0),
      source: resolved.source,
      sourceId: resolved.sourceId,
      ruleLabel: ruleLabels[resolved.source],
      type: resolved.type,
      basisPoints: resolved.basisPoints,
      fixedAmount: resolved.fixedAmount,
    }),
  );

  const fixedGroups = new Map<
    string,
    Array<{ index: number; resolved: ResolvedShopifyCommission }>
  >();
  completeLines.forEach(({ resolved }, index) => {
    if (resolved.type !== "fixed") return;
    const key = fixedRuleKey(resolved);
    fixedGroups.set(key, [
      ...(fixedGroups.get(key) ?? []),
      { index, resolved },
    ]);
  });

  for (const group of fixedGroups.values()) {
    const allocations = allocateCommissionProportionally({
      total: group[0].resolved.fixedAmount ?? BigInt(0),
      amounts: group.map(({ index }) => results[index].commissionableAmount),
    });
    group.forEach(({ index }, allocationIndex) => {
      results[index].commission = allocations[allocationIndex];
    });
  }

  return {
    lines: results,
    totalCommission: results.reduce(
      (total, line) => total + line.commission,
      BigInt(0),
    ),
  };
}
