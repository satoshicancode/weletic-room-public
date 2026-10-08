import { createWeleticId } from "@/lib/weletic/ids";
import type { Prisma } from "@prisma/client";
import { CoreLaunchDeferredError, isCoreLaunch } from "../core-launch-policy";
import { ReviewError } from "../reviews/contracts";
import {
  defaultStoreReviewSettingsPolicy,
  storeReviewSettingsReadInputSchema,
  storeReviewSettingsReadResponseSchema,
  storeReviewSettingsWriteInputSchema,
} from "../reviews/store-settings-contract";
import { withReviewMutation } from "../reviews/transaction";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

async function readSettings(
  tx: Prisma.TransactionClient,
  storeId: string,
  generation: string,
) {
  const [settings, product] = await Promise.all([
    tx.weleticStoreReviewSettings.findUnique({ where: { storeId } }),
    tx.weleticReviewSettings.findUnique({
      where: { storeId },
      select: { enabled: true },
    }),
  ]);
  return storeReviewSettingsReadResponseSchema.parse({
    revision: settings?.revision ?? 0,
    installationGeneration: generation,
    productReviewsEnabled: product?.enabled ?? false,
    policy: settings
      ? {
          enabled: settings.enabled,
          requestEmailEnabled: settings.requestEmailEnabled,
          autoPublish: settings.autoPublish,
          sendAfterDays: settings.sendAfterDays,
          expiresAfterDays: settings.expiresAfterDays,
        }
      : defaultStoreReviewSettingsPolicy(),
  });
}

export async function readShopifyMerchantStoreReviewSettingsInTransaction({
  tx,
  envelope,
  input,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  input: unknown;
}) {
  storeReviewSettingsReadInputSchema.parse(input);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "reviews.configure",
  });
  return readSettings(tx, actor.storeId, actor.installationGeneration);
}

export async function writeShopifyMerchantStoreReviewSettings({
  envelope,
  input,
}: {
  envelope: unknown;
  input: unknown;
}) {
  const actorEnvelope = shopifyMerchantActorEnvelopeSchema.parse(envelope);
  const patch = storeReviewSettingsWriteInputSchema.parse(input);
  if (isCoreLaunch() && patch.policy.enabled)
    throw new CoreLaunchDeferredError();
  if (
    actorEnvelope.installationGeneration !==
    patch.expectedInstallationGeneration
  )
    throw new ReviewError("conflict", "Installation changed");
  return withReviewMutation(
    actorEnvelope.storeId,
    async (tx, generation) => {
      const actor = await authorizeShopifyMerchantInTransaction({
        tx,
        envelope: actorEnvelope,
        permission: "reviews.configure",
      });
      if (actor.installationGeneration !== generation)
        throw new ReviewError("conflict", "Installation changed");
      const current = await tx.weleticStoreReviewSettings.findUnique({
        where: { storeId: actor.storeId },
      });
      if ((current?.revision ?? 0) !== patch.expectedRevision)
        throw new ReviewError("conflict", "Store review settings changed");
      const product = await tx.weleticReviewSettings.findUnique({
        where: { storeId: actor.storeId },
        select: { enabled: true },
      });
      if (patch.policy.enabled && !product?.enabled)
        throw new ReviewError("disabled", "Product Reviews must be enabled");
      const wasSending = Boolean(
        current?.enabled && current.requestEmailEnabled,
      );
      const willSend = patch.policy.enabled && patch.policy.requestEmailEnabled;
      const activatedAt = willSend
        ? wasSending
          ? current?.activatedAt ?? new Date()
          : new Date()
        : null;
      if (current) {
        const changed = await tx.weleticStoreReviewSettings.updateMany({
          where: {
            id: current.id,
            storeId: actor.storeId,
            revision: patch.expectedRevision,
          },
          data: {
            ...patch.policy,
            revision: { increment: 1 },
            activatedAt,
          },
        });
        if (changed.count !== 1)
          throw new ReviewError("conflict", "Store review settings changed");
      } else {
        await tx.weleticStoreReviewSettings.create({
          data: {
            id: createWeleticId("wstorset_"),
            storeId: actor.storeId,
            revision: 1,
            ...patch.policy,
            activatedAt,
          },
        });
      }
      return readSettings(tx, actor.storeId, generation);
    },
    actorEnvelope.installationGeneration,
  );
}
