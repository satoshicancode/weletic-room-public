import * as z from "zod/v4";

const moneySchema = z.object({
  amount: z.string(),
  currency_code: z.string(),
});

const moneySetSchema = z.object({
  shop_money: moneySchema.describe("Amount in the Shopify shop currency."),
  presentment_money: moneySchema.optional(),
});

export const orderSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  created_at: z.string().optional(),
  processed_at: z.string().nullish(),
  financial_status: z.string().nullish(),
  confirmation_number: z.string(),
  checkout_token: z.string(),
  email: z.string().nullish(),
  contact_email: z.string().nullish(),
  customer: z
    .object({
      id: z.number(),
      email: z.string().nullish(),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
    })
    .nullish(),
  current_subtotal_price_set: moneySetSchema,
  current_total_discounts_set: moneySetSchema.optional(),
  current_total_price_set: moneySetSchema.optional(),
  current_total_tax_set: moneySetSchema.optional(),
  total_shipping_price_set: moneySetSchema.optional(),
  line_items: z
    .array(
      z.object({
        id: z.number(),
        product_id: z.number().nullish(),
        variant_id: z.number().nullish(),
        sku: z.string().nullish(),
        title: z.string(),
        quantity: z.number().int().positive(),
        price_set: moneySetSchema,
        total_discount_set: moneySetSchema.optional(),
      }),
    )
    .default([]),
  discount_codes: z.array(
    z.object({
      code: z.string().describe("The code of the discount."),
    }),
  ),
  billing_address: z
    .object({
      province: z.string().nullish(),
      country_code: z.string().nullish(),
    })
    .nullish(),
});

export const refundSchema = z.object({
  id: z.number(),
  order_id: z.number(),
  created_at: z.string(),
  refund_line_items: z.array(
    z.object({
      id: z.number(),
      line_item_id: z.number(),
      quantity: z.number().int().positive(),
      subtotal_set: moneySetSchema,
    }),
  ),
});

export const integrationCredentialsSchema = z.object({
  accessToken: z
    .string()
    .nullish()
    .describe("Encrypted access token for the Shopify store."),
  scope: z.string().nullish().describe("Scope of the Shopify store."),
  shop: z.string().nullish().describe("Shop domain of the Shopify store."),
  installationGeneration: z
    .string()
    .min(1)
    .max(64)
    .nullish()
    .describe(
      "Immutable generation shared with the retained Shopify store for this credential installation.",
    ),
  shopVerifiedAt: z
    .string()
    .nullish()
    .describe("When Shopify last verified the token's canonical shop domain."),
  shopVerificationTokenHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullish()
    .describe("SHA-256 binding between the verified shop and access token."),
});
