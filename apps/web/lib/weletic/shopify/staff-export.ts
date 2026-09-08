import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import {
  SHOPIFY_STAFF_PERMISSIONS,
  shopifyStaffExportInputSchema,
  shopifyStaffGrantPermissionsSchema,
} from "./staff-contract";
import { STAFF_EXPORT_CONSISTENCY } from "./staff-export-contract";

const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    before: z.iso.datetime(),
    after: z.string().min(1).max(64),
  })
  .strict();
export class ShopifyStaffExportCursorError extends Error {}

/** Owner-only privacy export, not a financial or frozen database snapshot.
 * Retained generations belong to this exact store/app; exporting never grants
 * current authority to historical users. No sessions or request nonces leave.
 */
export async function exportShopifyStaffInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  const data = shopifyStaffExportInputSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "staff.manage",
  });
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        actor.appId,
        actor.storeId,
        actor.installationGeneration,
        data.kind,
      ]),
    )
    .digest("hex");
  const receipt = await tx.weleticShopifyMerchantAction.findUniqueOrThrow({
    where: { id: actor.actionId },
    select: { createdAt: true },
  });
  let before = receipt.createdAt;
  let after: string | undefined;
  if (data.cursor) {
    try {
      const bytes = Buffer.from(data.cursor, "base64url");
      if (bytes.toString("base64url") !== data.cursor) throw new Error();
      const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      before = new Date(cursor.before);
      if (cursor.scope !== scope || before > receipt.createdAt)
        throw new Error();
      after = cursor.after;
    } catch {
      throw new ShopifyStaffExportCursorError("Invalid staff export cursor");
    }
  }
  const where = {
    storeId: actor.storeId,
    appId: actor.appId,
    createdAt: { lt: before },
    ...(after ? { id: { gt: after } } : {}),
  };
  const bounds = {
    where,
    orderBy: { id: "asc" as const },
    take: data.limit + 1,
  };
  // Explicit projections prevent accidental credential/request-body exports.
  const rows =
    data.kind === "grants"
      ? (
          await tx.weleticShopifyStaffGrant.findMany({
            ...bounds,
            select: {
              id: true,
              installationGeneration: true,
              shopifyUserId: true,
              permissions: true,
              revision: true,
              updatedByShopifyUserId: true,
              createdAt: true,
              updatedAt: true,
            },
          })
        ).map((row) => {
          const permissions = shopifyStaffGrantPermissionsSchema.safeParse(
            row.permissions,
          );
          return {
            id: row.id,
            installationGeneration: row.installationGeneration,
            shopifyUserId: row.shopifyUserId,
            permissions: permissions.success ? permissions.data : null,
            revision: row.revision,
            updatedByShopifyUserId: row.updatedByShopifyUserId,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          };
        })
      : (
          await tx.weleticShopifyMerchantAction.findMany({
            ...bounds,
            select: {
              id: true,
              installationGeneration: true,
              shopifyUserId: true,
              owner: true,
              permission: true,
              grantRevision: true,
              targetShopifyUserId: true,
              changedPermissions: true,
              changedGrantRevision: true,
              createdAt: true,
            },
          })
        ).map((row) => {
          const permissions = shopifyStaffGrantPermissionsSchema.safeParse(
            row.changedPermissions,
          );
          const allowed =
            row.permission === "staff.manage" ||
            SHOPIFY_STAFF_PERMISSIONS.some(
              (permission) => permission === row.permission,
            );
          return {
            id: row.id,
            installationGeneration: row.installationGeneration,
            shopifyUserId: row.shopifyUserId,
            owner: row.owner,
            permission: allowed ? row.permission : null,
            grantRevision: row.grantRevision,
            targetShopifyUserId: row.targetShopifyUserId,
            changedPermissions: permissions.success ? permissions.data : null,
            changedGrantRevision: row.changedGrantRevision,
            createdAt: row.createdAt.toISOString(),
          };
        });
  const page = rows.slice(0, data.limit);
  return {
    version: 1 as const,
    kind: data.kind,
    currentInstallationGeneration: actor.installationGeneration,
    createdBefore: before.toISOString(),
    consistency: STAFF_EXPORT_CONSISTENCY,
    rows: page,
    nextCursor:
      rows.length > data.limit
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              scope,
              before: before.toISOString(),
              after: page[page.length - 1].id,
            }),
          ).toString("base64url")
        : null,
  };
}
