import {
  merchantReviewCreateInputSchema,
  merchantReviewCreateResponseSchema,
} from "@/lib/weletic/reviews/merchant-contract";
import { createMerchantReviewInTransaction } from "@/lib/weletic/reviews/service";
import { withReviewMutation } from "@/lib/weletic/reviews/transaction";
import {
  ShopifyStaffAuthorizationError,
  authorizeShopifyMerchantInTransaction,
} from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

export async function createShopifyMerchantReview({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const data = merchantReviewCreateInputSchema.parse(input);
  return withReviewMutation(
    actorEnvelope.storeId,
    async (tx) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.moderate",
      });
      if (!actor.owner)
        throw new ShopifyStaffAuthorizationError("access_denied");
      const review = await createMerchantReviewInTransaction({
        tx,
        storeId: actor.storeId,
        userId: actor.shopifyUserId,
        input: data,
      });
      return merchantReviewCreateResponseSchema.parse({
        id: review.id,
        status: review.status,
      });
    },
    actorEnvelope.installationGeneration,
  );
}
