import { reviewIncentiveDisclosure } from "@/lib/weletic/reviews/incentive-disclosure";
import { reviewIncentivePolicyDigest } from "@/lib/weletic/reviews/incentive-policy";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));

const terms = () => ({
  rewardDefinitionId: "private-reward-record",
  name: "Coupon",
  description: null,
  rewardType: "amount_off",
  salesChannel: "online_store",
  exchangeType: "fixed",
  purchasePolicy: {
    purchaseType: "one_time",
    subscriptionCadence: "first_payment",
    subscriptionPaymentLimit: null,
  },
  discountValue: "12345",
  maxDiscountValue: null,
  minOrderAmount: "20000",
  appliesToResource: "entire_order",
  entitledCollectionIds: [] as string[],
  entitledProductIds: [] as string[],
  entitledVariantIds: [] as string[],
  combinesWithProductDiscounts: false,
  combinesWithOrderDiscounts: true,
  combinesWithShippingDiscounts: false,
  usageLimit: 1,
  usageLimitPerCustomer: 1,
  expiresInDays: 30,
  shopCurrency: "USD",
});
function snapshot(
  patch: Record<string, unknown> = {},
  displayTargets?: Array<{ id: string; name: string }>,
) {
  return {
    version: 1,
    award: {
      kind: "coupon",
      terms: { ...terms(), ...patch },
      ...(displayTargets === undefined ? {} : { displayTargets }),
    },
  };
}
const disclose = (
  patch: Record<string, unknown> = {},
  targets?: Array<{ id: string; name: string }>,
) => reviewIncentiveDisclosure(snapshot(patch, targets))!;
describe("immutable coupon disclosure", () => {
  it.each([
    ["JPY", "12345 JPY"],
    ["USD", "123.45 USD"],
    ["KWD", "12.345 KWD"],
  ])("uses exact minor-unit conversion for %s", (shopCurrency, expected) => {
    const result = disclose({ shopCurrency });
    for (const locale of ["en", "ja", "vi"] as const) {
      expect(result[locale][0]).toContain(expected);
      expect(result[locale].join(" ")).not.toContain("private-reward-record");
    }
  });
  it("does not round large minor-unit values through Number", () => {
    expect(disclose({ discountValue: "9007199254740993" }).en[0]).toContain(
      "90071992547409.93 USD",
    );
  });
  it.each(["en", "ja", "vi"] as const)(
    "discloses native terms in %s",
    (locale) => {
      const lines = disclose()[locale];
      expect(lines[1]).toContain("200.00 USD");
      expect(lines.join(" ")).toContain("30");
      expect(lines.length).toBeGreaterThan(6);
      expect(
        lines.every((line) => line.length > 0 && line.length <= 2000),
      ).toBe(true);
    },
  );
  it("uses native default code usage and no-expiry semantics", () => {
    const lines = disclose({
      usageLimit: null,
      usageLimitPerCustomer: null,
      expiresInDays: 0,
      minOrderAmount: null,
    }).en;
    expect(lines).toContain("Total code uses: 1. Once per customer: no.");
    expect(lines).toContain("No scheduled coupon expiry.");
    expect(lines).toContain("Minimum order amount: 0.00 USD.");
  });
  it.each([
    ["first_payment", null, "first payment"],
    ["first_n_payments", 3, "first 3 payments"],
    ["every_payment", null, "every payment"],
  ] as const)(
    "describes subscription cadence %s",
    (subscriptionCadence, subscriptionPaymentLimit, expected) => {
      const lines = disclose({
        purchasePolicy: {
          purchaseType: "both",
          subscriptionCadence,
          subscriptionPaymentLimit,
        },
      }).en;
      expect(lines.join(" ")).toContain(expected);
      expect(lines.join(" ")).toContain("after the code is applied");
    },
  );
  it("renders percentage and shipping offers without treating percentages as money", () => {
    expect(
      disclose({ rewardType: "percentage_off", discountValue: "12.50" }).en[0],
    ).toContain("12.50%");
    expect(
      disclose({ rewardType: "free_shipping", discountValue: null }).ja[0],
    ).toContain("送料無料");
  });
  it("requires a complete immutable readable target set and does not leak target IDs", () => {
    const id = "gid://shopify/Product/123";
    const patch = {
      appliesToResource: "specific_items",
      entitledProductIds: [id],
    };
    expect(() => disclose(patch)).toThrow("disclosure is unavailable");
    expect(() =>
      disclose(patch, [{ id: "gid://shopify/Product/999", name: "Other" }]),
    ).toThrow();
    const result = disclose(patch, [{ id, name: "Saved product name" }]);
    expect(result.en.join(" ")).toContain("Saved product name");
    expect(JSON.stringify(result)).not.toContain(id);
    expect(() =>
      disclose(patch, [
        { id, name: "One" },
        { id, name: "Two" },
      ]),
    ).toThrow();
  });
  it("bounds paragraph length for the maximum supported saved target list", () => {
    const targets = Array.from({ length: 250 }, (_, index) => ({
      id: `gid://shopify/Product/${index + 1}`,
      name: "x".repeat(200),
    }));
    const result = disclose(
      {
        appliesToResource: "specific_items",
        entitledProductIds: targets.map((item) => item.id),
      },
      targets,
    );
    for (const lines of Object.values(result)) {
      expect(lines.length).toBeLessThanOrEqual(50);
      expect(lines.every((line) => line.length <= 2000)).toBe(true);
    }
  });
  it("rejects duplicate or wrong-kind restrictions even when labels exist", () => {
    const id = "gid://shopify/Collection/1";
    expect(() =>
      disclose(
        { appliesToResource: "specific_items", entitledProductIds: [id] },
        [{ id, name: "Collection" }],
      ),
    ).toThrow();
    expect(() =>
      disclose(
        {
          appliesToResource: "specific_items",
          entitledCollectionIds: [id, id],
        },
        [{ id, name: "Collection" }],
      ),
    ).toThrow();
  });
  it.each([
    { discountValue: "-1" },
    { discountValue: "1.5" },
    { maxDiscountValue: "100" },
    { rewardType: "percentage_off", discountValue: "101" },
    { rewardType: "percentage_off", discountValue: "0" },
    { exchangeType: "incremental" },
    { minOrderAmount: "-1" },
    { appliesToResource: "product" },
    { entitledProductIds: ["gid://shopify/Product/1"] },
    { rewardType: "free_shipping", discountValue: "100" },
  ])("fails closed for unsupported or misleading terms %j", (patch) =>
    expect(() => disclose(patch)).toThrow(),
  );
  it("does not add new fields to historical snapshots or change their digests", () => {
    const value = snapshot();
    const digest = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    expect(reviewIncentivePolicyDigest(value)).toBe(digest);
    expect(reviewIncentivePolicyDigest(snapshot({}, []))).not.toBe(digest);
  });
});
