import { decrypt } from "@/lib/encryption";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { lockShopifySessionLifecycle } from "./session-lifecycle-fence";
import { readShopifySessionPayload } from "./session-online-binding";
import { readOnlineSessionEvidence } from "./session-online-evidence";
import {
  configuredShopifySessionScope,
  readShopifySessionSnapshot,
} from "./session-snapshot";
import {
  isFreshShopifyMerchantActor,
  shopifyMerchantActorEnvelopeSchema,
  shopifyStaffPermissionSchema,
  staffGrantAllows,
  type ShopifyMerchantActorEnvelope,
  type ShopifyMerchantPermission,
} from "./staff-contract";

export class ShopifyStaffAuthorizationError extends Error {
  constructor(
    readonly code: "invalid_actor" | "access_denied" | "request_replayed",
  ) {
    super(code);
    this.name = "ShopifyStaffAuthorizationError";
  }
}

function scopedId(kind: string, parts: string[]) {
  return createHash("sha256")
    .update(JSON.stringify([kind, ...parts]))
    .digest("hex");
}

export function shopifyStaffGrantId(
  actor: Pick<
    ShopifyMerchantActorEnvelope,
    "storeId" | "appId" | "installationGeneration" | "userId"
  >,
) {
  return scopedId("staff-grant-v1", [
    actor.storeId,
    actor.appId,
    actor.installationGeneration,
    actor.userId,
  ]);
}

export type AuthorizedShopifyMerchant = {
  storeId: string;
  projectId: string;
  appId: string;
  installationGeneration: string;
  shopifyUserId: string;
  owner: boolean;
  permission: ShopifyMerchantPermission;
  grantRevision: number | null;
  actionId: string;
};

/** Internal primitive, NOT a request authenticator. Call only after verifying
 * the signature over the complete actor + operation body. The caller must run
 * its data change on this same tx and must not catch/recover inside the tx.
 * Neither this function nor an app owner bypasses business/financial gates.
 */
export async function authorizeShopifyMerchantInTransaction({
  tx,
  envelope,
  permission,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  permission: ShopifyMerchantPermission;
}): Promise<AuthorizedShopifyMerchant> {
  const parsed = shopifyMerchantActorEnvelopeSchema.safeParse(envelope);
  if (
    !parsed.success ||
    (permission !== "staff.manage" &&
      !shopifyStaffPermissionSchema.safeParse(permission).success)
  )
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const actor = parsed.data;
  const scope = configuredShopifySessionScope(actor.shop);
  if (scope.appId !== actor.appId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");

  // Same order as online publication and lifecycle cleanup. No network I/O
  // while these locks are held. Use a locking snapshot, not an earlier ORM read.
  const store = await lockShopifySessionLifecycle({
    tx,
    shop: actor.shop,
    storeId: actor.storeId,
  });
  if (!store || store.installationGeneration !== actor.installationGeneration)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const snapshot = await readShopifySessionSnapshot(tx, scope, store);
  if (
    !snapshot.observed.credentialTokenHash ||
    snapshot.observed.installationGeneration !== actor.installationGeneration
  )
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const rows = await tx.$queryRaw<
    Array<{
      payload: string;
      shop: string;
      isOnline: boolean | number;
      expiresAt: Date | null;
    }>
  >(Prisma.sql`
    SELECT payload, shop, isOnline, expiresAt FROM WeleticShopifyAppSession
    WHERE id = ${actor.sessionId} FOR UPDATE
  `);
  // Read the database clock AFTER lock waits, not the HTTP request's start time.
  const clocks = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  const now = clocks[0]?.now.getTime();
  const row = rows[0];
  if (
    !isFreshShopifyMerchantActor(actor, now) ||
    !row ||
    row.shop !== actor.shop ||
    !row.isOnline ||
    !row.expiresAt ||
    row.expiresAt.getTime() <= now ||
    createHash("sha256").update(row.payload).digest("hex") !==
      actor.sessionDigest
  )
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  let session: ReturnType<typeof readShopifySessionPayload>;
  try {
    session = readShopifySessionPayload(JSON.parse(decrypt(row.payload)));
  } catch {
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  }
  const binding = session.onlineBinding;
  const evidence = readOnlineSessionEvidence(session.properties);
  const values = Object.fromEntries(session.properties);
  if (
    !binding ||
    binding.appId !== actor.appId ||
    binding.storeId !== actor.storeId ||
    binding.shop !== actor.shop ||
    binding.installationGeneration !== actor.installationGeneration ||
    !evidence ||
    String(evidence.userId) !== actor.userId ||
    values.id !== actor.sessionId ||
    typeof values.expires !== "number" ||
    values.expires <= now
  )
    throw new ShopifyStaffAuthorizationError("invalid_actor");

  const owner = evidence.accountOwner && !evidence.collaborator;
  let grantRevision: number | null = null;
  if (!owner) {
    // Current read after the shared store lock also serializes grant/revoke.
    const grants = await tx.$queryRaw<
      Array<{ permissions: unknown; revision: number }>
    >(Prisma.sql`
      SELECT permissions, revision FROM WeleticShopifyStaffGrant
      WHERE id = ${shopifyStaffGrantId(actor)} AND storeId = ${actor.storeId}
        AND appId = ${actor.appId} AND installationGeneration = ${actor.installationGeneration}
        AND shopifyUserId = ${actor.userId} FOR UPDATE
    `);
    const grant = grants[0];
    if (
      !grant ||
      !Number.isSafeInteger(grant.revision) ||
      grant.revision < 1 ||
      !staffGrantAllows(grant.permissions, permission)
    )
      throw new ShopifyStaffAuthorizationError("access_denied");
    grantRevision = grant.revision;
  }

  const actionId = scopedId("merchant-action-v1", [
    actor.appId,
    actor.storeId,
    actor.installationGeneration,
    actor.requestId,
  ]);
  const prior = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyMerchantAction WHERE id = ${actionId} FOR UPDATE
  `);
  if (prior.length)
    throw new ShopifyStaffAuthorizationError("request_replayed");
  await tx.weleticShopifyMerchantAction.create({
    data: {
      id: actionId,
      storeId: actor.storeId,
      appId: actor.appId,
      installationGeneration: actor.installationGeneration,
      requestId: actor.requestId,
      shopifyUserId: actor.userId,
      owner,
      permission,
      grantRevision,
    },
  });
  return {
    storeId: store.id,
    projectId: store.projectId,
    appId: actor.appId,
    installationGeneration: actor.installationGeneration,
    shopifyUserId: actor.userId,
    owner,
    permission,
    grantRevision,
    actionId,
  };
}
