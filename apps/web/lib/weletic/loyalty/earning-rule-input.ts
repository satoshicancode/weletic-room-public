import { Prisma } from "@prisma/client";
import {
  isCustomerIntentTriggerCode,
  validateCustomerIntentConditions,
} from "./customer-intent-policy";
import { earningRuleFieldsSchema } from "./earning-rule-contract";
import type { ValidatedEarningRuleData } from "./earning-rule-writer";

/** Parse even typed callers: HTTP authority and transaction fencing are separate. */
export function parseEarningRuleData(input: unknown): ValidatedEarningRuleData {
  const rule = earningRuleFieldsSchema.parse(input);
  const {
    purchaseType,
    subscriptionCadence,
    subscriptionPaymentLimit,
    ...storedRule
  } = rule;
  return {
    ...storedRule,
    ruleType: rule.triggerCode === "order_paid" ? "multiplier" : "fixed_points",
    multiplier: new Prisma.Decimal(rule.multiplier),
    fixedPoints: rule.fixedPoints === null ? null : BigInt(rule.fixedPoints),
    maxPointsPerEvent:
      rule.maxPointsPerEvent === null ? null : BigInt(rule.maxPointsPerEvent),
    minOrderSubtotal:
      rule.minOrderSubtotal === null
        ? null
        : new Prisma.Decimal(rule.minOrderSubtotal),
    conditions: isCustomerIntentTriggerCode(rule.triggerCode)
      ? validateCustomerIntentConditions({
          triggerCode: rule.triggerCode,
          conditions: rule.conditions,
        })
      : rule.conditions ?? Prisma.DbNull,
    purchasePolicy: {
      purchaseType,
      subscriptionCadence,
      subscriptionPaymentLimit,
    },
  };
}
