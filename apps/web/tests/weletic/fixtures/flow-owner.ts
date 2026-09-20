import type { PrismaClient } from "@prisma/client";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { encrypt } from "../../../lib/encryption";
import { deriveAllShopifyShopPrivacyIdentities } from "../../../lib/weletic/shopify/privacy-identity";
import { bindShopifyOnlineSession } from "../../../lib/weletic/shopify/session-online-binding";
import { shopifyStaffGrantId } from "../../../lib/weletic/shopify/staff-authorization";

/** Synthetic session/credential fixture, never a live Shopify login. Caller
 * must validate the disposable database before invoking this helper.
 */
export async function seedFlowOwner(database: PrismaClient, owner = true) {
  const suffix = randomUUID();
  const storeId = `flow-owner-${suffix}`;
  const shop = `flow-${suffix}.myshopify.com`;
  const workspaceId = `workspace-${suffix}`;
  const appId = "flow-db-test";
  const installationGeneration = "g1";
  await database.weleticShopifyStore.create({
    data: {
      id: storeId,
      projectId: workspaceId,
      programId: `program-${suffix}`,
      shopDomain: shop,
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date(),
      apiVersion: "2026-07",
      installationGeneration,
      storeAccessState: "active",
    },
  });
  await database.weleticLoyaltyProgram.create({
    data: { id: `loyalty-${suffix}`, storeId },
  });
  await database.weleticShopifyPendingInstallation.create({
    data: {
      id: randomUUID(),
      appId,
      ...deriveAllShopifyShopPrivacyIdentities({ shopDomain: shop })[0],
      mappedStoreId: storeId,
      installationGeneration,
      state: "mapped",
      authenticatedAt: new Date(),
    },
  });
  await database.weleticShopifyInstallationCredential.create({
    data: {
      id: randomUUID(),
      storeId,
      appId,
      installationGeneration,
      revision: 1,
      credentialCiphertext: encrypt(
        JSON.stringify({
          version: 1,
          revision: 1,
          identity: {
            storeId,
            workspaceId,
            appId,
            shop,
            installationGeneration,
          },
          material: {
            accessToken: "synthetic-offline",
            scope: "read_products",
          },
        }),
      ),
    },
  });
  const binding = { storeId, appId, shop, installationGeneration };
  const userId = "123";
  const sessionId = `${shop}_${userId}`;
  const expiresAt = new Date(Date.now() + 3600000);
  const payload = encrypt(
    JSON.stringify(
      bindShopifyOnlineSession(
        [
          ["id", sessionId],
          ["shop", shop],
          ["isOnline", true],
          ["userId", 123],
          ["accountOwner", owner],
          ["collaborator", false],
          ["associatedUserScope", "read_products"],
          ["accessToken", "synthetic-online"],
          ["expires", expiresAt.getTime()],
        ],
        binding,
      ),
    ),
  );
  await database.weleticShopifyAppSession.create({
    data: { id: sessionId, shop, isOnline: true, payload, expiresAt },
  });
  const actor = {
    ...binding,
    version: 1 as const,
    userId,
    sessionId,
    sessionDigest: createHash("sha256").update(payload).digest("hex"),
    authenticatedAt: Date.now() - 1000,
    requestId: randomBytes(32).toString("hex"),
  };
  if (!owner)
    await database.weleticShopifyStaffGrant.create({
      data: {
        id: shopifyStaffGrantId(actor),
        storeId,
        appId,
        installationGeneration,
        shopifyUserId: userId,
        updatedByShopifyUserId: userId,
        permissions: ["loyalty.configure"],
        revision: 1,
      },
    });
  return { actor, storeId };
}
