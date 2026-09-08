import { loyaltyConfigurationPatchSchema } from "@/lib/weletic/loyalty/configuration-contract";
import {
  configurationSelect,
  normalizeConfiguration,
  projectConfiguration,
} from "@/lib/weletic/loyalty/configuration-state";
import { describe, expect, it } from "vitest";

describe("shared Loyalty configuration representation", () => {
  it("selects only displayed configuration and revision inputs", () => {
    expect(configurationSelect).not.toHaveProperty("metadata");
    expect(configurationSelect).not.toHaveProperty("store");
    expect(configurationSelect).not.toHaveProperty("referralRules");
    expect(projectConfiguration(null)).toEqual({
      program: null,
      configurationRevision: null,
    });
  });

  it("normalizes an exact rate and signed-64-bit valuation without Number", () => {
    const normalized = normalizeConfiguration(
      loyaltyConfigurationPatchSchema.parse({
        pointsPerCurrencyUnit: "999999.9999",
        liabilityValuationCurrency: "JPY",
        liabilityMinorUnitsNumerator: "9223372036854775807",
        liabilityPointsDenominator: "100",
      }),
    );
    expect(normalized.parsedPointsPerCurrencyUnit?.toString()).toBe(
      "999999.9999",
    );
    expect(normalized.parsedLiabilityNumerator).toBe(
      BigInt("9223372036854775807"),
    );
    expect(normalized.parsedLiabilityDenominator).toBe(BigInt("100"));
    expect(normalized.valuationFieldsPresent).toBe(true);
  });

  it("distinguishes omitted valuation from an explicit clear", () => {
    const omitted = normalizeConfiguration({ name: "Updated" });
    expect(omitted.valuationFieldsPresent).toBe(false);
    expect(omitted.parsedLiabilityNumerator).toBeUndefined();
    expect(omitted.parsedLiabilityDenominator).toBeUndefined();
    const cleared = normalizeConfiguration({
      liabilityValuationCurrency: null,
      liabilityMinorUnitsNumerator: null,
      liabilityPointsDenominator: null,
    });
    expect(cleared.valuationFieldsPresent).toBe(true);
    expect(cleared.normalizedValuationCurrency).toBeNull();
    expect(cleared.parsedLiabilityNumerator).toBeNull();
    expect(cleared.parsedLiabilityDenominator).toBeNull();
  });

  it("preserves explicit zero and false controls without filling omitted fields", () => {
    const normalized = normalizeConfiguration({
      holdingPeriodDays: 0,
      pointsExpiryMonths: 0,
      pointsExpiryDays: 0,
      pointsExpiryWarningDays: 0,
      pointsExpiryLastChanceDays: 0,
      vipDowngradeGraceDays: 0,
      pointsExpiryWarningEnabled: false,
      pointsExpiryLastChanceEnabled: false,
      vipAutoDowngradeEnabled: false,
      killSwitchActive: false,
    });
    expect(normalized).toMatchObject({
      parsedHoldingPeriodDays: 0,
      parsedExpiryMonths: 0,
      parsedExpiryDays: 0,
      parsedWarningDays: 0,
      parsedLastChanceDays: 0,
      parsedVipGraceDays: 0,
      pointsExpiryWarningEnabled: false,
      pointsExpiryLastChanceEnabled: false,
      vipAutoDowngradeEnabled: false,
      killSwitchActive: false,
    });
    expect(normalized.status).toBeUndefined();
    expect(normalized.parsedPointsPerCurrencyUnit).toBeUndefined();
  });
});
