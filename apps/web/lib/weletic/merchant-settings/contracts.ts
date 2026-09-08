import { z } from "zod";

const cleanText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      (value) => !/[\u0000-\u001f\u007f]/.test(value),
      "Control characters are not allowed",
    );

export const merchantLogoUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    // Merchant-supplied public HTTPS images only. Never fetch these server-side.
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.hostname.includes(".") &&
      !/^[\d.]+$/.test(url.hostname) &&
      !url.hostname.includes(":") &&
      !/(^|\.)(localhost|local|internal|invalid|test)$/.test(url.hostname)
    );
  }, "Use a public HTTPS logo URL");

export const merchantTimeZoneSchema = cleanText(100).refine((value) => {
  // Require a named IANA zone (or UTC), never infer a zone from currency/locale.
  if (value !== "UTC" && !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(value))
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Use an IANA timezone");

const merchantSettingsFieldsSchema = z
  .object({
    brandName: cleanText(100).nullable().optional(),
    logoUrl: merchantLogoUrlSchema.nullable().optional(),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .transform((value) => value.toLowerCase())
      .nullable()
      .optional(),
    defaultLocale: z.enum(["en", "ja", "vi"]).optional(),
    timeZone: merchantTimeZoneSchema.nullable().optional(),
    shopperEmailPaused: z.boolean().optional(),
  })
  .strict();

export const merchantAppearancePatchSchema = merchantSettingsFieldsSchema
  .pick({ brandName: true, logoUrl: true, accentColor: true })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "At least one setting is required",
  );

export const merchantSettingsPatchSchema = merchantSettingsFieldsSchema.refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  "At least one setting is required",
);

export const merchantSettingsUpdateSchema = z
  .object({
    expectedRevision: z.number().int().min(0).max(2147483646),
    expectedInstallationGeneration: z.string().min(1).max(64),
    settings: merchantSettingsPatchSchema,
  })
  .strict();

export const merchantAppearanceUpdateSchema =
  merchantSettingsUpdateSchema.extend({
    settings: merchantAppearancePatchSchema,
  });
export type MerchantAppearanceUpdate = z.infer<
  typeof merchantAppearanceUpdateSchema
>;

export class MerchantSettingsError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "forbidden") {
    super(
      {
        not_found: "Merchant settings are unavailable for this workspace",
        conflict: "Settings changed. Reload before saving again",
        forbidden: "Only workspace owners may update shared merchant settings",
      }[code],
    );
    this.name = "MerchantSettingsError";
  }
}
export type MerchantSettingsUpdate = z.infer<
  typeof merchantSettingsUpdateSchema
>;
