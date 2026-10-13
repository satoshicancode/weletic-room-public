import * as z from "zod/v4";
import { shopifyOnlineSessionBindingSchema } from "./session-online-binding";

export const shopifyMerchantOverviewInputSchema = z.object({}).strict();
export const shopifyStaffExportInputSchema = z
  .object({
    kind: z.enum(["grants", "actions"]),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(1024)
      .optional(),
  })
  .strict();
export const shopifyMerchantOverviewResponseSchema = z
  .object({
    shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    canManageStaff: z.boolean(),
    catalog: z
      .object({
        products: z.number().int().nonnegative(),
        markets: z.number().int().nonnegative(),
        syncStatus: z.enum(["pending", "running", "succeeded", "failed"]),
        lastSyncAt: z.iso.datetime().nullable(),
      })
      .strict(),
  })
  .strict();
export type ShopifyMerchantOverview = z.infer<
  typeof shopifyMerchantOverviewResponseSchema
>;

// Deliberately no wildcard, workspace, affiliate, payout, billing or release
// permission. Adding a capability requires an explicit server-side mapping.
export const SHOPIFY_STAFF_PERMISSIONS = [
  "overview.read",
  "customers.read",
  "loyalty.read",
  "loyalty.configure",
  "loyalty.adjust",
  "reviews.read",
  "reviews.moderate",
  "reviews.configure",
  "campaigns.configure",
  "appearance.configure",
  "analytics.read",
  "analytics.export",
  "settings.configure",
] as const;

export const shopifyStaffPermissionSchema = z.enum(SHOPIFY_STAFF_PERMISSIONS);
export type ShopifyStaffPermission = z.infer<
  typeof shopifyStaffPermissionSchema
>;
// Access administration is owner-only, never a delegable staff permission.
export type ShopifyMerchantPermission = ShopifyStaffPermission | "staff.manage";

export const shopifyStaffUserIdSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/)
  .refine((value) => Number.isSafeInteger(Number(value)));

export const shopifyStaffGrantPermissionsSchema = z
  .array(shopifyStaffPermissionSchema)
  .max(SHOPIFY_STAFF_PERMISSIONS.length)
  .refine((values) => new Set(values).size === values.length);

export const replaceShopifyStaffGrantSchema = z
  .object({
    userId: shopifyStaffUserIdSchema,
    expectedRevision: z.number().int().min(0).max(2_147_483_647),
    permissions: shopifyStaffGrantPermissionsSchema,
  })
  .strict();

export const listShopifyStaffGrantsSchema = z
  .object({
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict();

export const shopifyStaffGrantViewSchema = z
  .object({
    userId: z.string().min(1).max(20),
    permissions: shopifyStaffGrantPermissionsSchema,
    revision: z.number().int(),
    status: z.enum(["active", "revoked", "invalid"]),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .refine((row) =>
    row.status === "invalid"
      ? row.permissions.length === 0
      : shopifyStaffUserIdSchema.safeParse(row.userId).success &&
        row.revision > 0 &&
        (row.status === "active"
          ? row.permissions.length > 0
          : row.permissions.length === 0),
  );

export const shopifyStaffGrantListResponseSchema = z
  .object({
    grants: z.array(shopifyStaffGrantViewSchema).max(100),
    nextCursor: z
      .string()
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable(),
  })
  .strict();

export const shopifyStaffGrantSaveResponseSchema = z
  .object({
    grant: z
      .object({
        userId: shopifyStaffUserIdSchema,
        permissions: shopifyStaffGrantPermissionsSchema,
        revision: z.number().int().min(1).max(2_147_483_647),
      })
      .strict(),
  })
  .strict();

export type ShopifyStaffGrantView = z.infer<typeof shopifyStaffGrantViewSchema>;

/** The trusted app attests fresh exchange time, not owner/grant flags. This
 * entire envelope must be covered by the internal request signature. Parsing
 * it is NOT authentication: resolve the current encrypted session and grant
 * under the transaction's lifecycle lock before using it as an actor.
 */
export const shopifyMerchantActorEnvelopeSchema =
  shopifyOnlineSessionBindingSchema
    .extend({
      version: z.literal(1),
      userId: shopifyStaffUserIdSchema,
      sessionId: z.string().min(1).max(255),
      sessionDigest: z.string().regex(/^[a-f0-9]{64}$/),
      authenticatedAt: z.number().int().positive().max(8640000000000000),
      requestId: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict()
    .refine((value) => value.sessionId === `${value.shop}_${value.userId}`);

export type ShopifyMerchantActorEnvelope = z.infer<
  typeof shopifyMerchantActorEnvelopeSchema
>;

export const SHOPIFY_MERCHANT_ACTOR_MAX_AGE_MS = 60_000;

export function isFreshShopifyMerchantActor(
  actor: ShopifyMerchantActorEnvelope,
  now: number,
) {
  return (
    Number.isSafeInteger(now) &&
    now >= actor.authenticatedAt &&
    now - actor.authenticatedAt < SHOPIFY_MERCHANT_ACTOR_MAX_AGE_MS
  );
}

/** Missing, malformed and unknown stored permissions all fail closed. Empty
 * grants revoke access; there is no role-name or email-based fallback.
 */
export function staffGrantAllows(permissions: unknown, permission: unknown) {
  const parsed = shopifyStaffGrantPermissionsSchema.safeParse(permissions);
  const required = shopifyStaffPermissionSchema.safeParse(permission);
  return (
    parsed.success && required.success && parsed.data.includes(required.data)
  );
}
