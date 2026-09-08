import { z } from "zod";

const points = z
  .string()
  .trim()
  .max(20)
  .default("")
  .refine((value) => {
    if (value === "") return true;
    if (!/^(0|-?[1-9]\d*)$/.test(value)) return false;
    const number = BigInt(value);
    return (
      number >= BigInt("-9223372036854775808") &&
      number <= BigInt("9223372036854775807")
    );
  }, "Use a signed 64-bit integer, not a decimal or scientific notation");
const day = z
  .string()
  .max(10)
  .default("")
  .refine((value) => {
    if (!value) return true;
    if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    );
  }, "Use a valid UTC calendar date");

// Only existing store-scoped facts. Never interpret the Shopify marketing flag
// as consent, or Partner groups / cached Shopify segment IDs as shopper groups.
export const shopperSegmentSchema = z
  .object({
    loyalty: z
      .enum([
        "any",
        "enrolled",
        "not_enrolled",
        "active",
        "suspended",
        "closed",
      ])
      .default("any"),
    vip: z.enum(["any", "assigned", "unassigned"]).default("any"),
    minPoints: points,
    maxPoints: points,
    purchase: z.enum(["any", "has_order", "no_order"]).default("any"),
    purchasedFrom: day,
    purchasedBefore: day,
  })
  .superRefine((value, context) => {
    // Zod may run object refinements after a leaf refinement failed. Never
    // convert an unvalidated bound: invalid input must return a validation issue.
    const minimum = points.safeParse(value.minPoints);
    const maximum = points.safeParse(value.maxPoints);
    if (
      minimum.success &&
      maximum.success &&
      minimum.data !== "" &&
      maximum.data !== "" &&
      BigInt(minimum.data) > BigInt(maximum.data)
    )
      context.addIssue({
        code: "custom",
        path: ["maxPoints"],
        message: "Maximum points must not be below minimum points",
      });
    if (
      value.purchasedFrom &&
      value.purchasedBefore &&
      value.purchasedFrom >= value.purchasedBefore
    )
      context.addIssue({
        code: "custom",
        path: ["purchasedBefore"],
        message: "Purchase end date must be after start date",
      });
    if (
      value.purchase === "any" &&
      (value.purchasedFrom || value.purchasedBefore)
    )
      context.addIssue({
        code: "custom",
        path: ["purchase"],
        message: "Select a purchase condition before setting dates",
      });
    if (
      value.loyalty === "not_enrolled" &&
      (value.vip !== "any" || value.minPoints || value.maxPoints)
    )
      context.addIssue({
        code: "custom",
        path: ["loyalty"],
        message: "Point and tier filters require an existing loyalty account",
      });
  });

export type ShopperSegment = z.infer<typeof shopperSegmentSchema>;
export const emptyShopperSegment: ShopperSegment = shopperSegmentSchema.parse(
  {},
);
export function hasShopperSegment(segment: ShopperSegment) {
  return Object.keys(emptyShopperSegment).some((key) => {
    const field = key as keyof ShopperSegment;
    return segment[field] !== emptyShopperSegment[field];
  });
}
