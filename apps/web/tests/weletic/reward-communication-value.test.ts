import { expect, it } from "vitest";
import { rewardCommunicationValue } from "../../lib/weletic/loyalty/reward-communication-value";

it.each([
  ["USD", "1234", "12.34 USD"],
  ["JPY", "1234", "1234 JPY"],
  ["KWD", "1234", "1.234 KWD"],
  ["USD", "9007199254740993", "90071992547409.93 USD"],
  ["USD", "1234.000", "12.34 USD"],
])("renders exact %s minor units %s", (currency, value, expected) => {
  for (const type of ["amount_off", "gift_card", "store_credit"] as const)
    expect(
      rewardCommunicationValue({ type, name: "Reward", value, currency }, "en"),
    ).toBe(expected);
});

it.each(["0", "-1", "1.5", "NaN", "1e2", ""])(
  "rejects invalid monetary value %s",
  (value) => {
    expect(() =>
      rewardCommunicationValue(
        { type: "amount_off", name: "Reward", value, currency: "USD" },
        "en",
      ),
    ).toThrow();
  },
);

it.each(["0.01", "12.34", "100", "100.000"])(
  "preserves valid percentage %s",
  (value) => {
    expect(
      rewardCommunicationValue(
        { type: "percentage_off", name: "Reward", value, currency: "USD" },
        "ja",
      ),
    ).toBe(`${value}%`);
  },
);
it.each(["0", "0.000", "100.001", "101", "-1", "NaN", "1e2"])(
  "rejects invalid percentage %s",
  (value) => {
    expect(() =>
      rewardCommunicationValue(
        { type: "percentage_off", name: "Reward", value, currency: "USD" },
        "vi",
      ),
    ).toThrow();
  },
);

it.each([
  ["en", "Free shipping", "Free product"],
  ["ja", "送料無料", "無料商品"],
  ["vi", "Miễn phí vận chuyển", "Sản phẩm miễn phí"],
] as const)(
  "localizes nonmonetary rewards in %s without inventing amounts",
  (locale, shipping, product) => {
    expect(
      rewardCommunicationValue(
        { type: "free_shipping", name: "Reward", value: null, currency: "USD" },
        locale,
      ),
    ).toBe(shipping);
    expect(
      rewardCommunicationValue(
        { type: "free_product", name: "Reward", value: null, currency: "USD" },
        locale,
      ),
    ).toBe(product);
  },
);
