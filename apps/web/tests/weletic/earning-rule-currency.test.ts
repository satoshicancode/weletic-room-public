import { describe, expect, it } from "vitest";
import { earningRulesResponseSchema } from "../../lib/weletic/loyalty/earning-rule-contract";
import { projectEarningRuleCurrency } from "../../lib/weletic/loyalty/earning-rule-projection";
const response = {
  storeId: "store",
  installationGeneration: "g1",
  programId: null,
  revision: null,
  affectedRuleId: null,
  capabilities: { configure: true },
  rules: [],
};
describe("earning rule shop currency context", () => {
  it.each(["USD", "JPY", "VND", "BHD"])(
    "retains canonical currency %s",
    (currency) => {
      expect(projectEarningRuleCurrency(currency)).toBe(currency);
      expect(
        earningRulesResponseSchema.parse({
          ...response,
          shopCurrency: currency,
        }).shopCurrency,
      ).toBe(currency);
    },
  );
  it.each([null, undefined, "", "usd", " JPY ", "JPY<script>", 123])(
    "does not guess missing or malformed currency %s",
    (currency) => {
      expect(projectEarningRuleCurrency(currency)).toBeNull();
    },
  );
  it("accepts old responses without currency without defaulting to USD", () => {
    expect(
      earningRulesResponseSchema.parse(response).shopCurrency,
    ).toBeUndefined();
    expect(
      earningRulesResponseSchema.parse({ ...response, shopCurrency: null })
        .shopCurrency,
    ).toBeNull();
  });
  it.each(["usd", "", "JPY<script>"])(
    "rejects malformed wire currency %s",
    (shopCurrency) => {
      expect(
        earningRulesResponseSchema.safeParse({ ...response, shopCurrency })
          .success,
      ).toBe(false);
    },
  );
});
