import type { WeleticLoyaltyEarningRule } from "@prisma/client";
import { earningRuleFieldsSchema } from "./earning-rule-contract";

export function projectEarningRuleCurrency(currency: unknown): string | null {
  return typeof currency === "string" && /^[A-Z]{3}$/.test(currency)
    ? currency
    : null;
}

/** Never expose raw JSON, tenant identity, or lifecycle columns to the editor. */
export function projectEarningRule(rule: WeleticLoyaltyEarningRule) {
  const parsed = earningRuleFieldsSchema.safeParse({
    name: rule.name,
    description: rule.description,
    triggerCode: rule.triggerCode,
    priority: rule.priority,
    multiplier: rule.multiplier.toString(),
    fixedPoints: rule.fixedPoints?.toString() ?? null,
    maxPointsPerEvent: rule.maxPointsPerEvent?.toString() ?? null,
    minOrderSubtotal: rule.minOrderSubtotal?.toString() ?? null,
    excludeDiscountedItems: rule.excludeDiscountedItems,
    excludeTaxesAndShipping: rule.excludeTaxesAndShipping,
    maxEventsPerCustomer: rule.maxEventsPerCustomer,
    limitInterval: rule.limitInterval,
    conditions: rule.conditions,
    isActive: rule.isActive,
  });
  // Do not reinterpret legacy provider defaults or a different stored rule type.
  const editable =
    parsed.success &&
    rule.ruleType ===
      (rule.triggerCode === "order_paid" ? "multiplier" : "fixed_points");
  return {
    id: rule.id,
    name: rule.name,
    triggerCode: rule.triggerCode,
    isActive: rule.isActive,
    fields: editable && parsed.success ? parsed.data : null,
    editUnavailableReason: editable
      ? null
      : ("legacy_configuration_requires_review" as const),
    constraints: {
      startAt: rule.startAt?.toISOString() ?? null,
      endAt: rule.endAt?.toISOString() ?? null,
      hasTierEligibility: rule.eligibleTierIds !== null,
    },
  };
}
