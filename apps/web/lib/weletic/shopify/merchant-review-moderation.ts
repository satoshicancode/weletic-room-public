import { moderateReviewWithAuditInTransaction } from "../reviews/moderation-audit";
import { auditedReviewModerationInputSchema } from "../reviews/moderation-contract";
import { withReviewMutation } from "../reviews/transaction";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

// Only call after verifying the HMAC over the full envelope and input body.
// The browser never supplies the audit actor or a separate target store.
export async function moderateShopifyMerchantReview({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const patch = auditedReviewModerationInputSchema.parse(input);
  return withReviewMutation(
    actorEnvelope.storeId,
    async (tx, generation) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.moderate",
      });
      return moderateReviewWithAuditInTransaction({
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
