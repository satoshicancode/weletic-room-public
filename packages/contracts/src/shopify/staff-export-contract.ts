import * as z from "zod/v4";
import {
  SHOPIFY_STAFF_PERMISSIONS,
  shopifyStaffGrantPermissionsSchema,
} from "./staff-contract";

export const STAFF_EXPORT_CONSISTENCY =
  "created-before-boundary; grant updates may change between pages" as const;
const generation = z.string().min(1).max(64);
const rowBase = z.object({
  id: z.string().min(1).max(64),
  installationGeneration: generation,
  shopifyUserId: z.string().min(1).max(20),
  createdAt: z.iso.datetime(),
});
const revision = z.number().int().min(-2_147_483_648).max(2_147_483_647);
const base = z.object({
  version: z.literal(1),
  currentInstallationGeneration: generation,
  createdBefore: z.iso.datetime(),
  consistency: z.literal(STAFF_EXPORT_CONSISTENCY),
  nextCursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(1024)
    .nullable(),
});
export const shopifyStaffExportResponseSchema = z.discriminatedUnion("kind", [
  base
    .extend({
      kind: z.literal("grants"),
      rows: z
        .array(
          rowBase
            .extend({
              permissions: shopifyStaffGrantPermissionsSchema.nullable(),
              revision,
              updatedByShopifyUserId: z.string().min(1).max(20),
              updatedAt: z.iso.datetime(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
  base
    .extend({
      kind: z.literal("actions"),
      rows: z
        .array(
          rowBase
            .extend({
              owner: z.boolean(),
              permission: z
                .enum(["staff.manage", ...SHOPIFY_STAFF_PERMISSIONS])
                .nullable(),
              grantRevision: revision.nullable(),
              targetShopifyUserId: z.string().min(1).max(20).nullable(),
              changedPermissions: shopifyStaffGrantPermissionsSchema.nullable(),
              changedGrantRevision: revision.nullable(),
            })
            .strict(),
        )
        .max(100),
    })
    .strict(),
]);
export type ShopifyStaffExportPage = z.infer<
  typeof shopifyStaffExportResponseSchema
>;
