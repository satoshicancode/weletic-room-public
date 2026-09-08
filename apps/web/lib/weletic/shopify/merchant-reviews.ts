import { listAdminReviews } from "@/lib/weletic/reviews/admin";
import { ReviewError } from "@/lib/weletic/reviews/contracts";
import {
  merchantReviewListInputSchema,
  merchantReviewListResponseSchema,
} from "@/lib/weletic/reviews/merchant-contract";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import * as z from "zod/v4";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";

const cursorSchema = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    cursor: z.string().min(1).max(2048),
  })
  .strict();

export async function listShopifyMerchantReviewsInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  const query = merchantReviewListInputSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "reviews.read",
  });
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        "merchant-review-list-v1",
        actor.storeId,
        actor.appId,
        actor.installationGeneration,
        query.view,
        query.status ?? "",
        query.view === "reviews" ? query.rating ?? null : null,
      ]),
    )
    .digest("hex");
  let cursor: string | undefined;
  if (query.cursor) {
    try {
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.toString("base64url") !== query.cursor) throw new Error();
      const decoded = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (decoded.scope !== scope) throw new Error();
      cursor = decoded.cursor;
    } catch {
      throw new ReviewError("bad_request", "Invalid review cursor");
    }
  }
  const result = await listAdminReviews(
    actor.storeId,
    { ...query, cursor },
    tx,
  );
  const nextCursor = result.nextCursor
    ? Buffer.from(
        JSON.stringify({ scope, cursor: result.nextCursor }),
      ).toString("base64url")
    : null;
  // Explicit merchant projection: no delivery tokens, private media keys,
  // shopper identity, provider error strings or arbitrary metadata.
  const items = result.items.map((row) => {
    const common = {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      product: row.product,
      status: row.status,
    };
    return "rating" in row
      ? {
          ...common,
          version: row.version,
          rating: row.rating,
          title: row.title,
          body: row.body,
          displayName: row.displayName,
          merchantReply: row.merchantReply,
          verifiedPurchase: row.verifiedPurchase,
          incentivized: row.incentivized,
          rewardStatus: row.rewardStatus,
          photoCount: row.media.length,
        }
      : {
          ...common,
          sendAt: row.sendAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          sentAt: row.sentAt?.toISOString() ?? null,
          submittedAt: row.submittedAt?.toISOString() ?? null,
          deliveryAttempts: row.deliveryAttempts,
          hasDeliveryError: Boolean(row.lastError),
        };
  });
  return merchantReviewListResponseSchema.parse({
    view: query.view,
    items,
    nextCursor,
  });
}
