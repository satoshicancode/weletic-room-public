import {
  assertNewBenefitsEnabled,
  isSetupOnly,
  SubscriptionVerificationRequiredError,
} from "@/lib/weletic/shopify/setup-only";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());
it.each(["1", "0", "", "true"])(
  "setup flag %j fails closed independently of profile",
  (value) => {
    vi.stubEnv("WELETIC_SETUP_ONLY", value);
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "legacy");
    expect(isSetupOnly()).toBe(true);
    expect(assertNewBenefitsEnabled).toThrow(
      SubscriptionVerificationRequiredError,
    );
  },
);
it("normal runtime has no additional setup restriction", () => {
  vi.stubEnv("WELETIC_SETUP_ONLY", undefined);
  expect(isSetupOnly()).toBe(false);
  expect(assertNewBenefitsEnabled).not.toThrow();
});
