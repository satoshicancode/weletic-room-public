import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type { LoyaltyConfigurationPatch } from "./configuration-contract";
import {
  readNullablePositiveBigInt,
  readPositiveDecimal,
} from "./settings-validation";
import type { ValidatedLoyaltySettings } from "./settings-writer";

// Server-only representation shared by merchant gateways. This module does not
// authorize callers or acquire write fences; those remain the gateway's duty.
export const configurationSelect = {
  id: true,
  name: true,
  status: true,
  pointNameSingular: true,
  pointNamePlural: true,
  pointsPerCurrencyUnit: true,
  holdingPeriodDays: true,
  pointsExpiryMonths: true,
  pointsExpiryDays: true,
  pointsExpiryWarningDays: true,
  pointsExpiryLastChanceDays: true,
  pointsExpiryWarningEnabled: true,
  pointsExpiryLastChanceEnabled: true,
  killSwitchActive: true,
  vipMilestoneMode: true,
  vipTimeframe: true,
  vipDowngradeGraceDays: true,
  vipAutoDowngradeEnabled: true,
  liabilityValuationCurrency: true,
  liabilityMinorUnitsNumerator: true,
  liabilityPointsDenominator: true,
  earnPolicyVersion: true,
  updatedAt: true,
} satisfies Prisma.WeleticLoyaltyProgramSelect;

type ConfigurationRow = Prisma.WeleticLoyaltyProgramGetPayload<{
  select: typeof configurationSelect;
}>;

export function projectConfiguration(program: ConfigurationRow | null) {
  if (!program) return { program: null, configurationRevision: null };
  const { id, updatedAt, earnPolicyVersion, ...fields } = program;
  const settings = {
    ...fields,
    pointsPerCurrencyUnit: fields.pointsPerCurrencyUnit.toString(),
    liabilityMinorUnitsNumerator:
      fields.liabilityMinorUnitsNumerator?.toString() ?? null,
    liabilityPointsDenominator:
      fields.liabilityPointsDenominator?.toString() ?? null,
  };
  // Compare under the store/program write fence. This is a state fingerprint,
  // not a write counter: identical state within one timestamp may retain it.
  // Include earning-policy changes as well as all displayed configuration.
  const configurationRevision = createHash("sha256")
    .update(
      JSON.stringify([
        "loyalty-configuration-v1",
        id,
        updatedAt,
        earnPolicyVersion,
        Object.entries(settings).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      ]),
    )
    .digest("hex");
  return { program: { id, settings }, configurationRevision };
}

export function normalizeConfiguration(
  settings: LoyaltyConfigurationPatch,
): ValidatedLoyaltySettings {
  return {
    name: settings.name,
    status: settings.status,
    pointNameSingular: settings.pointNameSingular,
    pointNamePlural: settings.pointNamePlural,
    killSwitchActive: settings.killSwitchActive,
    pointsExpiryWarningEnabled: settings.pointsExpiryWarningEnabled,
    pointsExpiryLastChanceEnabled: settings.pointsExpiryLastChanceEnabled,
    vipMilestoneMode: settings.vipMilestoneMode,
    vipTimeframe: settings.vipTimeframe,
    vipAutoDowngradeEnabled: settings.vipAutoDowngradeEnabled,
    parsedPointsPerCurrencyUnit: readPositiveDecimal(
      settings.pointsPerCurrencyUnit,
      "pointsPerCurrencyUnit",
    ),
    parsedHoldingPeriodDays: settings.holdingPeriodDays,
    parsedExpiryMonths: settings.pointsExpiryMonths,
    parsedExpiryDays: settings.pointsExpiryDays,
    parsedWarningDays: settings.pointsExpiryWarningDays,
    parsedLastChanceDays: settings.pointsExpiryLastChanceDays,
    parsedVipGraceDays: settings.vipDowngradeGraceDays,
    valuationFieldsPresent: settings.liabilityValuationCurrency !== undefined,
    normalizedValuationCurrency: settings.liabilityValuationCurrency,
    parsedLiabilityNumerator: readNullablePositiveBigInt(
      settings.liabilityMinorUnitsNumerator,
      "liabilityMinorUnitsNumerator",
    ),
    parsedLiabilityDenominator: readNullablePositiveBigInt(
      settings.liabilityPointsDenominator,
      "liabilityPointsDenominator",
    ),
  };
}
