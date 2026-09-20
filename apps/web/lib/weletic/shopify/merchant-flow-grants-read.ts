import { Prisma } from "@prisma/client";
import { ListFlowPointsGrantsSchema } from "../loyalty/flow-action-grant-contract";
import { readFlowGrantQuantities } from "../loyalty/flow-action-grant-storage";
import { FlowGrantMutationError } from "./merchant-flow-grants";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";

/** Signed merchant read, not public grant discovery. Caller retains the same
 * transaction as authorization. Reads never mint an action audit or authority.
 * An empty recovery result is not permission to automatically resubmit a write.
 */
export async function readShopifyFlowGrantsInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  const query = ListFlowPointsGrantsSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "loyalty.configure",
    recordAction: false,
  });
  if (!actor.owner) throw new ShopifyStaffAuthorizationError("access_denied");
  if (query.expectedInstallationGeneration !== actor.installationGeneration)
    throw new FlowGrantMutationError("state_changed");
  const scope = {
    storeId: actor.storeId,
    appId: actor.appId,
    installationGeneration: actor.installationGeneration,
  };
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new FlowGrantMutationError("unavailable");
  const result = <T>(grants: T[], nextCursor: string | null = null) => ({
    grants,
    nextCursor,
    installationGeneration: actor.installationGeneration,
    observedAt: now.toISOString(),
  });
  let approvedMerchantActionId: string | undefined;
  if (query.approvalRequestId) {
    const actions = await tx.weleticShopifyMerchantAction.findMany({
      where: {
        ...scope,
        requestId: query.approvalRequestId,
        owner: true,
        permission: "loyalty.configure",
      },
      select: { id: true },
      take: 2,
    });
    if (actions.length === 0) return result([]);
    if (actions.length !== 1) throw new FlowGrantMutationError("unavailable");
    approvedMerchantActionId = actions[0].id;
  }
  let boundary: { createdAt: Date; id: string } | null = null;
  if (query.cursor) {
    boundary = await tx.weleticShopifyFlowPointsGrant.findFirst({
      where: { ...scope, id: query.cursor },
      select: { createdAt: true, id: true },
    });
    if (!boundary) throw new FlowGrantMutationError("unavailable");
  }
  const rows = await tx.weleticShopifyFlowPointsGrant.findMany({
    where: {
      ...scope,
      ...(query.grantId ? { id: query.grantId } : {}),
      ...(approvedMerchantActionId ? { approvedMerchantActionId } : {}),
      ...(boundary
        ? {
            OR: [
              { createdAt: { lt: boundary.createdAt } },
              { createdAt: boundary.createdAt, id: { lt: boundary.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: query.limit + 1,
    select: {
      id: true,
      revision: true,
      allowCredit: true,
      allowDebit: true,
      maxAbsolutePointsPerAction: true,
      absolutePointsBudget: true,
      absolutePointsUsed: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  const grants = rows.slice(0, query.limit).map((row) => {
    const quantities = readFlowGrantQuantities(row);
    return {
      id: row.id,
      revision: row.revision,
      allowCredit: row.allowCredit,
      allowDebit: row.allowDebit,
      maxAbsolutePointsPerAction:
        quantities.maxAbsolutePointsPerAction.toString(),
      absolutePointsBudget: quantities.absolutePointsBudget.toString(),
      absolutePointsUsed: quantities.absolutePointsUsed.toString(),
      remainingAbsolutePoints: (
        quantities.absolutePointsBudget - quantities.absolutePointsUsed
      ).toString(),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
      status: row.revokedAt
        ? "revoked"
        : row.expiresAt <= now
          ? "expired"
          : quantities.absolutePointsUsed === quantities.absolutePointsBudget
            ? "exhausted"
            : "active",
    };
  });
  return result(
    grants,
    rows.length > query.limit ? rows[query.limit - 1].id : null,
  );
}
