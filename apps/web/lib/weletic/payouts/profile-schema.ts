import { WELETIC_LOCALES } from "@/lib/weletic/localization";
import { normalizeCurrency } from "@/lib/weletic/money";
import * as z from "zod/v4";

export const weleticPayoutProfileSchema = z.object({
  programId: z.string().min(1),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase()),
  payoutCurrency: z
    .string()
    .transform((value): string => normalizeCurrency(value)),
  provider: z.enum(["stripe_connect", "paypal", "bank_transfer", "manual"]),
  method: z.enum(["bank", "wallet", "paypal", "manual"]),
  taxResidencyCountry: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .nullish(),
  locale: z.enum(WELETIC_LOCALES).default("en"),
  details: z
    .object({
      accountLabel: z.string().max(100).optional(),
      accountLast4: z
        .string()
        .regex(/^\d{4}$/)
        .optional(),
      taxFormStatus: z.enum(["not_required", "pending", "verified"]).optional(),
    })
    .optional(),
});
