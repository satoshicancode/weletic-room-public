import type { Prisma } from "@prisma/client";
import {
  defaultReviewCollectionPolicy,
  reviewCollectionReadInputSchema,
  reviewCollectionReadResponseSchema,
  reviewCollectionWriteInputSchema,
} from "../reviews/collection-contract";
import { ReviewError } from "../reviews/contracts";
import { updateReviewCollectionInTransaction } from "../reviews/service";
import { withReviewMutation } from "../reviews/transaction";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

async function readCollection(
  tx: Prisma.TransactionClient,
  storeId: string,
  installationGeneration: string,
) {
  const settings = await tx.weleticReviewSettings.findUnique({
    where: { storeId },
  });
  const defaults = defaultReviewCollectionPolicy();
  return reviewCollectionReadResponseSchema.parse({
    revision: settings?.collectionRevision ?? 0,
    installationGeneration,
    moduleEnabled: settings?.enabled ?? false,
    policy: settings
      ? {
          sendAfterDays: settings.sendAfterDays,
          expiresAfterDays: settings.expiresAfterDays,
          autoPublish: settings.autoPublish,
          photoUploadsEnabled: settings.photoUploadsEnabled,
          requestEmailEnabled: settings.requestEmailEnabled,
          reminderAfterDays: settings.reminderAfterDays ?? [],
        }
      : defaults,
  });
}

/** Internal signed gateway only. Read records authorization, not default rows. */
export async function readShopifyMerchantReviewCollectionInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  reviewCollectionReadInputSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "reviews.configure",
  });
  return readCollection(tx, actor.storeId, actor.installationGeneration);
}

/** Authorization receipt and lifecycle effects commit under one store/program
 * fence. Never accept tenant/staff identity from the collection form itself.
 */
export async function writeShopifyMerchantReviewCollection({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actor = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const patch = reviewCollectionWriteInputSchema.parse(input);
  if (actor.installationGeneration !== patch.expectedInstallationGeneration)
    throw new ReviewError("conflict", "Installation changed; reload and retry");
  return withReviewMutation(
    actor.storeId,
    async (tx) => {
      await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actor,
        permission: "reviews.configure",
      });
      await updateReviewCollectionInTransaction(tx, actor.storeId, patch);
      return readCollection(tx, actor.storeId, actor.installationGeneration);
    },
    actor.installationGeneration,
  );
}
