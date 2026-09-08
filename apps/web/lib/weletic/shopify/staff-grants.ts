import { Prisma } from "@prisma/client";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
  shopifyStaffGrantId,
} from "./staff-authorization";
import { replaceShopifyStaffGrantSchema } from "./staff-contract";
export { replaceShopifyStaffGrantSchema } from "./staff-contract";

export class ShopifyStaffGrantConflictError extends Error {
  constructor() {
    super("Shopify staff grant changed; reload before saving");
    this.name = "ShopifyStaffGrantConflictError";
  }
}

/** Call inside the signed gateway transaction. A fresh Shopify owner can
 * replace/revoke a bounded store grant; staff can never delegate authority.
 */
export async function replaceShopifyStaffGrantInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  const data = replaceShopifyStaffGrantSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "staff.manage",
  });
  // Do not plant an automatic staff fallback for the current owner after transfer.
  if (data.userId === actor.shopifyUserId)
    throw new ShopifyStaffAuthorizationError("access_denied");
  const id = shopifyStaffGrantId({ ...actor, userId: data.userId });
  const rows = await tx.$queryRaw<Array<{ revision: number }>>(Prisma.sql`
    SELECT revision FROM WeleticShopifyStaffGrant WHERE id = ${id} FOR UPDATE
  `);
  const previousRevision = rows[0]?.revision ?? 0;
  if (previousRevision !== data.expectedRevision)
    throw new ShopifyStaffGrantConflictError();
  // Exhaustion must never prevent revocation. A terminal revision may only
  // transition to (or remain) empty; it cannot later restore permissions.
  if (previousRevision === 2_147_483_647 && data.permissions.length > 0)
    throw new ShopifyStaffGrantConflictError();
  const revision = Math.min(2_147_483_647, previousRevision + 1);
  await tx.weleticShopifyStaffGrant.upsert({
    where: { id },
    create: {
      id,
      storeId: actor.storeId,
      appId: actor.appId,
      installationGeneration: actor.installationGeneration,
      shopifyUserId: data.userId,
      permissions: data.permissions,
      revision,
      updatedByShopifyUserId: actor.shopifyUserId,
    },
    update: {
      permissions: data.permissions,
      revision,
      updatedByShopifyUserId: actor.shopifyUserId,
    },
  });
  await tx.weleticShopifyMerchantAction.update({
    where: { id: actor.actionId },
    data: {
      targetShopifyUserId: data.userId,
      changedPermissions: data.permissions,
      changedGrantRevision: revision,
    },
  });
  return { userId: data.userId, revision, permissions: data.permissions };
}
