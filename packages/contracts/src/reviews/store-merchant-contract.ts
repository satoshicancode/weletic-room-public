import * as z from "zod/v4";

export const storeMerchantListInputSchema = z
  .object({
    status: z.enum(["pending", "published", "hidden", "rejected"]).optional(),
    rating: z.number().int().min(1).max(5).optional(),
    limit: z.number().int().min(1).max(50).default(20),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();

export const storeMerchantListResponseSchema = z
  .object({
    enabled: z.boolean(),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(191),
            version: z.number().int().positive(),
            status: z.enum(["pending", "published", "hidden", "rejected"]),
            rating: z.number().int().min(1).max(5),
            title: z.string().max(120),
            body: z.string().max(10000),
            displayName: z.string().max(80),
            merchantReply: z.string().max(5000).nullable(),
            verifiedPurchase: z.boolean(),
            incentivized: z.boolean(),
            createdAt: z.string().datetime(),
            canModerate: z.boolean(),
          })
          .strict(),
      )
      .max(50),
    nextCursor: z.string().min(1).max(4096).nullable(),
  })
  .strict();

export type StoreMerchantListInput = z.input<
  typeof storeMerchantListInputSchema
>;
export type StoreMerchantListPage = z.infer<
  typeof storeMerchantListResponseSchema
>;
