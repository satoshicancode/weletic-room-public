import { DubApiError } from "@/lib/api/errors";
import { Prisma } from "@prisma/client";
import { ShopifyCredentialUnavailableError } from "./credential-errors";
import { readPendingInstallation } from "./installation-admission";
import { deriveAllShopifyShopPrivacyIdentities } from "./privacy-identity";
import {
  ensureShopifySessionCoordination,
  shopifySessionCoordinationId,
} from "./session-coordination";
import { assertLegacyShopifyCredentialAuthority } from "./store-owned-credential";

/** The workspace's pasted-token callback is legacy-only. Check before remote
 * verification and again inside the final write transaction. Normal public-app
 * authentication belongs to coordinated Shopify SDK publication, not this API.
 */
export async function lockLegacyShopifyConnection(
  tx: Prisma.TransactionClient,
  input: { workspaceId: string; shop: string },
) {
  const scope = {
    appId: process.env.SHOPIFY_API_KEY?.trim() || "",
    shop: input.shop,
  };
  shopifySessionCoordinationId(scope);
  const stores = await tx.$queryRaw<
    Array<{ id: string; projectId: string; shopDomain: string }>
  >(Prisma.sql`
    SELECT id, projectId, shopDomain FROM WeleticShopifyStore
    WHERE shopDomain = ${input.shop} OR projectId = ${input.workspaceId}
    ORDER BY id LIMIT 2 FOR UPDATE
  `);
  if (
    stores.length > 1 ||
    stores.some(
      (store) =>
        store.projectId !== input.workspaceId ||
        store.shopDomain !== input.shop,
    )
  )
    throw new DubApiError({
      code: "conflict",
      message: "The Shopify store binding changed. Reload the connection.",
    });
  const predicates = deriveAllShopifyShopPrivacyIdentities({
    shopDomain: input.shop,
  }).map(
    ({ identityKeyId, shopDomainDigest }) =>
      Prisma.sql`(identityKeyId = ${identityKeyId} AND shopDomainDigest = ${shopDomainDigest})`,
  );
  const tombstones = predicates.length
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM WeleticShopifyShopPrivacyTombstone
        WHERE expiresAt > CURRENT_TIMESTAMP(3) AND (${Prisma.join(predicates, " OR ")})
        LIMIT 1 FOR UPDATE
      `)
    : [];
  if (tombstones.length)
    throw new DubApiError({
      code: "conflict",
      message:
        "This Shopify domain is retained by a redacted privacy lifecycle.",
    });
  // Anchor absent admissions too, so first public authentication cannot pass
  // between the final absence check and a legacy credential write.
  await ensureShopifySessionCoordination(tx, scope);
  const admission = await readPendingInstallation(tx, scope);
  const managedConnectionError = () =>
    new DubApiError({
      code: "conflict",
      message:
        "This installation is managed by Shopify. Open the app in Shopify Admin to authenticate or reconnect.",
    });
  if (admission) throw managedConnectionError();
  if (stores[0]) {
    try {
      await assertLegacyShopifyCredentialAuthority(
        tx,
        stores[0].id,
        scope.appId,
      );
    } catch (error) {
      if (error instanceof ShopifyCredentialUnavailableError)
        throw managedConnectionError();
      throw error;
    }
  }
}
