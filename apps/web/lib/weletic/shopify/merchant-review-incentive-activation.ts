import { Prisma } from "@prisma/client";
import { createWeleticId } from "../ids";
import { ReviewError } from "../reviews/contracts";
import { reviewIncentiveDisclosure } from "../reviews/incentive-disclosure";
import { merchantReviewIncentiveActivationInputSchema } from "../reviews/incentive-merchant-contract";
import {
  readReviewIncentivePolicySnapshot,
  reviewIncentivePolicyDigest,
} from "../reviews/incentive-policy";
import { withReviewMutation } from "../reviews/transaction";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

/** Internal signed-gateway service. Deploy only after the additive migration and
 * history-aware readers. Activation only affects new order promises;
 * disabling uses a new explicit none policy, never a null/legacy pointer.
 */
export async function activateShopifyMerchantReviewIncentive({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const patch = merchantReviewIncentiveActivationInputSchema.parse(input);
  const conflict = () =>
    new ReviewError(
      "conflict",
      "Review incentive policy changed; reload and retry",
    );
  if (
    patch.expectedInstallationGeneration !==
    actorEnvelope.installationGeneration
  )
    throw conflict();
  return withReviewMutation(
    actorEnvelope.storeId,
    async (tx) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.configure",
      });
      const settings = await tx.weleticReviewSettings.findUnique({
        where: { storeId: actor.storeId },
      });
      if (
        !settings ||
        settings.incentivePolicyRevision !== patch.expectedRevision ||
        settings.activeIncentivePolicyId !== patch.expectedActivePolicyId ||
        settings.activeIncentivePolicyId === patch.policyId
      )
        throw conflict();
      const row = await tx.weleticReviewIncentivePolicy.findUnique({
        where: { storeId_id: { storeId: actor.storeId, id: patch.policyId } },
      });
      if (
        !row ||
        row.revision !== patch.expectedRevision ||
        row.contentDigest !== patch.contentDigest
      )
        throw conflict();
      const snapshot = await readReviewIncentivePolicySnapshot(
        tx,
        actor.storeId,
        patch.policyId,
      );
      if (
        !snapshot ||
        reviewIncentivePolicyDigest(snapshot) !== patch.contentDigest
      )
        throw conflict();
      reviewIncentiveDisclosure(snapshot);
      await readReviewIncentivePolicySnapshot(
        tx,
        actor.storeId,
        settings.activeIncentivePolicyId,
      );
      const last = await tx.weleticReviewIncentiveActivation.findFirst({
        where: { storeId: actor.storeId },
        orderBy: [{ effectiveAt: "desc" }, { policyRevision: "desc" }],
      });
      if (
        last &&
        (last.policyId !== settings.activeIncentivePolicyId ||
          last.policyRevision >= row.revision)
      )
        throw conflict();
      const clocks = await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
      );
      const effectiveAt = clocks[0]?.now;
      if (
        !(effectiveAt instanceof Date) ||
        !Number.isFinite(effectiveAt.getTime()) ||
        (last && effectiveAt < last.effectiveAt)
      )
        throw new ReviewError(
          "unavailable",
          "Activation clock requires reconciliation",
        );
      const activationId = createWeleticId("wrevactivate_");
      await tx.weleticReviewIncentiveActivation.create({
        data: {
          id: activationId,
          storeId: actor.storeId,
          policyId: row.id,
          policyRevision: row.revision,
          previousPolicyId: settings.activeIncentivePolicyId,
          contentDigest: row.contentDigest,
          effectiveAt,
          appId: actor.appId,
          installationGeneration: actor.installationGeneration,
          shopifyUserId: actor.shopifyUserId,
          merchantActionId: actor.actionId,
        },
      });
      const changed = await tx.weleticReviewSettings.updateMany({
        where: {
          storeId: actor.storeId,
          incentivePolicyRevision: patch.expectedRevision,
          activeIncentivePolicyId: patch.expectedActivePolicyId,
        },
        data: { activeIncentivePolicyId: row.id },
      });
      if (changed.count !== 1) throw conflict();
      return {
        activationId,
        policyId: row.id,
        revision: row.revision,
        effectiveAt: effectiveAt.toISOString(),
      };
    },
    actorEnvelope.installationGeneration,
  );
}
