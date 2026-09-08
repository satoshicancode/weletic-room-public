import { DiscountProvider, RewardStructure } from "@prisma/client";
import * as z from "zod/v4";
import { getPaginationQuerySchema, maxDurationSchema } from "./misc";

export const ShopifyDiscountType = [
  "amount_off_order",
  "amount_off_products",
  "bxgy",
  "free_shipping",
] as const;

export const shopifyDiscountTypeSchema = z.enum(ShopifyDiscountType);
export type ShopifyDiscountType = z.infer<typeof shopifyDiscountTypeSchema>;

export const bxgyConfigSchema = z.object({
  buyQuantity: z.number().int().min(1).default(1),
  getQuantity: z.number().int().min(1).default(1),
  discountType: z.enum(["percentage", "amount"]).default("percentage"),
  discountValue: z.number().min(0).default(100),
});
export type BxgyConfig = z.infer<typeof bxgyConfigSchema>;

export const freeShippingConfigSchema = z.object({
  minimumSubtotal: z.number().min(0).nullish(),
  maximumShippingPrice: z.number().min(0).nullish(),
});
export type FreeShippingConfig = z.infer<typeof freeShippingConfigSchema>;

export const shopifyDiscountConfigSchema = z.object({
  type: shopifyDiscountTypeSchema.default("amount_off_order"),
  productIds: z.array(z.string()).optional().default([]),
  collectionIds: z.array(z.string()).optional().default([]),
  bxgy: bxgyConfigSchema.optional(),
  freeShipping: freeShippingConfigSchema.optional(),
});
export type ShopifyDiscountConfig = z.infer<typeof shopifyDiscountConfigSchema>;

export const DiscountSchema = z.object({
  id: z.string(),
  amount: z.number(),
  type: z.enum(RewardStructure),
  maxDuration: z.number().nullable(),
  couponId: z.string().nullable(),
  couponTestId: z.string().nullable(),
  description: z.string().nullish(),
  partnersCount: z.number().nullish(),
  autoProvisionEnabledAt: z.coerce.date().nullish(),
  provider: z.enum(DiscountProvider),
  shopifyConfig: shopifyDiscountConfigSchema.nullish(),
});

export const DiscountSchemaWithDeprecatedFields = DiscountSchema.omit({
  autoProvisionEnabledAt: true,
  provider: true,
})
  .extend({
    duration: z
      .number()
      .nullish()
      .describe("Deprecated: Use `maxDuration` instead"),
    interval: z.string().nullish().describe("Deprecated: Defaults to `month`"),
  })
  .nullish();

export const createDiscountSchema = z.object({
  workspaceId: z.string(),
  amount: z.number().min(0).default(0),
  type: z.enum(RewardStructure).default("flat"),
  maxDuration: maxDurationSchema,
  couponId: z.string().optional().or(z.literal("")),
  couponTestId: z.string().nullish(),
  groupId: z.string(),
  autoProvision: z.boolean().optional(),
  provider: z.enum(DiscountProvider),
  description: z.string().nullish(),
  shopifyDiscountType: shopifyDiscountTypeSchema.optional(),
  shopifyConfig: shopifyDiscountConfigSchema.optional(),
  productIds: z.array(z.string()).optional(),
  collectionIds: z.array(z.string()).optional(),
  bxgy: bxgyConfigSchema.optional(),
  freeShipping: freeShippingConfigSchema.optional(),
});

export const updateDiscountSchema = createDiscountSchema
  .pick({
    workspaceId: true,
    couponTestId: true,
    autoProvision: true,
  })
  .extend({
    discountId: z.string(),
    couponId: z.string().nullish(),
  });

export const discountPartnersQuerySchema = z
  .object({
    discountId: z.string(),
  })
  .extend(getPaginationQuerySchema({ pageSize: 25 }));

export const DiscountCodeSchema = z.object({
  id: z.string(),
  code: z.string(),
  discountId: z.string().nullable(),
  partnerId: z.string(),
  linkId: z.string().nullable().optional(),
  disabledAt: z.coerce
    .date()
    .nullish()
    .describe(
      "When this discount code was disabled, which happens when a partner is banned or deactivated.",
    ),
});

export const createDiscountCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .max(100, "Code must be 100 characters or fewer.")
    .regex(
      /^[a-zA-Z0-9\-_]+$/,
      "Code can only contain letters, numbers, dashes, and underscores.",
    )
    .optional()
    .or(z.literal("").transform(() => undefined)),
  partnerId: z.string(),
  linkId: z.string(),
});

export const getDiscountCodesQuerySchema = z.object({
  partnerId: z.string(),
  status: z.enum(["active", "archived", "all"]).optional().default("active"),
});
