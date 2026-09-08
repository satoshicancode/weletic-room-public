import type { Prisma } from "@prisma/client";
import {
  shopifyStaffGrantId,
  type AuthorizedShopifyMerchant,
} from "./staff-authorization";
import { staffGrantAllows } from "./staff-contract";

/** UI hints only. The caller has already authorized and locked the current
 * installation; each mutation must still enforce its own required permission.
 */
export async function readSettingsCapabilities(
  tx: Prisma.TransactionClient,
  actor: AuthorizedShopifyMerchant,
) {
  const grant = actor.owner
    ? null
    : await tx.weleticShopifyStaffGrant.findUnique({
        where: {
          id: shopifyStaffGrantId({
            storeId: actor.storeId,
            appId: actor.appId,
            installationGeneration: actor.installationGeneration,
            userId: actor.shopifyUserId,
          }),
        },
        select: { permissions: true, revision: true },
      });
  const allowed = (
    permission:
      | "settings.configure"
      | "appearance.configure"
      | "loyalty.configure"
      | "reviews.configure",
  ) =>
    actor.owner ||
    Boolean(
      grant &&
        grant.revision === actor.grantRevision &&
        staffGrantAllows(grant.permissions, permission),
    );
  return {
    settings: allowed("settings.configure"),
    appearance: allowed("appearance.configure"),
    loyalty: allowed("loyalty.configure"),
    reviews: allowed("reviews.configure"),
  };
}
