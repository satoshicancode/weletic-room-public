import { listMerchantShoppers } from "@/lib/weletic/shoppers/directory";
import {
  merchantShopperListInputSchema,
  merchantShopperProfileInputSchema,
} from "@/lib/weletic/shoppers/merchant-contract";
import { readMerchantShopperProfile } from "@/lib/weletic/shoppers/profile";
import { ShopperProfileError } from "@/lib/weletic/shoppers/profile-query";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";

const cursorSchema = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    cursor: z.string().min(1).max(2048),
  })
  .strict();

type Request = {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
};

async function authorizeRead(
  request: Request,
  operation: "list" | "profile",
  query: { cursor?: string },
) {
  const actor = await authorizeShopifyMerchantInTransaction({
    tx: request.tx,
    envelope: request.envelope,
    permission: "customers.read",
  });
  const { cursor: suppliedCursor, ...filters } = query;
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        "merchant-shoppers-v1",
        operation,
        actor.storeId,
        actor.projectId,
        actor.appId,
        actor.installationGeneration,
        actor.shopifyUserId,
        actor.grantRevision,
        filters,
      ]),
    )
    .digest("hex");
  let cursor: string | undefined;
  if (suppliedCursor) {
    try {
      const bytes = Buffer.from(suppliedCursor, "base64url");
      if (bytes.toString("base64url") !== suppliedCursor) throw new Error();
      const decoded = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (decoded.scope !== scope) throw new Error();
      cursor = decoded.cursor;
    } catch {
      throw new ShopperProfileError("bad_request");
    }
  }
  return { actor, cursor, scope };
}

function wrapCursor(scope: string, cursor: string | null) {
  return cursor
    ? Buffer.from(JSON.stringify({ scope, cursor })).toString("base64url")
    : null;
}

/** Call only after verifying the complete signed request body. Authorization
 * and all privacy-filtered reads must commit or roll back on this same tx.
 */
export async function listShopifyMerchantShoppersInTransaction(
  request: Request,
) {
  const query = merchantShopperListInputSchema.parse(request.input);
  const { actor, cursor, scope } = await authorizeRead(request, "list", query);
  const result = await listMerchantShoppers(
    actor.projectId,
    { ...query, cursor },
    request.tx,
  );
  return {
    ...result,
    pagination: {
      ...result.pagination,
      nextCursor: wrapCursor(scope, result.pagination.nextCursor),
    },
  };
}

export async function readShopifyMerchantShopperInTransaction(
  request: Request,
) {
  const query = merchantShopperProfileInputSchema.parse(request.input);
  const { actor, cursor, scope } = await authorizeRead(
    request,
    "profile",
    query,
  );
  const result = await readMerchantShopperProfile(
    actor.projectId,
    { ...query, cursor },
    request.tx,
  );
  if (result.section === "overview") return result;
  return {
    ...result,
    pagination: {
      ...result.pagination,
      nextCursor: wrapCursor(scope, result.pagination.nextCursor),
    },
  };
}
