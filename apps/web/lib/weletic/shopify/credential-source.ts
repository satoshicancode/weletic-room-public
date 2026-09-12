import { prisma } from "@/lib/prisma";
import { ShopifyCredentialUnavailableError } from "./credential-errors";
import { readPendingInstallation } from "./installation-admission";
import {
  observeShopifySessionCoordination,
  ShopifySessionCoordinationError,
  shopifySessionCoordinationId,
} from "./session-coordination";
import {
  lockShopifySessionLifecycle,
  SessionCredentialWriteBlockedError,
} from "./session-lifecycle-fence";
import {
  assertLegacyShopifyCredentialAuthority,
  readStoreOwnedShopifyCredential,
} from "./store-owned-credential";

/** Internal credential selection, not caller authorization. No caching, token
 * exchange, or legacy fallback after a public admission/credential failure.
 * Frozen cleanup must use a separately authorized reader, never this one.
 */
export async function readShopifyCredentialSource(input: {
  storeId: string;
  workspaceId: string;
  shop: string;
  installationGeneration: string | null;
}) {
  const scope = {
    appId: process.env.SHOPIFY_API_KEY?.trim() || "",
    shop: input.shop,
  };
  shopifySessionCoordinationId(scope);
  try {
    return await prisma.$transaction(async (tx) => {
      const store = await lockShopifySessionLifecycle({
        tx,
        shop: input.shop,
        storeId: input.storeId,
      });
      if (
        !store ||
        store.projectId !== input.workspaceId ||
        store.installationGeneration !== input.installationGeneration
      )
        throw new ShopifyCredentialUnavailableError(
          "Shopify credential store identity changed",
        );
      await observeShopifySessionCoordination(tx, scope);
      const admission = await readPendingInstallation(tx, scope);
      if (!admission) {
        await assertLegacyShopifyCredentialAuthority(tx, store.id, scope.appId);
        return { source: "legacy" as const };
      }
      if (!store.installationGeneration)
        throw new ShopifyCredentialUnavailableError(
          "Public Shopify installation generation is missing",
        );
      const credential = await readStoreOwnedShopifyCredential(tx, {
        ...scope,
        storeId: store.id,
        workspaceId: store.projectId,
        installationGeneration: store.installationGeneration,
      });
      if (!credential)
        throw new ShopifyCredentialUnavailableError(
          "Public Shopify installation requires fresh authentication",
        );
      return {
        source: "native" as const,
        ...credential,
        installationGeneration: store.installationGeneration,
      };
    });
  } catch (error) {
    if (
      error instanceof SessionCredentialWriteBlockedError ||
      error instanceof ShopifySessionCoordinationError
    )
      throw new ShopifyCredentialUnavailableError(
        "Shopify credential lifecycle requires authentication review",
      );
    // Preserve database outages/timeouts for operational retry handling.
    throw error;
  }
}
