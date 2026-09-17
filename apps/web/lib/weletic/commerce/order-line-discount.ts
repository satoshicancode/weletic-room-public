import type { orderSchema } from "@/lib/integrations/shopify/schema";
import { currencyMinorUnits, decimalToMinorUnits } from "@/lib/weletic/money";
import type { z } from "zod/v4";

type Line = z.infer<typeof orderSchema>["line_items"][number];
type MoneySet = Line["price_set"];

/** Shopify recommends allocations over total_discount_set for native discounts.
 * Missing allocations retain legacy ingestion compatibility; an explicit empty
 * array means zero, not permission to reuse the legacy field or double count it.
 */
export function readOrderLineDiscount(
  line: Pick<
    Line,
    "discount_allocations" | "total_discount_set" | "price_set" | "quantity"
  >,
  side: "shop_money" | "presentment_money",
  currency: string,
): bigint {
  const read = (set: MoneySet): bigint => {
    const money =
      side === "shop_money"
        ? set.shop_money
        : set.presentment_money ?? set.shop_money;
    if (
      money.currency_code !== currency ||
      !/^\d+(\.\d+)?$/.test(money.amount)
    ) {
      throw new Error("Invalid order line discount money or currency");
    }
    const fraction = money.amount.split(".")[1] ?? "";
    if (/[^0]/.test(fraction.slice(currencyMinorUnits(currency)))) {
      throw new Error("Order line discount money must use exact minor units");
    }
    return decimalToMinorUnits(money.amount, currency);
  };
  const sets =
    line.discount_allocations === undefined
      ? line.total_discount_set
        ? [line.total_discount_set]
        : []
      : line.discount_allocations.map((allocation) => allocation.amount_set);
  const discount = sets.reduce((sum, set) => sum + read(set), BigInt(0));
  const gross = read(line.price_set) * BigInt(line.quantity);
  if (discount > gross)
    throw new Error("Order line discount exceeds gross amount");
  return discount;
}
