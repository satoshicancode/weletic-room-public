import { z } from "zod";
import { shopperDirectoryQuerySchema } from "./directory-query";
import { shopperProfileQuerySchema } from "./profile-query";
import { shopperSegmentSchema } from "./segment-query";

// Browser-safe contracts. Only filters and shopper IDs are accepted; store,
// workspace, app, staff and installation identity come from authentication.
const cursor = z.string().min(1).max(4096).optional();
export const merchantShopperListInputSchema = shopperSegmentSchema
  .safeExtend({ ...shopperDirectoryQuerySchema.shape, cursor })
  .strict();
export const merchantShopperProfileInputSchema = shopperProfileQuerySchema
  .extend({ cursor })
  .strict()
  .refine((input) => input.section !== "overview" || !input.cursor);

export type MerchantShopperListInput = z.input<
  typeof merchantShopperListInputSchema
>;
export type MerchantShopperProfileInput = z.input<
  typeof merchantShopperProfileInputSchema
>;
