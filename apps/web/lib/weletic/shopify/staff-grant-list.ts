import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import {
  authorizeShopifyMerchantInTransaction,
  shopifyStaffGrantId,
} from "./staff-authorization";
import {
  listShopifyStaffGrantsSchema,
  shopifyStaffGrantPermissionsSchema,
  shopifyStaffUserIdSchema,
} from "./staff-contract";

const cursorSchema = z
  .object({
    version: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    after: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export class ShopifyStaffGrantCursorError extends Error {}

/** A cursor selects position only, never authority. Every page reauthenticates
 * the current owner and installation in its own signed, nonce-bound transaction.
 */
export async function listShopifyStaffGrantsInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  const data = listShopifyStaffGrantsSchema.parse(input);
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
      ]),
    )
    .digest("hex");
  let after: string | undefined;
  if (data.cursor) {
    try {
      const bytes = Buffer.from(data.cursor, "base64url");
      if (bytes.toString("base64url") !== data.cursor) throw new Error();
      const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (cursor.scope !== scope) throw new Error();
      after = cursor.after;
    } catch {
      throw new ShopifyStaffGrantCursorError("Invalid staff grant cursor");
    }
  }
  const rows = await tx.weleticShopifyStaffGrant.findMany({
    where: {
      storeId: actor.storeId,
      appId: actor.appId,
      installationGeneration: actor.installationGeneration,
      ...(after ? { id: { gt: after } } : {}),
    },
    orderBy: { id: "asc" },
    take: data.limit + 1,
    select: {
      id: true,
      shopifyUserId: true,
      permissions: true,
      revision: true,
      updatedAt: true,
    },
  });
  const page = rows.slice(0, data.limit);
  return {
    grants: page.map((row) => {
      const permissions = shopifyStaffGrantPermissionsSchema.safeParse(
        row.permissions,
      );
      // Corrupt grants remain visible for owner repair, but never appear active.
      const valid =
        permissions.success &&
        Number.isSafeInteger(row.revision) &&
        row.revision > 0 &&
        shopifyStaffUserIdSchema.safeParse(row.shopifyUserId).success &&
        row.id === shopifyStaffGrantId({ ...actor, userId: row.shopifyUserId });
      return {
        userId: row.shopifyUserId,
        permissions: valid ? permissions.data : [],
        revision: row.revision,
        status: !valid
          ? ("invalid" as const)
          : permissions.data.length
            ? ("active" as const)
            : ("revoked" as const),
        updatedAt: row.updatedAt.toISOString(),
      };
    }),
    nextCursor:
      rows.length > data.limit
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              scope,
              after: page[page.length - 1].id,
            }),
          ).toString("base64url")
        : null,
  };
}
