import { expect, it } from "vitest";
import { defaultLoyaltyNudgeSettings } from "../../lib/weletic/loyalty/nudge-contract";
import { projectPublicLoyaltyNudges } from "../../lib/weletic/loyalty/nudge-public-projection";
it("projects only validated presentation settings, never private metadata", () => {
  const settings = defaultLoyaltyNudgeSettings();
  settings.policies[0].enabled = true;
  const result = projectPublicLoyaltyNudges(
    {
      loyaltyNudges: settings,
      secret: "private-token",
      loyaltyNudgeSequence: 42,
    },
    true,
  );
  expect(result).toEqual(settings);
  expect(JSON.stringify(result)).not.toContain("private-token");
  expect(result).not.toBe(settings);
});
it.each([
  null,
  [],
  "corrupt",
  {},
  { loyaltyNudges: null },
  { loyaltyNudges: { version: 9 } },
])("fails closed for unavailable or corrupt metadata %j", (metadata) => {
  expect(projectPublicLoyaltyNudges(metadata, true)).toEqual(
    defaultLoyaltyNudgeSettings(),
  );
});
it("suppresses disabled programs and unknown policy fields", () => {
  const settings = defaultLoyaltyNudgeSettings();
  settings.policies[0].enabled = true;
  expect(
    projectPublicLoyaltyNudges({ loyaltyNudges: settings }, false),
  ).toEqual(defaultLoyaltyNudgeSettings());
  expect(
    projectPublicLoyaltyNudges(
      { loyaltyNudges: { ...settings, privateId: "x" } },
      true,
    ),
  ).toEqual(defaultLoyaltyNudgeSettings());
});
