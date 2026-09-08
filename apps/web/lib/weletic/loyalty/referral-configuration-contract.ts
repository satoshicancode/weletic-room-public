import { z } from "zod";
import {
  loyaltyPurchasePolicySchema,
  loyaltyPurchaseTypeSchema,
  loyaltySubscriptionCadenceSchema,
  loyaltySubscriptionPaymentLimitSchema,
} from "./purchase-policy";
import { MAX_REFERRALS_PER_ADVOCATE_LIMIT } from "./referral-rule-config";

const id = z.string().min(1).max(191);
const points = z
  .string()
  .max(19)
  .regex(/^(?:0|[1-9]\d*)$/)
  .refine((value) => value.length < 19 || value <= "9223372036854775807");
const revision = z.string().regex(/^[a-f0-9]{64}$/);
// This existing column is Decimal(10,2) in major units, unlike reward amounts.
export const referralConfigurationFieldsSchema = z
  .object({
    advocatePointsReward: points,
    refereePointsReward: points,
    advocateRewardKind: z.enum(["points", "coupon"]),
    refereeRewardKind: z.enum(["points", "coupon"]),
    advocateRewardDefinitionId: id.nullable(),
    refereeRewardDefinitionId: id.nullable(),
    minQualifyingOrderSubtotal: z
      .string()
      .regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/)
      .nullable(),
    maxReferralsPerAdvocate: z
      .number()
      .int()
      .min(1)
      .max(MAX_REFERRALS_PER_ADVOCATE_LIMIT)
      .nullable(),
    fraudCheckSameIp: z.boolean(),
    purchaseType: loyaltyPurchaseTypeSchema,
    subscriptionCadence: loyaltySubscriptionCadenceSchema,
    subscriptionPaymentLimit: loyaltySubscriptionPaymentLimitSchema,
    isActive: z.boolean(),
  })
  .strict()
  .superRefine((fields, ctx) => {
    const purchasePolicy = loyaltyPurchasePolicySchema.safeParse({
      purchaseType: fields.purchaseType,
      subscriptionCadence: fields.subscriptionCadence,
      subscriptionPaymentLimit: fields.subscriptionPaymentLimit,
    });
    if (!purchasePolicy.success)
      ctx.addIssue({
        code: "custom",
        path: ["subscriptionPaymentLimit"],
        message:
          purchasePolicy.error.issues[0]?.message ??
          "Provide valid purchase eligibility",
      });
    for (const side of ["advocate", "referee"] as const) {
      const kind = fields[`${side}RewardKind`];
      const rewardId = fields[`${side}RewardDefinitionId`];
      if ((kind === "coupon") !== (rewardId !== null))
        ctx.addIssue({
          code: "custom",
          path: [`${side}RewardDefinitionId`],
          message: "Select a coupon only for coupon rewards",
        });
      if (kind === "coupon" && fields[`${side}PointsReward`] !== "0")
        ctx.addIssue({
          code: "custom",
          path: [`${side}PointsReward`],
          message: "Coupon rewards must have zero configured points",
        });
    }
  });
const expected = {
  expectedInstallationGeneration: id,
  expectedRevision: revision,
};
export const referralConfigurationWriteSchema = z
  .object({
    ...expected,
    ruleId: id.nullable(),
    fields: referralConfigurationFieldsSchema,
  })
  .strict();
export const referralConfigurationPauseSchema = z.object(expected).strict();
export const referralConfigurationRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("read") }).strict(),
    z
      .object({
        operation: z.literal("save"),
        input: referralConfigurationWriteSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("pause"),
        input: referralConfigurationPauseSchema,
      })
      .strict(),
  ],
);
export const referralConfigurationResponseSchema = z
  .object({
    storeId: id,
    installationGeneration: id,
    programId: id.nullable(),
    shopCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable(),
    thresholdDecimalPlaces: z.number().int().min(0).max(2).nullable(),
    revision,
    capabilities: z.object({ configure: z.boolean() }).strict(),
    ruleId: id.nullable(),
    fields: referralConfigurationFieldsSchema.nullable(),
    active: z.boolean(),
    legacyConfiguration: z.boolean(),
    couponOptions: z.array(
      z.object({ id, name: z.string(), rewardType: z.string() }).strict(),
    ),
    acknowledgedOperation: z.enum(["read", "save", "pause"]),
  })
  .strict();
export type ReferralConfigurationFields = z.infer<
  typeof referralConfigurationFieldsSchema
>;
export type ReferralConfigurationWrite = z.infer<
  typeof referralConfigurationWriteSchema
>;
export type ReferralConfigurationPause = z.infer<
  typeof referralConfigurationPauseSchema
>;
export type ReferralConfigurationResponse = z.infer<
  typeof referralConfigurationResponseSchema
>;
export const canonicalReferralFields = (
  value: ReferralConfigurationFields,
) => ({
  ...value,
  minQualifyingOrderSubtotal: value.minQualifyingOrderSubtotal?.includes(".")
    ? value.minQualifyingOrderSubtotal.replace(/0+$/, "").replace(/\.$/, "")
    : value.minQualifyingOrderSubtotal,
});
