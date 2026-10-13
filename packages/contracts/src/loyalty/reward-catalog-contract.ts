import { z } from "zod";
import {
  loyaltyPurchasePolicySchema,
  loyaltyPurchaseTypeSchema,
  loyaltySubscriptionCadenceSchema,
  loyaltySubscriptionPaymentLimitSchema,
} from "./purchase-policy";

const identifier = z.string().min(1).max(191);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const points = z
  .string()
  .max(19)
  .regex(/^[1-9]\d*$/)
  .refine((value) => value.length < 19 || value <= "9223372036854775807");
// Existing Decimal(10,2) columns store integer minor units, not major currency.
const minorUnits = z.string().regex(/^[1-9]\d{0,7}$/);
const discountValue = z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/);
const limit = z.number().int().min(1).max(2147483647);
const ids = (resource: string) =>
  z
    .array(
      z
        .string()
        .max(191)
        .regex(new RegExp(`^gid://shopify/${resource}/[1-9]\\d*$`)),
    )
    .max(100)
    .refine(
      (values) => new Set(values).size === values.length,
      "Duplicate identifiers",
    );

/** Strict new editor contract; legacy HTTP coercion is not redefined here. */
export const rewardCatalogFieldsSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    description: z.string().max(191).nullable(),
    rewardType: z.enum([
      "amount_off",
      "percentage_off",
      "free_shipping",
      "free_product",
      "gift_card",
      "store_credit",
    ]),
    salesChannel: z.literal("online_store"),
    exchangeType: z.enum(["fixed", "incremental"]),
    pointsCost: points,
    pointsStep: points.nullable(),
    minPointsCost: points.nullable(),
    maxPointsCost: points.nullable(),
    discountValue: discountValue.nullable(),
    maxDiscountValue: minorUnits.nullable(),
    minOrderAmount: minorUnits.nullable(),
    appliesToResource: z.enum(["entire_order", "specific_items"]),
    entitledProductIds: ids("Product"),
    entitledVariantIds: ids("ProductVariant"),
    entitledCollectionIds: ids("Collection"),
    combinesWithOrderDiscounts: z.boolean(),
    combinesWithProductDiscounts: z.boolean(),
    combinesWithShippingDiscounts: z.boolean(),
    usageLimit: limit.nullable(),
    usageLimitPerCustomer: z.union([z.literal(0), z.literal(1)]),
    expiresInDays: z.number().int().min(1).max(36500).nullable(),
    purchaseType: loyaltyPurchaseTypeSchema,
    subscriptionCadence: loyaltySubscriptionCadenceSchema,
    subscriptionPaymentLimit: loyaltySubscriptionPaymentLimitSchema,
    status: z.enum(["active", "inactive", "archived"]),
  })
  .strict()
  .superRefine((reward, context) => {
    const issue = (field: string, message: string) =>
      context.addIssue({ code: "custom", path: [field], message });
    const purchasePolicy = loyaltyPurchasePolicySchema.safeParse({
      purchaseType: reward.purchaseType,
      subscriptionCadence: reward.subscriptionCadence,
      subscriptionPaymentLimit: reward.subscriptionPaymentLimit,
    });
    if (!purchasePolicy.success)
      issue(
        "subscriptionPaymentLimit",
        purchasePolicy.error.issues[0]?.message ??
          "Provide valid purchase eligibility",
      );
    if (reward.exchangeType === "incremental") {
      if (reward.rewardType !== "amount_off")
        issue("exchangeType", "Incremental rewards require amount-off type");
      if (reward.pointsStep === null || reward.minPointsCost === null)
        issue("pointsStep", "Provide an explicit step and minimum");
      else if (
        [reward.pointsStep, reward.minPointsCost, reward.maxPointsCost].every(
          (value) => value === null || points.safeParse(value).success,
        )
      ) {
        const step = BigInt(reward.pointsStep);
        const minimum = BigInt(reward.minPointsCost);
        const maximum =
          reward.maxPointsCost === null ? null : BigInt(reward.maxPointsCost);
        if (
          minimum % step !== BigInt(0) ||
          (maximum !== null &&
            (maximum < minimum || maximum % step !== BigInt(0)))
        )
          issue(
            "minPointsCost",
            "Limits must be ordered positive step multiples",
          );
      }
    } else if (
      reward.pointsStep !== null ||
      reward.minPointsCost !== null ||
      reward.maxPointsCost !== null
    ) {
      issue("exchangeType", "Fixed rewards do not use incremental limits");
    }
    if (
      ["amount_off", "gift_card", "store_credit"].includes(reward.rewardType)
    ) {
      if (!minorUnits.safeParse(reward.discountValue).success)
        issue("discountValue", "Provide positive integer minor currency units");
    } else if (reward.rewardType === "percentage_off") {
      if (
        reward.discountValue === null ||
        !discountValue.safeParse(reward.discountValue).success ||
        Number(reward.discountValue) < 1 ||
        Number(reward.discountValue) > 100
      )
        issue(
          "discountValue",
          "Percentage must be from 1 to 100 with at most two decimals",
        );
    } else if (reward.discountValue !== null) {
      issue("discountValue", "This reward does not use a discount value");
    }
    if (reward.rewardType === "free_product") {
      if (reward.maxDiscountValue === null)
        issue(
          "maxDiscountValue",
          "Provide a product discount cap in minor units",
        );
      if (
        reward.appliesToResource !== "specific_items" ||
        reward.entitledProductIds.length + reward.entitledVariantIds.length ===
          0 ||
        reward.entitledCollectionIds.length > 0
      )
        issue(
          "appliesToResource",
          "Product rewards require products or variants, not collections",
        );
    } else if (
      reward.maxDiscountValue !== null &&
      !(
        reward.rewardType === "amount_off" &&
        reward.exchangeType === "incremental"
      )
    ) {
      issue(
        "maxDiscountValue",
        "Only product or incremental amount-off rewards use this cap",
      );
    }
    const productCount =
      reward.entitledProductIds.length + reward.entitledVariantIds.length;
    const collectionCount = reward.entitledCollectionIds.length;
    if (
      reward.appliesToResource === "entire_order" &&
      productCount + collectionCount > 0
    )
      issue(
        "appliesToResource",
        "Entire-order scope cannot carry hidden item restrictions",
      );
    if (
      reward.appliesToResource === "specific_items" &&
      (productCount + collectionCount === 0 ||
        (productCount > 0 && collectionCount > 0))
    )
      issue(
        "appliesToResource",
        "Choose products/variants or collections, not both",
      );
    if (
      ["free_shipping", "gift_card", "store_credit"].includes(
        reward.rewardType,
      ) &&
      reward.appliesToResource !== "entire_order"
    )
      issue(
        "appliesToResource",
        "This reward does not support item restrictions",
      );
    if (
      ["gift_card", "store_credit"].includes(reward.rewardType) &&
      (reward.usageLimit !== null ||
        reward.usageLimitPerCustomer !== 0 ||
        reward.minOrderAmount !== null ||
        reward.combinesWithOrderDiscounts ||
        reward.combinesWithProductDiscounts ||
        reward.combinesWithShippingDiscounts)
    )
      issue(
        "rewardType",
        "Financial artifacts do not use discount-code conditions",
      );
    if (
      ["gift_card", "store_credit"].includes(reward.rewardType) &&
      reward.purchaseType !== "one_time"
    )
      issue(
        "purchaseType",
        "Financial artifacts do not support subscription discount terms",
      );
  });

export const rewardCatalogWriteSchema = z
  .object({
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: revision,
    rewardId: identifier.nullable(),
    reward: rewardCatalogFieldsSchema,
  })
  .strict();

export type RewardCatalogFields = z.infer<typeof rewardCatalogFieldsSchema>;
export type RewardCatalogWrite = z.infer<typeof rewardCatalogWriteSchema>;

export const rewardCatalogContainSchema = z
  .object({
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: revision,
    rewardId: identifier,
    status: z.enum(["inactive", "archived"]),
  })
  .strict();
export type RewardCatalogContain = z.infer<typeof rewardCatalogContainSchema>;

export const rewardCatalogRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read") }).strict(),
  z
    .object({ operation: z.literal("save"), input: rewardCatalogWriteSchema })
    .strict(),
  z
    .object({
      operation: z.literal("contain"),
      input: rewardCatalogContainSchema,
    })
    .strict(),
]);
export const rewardCatalogResponseSchema = z
  .object({
    storeId: identifier,
    installationGeneration: z.string().min(1).max(64),
    shopCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    revision,
    affectedRewardId: identifier.nullable(),
    capabilities: z.object({ configure: z.boolean() }).strict(),
    rewards: z.array(
      z
        .object({
          id: identifier,
          name: z.string().max(191),
          rewardType: z.enum([
            "amount_off",
            "percentage_off",
            "free_shipping",
            "free_product",
            "gift_card",
            "store_credit",
          ]),
          status: z.enum(["active", "inactive", "archived"]),
          fields: rewardCatalogFieldsSchema.nullable(),
          editUnavailableReason: z
            .literal("legacy_configuration_requires_review")
            .nullable(),
        })
        .strict()
        .refine(
          (reward) =>
            (reward.fields === null) ===
            (reward.editUnavailableReason !== null),
        ),
    ),
  })
  .strict();
export type RewardCatalogRequest = z.infer<typeof rewardCatalogRequestSchema>;
export type RewardCatalogResponse = z.infer<typeof rewardCatalogResponseSchema>;
