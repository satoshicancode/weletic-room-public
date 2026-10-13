import { Prisma } from "@prisma/client";
import { ReviewError } from "../reviews/contracts";
import { withReviewMutation } from "../reviews/transaction";
import {
  appProxyObservationSchema,
  appProxyPathSchema,
  assertFreshAppProxyTimestamp,
} from "./app-proxy-contract";

/** The service endpoint accepts observations only from the authenticated proxy gateway. */
export async function observeAppProxyRoute(storeId: string, value: unknown) {
  const input = appProxyObservationSchema.parse(value);
  if (input.appId !== process.env.SHOPIFY_API_KEY?.trim())
    throw new ReviewError("unavailable", "App proxy identity mismatch");
  return withReviewMutation(storeId, async (tx, generation) => {
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
      Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
    );
    assertFreshAppProxyTimestamp(input.timestamp, clock.now);
    const installation = await tx.weleticShopifyPendingInstallation.findUnique({
      where: { mappedStoreId: storeId },
    });
    const store = await tx.weleticShopifyStore.findUniqueOrThrow({
      where: { id: storeId },
      select: { shopDomain: true },
    });
    const nativeInstallationIsCurrent = Boolean(
      generation &&
        installation &&
        installation.appId === input.appId &&
        installation.state === "mapped" &&
        !installation.uninstalledAt &&
        !installation.redactedAt &&
        installation.installationGeneration === generation &&
        installation.authenticatedAt &&
        input.timestamp * 1000 > installation.authenticatedAt.getTime(),
    );
    if (
      store.shopDomain !== input.shop ||
      (generation ? !nativeInstallationIsCurrent : Boolean(installation))
    )
      throw new ReviewError(
        "unavailable",
        "App proxy installation unavailable",
      );
    const key = { storeId, appId: input.appId };
    const existing = await tx.weleticShopifyAppProxyRoute.findUnique({
      where: { storeId_appId: key },
    });
    const observedAt = new Date(input.timestamp * 1000);
    if (
      existing?.installationGeneration === generation &&
      existing.pathPrefix === input.pathPrefix
    )
      return { recorded: false };
    if (
      existing?.installationGeneration === generation &&
      existing.observedAt >= observedAt
    ) {
      if (
        existing.observedAt.getTime() === observedAt.getTime() &&
        existing.pathPrefix !== input.pathPrefix
      )
        throw new ReviewError(
          "unavailable",
          "Conflicting app proxy observations",
        );
      return { recorded: false };
    }
    const data = {
      installationGeneration: generation,
      pathPrefix: input.pathPrefix,
      observedAt,
    };
    await tx.weleticShopifyAppProxyRoute.upsert({
      where: { storeId_appId: key },
      create: { ...key, ...data },
      update: data,
    });
    return { recorded: true };
  });
}

/** Called inside the locked delivery transaction, before preparing a NEW snapshot. */
export async function readReviewInvitationPath(
  tx: Prisma.TransactionClient,
  storeId: string,
  generation: string | null,
) {
  const appId = process.env.SHOPIFY_API_KEY?.trim();
  if (!appId)
    throw new ReviewError(
      "unavailable",
      "Storefront route requires verification",
    );
  const route = await tx.weleticShopifyAppProxyRoute.findUnique({
    where: { storeId_appId: { storeId, appId } },
  });
  if (!route || route.installationGeneration !== generation)
    throw new ReviewError(
      "unavailable",
      "Storefront route requires verification",
    );
  return appProxyPathSchema.parse(route.pathPrefix);
}
