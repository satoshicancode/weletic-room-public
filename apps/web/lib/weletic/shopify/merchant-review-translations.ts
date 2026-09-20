import { withReviewMutation } from "../reviews/transaction";
import {
  manualReviewTranslationInputSchema,
  manualReviewTranslationReadInputSchema,
} from "../reviews/translation-contract";
import { readReviewTranslationsInTransaction } from "../reviews/translation-read";
import { writeReviewTranslationInTransaction } from "../reviews/translation-write";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

export async function readShopifyMerchantReviewTranslations({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const query = manualReviewTranslationReadInputSchema.parse(input);
  return withReviewMutation(
    actorEnvelope.storeId,
    async (tx) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.read",
      });
      return readReviewTranslationsInTransaction({
        tx,
        storeId: actor.storeId,
        reviewId: query.reviewId,
        generation: actor.installationGeneration,
      });
    },
    actorEnvelope.installationGeneration,
  );
}

// Internal gateway only; the route must verify HMAC over envelope AND input.
// The additive translation schema must be installed before deploying its routes.
export async function writeShopifyMerchantReviewTranslation({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const patch = manualReviewTranslationInputSchema.parse(input);
  return withReviewMutation(
    actorEnvelope.storeId,
    async (tx, generation) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.moderate",
      });
      return writeReviewTranslationInTransaction({
        tx,
        storeId: actor.storeId,
        generation,
        input: patch,
        actor: {
          kind: "shopify",
          userId: actor.shopifyUserId,
          appId: actor.appId,
          installationGeneration: actor.installationGeneration,
          merchantActionId: actor.actionId,
        },
      });
    },
    actorEnvelope.installationGeneration,
  );
}
