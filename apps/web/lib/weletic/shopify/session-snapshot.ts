import { decrypt } from "@/lib/encryption";
import { integrationCredentialsSchema } from "@/lib/integrations/shopify/schema";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import type {
  ShopifySessionObservation,
  ShopifySessionSnapshot,
} from "./session-contract";
import { shopifySessionPropertiesSchema } from "./session-contract-validation";
import {
  observeShopifySessionCoordination,
  ShopifySessionCoordinationError,
  shopifySessionCoordinationId,
  type ShopifySessionScope,
} from "./session-coordination";
import type { LockedShopifySessionStore } from "./session-lifecycle-fence";
import {
  canonicalizeShopifyDomain,
  readShopifyCredentialTokenHash,
} from "./store-resolver";

export function configuredShopifySessionScope(
  shop: string,
): ShopifySessionScope {
  const scope = { appId: process.env.SHOPIFY_API_KEY?.trim() || "", shop };
  shopifySessionCoordinationId(scope);
  return scope;
}

/** Caller holds the lifecycle/store lock, then coordinator lock, in that order. */
export async function readShopifySessionSnapshot(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
  store: LockedShopifySessionStore | undefined,
): Promise<ShopifySessionSnapshot> {
  const observed = await observeShopifySessionCoordination(tx, scope);
  const rows = await tx.$queryRaw<
    Array<{ shop: string; payload: string; isOnline: boolean | number }>
  >(Prisma.sql`
    SELECT shop, payload, isOnline FROM WeleticShopifyAppSession
    WHERE id = ${`offline_${scope.shop}`} FOR UPDATE
  `);
  const row = rows[0];
  if (row && (row.shop !== scope.shop || Boolean(row.isOnline))) {
    throw new ShopifySessionCoordinationError("invalid_scope");
  }
  let credentialTokenHash: string | null = null;
  let hasInstallation = false;
  if (store) {
    if (!store.installationGeneration)
      throw new ShopifySessionCoordinationError("invalid_scope");
    const installations = await tx.installedIntegration.findMany({
      where: {
        projectId: store.projectId,
        integrationId: SHOPIFY_INTEGRATION_ID,
      },
      take: 2,
      orderBy: { id: "asc" },
      select: { credentials: true },
    });
    if (installations.length > 1)
      throw new ShopifySessionCoordinationError("invalid_scope");
    const installation = installations[0];
    if (installation) {
      hasInstallation = true;
      const credentials = integrationCredentialsSchema.safeParse(
        installation.credentials,
      );
      if (
        !credentials.success ||
        canonicalizeShopifyDomain(credentials.data.shop || "") !== scope.shop ||
        credentials.data.installationGeneration !== store.installationGeneration
      ) {
        throw new ShopifySessionCoordinationError("invalid_scope");
      }
      credentialTokenHash = readShopifyCredentialTokenHash(
        installation.credentials,
      );
    }
  }
  const parsed = row
    ? shopifySessionPropertiesSchema.parse(JSON.parse(decrypt(row.payload)))
    : null;
  if (parsed) {
    const values = Object.fromEntries(parsed);
    if (
      values.id !== `offline_${scope.shop}` ||
      values.shop !== scope.shop ||
      values.isOnline !== false
    ) {
      throw new ShopifySessionCoordinationError("invalid_scope");
    }
    // A snapshot must not convert an already-diverged SDK token into authority
    // to overwrite a newer projection. Token-less invalidations and absent
    // sessions may be exchanged again by authenticated SDK flows, but a present
    // access token must agree with its installed credential before network I/O.
    if (
      hasInstallation &&
      typeof values.accessToken === "string" &&
      values.accessToken &&
      createHash("sha256").update(values.accessToken).digest("hex") !==
        credentialTokenHash
    ) {
      throw new ShopifySessionCoordinationError("stale_session");
    }
  }
  return {
    observed: {
      ...observed,
      sessionDigest: createHash("sha256")
        .update(row ? `present:${row.payload}` : "missing")
        .digest("hex"),
      installationGeneration: store?.installationGeneration ?? null,
      credentialTokenHash,
    },
    properties: parsed,
  };
}

export function assertShopifySessionObservation(
  current: ShopifySessionObservation,
  original: ShopifySessionObservation,
) {
  // Epoch is checked by acquisition/publication separately. Merely reading a
  // session under another lease must not change the credential revision.
  if (
    current.revision !== original.revision ||
    current.sessionDigest !== original.sessionDigest ||
    current.installationGeneration !== original.installationGeneration ||
    current.credentialTokenHash !== original.credentialTokenHash
  ) {
    throw new ShopifySessionCoordinationError("stale_session");
  }
}
