import { ReviewError } from "../reviews/contracts";
import {
  createOpenReviewPolicyRevision,
  readCurrentOpenReviewPolicy,
} from "../reviews/open-policy-history";
import {
  openReviewPolicyReadSchema,
  openReviewPolicyWriteSchema,
} from "../reviews/open-submission-policy";
import { withReviewMutation } from "../reviews/transaction";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

/** Internal service boundary. HTTP callers must verify HMAC over actor AND input
 * before invoking either operation. These functions do not verify a signature.
 */
export async function readShopifyMerchantOpenReviewPolicy({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  openReviewPolicyReadSchema.parse(input);
  return withReviewMutation(
    actorEnvelope.storeId,
    async (tx) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.configure",
      });
      const current = await readCurrentOpenReviewPolicy(tx, actor.storeId);
      const requiresReauthorization =
        current.revision > 0 &&
        current.installationGeneration !== actor.installationGeneration;
      return {
        revision: current.revision,
        policy: current.policy,
        installationGeneration: actor.installationGeneration,
        requiresReauthorization,
        // This covers only policy/generation, not global module or shopper gates.
        policyEnabledForInstallation:
          current.policy.enabled && !requiresReauthorization,
      };
    },
    actorEnvelope.installationGeneration,
  );
}

export async function writeShopifyMerchantOpenReviewPolicy({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const command = openReviewPolicyWriteSchema.parse(input);
  if (
    command.expectedInstallationGeneration !==
    actorEnvelope.installationGeneration
  )
    throw new ReviewError("conflict", "Installation changed; reload and retry");
  return createOpenReviewPolicyRevision(
    actorEnvelope.storeId,
    command,
    async (tx) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.configure",
        recordAction: true,
      });
      return { appId: actor.appId, shopifyUserId: actor.shopifyUserId };
    },
  );
}
