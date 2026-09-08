import { z } from "zod";
import { loyaltyModuleToggleSchema } from "../loyalty/module-contract";
import { reviewModuleToggleSchema } from "../reviews/module-contract";
import {
  merchantAppearanceUpdateSchema,
  merchantSettingsUpdateSchema,
} from "./contracts";

export const merchantSettingsReadInputSchema = z.object({}).strict();
export const shopifyMerchantSettingsInputSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("appearance-read"),
        input: merchantSettingsReadInputSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("appearance-update"),
        input: merchantAppearanceUpdateSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("read"),
        input: merchantSettingsReadInputSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("update"),
        input: merchantSettingsUpdateSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("review-module"),
        input: reviewModuleToggleSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("loyalty-module"),
        input: loyaltyModuleToggleSchema,
      })
      .strict(),
  ],
);

// Explicit browser projection. No Prisma-generated types or server modules.
export const merchantSettingsCapabilitiesSchema = z
  .object({
    settings: z.boolean(),
    appearance: z.boolean(),
    loyalty: z.boolean(),
    reviews: z.boolean(),
  })
  .strict();
export const merchantSettingsResponseSchema = z
  .object({
    capabilities: merchantSettingsCapabilitiesSchema.optional(),
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    revision: z.number().int().min(0).max(2147483647),
    settings: z
      .object({
        brandName: z.string().max(100).nullable(),
        logoUrl: z.string().max(2048).nullable(),
        accentColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable(),
        defaultLocale: z.string().min(1).max(191),
        timeZone: z.string().max(100).nullable(),
        shopperEmailPaused: z.boolean(),
      })
      .strict(),
    branding: z
      .object({
        name: z.string().max(191),
        source: z.enum(["merchant", "legacy_loyalty", "default"]),
      })
      .strict(),
    modules: z
      .object({
        loyalty: z
          .object({
            status: z.enum([
              "draft",
              "test",
              "active",
              "disabled",
              "not_configured",
            ]),
            killSwitchActive: z.boolean(),
          })
          .strict(),
        reviews: z
          .object({
            enabled: z.boolean(),
            requestEmailEnabled: z.boolean(),
            updatedAt: z.string().datetime().nullable(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type MerchantSettingsView = z.infer<
  typeof merchantSettingsResponseSchema
>;

export const merchantAppearanceResponseSchema = merchantSettingsResponseSchema
  .pick({
    storeId: true,
    installationGeneration: true,
    revision: true,
    branding: true,
  })
  .extend({
    settings: merchantSettingsResponseSchema.shape.settings.pick({
      brandName: true,
      logoUrl: true,
      accentColor: true,
    }),
  })
  .strict();
export type MerchantAppearanceView = z.infer<
  typeof merchantAppearanceResponseSchema
>;

export const reviewModuleResponseSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    settings: merchantSettingsResponseSchema.shape.modules.shape.reviews,
  })
  .strict();

export const loyaltyModuleResponseSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    settings: merchantSettingsResponseSchema.shape.modules.shape.loyalty,
  })
  .strict();
