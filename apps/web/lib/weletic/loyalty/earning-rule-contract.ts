import { z } from "zod";
import {
  CUSTOMER_INTENT_TRIGGER_CODES,
  isCustomerIntentTriggerCode,
  validateCustomerIntentConditions,
} from "./customer-intent-policy";
import {
  loyaltyPurchasePolicySchema,
  loyaltyPurchaseTypeSchema,
  loyaltySubscriptionCadenceSchema,
  loyaltySubscriptionPaymentLimitSchema,
} from "./purchase-policy";

const identifier = z.string().min(1).max(191);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const positivePoints = z
  .string()
  .max(19)
  .regex(/^[1-9]\d*$/)
  .refine((value) => value.length < 19 || value <= "9223372036854775807");
const multiplier = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/)
  .refine((value) => /[1-9]/.test(value));
const subtotal = z.string().regex(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/);
const label = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

const socialConditions = z
  .object({
    targetUrl: z.string().trim().min(1).max(2048),
    shareMessage: z.string().trim().max(280).optional(),
  })
  .strict();

// Explicit fields prevent accidental provider defaults at this new boundary.
const reviewConditions = z
  .object({
    provider: z.enum(["native", "judgeme"]),
    minContentLength: z.number().int().min(0).max(10000),
    photoBonusPoints: z.number().int().min(0).max(1000000),
    videoBonusPoints: z.number().int().min(0).max(1000000),
  })
  .strict();

/** Exact wire values for the new editor; legacy coercion remains separate. */
export const earningRuleFieldsSchema = z
  .object({
    name: label,
    description: z.string().max(191).nullable(),
    triggerCode: z.enum([
      "order_paid",
      "account_created",
      "birthday",
      "product_review",
      ...CUSTOMER_INTENT_TRIGGER_CODES,
    ]),
    priority: z.number().int().min(-2147483648).max(2147483647),
    multiplier,
    fixedPoints: positivePoints.nullable(),
    maxPointsPerEvent: positivePoints.nullable(),
    minOrderSubtotal: subtotal.nullable(),
    excludeDiscountedItems: z.boolean(),
    excludeTaxesAndShipping: z.literal(true),
    purchaseType: loyaltyPurchaseTypeSchema,
    subscriptionCadence: loyaltySubscriptionCadenceSchema,
    subscriptionPaymentLimit: loyaltySubscriptionPaymentLimitSchema,
    maxEventsPerCustomer: z.number().int().min(1).max(100).nullable(),
    limitInterval: z.enum(["lifetime", "monthly", "calendar_year"]).nullable(),
    conditions: z.union([socialConditions, reviewConditions]).nullable(),
    isActive: z.boolean(),
  })
  .strict()
  .superRefine((rule, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    if (rule.triggerCode === "order_paid") {
      const purchasePolicy = loyaltyPurchasePolicySchema.safeParse({
        purchaseType: rule.purchaseType,
        subscriptionCadence: rule.subscriptionCadence,
        subscriptionPaymentLimit: rule.subscriptionPaymentLimit,
      });
      if (!purchasePolicy.success)
        issue(
          "subscriptionPaymentLimit",
          purchasePolicy.error.issues[0]?.message ??
            "Provide valid purchase eligibility",
        );
      for (const key of [
        "fixedPoints",
        "maxEventsPerCustomer",
        "limitInterval",
        "conditions",
      ] as const)
        if (rule[key] !== null)
          issue(key, "Not applicable to purchase earning");
      return;
    }
    if (
      rule.purchaseType !== "one_time" ||
      rule.subscriptionCadence !== "first_payment" ||
      rule.subscriptionPaymentLimit !== null
    )
      issue(
        "purchaseType",
        "Non-purchase activities are always one-time events",
      );
    if (rule.fixedPoints === null)
      issue("fixedPoints", "Activity earning requires fixed points");
    if (rule.maxEventsPerCustomer === null || rule.limitInterval === null)
      issue("limitInterval", "Activity earning requires an explicit limit");
    if (!/^1(?:\.0{1,4})?$/.test(rule.multiplier))
      issue("multiplier", "Activity earning uses a multiplier of one");
    if (rule.minOrderSubtotal !== null)
      issue("minOrderSubtotal", "Not applicable to activity earning");
    if (
      rule.triggerCode === "birthday" &&
      rule.limitInterval !== "calendar_year"
    )
      issue("limitInterval", "Birthday earning uses a calendar-year limit");
    if (
      rule.triggerCode === "account_created" &&
      rule.limitInterval !== "lifetime"
    )
      issue("limitInterval", "Signup earning uses a lifetime limit");
    if (isCustomerIntentTriggerCode(rule.triggerCode)) {
      const parsed = socialConditions.safeParse(rule.conditions);
      if (!parsed.success) {
        issue("conditions", "Provide customer-intent conditions");
        return;
      }
      try {
        validateCustomerIntentConditions({
          triggerCode: rule.triggerCode,
          conditions: parsed.data,
        });
      } catch {
        issue("conditions", "Provide a valid HTTPS URL for this action");
      }
    } else if (rule.triggerCode === "product_review") {
      const review = reviewConditions.safeParse(rule.conditions);
      if (!review.success)
        issue("conditions", "Provide explicit review incentive conditions");
      else if (
        rule.fixedPoints !== null &&
        positivePoints.safeParse(rule.fixedPoints).success &&
        rule.maxPointsPerEvent === null &&
        BigInt(rule.fixedPoints) +
          BigInt(
            Math.max(
              review.data.photoBonusPoints,
              review.data.videoBonusPoints,
            ),
          ) >
          BigInt("9223372036854775807")
      )
        issue(
          "fixedPoints",
          "Review award including bonuses exceeds the points range",
        );
    } else if (rule.conditions !== null) {
      issue("conditions", "This action does not accept conditions");
    }
  });

export const earningRuleWriteSchema = z
  .object({
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: revision.nullable(),
    ruleId: identifier.nullable(),
    rule: earningRuleFieldsSchema,
  })
  .strict();

export const earningRuleRetireSchema = z
  .object({
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: revision,
    ruleId: identifier,
  })
  .strict();

export type EarningRuleFields = z.infer<typeof earningRuleFieldsSchema>;
export type EarningRuleWrite = z.infer<typeof earningRuleWriteSchema>;
export type EarningRuleRetire = z.infer<typeof earningRuleRetireSchema>;

export const shopifyEarningRulesInputSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("read") }).strict(),
    z
      .object({ operation: z.literal("save"), input: earningRuleWriteSchema })
      .strict(),
    z
      .object({
        operation: z.literal("retire"),
        input: earningRuleRetireSchema,
      })
      .strict(),
  ],
);

export const earningRulesResponseSchema = z
  .object({
    storeId: identifier,
    shopCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .optional(),
    installationGeneration: z.string().min(1).max(64),
    programId: identifier.nullable(),
    revision: revision.nullable(),
    affectedRuleId: identifier.nullable().default(null),
    capabilities: z.object({ configure: z.boolean() }).strict(),
    rules: z.array(
      z
        .object({
          id: identifier,
          name: z.string().max(191),
          triggerCode: z.string().max(191),
          isActive: z.boolean(),
          fields: earningRuleFieldsSchema.nullable(),
          editUnavailableReason: z
            .enum(["legacy_configuration_requires_review"])
            .nullable(),
          constraints: z
            .object({
              startAt: z.string().datetime().nullable(),
              endAt: z.string().datetime().nullable(),
              hasTierEligibility: z.boolean(),
            })
            .strict(),
        })
        .strict()
        .refine(
          (rule) =>
            (rule.fields === null) === (rule.editUnavailableReason !== null),
        ),
    ),
  })
  .strict()
  .refine(
    (value) =>
      (value.programId === null) === (value.revision === null) &&
      (value.programId !== null || value.rules.length === 0),
  );

export type EarningRulesResponse = z.infer<typeof earningRulesResponseSchema>;
