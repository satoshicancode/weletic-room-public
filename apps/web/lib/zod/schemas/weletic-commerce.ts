import { WELETIC_LOCALES } from "@/lib/weletic/localization";
import { normalizeCurrency } from "@/lib/weletic/money";
import {
  WeleticCommissionRuleType,
  WeleticCommissionScope,
  WeleticFixedAmountMode,
} from "@prisma/client";
import * as z from "zod/v4";

export const weleticCatalogQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  marketId: z.string().optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .optional(),
  locale: z.enum(WELETIC_LOCALES).default("en"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const createWeleticProductLinkSchema = z.object({
  variantId: z.string().optional(),
  marketId: z.string().optional(),
  countryCode: z
    .string()
    .trim()
    .length(2)
    .transform((value) => value.toUpperCase())
    .optional(),
  locale: z.enum(WELETIC_LOCALES).default("en"),
  subId: z.string().trim().min(1).max(100).optional(),
  subId1: z.string().trim().max(100).optional(),
  subId2: z.string().trim().max(100).optional(),
  subId3: z.string().trim().max(100).optional(),
  subId4: z.string().trim().max(100).optional(),
  subId5: z.string().trim().max(100).optional(),
  key: z.string().trim().min(1).max(190).optional(),
});

export const createWeleticCommissionRuleSchema = z
  .object({
    logicalKey: z.string().trim().min(1).max(100).optional(),
    scope: z.enum(WeleticCommissionScope),
    ruleType: z.enum(WeleticCommissionRuleType),
    fixedAmountMode: z.enum(WeleticFixedAmountMode).default("line"),
    priority: z.number().int().min(-1000).max(1000).default(0),
    collectionExternalId: z.string().nullish(),
    partnerId: z.string().nullish(),
    productId: z.string().nullish(),
    variantId: z.string().nullish(),
    promotionCode: z.string().trim().min(1).max(100).nullish(),
    tag: z.string().trim().min(1).max(100).nullish(),
    basisPoints: z.number().int().min(0).max(100_000).nullish(),
    fixedAmount: z.coerce.bigint().min(BigInt(0)).nullish(),
    currency: z
      .string()
      .transform((value): string => normalizeCurrency(value))
      .nullish(),
    minOrderAmount: z.coerce.bigint().min(BigInt(0)).nullish(),
    maxCommissionAmount: z.coerce.bigint().min(BigInt(0)).nullish(),
    effectiveAt: z.coerce.date().default(() => new Date()),
    expiresAt: z.coerce.date().nullish(),
  })
  .superRefine((value, ctx) => {
    const scopeField: Partial<
      Record<WeleticCommissionScope, keyof typeof value>
    > = {
      collection: "collectionExternalId",
      partner: "partnerId",
      product: "productId",
      variant: "variantId",
      promotion: "promotionCode",
      tag: "tag",
    };
    const requiredField = scopeField[value.scope];
    if (requiredField && !value[requiredField]) {
      ctx.addIssue({
        code: "custom",
        path: [requiredField],
        message: `${requiredField} is required for ${value.scope} rules`,
      });
    }
    if (value.ruleType === "percentage" && value.basisPoints == null) {
      ctx.addIssue({
        code: "custom",
        path: ["basisPoints"],
        message: "basisPoints is required for percentage rules",
      });
    }
    if (value.ruleType === "fixed" && value.fixedAmount == null) {
      ctx.addIssue({
        code: "custom",
        path: ["fixedAmount"],
        message: "fixedAmount is required for fixed rules",
      });
    }
    if (value.expiresAt && value.expiresAt <= value.effectiveAt) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "expiresAt must be after effectiveAt",
      });
    }
  });
