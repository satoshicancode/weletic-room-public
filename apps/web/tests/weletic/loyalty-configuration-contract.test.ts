import {
  loyaltyConfigurationPatchSchema,
  loyaltyConfigurationRateSchema,
  loyaltyConfigurationResponseSchema,
  requiresLoyaltyConfigurationOwner,
  shopifyLoyaltyConfigurationInputSchema,
} from "@/lib/weletic/loyalty/configuration-contract";
import { describe, expect, it } from "vitest";

describe("embedded Loyalty configuration contract", () => {
  it.each(["0.0001", "1", "1.2500", "999999.9999"])(
    "accepts exactly representable rate %s",
    (value) => expect(loyaltyConfigurationRateSchema.parse(value)).toBe(value),
  );

  it.each([
    "0",
    "0.0000",
    "0.00001",
    "1000000",
    "01",
    "+1",
    "1e2",
    "1.",
    " 1",
    1,
  ])("rejects ambiguous or unrepresentable embedded rate %s", (value) =>
    expect(loyaltyConfigurationRateSchema.safeParse(value).success).toBe(false),
  );

  it("retains rational valuation strings without converting them to numbers", () => {
    const value = {
      liabilityValuationCurrency: "JPY",
      liabilityMinorUnitsNumerator: "1",
      liabilityPointsDenominator: "100",
    };
    expect(loyaltyConfigurationPatchSchema.parse(value)).toEqual(value);
    expect(
      loyaltyConfigurationPatchSchema.parse({
        ...value,
        liabilityMinorUnitsNumerator: "9223372036854775807",
      }).liabilityMinorUnitsNumerator,
    ).toBe("9223372036854775807");
    expect(
      loyaltyConfigurationPatchSchema.safeParse({
        ...value,
        liabilityMinorUnitsNumerator: "9223372036854775808",
      }).success,
    ).toBe(false);
  });

  it.each([
    {},
    { name: undefined },
    { name: "" },
    { name: "Hidden\u0000name" },
    { name: "a".repeat(192) },
    { pointsExpiryDays: 7, pointsExpiryMonths: 12 },
    { holdingPeriodDays: "7" },
    { holdingPeriodDays: 366 },
    { pointsExpiryMonths: 25 },
    { pointsExpiryDays: 731 },
    { vipDowngradeGraceDays: -1 },
    { killSwitchActive: "false" },
    { liabilityValuationCurrency: "JPY" },
    {
      liabilityValuationCurrency: "JPY",
      liabilityMinorUnitsNumerator: "1",
      liabilityPointsDenominator: null,
    },
    { enableCheckoutExtension: true },
    { metadata: {} },
  ])("rejects invalid or out-of-scope patch %#", (value) => {
    expect(loyaltyConfigurationPatchSchema.safeParse(value).success).toBe(
      false,
    );
  });

  it("allows an explicit complete valuation clear", () => {
    expect(
      loyaltyConfigurationPatchSchema.safeParse({
        liabilityValuationCurrency: null,
        liabilityMinorUnitsNumerator: null,
        liabilityPointsDenominator: null,
      }).success,
    ).toBe(true);
  });

  it("marks financial and emergency controls as owner-only even when clearing", () => {
    expect(requiresLoyaltyConfigurationOwner({ name: "New name" })).toBe(false);
    expect(requiresLoyaltyConfigurationOwner({ status: "draft" })).toBe(true);
    expect(requiresLoyaltyConfigurationOwner({ killSwitchActive: false })).toBe(
      true,
    );
    expect(
      requiresLoyaltyConfigurationOwner({ liabilityValuationCurrency: null }),
    ).toBe(true);
  });

  it("requires explicit generation and configuration revision on writes", () => {
    const input = {
      expectedInstallationGeneration: "generation-1",
      expectedRevision: "a".repeat(64),
      settings: { name: "Loyalty" },
    };
    expect(
      shopifyLoyaltyConfigurationInputSchema.safeParse({ operation: "read" })
        .success,
    ).toBe(true);
    expect(
      shopifyLoyaltyConfigurationInputSchema.safeParse({
        operation: "read",
        input,
      }).success,
    ).toBe(false);
    expect(
      shopifyLoyaltyConfigurationInputSchema.safeParse({
        operation: "update",
        input,
      }).success,
    ).toBe(true);
    expect(
      shopifyLoyaltyConfigurationInputSchema.safeParse({
        operation: "update",
        input: { ...input, expectedRevision: undefined },
      }).success,
    ).toBe(false);
    expect(
      shopifyLoyaltyConfigurationInputSchema.safeParse({
        operation: "update",
        input: { ...input, storeId: "foreign" },
      }).success,
    ).toBe(false);
  });

  it("represents an unconfigured program without fabricating a revision", () => {
    const response = {
      storeId: "store-1",
      installationGeneration: "generation-1",
      accountingCurrency: "JPY",
      configurationRevision: null,
      program: null,
      capabilities: { configure: false, owner: false },
    };
    expect(loyaltyConfigurationResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(
      loyaltyConfigurationResponseSchema.safeParse({
        ...response,
        configurationRevision: "a".repeat(64),
      }).success,
    ).toBe(false);
    expect(
      loyaltyConfigurationResponseSchema.safeParse({
        ...response,
        privateToken: "secret",
      }).success,
    ).toBe(false);
  });
});
