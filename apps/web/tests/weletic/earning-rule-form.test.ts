import { describe, expect, it } from "vitest";
import { CUSTOMER_INTENT_TRIGGER_CODES } from "../../lib/weletic/loyalty/customer-intent-policy";
import {
  changeEarningRuleTrigger,
  earningRuleFormFromFields,
  newEarningRuleForm,
  parseEarningRuleForm,
} from "../../ui/weletic/loyalty/earning-rule-form";
describe("shared earning-rule form model", () => {
  it("starts inactive and requires an explicit name and activity award", () => {
    expect(newEarningRuleForm().isActive).toBe(false);
    expect(parseEarningRuleForm(newEarningRuleForm()).success).toBe(false);
    expect(
      parseEarningRuleForm({
        ...newEarningRuleForm("birthday"),
        name: "Birthday",
      }).success,
    ).toBe(false);
  });
  it.each([
    "order_paid",
    "account_created",
    "birthday",
    "product_review",
    ...CUSTOMER_INTENT_TRIGGER_CODES,
  ] as const)("round-trips valid %s without financial coercion", (trigger) => {
    const form = {
      ...newEarningRuleForm(trigger),
      name: "Rule",
      fixedPoints: "9007199254740993",
      multiplier: "1.2500",
      targetUrl:
        trigger === "facebook_like"
          ? "https://www.facebook.com/shop"
          : trigger === "instagram_follow"
            ? "https://instagram.com/shop"
            : trigger === "x_follow"
              ? "https://x.com/shop"
              : trigger === "tiktok_follow"
                ? "https://tiktok.com/@shop"
                : "https://example.com",
    };
    const parsed = parseEarningRuleForm(form);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("invalid fixture");
    expect(
      parseEarningRuleForm(earningRuleFormFromFields(parsed.data)),
    ).toEqual(parsed);
    if (trigger !== "order_paid")
      expect(parsed.data.fixedPoints).toBe("9007199254740993");
  });
  it("resets activation, provider and reward values when switching trigger", () => {
    const form = {
      ...newEarningRuleForm("product_review"),
      name: "Keep",
      description: "Description",
      isActive: true,
      provider: "judgeme" as const,
      fixedPoints: "100",
      photoBonusPoints: "50",
    };
    const changed = changeEarningRuleTrigger(form, "birthday");
    expect(changed).toMatchObject({
      name: "Keep",
      description: "Description",
      isActive: false,
      fixedPoints: "",
      photoBonusPoints: "0",
      provider: "native",
      limitInterval: "calendar_year",
    });
    expect(changeEarningRuleTrigger(form, "product_review")).toBe(form);
  });
  it.each(["", "1e2", "1.5", " 1", "Infinity", "2147483648"])(
    "rejects invalid priority %s",
    (priority) => {
      expect(
        parseEarningRuleForm({
          ...newEarningRuleForm(),
          name: "Rule",
          priority,
        }).success,
      ).toBe(false);
    },
  );
});
