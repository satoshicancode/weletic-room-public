import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { ReviewError } from "../reviews/contracts";
import {
  merchantReviewCouponListInputSchema,
  merchantReviewCouponListResponseSchema,
} from "../reviews/incentive-merchant-contract";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";

const cursorSchema = z
  .object({
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    after: z.string().min(1).max(191),
  })
  .strict();
/** Candidate names only. Draft creation revalidates all economic terms and live
 * targets; appearing here is neither issuance nor a capability guarantee.
 */
export async function listShopifyMerchantReviewCouponsInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  const query = merchantReviewCouponListInputSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "reviews.configure",
  });
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        "review-coupon-picker-v1",
        actor.storeId,
        actor.appId,
        actor.installationGeneration,
        query.query,
      ]),
    )
    .digest("hex");
  let after: string | undefined;
  if (query.cursor) {
    try {
      const bytes = Buffer.from(query.cursor, "base64url");
      if (bytes.toString("base64url") !== query.cursor) throw new Error();
      const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (cursor.scope !== scope) throw new Error();
      after = cursor.after;
    } catch {
      throw new ReviewError("bad_request", "Invalid coupon cursor");
    }
  }
  const rows = await tx.weleticRewardDefinition.findMany({
    where: {
      storeId: actor.storeId,
      status: "active",
      salesChannel: "online_store",
      exchangeType: "fixed",
      rewardType: { in: ["amount_off", "percentage_off", "free_shipping"] },
      maxDiscountValue: null,
      ...(query.query ? { name: { contains: query.query } } : {}),
      ...(after ? { id: { gt: after } } : {}),
    },
    select: { id: true, name: true },
    orderBy: { id: "asc" },
    take: 51,
  });
  const items = rows.slice(0, 50);
  return merchantReviewCouponListResponseSchema.parse({
    items,
    nextCursor:
      rows.length > 50
        ? Buffer.from(
            JSON.stringify({ scope, after: items[items.length - 1].id }),
          ).toString("base64url")
        : null,
  });
}
