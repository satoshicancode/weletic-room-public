import {
  isCustomerIntentTriggerCode,
  validateCustomerIntentConditions,
} from "./customer-intent-policy";
import {
  earningRulesResponseSchema,
  shopifyEarningRulesInputSchema,
  type EarningRuleFields,
} from "./earning-rule-contract";
function canonicalDecimal(value: string) {
  return value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value;
}
function canonicalFields(fields: EarningRuleFields) {
  const conditions = isCustomerIntentTriggerCode(fields.triggerCode)
    ? validateCustomerIntentConditions({
        triggerCode: fields.triggerCode,
        conditions: fields.conditions,
      })
    : fields.conditions;
  return JSON.stringify({
    ...fields,
    multiplier: canonicalDecimal(fields.multiplier),
    minOrderSubtotal:
      fields.minOrderSubtotal === null
        ? null
        : canonicalDecimal(fields.minOrderSubtotal),
    conditions,
  });
}

export function verifyEarningRuleAcknowledgement(
  request: unknown,
  response: unknown,
) {
  const input = shopifyEarningRulesInputSchema.parse(request);
  const result = earningRulesResponseSchema.safeParse(response);
  if (!result.success)
    throw new Error("Earning rule acknowledgement is unavailable");
  const view = result.data;
  if (input.operation !== "read") {
    const mutation = input.input;
    if (
      !view.programId ||
      !view.affectedRuleId ||
      view.installationGeneration !== mutation.expectedInstallationGeneration
    )
      throw new Error("Earning rule acknowledgement is unavailable");
    if (input.operation === "retire") {
      if (
        view.affectedRuleId !== mutation.ruleId ||
        view.rules.some((rule) => rule.id === mutation.ruleId)
      )
        throw new Error("Earning rule acknowledgement is unavailable");
    } else {
      const saved = view.rules.find((rule) => rule.id === view.affectedRuleId);
      if (
        (mutation.ruleId !== null && mutation.ruleId !== view.affectedRuleId) ||
        !saved?.fields ||
        canonicalFields(saved.fields) !== canonicalFields(input.input.rule)
      )
        throw new Error("Earning rule acknowledgement is unavailable");
    }
  }
  return view;
}
