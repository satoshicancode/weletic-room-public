import { isCustomerIntentTriggerCode } from "../../../lib/weletic/loyalty/customer-intent-policy";
import {
  earningRuleFieldsSchema,
  type EarningRuleFields,
} from "../../../lib/weletic/loyalty/earning-rule-contract";

export type EarningRuleForm = {
  name: string;
  description: string;
  triggerCode: EarningRuleFields["triggerCode"];
  priority: string;
  multiplier: string;
  fixedPoints: string;
  maxPointsPerEvent: string;
  minOrderSubtotal: string;
  maxEventsPerCustomer: string;
  limitInterval: "lifetime" | "monthly" | "calendar_year";
  excludeDiscountedItems: boolean;
  isActive: boolean;
  targetUrl: string;
  shareMessage: string;
  provider: "native" | "judgeme";
  minContentLength: string;
  photoBonusPoints: string;
  videoBonusPoints: string;
};

export function newEarningRuleForm(
  triggerCode: EarningRuleFields["triggerCode"] = "order_paid",
): EarningRuleForm {
  return {
    name: "",
    description: "",
    triggerCode,
    priority: "0",
    multiplier: "1",
    fixedPoints: "",
    maxPointsPerEvent: "",
    minOrderSubtotal: "",
    maxEventsPerCustomer: triggerCode === "product_review" ? "2" : "1",
    limitInterval:
      triggerCode === "birthday"
        ? "calendar_year"
        : triggerCode === "product_review"
          ? "monthly"
          : "lifetime",
    excludeDiscountedItems: false,
    isActive: false,
    targetUrl: "",
    shareMessage: "",
    provider: "native",
    minContentLength: "20",
    photoBonusPoints: "0",
    videoBonusPoints: "0",
  };
}

/** Switching trigger is an explicit reset of earning-specific configuration. */
export function changeEarningRuleTrigger(
  form: EarningRuleForm,
  triggerCode: EarningRuleFields["triggerCode"],
): EarningRuleForm {
  if (triggerCode === form.triggerCode) return form;
  return {
    ...newEarningRuleForm(triggerCode),
    name: form.name,
    description: form.description,
    priority: form.priority,
  };
}

function integer(value: string) {
  // Empty/exponent/decimal strings must not accidentally become valid integers.
  return /^-?(?:0|[1-9]\d*)$/.test(value) ? Number(value) : NaN;
}

export function parseEarningRuleForm(form: EarningRuleForm) {
  const order = form.triggerCode === "order_paid";
  return earningRuleFieldsSchema.safeParse({
    name: form.name,
    description: form.description || null,
    triggerCode: form.triggerCode,
    priority: integer(form.priority),
    multiplier: order ? form.multiplier : "1",
    fixedPoints: order ? null : form.fixedPoints,
    maxPointsPerEvent: form.maxPointsPerEvent || null,
    minOrderSubtotal: order ? form.minOrderSubtotal || null : null,
    maxEventsPerCustomer: order ? null : integer(form.maxEventsPerCustomer),
    limitInterval: order ? null : form.limitInterval,
    excludeDiscountedItems: form.excludeDiscountedItems,
    excludeTaxesAndShipping: true,
    isActive: form.isActive,
    conditions: isCustomerIntentTriggerCode(form.triggerCode)
      ? {
          targetUrl: form.targetUrl,
          ...(form.shareMessage ? { shareMessage: form.shareMessage } : {}),
        }
      : form.triggerCode === "product_review"
        ? {
            provider: form.provider,
            minContentLength: integer(form.minContentLength),
            photoBonusPoints: integer(form.photoBonusPoints),
            videoBonusPoints: integer(form.videoBonusPoints),
          }
        : null,
  });
}

export function earningRuleFormFromFields(
  fields: EarningRuleFields,
): EarningRuleForm {
  const form = {
    ...newEarningRuleForm(fields.triggerCode),
    name: fields.name,
    description: fields.description ?? "",
    priority: String(fields.priority),
    multiplier: fields.multiplier,
    fixedPoints: fields.fixedPoints ?? "",
    maxPointsPerEvent: fields.maxPointsPerEvent ?? "",
    minOrderSubtotal: fields.minOrderSubtotal ?? "",
    maxEventsPerCustomer: String(fields.maxEventsPerCustomer ?? 1),
    limitInterval: fields.limitInterval ?? "lifetime",
    excludeDiscountedItems: fields.excludeDiscountedItems,
    isActive: fields.isActive,
  };
  if (fields.conditions && "targetUrl" in fields.conditions) {
    form.targetUrl = fields.conditions.targetUrl;
    form.shareMessage = fields.conditions.shareMessage ?? "";
  } else if (fields.conditions && "provider" in fields.conditions) {
    form.provider = fields.conditions.provider;
    form.minContentLength = String(fields.conditions.minContentLength);
    form.photoBonusPoints = String(fields.conditions.photoBonusPoints);
    form.videoBonusPoints = String(fields.conditions.videoBonusPoints);
  }
  return form;
}
