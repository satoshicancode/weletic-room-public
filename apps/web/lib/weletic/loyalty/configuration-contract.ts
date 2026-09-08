import { z } from "zod";

const label = z
  .string()
  .trim()
  .min(1)
  .max(191)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const currency = z.string().regex(/^[A-Z]{3}$/);
const positiveIntegerString = z
  .string()
  .max(19)
  .regex(/^[1-9]\d*$/)
  .refine(
    (value) => value.length < 19 || value <= "9223372036854775807",
    "Valuation exceeds the signed-64-bit range",
  );

/** New embedded inputs must fit the existing Decimal(10,4) column exactly.
 * Legacy workspace coercion remains a separate compatibility boundary.
 */
export const loyaltyConfigurationRateSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/)
  .refine((value) => /[1-9]/.test(value), "Rate must be positive");

export const loyaltyConfigurationFieldsSchema = z
  .object({
    name: label,
    status: z.enum(["draft", "test", "active", "disabled"]),
    pointNameSingular: label,
    pointNamePlural: label,
    pointsPerCurrencyUnit: loyaltyConfigurationRateSchema,
    holdingPeriodDays: z.number().int().min(0).max(365),
    pointsExpiryMonths: z.number().int().min(0).max(24),
    pointsExpiryDays: z.number().int().min(0).max(730),
    pointsExpiryWarningDays: z.number().int().min(0).max(730),
    pointsExpiryLastChanceDays: z.number().int().min(0).max(730),
    pointsExpiryWarningEnabled: z.boolean(),
    pointsExpiryLastChanceEnabled: z.boolean(),
    killSwitchActive: z.boolean(),
    vipMilestoneMode: z.enum(["amount_spent", "points_earned", "both"]),
    vipTimeframe: z.enum(["rolling_12m", "calendar_year", "lifetime"]),
    vipDowngradeGraceDays: z.number().int().min(0).max(365),
    vipAutoDowngradeEnabled: z.boolean(),
    liabilityValuationCurrency: currency.nullable(),
    liabilityMinorUnitsNumerator: positiveIntegerString.nullable(),
    liabilityPointsDenominator: positiveIntegerString.nullable(),
  })
  .strict();

const valuationKeys = [
  "liabilityValuationCurrency",
  "liabilityMinorUnitsNumerator",
  "liabilityPointsDenominator",
] as const;

export const loyaltyConfigurationPatchSchema = loyaltyConfigurationFieldsSchema
  .partial()
  .superRefine((value, context) => {
    if (!Object.values(value).some((field) => field !== undefined))
      context.addIssue({
        code: "custom",
        message: "Provide a setting to update",
      });
    const valuation = valuationKeys.map((key) => value[key]);
    if (valuation.some((field) => field !== undefined)) {
      const complete = valuation.every((field) => field !== undefined);
      const allNull = valuation.every((field) => field === null);
      const allConfigured = valuation.every(
        (field) => field !== undefined && field !== null,
      );
      if (!complete || (!allNull && !allConfigured))
        context.addIssue({
          code: "custom",
          message: "Configure or clear all three valuation fields together",
        });
    }
    if (
      (value.pointsExpiryDays ?? 0) > 0 &&
      (value.pointsExpiryMonths ?? 0) > 0
    )
      context.addIssue({
        code: "custom",
        message: "Choose days or months for expiry, not both",
      });
    // Checks involving omitted fields require the current program and belong
    // to the existing writer, inside the authorized transaction.
  });

const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const loyaltyConfigurationUpdateSchema = z
  .object({
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: revision.nullable(),
    settings: loyaltyConfigurationPatchSchema,
  })
  .strict();

export const shopifyLoyaltyConfigurationInputSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("read") }).strict(),
    z
      .object({
        operation: z.literal("update"),
        input: loyaltyConfigurationUpdateSchema,
      })
      .strict(),
  ],
);

export const loyaltyConfigurationResponseSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    accountingCurrency: currency,
    configurationRevision: revision.nullable(),
    program: z
      .object({
        id: z.string().min(1).max(191),
        settings: loyaltyConfigurationFieldsSchema,
      })
      .strict()
      .nullable(),
    capabilities: z
      .object({ configure: z.boolean(), owner: z.boolean() })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      (value.program === null) === (value.configurationRevision === null),
    "Configuration revision must identify the returned program",
  );

export type LoyaltyConfigurationPatch = z.infer<
  typeof loyaltyConfigurationPatchSchema
>;
export type LoyaltyConfigurationUpdate = z.infer<
  typeof loyaltyConfigurationUpdateSchema
>;
export type LoyaltyConfigurationResponse = z.infer<
  typeof loyaltyConfigurationResponseSchema
>;

export function requiresLoyaltyConfigurationOwner(
  settings: LoyaltyConfigurationPatch,
) {
  return (
    settings.status !== undefined ||
    settings.killSwitchActive !== undefined ||
    valuationKeys.some((key) => settings[key] !== undefined)
  );
}
