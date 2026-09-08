import { currencyMinorUnits } from "@/lib/weletic/money";
import { canonicalizeLoyaltyDiscountCode } from "./redemption-discount-identity";

const currencies = new Set(Intl.supportedValuesOf("currency"));
const MAX_MINOR = BigInt("9223372036854775807");
const MAX_ALLOCATIONS = 10000;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export type CouponUseAmount = {
  discountAmountMinor: bigint | null;
  currency: string | null;
  amountUnavailableReason: string | null;
};

/** Minimize the webhook before passing evidence into financial settlement. */
export function selectShopifyCouponAllocationEvidence(input: unknown) {
  const order = record(input);
  if (
    !order ||
    !Array.isArray(order.discount_applications) ||
    !Array.isArray(order.line_items) ||
    !Array.isArray(order.shipping_lines) ||
    order.discount_applications.length > MAX_ALLOCATIONS ||
    order.line_items.length + order.shipping_lines.length > MAX_ALLOCATIONS
  )
    return null;
  let count = 0;
  const lines = [...order.line_items, ...order.shipping_lines];
  for (const line of lines) {
    const allocations = record(line)?.discount_allocations;
    if (Array.isArray(allocations)) count += allocations.length;
    if (count > MAX_ALLOCATIONS) return null;
  }
  const string = (value: unknown) => (typeof value === "string" ? value : null);
  const projectLine = (input: unknown) => {
    const allocations = record(input)?.discount_allocations;
    return {
      discount_allocations: Array.isArray(allocations)
        ? allocations.map((input) => {
            const allocation = record(input);
            const money = record(record(allocation?.amount_set)?.shop_money);
            return {
              discount_application_index:
                typeof allocation?.discount_application_index === "number"
                  ? allocation.discount_application_index
                  : null,
              amount_set: {
                shop_money: {
                  amount: string(money?.amount),
                  currency_code: string(money?.currency_code),
                },
              },
            };
          })
        : null,
    };
  };
  return {
    discount_applications: order.discount_applications.map((input) => {
      const application = record(input);
      return {
        type: string(application?.type),
        code: string(application?.code),
      };
    }),
    line_items: order.line_items.map(projectLine),
    shipping_lines: order.shipping_lines.map(projectLine),
  };
}

/** Read actual line/shipping allocations, not the discount's face value, order
 * total, or a presentment-currency amount. Raw webhook/customer fields are never
 * persisted. Missing or imprecise evidence is unavailable, never zero or rounded.
 */
export function readShopifyCouponUseAmount(
  input: unknown,
  code: string,
): CouponUseAmount {
  const unavailable = (reason: string): CouponUseAmount => ({
    discountAmountMinor: null,
    currency: null,
    amountUnavailableReason: reason,
  });
  const order = record(input);
  if (!order || !Array.isArray(order.discount_applications))
    return unavailable("missing_discount_applications");
  if (order.discount_applications.length > MAX_ALLOCATIONS)
    return unavailable("allocation_limit_exceeded");
  const canonical = canonicalizeLoyaltyDiscountCode(code);
  const matches: number[] = [];
  for (let index = 0; index < order.discount_applications.length; index++) {
    const application = record(order.discount_applications[index]);
    if (
      application?.type !== "discount_code" ||
      typeof application.code !== "string"
    )
      continue;
    try {
      if (canonicalizeLoyaltyDiscountCode(application.code) === canonical)
        matches.push(index);
    } catch {
      return unavailable("invalid_discount_application");
    }
  }
  if (matches.length !== 1)
    return unavailable("ambiguous_discount_application");
  if (!Array.isArray(order.line_items) || !Array.isArray(order.shipping_lines))
    return unavailable("missing_allocation_lines");
  if (order.line_items.length + order.shipping_lines.length > MAX_ALLOCATIONS)
    return unavailable("allocation_limit_exceeded");
  const lines = [...order.line_items, ...order.shipping_lines];
  let count = 0,
    inspected = 0,
    total = BigInt(0);
  let currency: string | null = null;
  for (const rawLine of lines) {
    const line = record(rawLine);
    if (!line || !Array.isArray(line.discount_allocations))
      return unavailable("missing_discount_allocations");
    inspected += line.discount_allocations.length;
    if (inspected > MAX_ALLOCATIONS)
      return unavailable("allocation_limit_exceeded");
    const lineApplicationIndexes = new Set<number>();
    for (const rawAllocation of line.discount_allocations) {
      const allocation = record(rawAllocation);
      if (
        !allocation ||
        typeof allocation.discount_application_index !== "number" ||
        !Number.isInteger(allocation.discount_application_index) ||
        allocation.discount_application_index < 0 ||
        allocation.discount_application_index >=
          order.discount_applications.length
      )
        return unavailable("invalid_allocation_index");
      if (lineApplicationIndexes.has(allocation.discount_application_index))
        return unavailable("duplicate_line_allocation");
      lineApplicationIndexes.add(allocation.discount_application_index);
      if (allocation.discount_application_index !== matches[0]) continue;
      const money = record(record(allocation.amount_set)?.shop_money);
      if (
        !money ||
        typeof money.currency_code !== "string" ||
        !currencies.has(money.currency_code)
      )
        return unavailable("invalid_shop_money_currency");
      if (currency !== null && currency !== money.currency_code)
        return unavailable("mixed_shop_money_currencies");
      currency = money.currency_code;
      if (
        typeof money.amount !== "string" ||
        !/^(0|[1-9]\d{0,18})(\.\d{1,6})?$/.test(money.amount)
      )
        return unavailable("invalid_shop_money_amount");
      const [whole, fraction = ""] = money.amount.split(".");
      const digits = currencyMinorUnits(currency);
      if (/[1-9]/.test(fraction.slice(digits)))
        return unavailable("inexact_shop_money_precision");
      total +=
        BigInt(whole) * BigInt(`1${"0".repeat(digits)}`) +
        BigInt(fraction.slice(0, digits).padEnd(digits, "0") || "0");
      if (total > MAX_MINOR) return unavailable("shop_money_overflow");
      count++;
    }
  }
  if (!count) return unavailable("missing_coupon_allocations");
  return {
    discountAmountMinor: total,
    currency,
    amountUnavailableReason: null,
  };
}
