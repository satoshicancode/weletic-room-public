import { expect, it } from "vitest";
import {
  defaultLoyaltyNudgeSettings,
  loyaltyNudgeSettingsSchema,
} from "../../lib/weletic/loyalty/nudge-contract";

it("defaults all three localized nudges off without shared mutable state", () => {
  const settings = defaultLoyaltyNudgeSettings();
  expect(settings.policies.map((p) => p.kind)).toEqual([
    "signup",
    "points_spending",
    "reward_usage",
  ]);
  expect(settings.policies.every((p) => !p.enabled)).toBe(true);
  settings.policies[0].enabled = true;
  expect(defaultLoyaltyNudgeSettings().policies[0].enabled).toBe(false);
  for (const policy of settings.policies)
    expect(Object.keys(policy.templates)).toEqual(["en", "ja", "vi"]);
});
it.each([
  "<img src=x>",
  "{{customer_id}}",
  "{{points_balance}",
  "\u0000text",
  "\u007ftext",
  " ",
  "x".repeat(101),
])("rejects unsafe or invalid title %j", (value) => {
  const settings = defaultLoyaltyNudgeSettings();
  settings.policies[1].templates.en.title = value;
  expect(loyaltyNudgeSettingsSchema.safeParse(settings).success).toBe(false);
});
it("does not allow balance variables in signup or reward-usage copy", () => {
  for (const index of [0, 2]) {
    const settings = defaultLoyaltyNudgeSettings();
    settings.policies[index].templates.ja.description = "{{points_balance}}";
    expect(loyaltyNudgeSettingsSchema.safeParse(settings).success).toBe(false);
  }
});
it("rejects duplicate, missing and unknown configuration", () => {
  const settings = defaultLoyaltyNudgeSettings();
  settings.policies[2] = settings.policies[0];
  expect(loyaltyNudgeSettingsSchema.safeParse(settings).success).toBe(false);
  expect(
    loyaltyNudgeSettingsSchema.safeParse({
      ...defaultLoyaltyNudgeSettings(),
      customerId: "private",
    }).success,
  ).toBe(false);
  expect(
    loyaltyNudgeSettingsSchema.safeParse({ version: 1, policies: [] }).success,
  ).toBe(false);
});
