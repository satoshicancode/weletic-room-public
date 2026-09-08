import {
  rewardCatalogFieldsSchema,
  type RewardCatalogFields,
} from "../../../lib/weletic/loyalty/reward-catalog-contract";

export type RewardCatalogForm = { [K in keyof RewardCatalogFields]: string };
export const newRewardCatalogFields = (): RewardCatalogFields => ({
  name: "",
  description: null,
  rewardType: "amount_off",
  salesChannel: "online_store",
  exchangeType: "fixed",
  pointsCost: "100",
  pointsStep: null,
  minPointsCost: null,
  maxPointsCost: null,
  discountValue: "1",
  maxDiscountValue: null,
  minOrderAmount: null,
  appliesToResource: "entire_order",
  entitledProductIds: [],
  entitledVariantIds: [],
  entitledCollectionIds: [],
  combinesWithOrderDiscounts: false,
  combinesWithProductDiscounts: false,
  combinesWithShippingDiscounts: false,
  usageLimit: 1,
  usageLimitPerCustomer: 1,
  expiresInDays: null,
  purchaseType: "one_time",
  subscriptionCadence: "first_payment",
  subscriptionPaymentLimit: null,
  status: "inactive",
});
export function rewardCatalogFormFromFields(
  fields: RewardCatalogFields,
): RewardCatalogForm {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value === null
        ? ""
        : Array.isArray(value)
          ? value.join("\n")
          : String(value),
    ]),
  ) as RewardCatalogForm;
}
const nullable = (value: string) => (value === "" ? null : value);
const integer = (value: string) =>
  value === "" ? null : /^\d+$/.test(value) ? Number(value) : value;
const boolean = (value: string) =>
  value === "true" ? true : value === "false" ? false : value;
const ids = (value: string, resource: string) => [
  ...new Set(
    value
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((id) =>
        /^[1-9]\d*$/.test(id) ? `gid://shopify/${resource}/${id}` : id,
      ),
  ),
];
export function parseRewardCatalogForm(form: RewardCatalogForm) {
  return rewardCatalogFieldsSchema.safeParse({
    ...form,
    description: nullable(form.description),
    pointsStep: nullable(form.pointsStep),
    minPointsCost: nullable(form.minPointsCost),
    maxPointsCost: nullable(form.maxPointsCost),
    discountValue: nullable(form.discountValue),
    maxDiscountValue: nullable(form.maxDiscountValue),
    minOrderAmount: nullable(form.minOrderAmount),
    usageLimit: integer(form.usageLimit),
    usageLimitPerCustomer: integer(form.usageLimitPerCustomer),
    expiresInDays: integer(form.expiresInDays),
    subscriptionPaymentLimit: integer(form.subscriptionPaymentLimit),
    entitledProductIds: ids(form.entitledProductIds, "Product"),
    entitledVariantIds: ids(form.entitledVariantIds, "ProductVariant"),
    entitledCollectionIds: ids(form.entitledCollectionIds, "Collection"),
    combinesWithOrderDiscounts: boolean(form.combinesWithOrderDiscounts),
    combinesWithProductDiscounts: boolean(form.combinesWithProductDiscounts),
    combinesWithShippingDiscounts: boolean(form.combinesWithShippingDiscounts),
  });
}

/** Changing a type explicitly resets its incompatible controls in the draft only. */
export function changeRewardCatalogType(
  form: RewardCatalogForm,
  rewardType: RewardCatalogFields["rewardType"],
) {
  const defaults = rewardCatalogFormFromFields(newRewardCatalogFields());
  const financial = rewardType === "gift_card" || rewardType === "store_credit";
  return {
    ...defaults,
    name: form.name,
    description: form.description,
    pointsCost: form.pointsCost,
    status: form.status,
    expiresInDays: form.expiresInDays,
    rewardType,
    discountValue:
      rewardType === "free_product" || rewardType === "free_shipping"
        ? ""
        : "1",
    maxDiscountValue: rewardType === "free_product" ? "1" : "",
    appliesToResource:
      rewardType === "free_product" ? "specific_items" : "entire_order",
    usageLimit: financial ? "" : "1",
    usageLimitPerCustomer: financial ? "0" : "1",
    purchaseType: financial ? "one_time" : form.purchaseType,
    subscriptionCadence: financial ? "first_payment" : form.subscriptionCadence,
    subscriptionPaymentLimit: financial ? "" : form.subscriptionPaymentLimit,
  };
}
