import { ReviewError } from "../reviews/contracts";
import {
  merchantReviewIncentiveDraftInputSchema,
  merchantReviewIncentiveDraftResponseSchema,
} from "../reviews/incentive-merchant-contract";
import { createReviewIncentivePolicyRevision } from "../reviews/incentive-policy";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

/** Internal only: caller must verify the signature over actor AND input.
 * Authorization is repeated after catalog I/O; its receipt commits atomically
 * with the draft. No request, active policy or award is changed here.
 */
export async function draftShopifyMerchantReviewIncentive({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actor = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const patch = merchantReviewIncentiveDraftInputSchema.parse(input);
  if (actor.installationGeneration !== patch.expectedInstallationGeneration)
    throw new ReviewError("conflict", "Installation changed; reload and retry");
  const policy = await createReviewIncentivePolicyRevision(
    actor.storeId,
    patch.draft,
    {
      expectedRevision: patch.expectedRevision,
      expectedInstallationGeneration: actor.installationGeneration,
      authorize: async (tx, phase) => {
        await authorizeShopifyMerchantInTransaction({
          tx,
          envelope: actor,
          permission: "reviews.configure",
          recordAction: phase === "commit",
        });
      },
    },
  );
  return merchantReviewIncentiveDraftResponseSchema.parse({
    policyId: policy.id,
    revision: policy.revision,
    contentDigest: policy.contentDigest,
    activated: false,
  });
}
