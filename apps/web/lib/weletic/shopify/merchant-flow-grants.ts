import { Prisma } from "@prisma/client";
import { createWeleticId } from "../ids";
import {
  CreateFlowPointsGrantSchema,
  RevokeFlowPointsGrantSchema,
} from "../loyalty/flow-action-grant-contract";
import { readFlowGrantQuantities } from "../loyalty/flow-action-grant-storage";
import { lockLoyaltyProgramRow } from "../loyalty/program-write-fence";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

export class FlowGrantMutationError extends Error {
  constructor(
    readonly code: "state_changed" | "invalid_expiry" | "unavailable",
  ) {
    super(code);
    this.name = "FlowGrantMutationError";
  }
}

/** Signed merchant gateway only. Caller owns the Serializable transaction and
 * verifies HMAC over the complete envelope/input before entering this primitive.
 * Never authenticate separately or commit the action audit without the grant.
 */
export async function manageShopifyFlowGrantInTransaction({
  tx,
  envelope,
  operation,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  operation: "create" | "revoke";
  input: unknown;
}) {
  const parsed =
    operation === "create"
      ? CreateFlowPointsGrantSchema.parse(input)
      : RevokeFlowPointsGrantSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "loyalty.configure",
  });
  if (!actor.owner) throw new ShopifyStaffAuthorizationError("access_denied");
  if (parsed.expectedInstallationGeneration !== actor.installationGeneration)
    throw new FlowGrantMutationError("state_changed");
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId: actor.storeId,
    action: "flow_grant_manage",
    expectedInstallationGeneration: actor.installationGeneration,
  });
  // Store/session authority precedes program, and program precedes grant.
  // Revocation remains possible while the module is disabled or killed.
  await lockLoyaltyProgramRow({
    tx,
    storeId: actor.storeId,
    mode: operation === "create" ? "active" : "lock_only",
  });
  if (operation === "revoke") {
    const data = RevokeFlowPointsGrantSchema.parse(input);
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM WeleticShopifyFlowPointsGrant WHERE id = ${data.grantId}
      AND storeId = ${actor.storeId} AND appId = ${actor.appId}
      AND installationGeneration = ${actor.installationGeneration} FOR UPDATE`);
    if (rows.length !== 1) throw new FlowGrantMutationError("unavailable");
    const grant = await tx.weleticShopifyFlowPointsGrant.findUnique({
      where: { id: data.grantId },
    });
    if (
      !grant ||
      grant.storeId !== actor.storeId ||
      grant.appId !== actor.appId ||
      grant.installationGeneration !== actor.installationGeneration
    )
      throw new FlowGrantMutationError("unavailable");
    if (
      grant.revision !== data.expectedRevision ||
      grant.revokedAt ||
      grant.revision >= 2_147_483_647
    )
      throw new FlowGrantMutationError("state_changed");
    const now = await databaseNow(tx);
    const changed = await tx.weleticShopifyFlowPointsGrant.updateMany({
      where: {
        id: grant.id,
        storeId: actor.storeId,
        appId: actor.appId,
        installationGeneration: actor.installationGeneration,
        revision: data.expectedRevision,
        revokedAt: null,
      },
      data: {
        revision: { increment: 1 },
        revokedAt: now,
        revokedByShopifyUserId: actor.shopifyUserId,
        revokedMerchantActionId: actor.actionId,
      },
    });
    if (changed.count !== 1) throw new FlowGrantMutationError("state_changed");
    return {
      id: grant.id,
      revision: grant.revision + 1,
      revokedAt: now.toISOString(),
    };
  }
  const data = CreateFlowPointsGrantSchema.parse(input);
  const now = await databaseNow(tx);
  const expiresAt = new Date(data.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now)
    throw new FlowGrantMutationError("invalid_expiry");
  const grant = await tx.weleticShopifyFlowPointsGrant.create({
    data: {
      id: createWeleticId("wflowgrant_"),
      storeId: actor.storeId,
      appId: actor.appId,
      installationGeneration: actor.installationGeneration,
      revision: 1,
      allowCredit: data.allowCredit,
      allowDebit: data.allowDebit,
      maxAbsolutePointsPerAction: data.maxAbsolutePointsPerAction,
      absolutePointsBudget: data.absolutePointsBudget,
      absolutePointsUsed: "0",
      expiresAt,
      approvedByShopifyUserId: actor.shopifyUserId,
      approvedMerchantActionId: actor.actionId,
    },
  });
  // Validate the persisted representation before acknowledging authority.
  readFlowGrantQuantities(grant);
  return { id: grant.id, revision: grant.revision, revokedAt: null };
}

async function databaseNow(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  const now = rows[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new FlowGrantMutationError("unavailable");
  return now;
}
