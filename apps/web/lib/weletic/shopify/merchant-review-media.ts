import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { ReviewError } from "@/lib/weletic/reviews/contracts";
import {
  merchantReviewMediaInputSchema,
  merchantReviewMediaResponseSchema,
} from "@/lib/weletic/reviews/merchant-contract";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";

export async function readShopifyMerchantReviewMedia({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const data = merchantReviewMediaInputSchema.parse(input);
  const media = await prisma.$transaction(async (tx) => {
    const actor = await authorizeShopifyMerchantInTransaction({
      tx,
      envelope,
      permission: "reviews.read",
    });
    const row = await tx.weleticReviewMedia.findFirst({
      where: {
        id: data.mediaId,
        storeId: actor.storeId,
        status: "uploaded",
        reviewId: { not: null },
      },
      select: { objectKey: true, kind: true, contentType: true },
    });
    if (!row) throw new ReviewError("not_found", "Media unavailable");
    return row;
  });
  return merchantReviewMediaResponseSchema.parse({
    kind: media.kind,
    contentType: media.contentType,
    url: await storage.getSignedDownloadUrl({
      key: media.objectKey,
      bucket: "private",
      expiresIn: media.kind === "video" ? 900 : 60,
    }),
  });
}
