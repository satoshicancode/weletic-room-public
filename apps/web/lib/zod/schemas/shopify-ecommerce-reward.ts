import * as z from "zod/v4";
import { rewardActivityDescriptionSchema } from "./rewards";

export type ShopifyRewardResourceType =
  | "Product"
  | "ProductVariant"
  | "Collection"
  | "Segment";

export const normalizeShopifyRewardResourceId = (
  type: ShopifyRewardResourceType,
  value?: string | null,
) => {
  if (!value) return null;
  const prefix = `gid://shopify/${type}/`;
  if (value.startsWith(prefix)) return value.slice(prefix.length);
  return /^\d+$/.test(value) ? value : null;
};

export const sameShopifyRewardResourceId = (
  type: ShopifyRewardResourceType,
  left?: string | null,
  right?: string | null,
) => {
  if (!left || !right) return false;
  if (left === right) return true;
  const normalizedLeft = normalizeShopifyRewardResourceId(type, left);
  return (
    normalizedLeft !== null &&
    normalizedLeft === normalizeShopifyRewardResourceId(type, right)
  );
};

const shopifyRewardResourceIdKey = (
  type: ShopifyRewardResourceType,
  value: string,
) => normalizeShopifyRewardResourceId(type, value) ?? value;

export const SHOPIFY_CUSTOMER_SEGMENT_MODES = [
  {
    value: "none",
    label: "Same commission for all customers",
    description:
      "Apply standard commission rate to every order regardless of customer history.",
  },
  {
    value: "new_vs_returning",
    label: "Set different commission rates for New vs. Returning customers",
    description:
      "Reward higher commission for acquiring brand new customers to maximize growth.",
  },
  {
    value: "shopify_segment",
    label: "Set a different commission rate for customers in a Shopify Segment",
    description:
      "Apply custom rates based on Shopify customer tags or saved segments.",
  },
] as const;

export const SHOPIFY_SUBSCRIPTION_COMMISSION_MODES = [
  {
    value: "first_sale",
    label: "Commission for first sale",
    description:
      "Pay the applicable commission on the first observed order only.",
  },
  {
    value: "every_recurring_order",
    label: "Commission for every recurring order",
    description:
      "Pay the applicable commission on the first observed order and every renewal.",
  },
  {
    value: "limited_recurring_orders",
    label: "Commission for number of recurring orders",
    description:
      "Pay the applicable commission on the first observed order and the specified number of renewals.",
  },
] as const;

export const ShopifySubscriptionCommissionModeSchema = z.enum([
  "first_sale",
  "every_recurring_order",
  "limited_recurring_orders",
]);

const ShopifySubscriptionRulesSchema = z
  .preprocess(
    (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value;
      }

      const legacy = value as Record<string, unknown>;
      if (
        legacy.mode === undefined &&
        typeof legacy.firstSaleOnly === "boolean"
      ) {
        return {
          mode: legacy.firstSaleOnly ? "first_sale" : "every_recurring_order",
          recurringOrderCount: null,
        };
      }

      return value;
    },
    z
      .object({
        mode: ShopifySubscriptionCommissionModeSchema.default("first_sale"),
        recurringOrderCount: z.number().int().min(1).nullable().default(null),
      })
      .superRefine((rules, ctx) => {
        if (
          rules.mode === "limited_recurring_orders" &&
          rules.recurringOrderCount === null
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["recurringOrderCount"],
            message: "Enter how many recurring orders should earn commission.",
          });
        }
      })
      .transform((rules) => ({
        ...rules,
        recurringOrderCount:
          rules.mode === "limited_recurring_orders"
            ? rules.recurringOrderCount
            : null,
      })),
  )
  .default({ mode: "first_sale", recurringOrderCount: null });

export const ShopifyRewardCollectionOverrideSchema = z.object({
  id: z.string(), // e.g. "gid://shopify/Collection/123456" or "123456"
  title: z.string(),
  returningRate: z.number().min(0).max(100),
  newRate: z.number().min(0).max(100).optional(),
  segmentRate: z.number().min(0).max(100).optional(),
});

export const ShopifyRewardProductOverrideSchema = z.object({
  id: z.string(), // e.g. "gid://shopify/Product/789012" or "789012"
  title: z.string(),
  image: z.string().optional().nullable(),
  returningRate: z.number().min(0).max(100),
  newRate: z.number().min(0).max(100).optional(),
  segmentRate: z.number().min(0).max(100).optional(),
});

export const ShopifyRewardVariantOverrideSchema = z.object({
  id: z.string(), // e.g. "gid://shopify/ProductVariant/345678" or "345678"
  title: z.string(),
  returningRate: z.number().min(0).max(100),
  newRate: z.number().min(0).max(100).optional(),
  segmentRate: z.number().min(0).max(100).optional(),
});

export const ShopifyRewardSegmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rate: z.number().min(0).max(100),
});

export const ShopifyRewardActivationSchema = z
  .object({
    published: z.boolean().default(true),
    startsAt: z.iso.datetime().nullable().default(null),
    endsAt: z.iso.datetime().nullable().default(null),
  })
  .superRefine((activation, ctx) => {
    if (
      activation.startsAt &&
      activation.endsAt &&
      new Date(activation.endsAt) <= new Date(activation.startsAt)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "The end date must be after the start date.",
      });
    }
  });

export const ShopifyEcommerceRewardConfigCoreSchema = z.object({
  type: z.literal("shopify_ecommerce").default("shopify_ecommerce"),
  activation: ShopifyRewardActivationSchema.default({
    published: true,
    startsAt: null,
    endsAt: null,
  }),
  customerSegmentMode: z
    .enum(["none", "new_vs_returning", "shopify_segment"])
    .default("new_vs_returning"),
  baseRateType: z.enum(["percentage", "flat"]).default("percentage"),
  baseReturningRate: z.number().min(0).max(100).default(10),
  baseNewRate: z.number().min(0).max(100).default(20),
  shopifySegment: ShopifyRewardSegmentSchema.nullable().default(null),
  collectionOverrides: z
    .array(ShopifyRewardCollectionOverrideSchema)
    .default([]),
  productOverrides: z.array(ShopifyRewardProductOverrideSchema).default([]),
  variantOverrides: z.array(ShopifyRewardVariantOverrideSchema).default([]),
  subscriptionRules: ShopifySubscriptionRulesSchema,
});

export const ShopifyEcommerceRewardConfigSchema =
  ShopifyEcommerceRewardConfigCoreSchema.extend({
    history: z
      .array(
        z.object({
          effectiveAt: z.iso.datetime(),
          config: ShopifyEcommerceRewardConfigCoreSchema,
        }),
      )
      .optional(),
  }).superRefine((config, ctx) => {
    if (
      config.customerSegmentMode === "shopify_segment" &&
      !config.shopifySegment
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["shopifySegment"],
        message:
          "Select a Shopify customer segment and configure its commission rate.",
      });
    }

    for (const [path, resourceType, overrides] of [
      ["collectionOverrides", "Collection", config.collectionOverrides],
      ["productOverrides", "Product", config.productOverrides],
      ["variantOverrides", "ProductVariant", config.variantOverrides],
    ] as const) {
      const seen = new Set<string>();
      overrides.forEach((override, index) => {
        const idKey = shopifyRewardResourceIdKey(resourceType, override.id);
        if (seen.has(idKey)) {
          ctx.addIssue({
            code: "custom",
            path: [path, index, "id"],
            message: "Each Shopify override target can only appear once.",
          });
        }
        seen.add(idKey);
      });
    }
  });

export type ShopifyEcommerceRewardConfigCore = z.infer<
  typeof ShopifyEcommerceRewardConfigCoreSchema
>;

export type ShopifyRewardActivation = z.infer<
  typeof ShopifyRewardActivationSchema
>;
export type ShopifyRewardLifecycleStatus =
  | "draft"
  | "scheduled"
  | "active"
  | "ended";

export function getShopifyRewardLifecycleStatus({
  activation,
  at = new Date(),
}: {
  activation: ShopifyRewardActivation;
  at?: Date;
}): ShopifyRewardLifecycleStatus {
  if (!activation.published) return "draft";
  if (activation.endsAt && new Date(activation.endsAt) <= at) return "ended";
  if (activation.startsAt && new Date(activation.startsAt) > at) {
    return "scheduled";
  }
  return "active";
}

export const isShopifyRewardActiveAt = (
  activation: ShopifyRewardActivation,
  at: Date,
) => getShopifyRewardLifecycleStatus({ activation, at }) === "active";

const ShopifyCapturedRewardSchema = z.object({
  rewardId: z.string(),
  config: ShopifyEcommerceRewardConfigCoreSchema,
});

export const ShopifyOrderRewardSnapshotSchema = z.object({
  version: z.literal(1),
  capturedAt: z.iso.datetime(),
  rewards: z.array(ShopifyCapturedRewardSchema),
  groups: z.array(
    z.object({
      groupId: z.string(),
      rewardId: z.string().nullable(),
    }),
  ),
  enrollmentOverrides: z.array(
    z.object({
      partnerId: z.string(),
      rewardId: z.string(),
    }),
  ),
  commissionRuleIds: z.array(z.string()),
  collectionRuleExternalIds: z.array(z.string()),
});

export type ShopifyOrderRewardSnapshot = z.infer<
  typeof ShopifyOrderRewardSnapshotSchema
>;

export const getShopifyRewardConfigCore = (
  config: ShopifyEcommerceRewardConfig,
): ShopifyEcommerceRewardConfigCore => {
  const { history: _history, ...core } = config;
  return core;
};

export function resolveShopifyRewardConfigAt({
  rawConfig,
  occurredAt,
  currentEffectiveAt,
}: {
  rawConfig: unknown;
  occurredAt: Date;
  currentEffectiveAt: Date;
}): ShopifyEcommerceRewardConfigCore | null {
  const parsed = ShopifyEcommerceRewardConfigSchema.safeParse(rawConfig);
  if (!parsed.success) return null;
  const history = parsed.data.history ?? [];
  if (history.length === 0) {
    const current = getShopifyRewardConfigCore(parsed.data);
    return currentEffectiveAt <= occurredAt &&
      isShopifyRewardActiveAt(current.activation, occurredAt)
      ? current
      : null;
  }

  const effectiveConfig = history
    .filter(({ effectiveAt }) => new Date(effectiveAt) <= occurredAt)
    .sort(
      (left, right) =>
        new Date(right.effectiveAt).getTime() -
        new Date(left.effectiveAt).getTime(),
    )[0]?.config;

  return effectiveConfig &&
    isShopifyRewardActiveAt(effectiveConfig.activation, occurredAt)
    ? effectiveConfig
    : null;
}

export type ShopifyEcommerceRewardConfig = z.infer<
  typeof ShopifyEcommerceRewardConfigSchema
>;
export type ShopifyRewardCollectionOverride = z.infer<
  typeof ShopifyRewardCollectionOverrideSchema
>;
export type ShopifyRewardProductOverride = z.infer<
  typeof ShopifyRewardProductOverrideSchema
>;
export type ShopifyRewardVariantOverride = z.infer<
  typeof ShopifyRewardVariantOverrideSchema
>;
export type ShopifyRewardSegment = z.infer<typeof ShopifyRewardSegmentSchema>;
export type ShopifySubscriptionCommissionMode = z.infer<
  typeof ShopifySubscriptionCommissionModeSchema
>;

export const countShopifyRewardOverrides = (
  config: Pick<
    ShopifyEcommerceRewardConfig,
    "variantOverrides" | "productOverrides" | "collectionOverrides"
  >,
) =>
  config.variantOverrides.length +
  config.productOverrides.length +
  config.collectionOverrides.length;

export const upsertShopifyEcommerceRewardSchema = z
  .object({
    workspaceId: z.string(),
    groupId: z.string(),
    rewardId: z.string().optional(),
    config: ShopifyEcommerceRewardConfigSchema,
  })
  .extend(rewardActivityDescriptionSchema.shape);

export type UpsertShopifyEcommerceRewardInput = z.infer<
  typeof upsertShopifyEcommerceRewardSchema
>;

export const deleteShopifyEcommerceRewardSchema = z
  .object({
    workspaceId: z.string(),
    groupId: z.string(),
    rewardId: z.string(),
  })
  .extend(rewardActivityDescriptionSchema.shape);
