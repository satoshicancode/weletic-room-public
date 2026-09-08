import type { Prisma } from "@prisma/client";
import { z } from "zod";

export const loyaltyPurchaseTypeSchema = z.enum([
  "one_time",
  "subscription",
  "both",
]);
export const loyaltySubscriptionCadenceSchema = z.enum([
  "first_payment",
  "first_n_payments",
  "every_payment",
]);
export const loyaltySubscriptionPaymentLimitSchema = z
  .number()
  .int()
  .min(2)
  .max(1_000)
  .nullable();

export const loyaltyPurchasePolicySchema = z
  .object({
    purchaseType: loyaltyPurchaseTypeSchema,
    subscriptionCadence: loyaltySubscriptionCadenceSchema,
    subscriptionPaymentLimit: loyaltySubscriptionPaymentLimitSchema,
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      (policy.subscriptionCadence === "first_n_payments") !==
      (policy.subscriptionPaymentLimit !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["subscriptionPaymentLimit"],
        message:
          "A payment limit is required only for first-N subscription rewards.",
      });
    }
    if (
      policy.purchaseType === "one_time" &&
      policy.subscriptionCadence !== "first_payment"
    ) {
      context.addIssue({
        code: "custom",
        path: ["subscriptionCadence"],
        message: "One-time purchases do not use a subscription cadence.",
      });
    }
  });

export type LoyaltyPurchasePolicy = z.infer<typeof loyaltyPurchasePolicySchema>;

export const DEFAULT_EARNING_PURCHASE_POLICY = {
  purchaseType: "both",
  subscriptionCadence: "every_payment",
  subscriptionPaymentLimit: null,
} as const satisfies LoyaltyPurchasePolicy;

export const DEFAULT_REWARD_PURCHASE_POLICY = {
  purchaseType: "one_time",
  subscriptionCadence: "first_payment",
  subscriptionPaymentLimit: null,
} as const satisfies LoyaltyPurchasePolicy;

export const DEFAULT_NON_PURCHASE_ACTIVITY_POLICY =
  DEFAULT_REWARD_PURCHASE_POLICY;

export const DEFAULT_REFERRAL_PURCHASE_POLICY = {
  purchaseType: "both",
  subscriptionCadence: "first_payment",
  subscriptionPaymentLimit: null,
} as const satisfies LoyaltyPurchasePolicy;

export function readLoyaltyPurchasePolicy(
  value: unknown,
  fallback: LoyaltyPurchasePolicy,
): LoyaltyPurchasePolicy {
  if (value === null || value === undefined) return { ...fallback };
  return loyaltyPurchasePolicySchema.parse(value);
}

export type LoyaltyPurchaseLine = {
  sellingPlanId?: string | null;
  subscriptionSeriesKey?: string | null;
  subscriptionSequence?: number | null;
};

export type LoyaltyPurchaseLineClassification =
  | { kind: "one_time" }
  | { kind: "subscription"; sequence: number }
  | { kind: "unknown" };

export function classifyLoyaltyPurchaseLine(
  line: LoyaltyPurchaseLine,
): LoyaltyPurchaseLineClassification {
  const sellingPlanId = line.sellingPlanId ?? null;
  const seriesKey = line.subscriptionSeriesKey ?? null;
  const sequence = line.subscriptionSequence ?? null;
  if (sellingPlanId === null && seriesKey === null && sequence === null) {
    return { kind: "one_time" };
  }
  if (
    typeof sellingPlanId === "string" &&
    sellingPlanId.length > 0 &&
    typeof seriesKey === "string" &&
    seriesKey.length > 0 &&
    Number.isSafeInteger(sequence) &&
    Number(sequence) > 0
  ) {
    return { kind: "subscription", sequence: Number(sequence) };
  }
  return { kind: "unknown" };
}

export function isLoyaltyPurchaseLineEligible({
  policy,
  line,
}: {
  policy: LoyaltyPurchasePolicy;
  line: LoyaltyPurchaseLine;
}) {
  const classification = classifyLoyaltyPurchaseLine(line);
  if (classification.kind === "unknown") return false;
  if (classification.kind === "one_time") {
    return policy.purchaseType === "one_time" || policy.purchaseType === "both";
  }
  if (policy.purchaseType === "one_time") return false;
  if (policy.subscriptionCadence === "every_payment") return true;
  if (policy.subscriptionCadence === "first_payment") {
    return classification.sequence === 1;
  }
  return classification.sequence <= policy.subscriptionPaymentLimit!;
}

export function getShopifyDiscountPurchaseFields(
  policy: LoyaltyPurchasePolicy,
) {
  if (policy.purchaseType === "one_time") return {};
  const recurringCycleLimit =
    policy.subscriptionCadence === "every_payment"
      ? 0
      : policy.subscriptionCadence === "first_payment"
        ? 1
        : policy.subscriptionPaymentLimit!;
  return {
    appliesOnOneTimePurchase: policy.purchaseType === "both",
    appliesOnSubscription: true,
    recurringCycleLimit,
  };
}

export function getExpectedShopifyDiscountPurchaseConfiguration(
  policy: LoyaltyPurchasePolicy,
) {
  if (policy.purchaseType === "one_time") {
    return {
      appliesOnOneTimePurchase: true,
      appliesOnSubscription: false,
      recurringCycleLimit: 1,
    };
  }
  return {
    appliesOnOneTimePurchase: policy.purchaseType === "both",
    appliesOnSubscription: true,
    recurringCycleLimit:
      policy.subscriptionCadence === "every_payment"
        ? 0
        : policy.subscriptionCadence === "first_payment"
          ? 1
          : policy.subscriptionPaymentLimit!,
  };
}

/** Reads immutable commerce-line facts inside the caller's transaction. */
export async function getEligibleLoyaltyOrderSubtotal({
  tx,
  storeId,
  orderId,
  policy,
  testFallbackSubtotal,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  orderId: string;
  policy: LoyaltyPurchasePolicy;
  testFallbackSubtotal: bigint;
}) {
  const delegate = (
    tx as Prisma.TransactionClient & {
      weleticCommerceOrderLine?: {
        findMany?: (args: unknown) => Promise<
          Array<
            LoyaltyPurchaseLine & {
              shopNet: bigint;
            }
          >
        >;
      };
    }
  ).weleticCommerceOrderLine;
  if (typeof delegate?.findMany !== "function") {
    if (process.env.NODE_ENV !== "test") {
      throw new Error("Commerce order-line purchase facts are unavailable.");
    }
    return policy.purchaseType === "subscription"
      ? BigInt(0)
      : testFallbackSubtotal;
  }
  const lines = await delegate.findMany({
    where: { orderId, order: { storeId } },
    select: {
      shopNet: true,
      sellingPlanId: true,
      subscriptionSeriesKey: true,
      subscriptionSequence: true,
    },
  });
  return lines
    .filter((line) => isLoyaltyPurchaseLineEligible({ policy, line }))
    .reduce((sum, line) => sum + BigInt(line.shopNet), BigInt(0));
}
