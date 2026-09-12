import { z } from "zod";
import {
  LOYALTY_LAUNCHER_ICONS,
  LOYALTY_LAUNCHER_POSITIONS,
  parseLoyaltyBrandingInput,
} from "./branding";

const text = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
const color = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toLowerCase());

// Full replacement of the existing nine-field projection. Never accept store,
// program, ownership, HTML, or arbitrary metadata from an appearance editor.
export const loyaltyAppearanceBrandingSchema = z
  .object({
    launcherText: text(40).refine((value) => value.length > 0),
    launcherPosition: z.enum(LOYALTY_LAUNCHER_POSITIONS),
    launcherIcon: z.enum(LOYALTY_LAUNCHER_ICONS),
    primaryColor: color,
    headerTextColor: color,
    panelTitle: text(100).refine((value) => value.length > 0),
    panelWelcomeSubtitle: text(300),
    heroImageUrl: z.string().trim().max(2048).nullable(),
    enableFloatingLauncher: z.boolean(),
  })
  .strict()
  .superRefine((branding, context) => {
    try {
      parseLoyaltyBrandingInput(branding);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["heroImageUrl"],
        message: "Use an HTTPS image URL without embedded credentials",
      });
    }
  })
  .transform((branding) => parseLoyaltyBrandingInput(branding));

const revision = z.string().regex(/^[a-f0-9]{64}$/);

// Existing workspace branding allowed embedded whitespace. Preserve it on reads
// so the merchant can repair it; new saves still use the stricter schema above.
const storedBrandingSchema = z
  .object({
    launcherText: z.string().max(40),
    launcherPosition: z.enum(LOYALTY_LAUNCHER_POSITIONS),
    launcherIcon: z.enum(LOYALTY_LAUNCHER_ICONS),
    primaryColor: color,
    headerTextColor: color,
    panelTitle: z.string().max(100),
    panelWelcomeSubtitle: z.string().max(300),
    heroImageUrl: z.string().max(2048).nullable(),
    enableFloatingLauncher: z.boolean(),
  })
  .strict()
  .superRefine((branding, context) => {
    try {
      parseLoyaltyBrandingInput(branding);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid stored appearance",
      });
    }
  })
  .transform((branding) => parseLoyaltyBrandingInput(branding));
export const loyaltyAppearanceRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z.object({ operation: z.literal("read") }).strict(),
    z
      .object({
        operation: z.literal("save"),
        expectedInstallationGeneration: z.string().min(1).max(64),
        expectedRevision: revision,
        branding: loyaltyAppearanceBrandingSchema,
      })
      .strict(),
  ],
);

export const loyaltyAppearanceResponseSchema = z
  .object({
    storeId: z.string().min(1),
    installationGeneration: z.string().min(1).max(64),
    revision,
    programConfigured: z.boolean(),
    branding: storedBrandingSchema,
    capabilities: z.object({ configure: z.boolean() }).strict(),
  })
  .strict();

export type LoyaltyAppearanceRequest = z.infer<
  typeof loyaltyAppearanceRequestSchema
>;
export type LoyaltyAppearanceResponse = z.infer<
  typeof loyaltyAppearanceResponseSchema
>;

export function verifyLoyaltyAppearanceResponse(
  request: LoyaltyAppearanceRequest,
  value: unknown,
): LoyaltyAppearanceResponse {
  const result = loyaltyAppearanceResponseSchema.parse(value);
  if (
    request.operation === "save" &&
    (result.installationGeneration !== request.expectedInstallationGeneration ||
      result.revision === request.expectedRevision ||
      !result.programConfigured ||
      !result.capabilities.configure ||
      JSON.stringify(result.branding) !==
        JSON.stringify(loyaltyAppearanceBrandingSchema.parse(request.branding)))
  )
    throw new Error("Appearance acknowledgement unavailable");
  return result;
}
