import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { REVIEW_MAX_PHOTO_BYTES, ReviewError } from "./contracts";
import { normalizeReviewPhoto, requireReviewStorage } from "./media";
import {
  openReviewPhotoEvidence,
  openReviewPhotoSchema,
} from "./open-media-contract";
import {
  InvalidOpenReviewPhoto,
  OpenPhotoReconciliationRequired,
} from "./open-media-errors";
import { openPhotoUploadProof } from "./open-media-proof";
import { reconcileOpenReviewPhotoStorage } from "./open-media-reconciliation";
import { reserveOpenReviewPhotoInTransaction } from "./open-media-reservation";
import {
  claimOpenPhotoStorageWrite,
  recordOpenPhotoStorageOutcome,
} from "./open-media-write-state";
import { readCurrentOpenReviewPolicy } from "./open-policy-history";
import { ensureOpenReviewAuthorInTransaction } from "./open-submission-author";
import { withReviewMutation } from "./transaction";

const identitySchema = z
  .object({
    shopifyCustomerId: z
      .string()
      .regex(/^(?:gid:\/\/shopify\/Customer\/)?[1-9][0-9]{0,19}$/),
    email: z.string().max(320).nullable(),
    source: z.enum(["app_proxy", "customer_account"]),
  })
  .strict();

/** Internal authenticated upload service, not a public endpoint. authorize must
 * verify signed gateway identity/domain inside the current transaction and be
 * replay-safe, with no external I/O. Never derive it from photo metadata JSON.
 */
export async function uploadOpenReviewPhoto({
  storeId,
  installationGeneration,
  input,
  bytes,
  authorize,
}: {
  storeId: string;
  installationGeneration: string;
  input: unknown;
  bytes: Buffer;
  authorize: (
    tx: Prisma.TransactionClient,
  ) => Promise<z.infer<typeof identitySchema>>;
}) {
  z.string().min(1).max(191).parse(storeId);
  const data = openReviewPhotoSchema.parse(input);
  if (data.expectedInstallationGeneration !== installationGeneration)
    throw new ReviewError("conflict", "Installation changed");
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > REVIEW_MAX_PHOTO_BYTES
  )
    throw new ReviewError("bad_request", "Photo exceeds the permitted size");
  requireReviewStorage();
  const initial = await withReviewMutation(
    storeId,
    async (tx) => {
      const identity = identitySchema.parse(await authorize(tx));
      const store = await tx.weleticShopifyStore.findUniqueOrThrow({
        where: { id: storeId },
        select: { projectId: true },
      });
      return { identity, workspaceId: store.projectId };
    },
    installationGeneration,
  );
  return withShopifyCustomerSettlementLocks({
    workspaceId: initial.workspaceId,
    storeId,
    shopifyCustomerId: initial.identity.shopifyCustomerId,
    fn: async () => {
      async function context(tx: Prisma.TransactionClient) {
        const identity = identitySchema.parse(await authorize(tx));
        if (
          identity.shopifyCustomerId !== initial.identity.shopifyCustomerId ||
          identity.email !== initial.identity.email ||
          identity.source !== initial.identity.source
        )
          throw new ReviewError("conflict", "Review identity changed");
        const policy = await readCurrentOpenReviewPolicy(tx, storeId);
        if (
          !policy.policy.enabled ||
          !policy.policy.photoUploadsEnabled ||
          policy.installationGeneration !== installationGeneration
        )
          throw new ReviewError(
            "disabled",
            "Open review photos are unavailable",
          );
        if (policy.revision !== data.expectedSettingsRevision)
          throw new ReviewError("conflict", "Open review policy changed");
        const settings = await tx.$queryRaw<
          Array<{ photoUploadsEnabled: boolean | number }>
        >(Prisma.sql`
          SELECT photoUploadsEnabled FROM WeleticReviewSettings WHERE storeId = ${storeId} FOR UPDATE
        `);
        if (
          settings.length !== 1 ||
          ![true, 1].includes(settings[0].photoUploadsEnabled)
        )
          throw new ReviewError("disabled", "Review photos are disabled");
        const { shopperId } = await ensureOpenReviewAuthorInTransaction({
          tx,
          storeId,
          installationGeneration,
          customer: identity,
        });
        const products = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT id FROM WeleticShopifyProduct WHERE storeId = ${storeId}
            AND externalId = ${data.productId} AND status = 'active' LIMIT 1 FOR UPDATE
        `);
        if (products.length !== 1)
          throw new ReviewError("not_found", "Product unavailable");
        return {
          scope: {
            storeId,
            shopperId,
            installationGeneration,
            source: identity.source,
          },
          productId: products[0].id,
          maxSubmissionsPer24Hours: policy.policy.maxSubmissionsPer24Hours,
        };
      }
      // Authorize before spending resources decoding an untrusted image, then
      // repeat after normalization and on both sides of the private PUT.
      await withReviewMutation(storeId, context, installationGeneration);
      let normalized: Buffer;
      try {
        normalized = await normalizeReviewPhoto(bytes, data.contentType);
      } catch (error) {
        if (error instanceof ReviewError && error.code === "bad_request")
          throw new InvalidOpenReviewPhoto();
        throw error;
      }
      if (!normalized.length || normalized.length > REVIEW_MAX_PHOTO_BYTES)
        throw new InvalidOpenReviewPhoto();
      async function reservation(tx: Prisma.TransactionClient) {
        const current = await context(tx);
        const evidence = openReviewPhotoEvidence(
          current.scope,
          data,
          bytes,
          normalized,
        );
        return reserveOpenReviewPhotoInTransaction({
          tx,
          ...current,
          input: data,
          evidence,
          sizeBytes: normalized.length,
        });
      }
      async function reservationWithRecovery() {
        try {
          return await withReviewMutation(
            storeId,
            reservation,
            installationGeneration,
          );
        } catch (error) {
          if (!(error instanceof OpenPhotoReconciliationRequired)) throw error;
          // The failed reservation already verified current identity, policy,
          // privacy and byte-exact retry evidence. No external I/O inside SQL.
          let confirmed = false;
          try {
            confirmed =
              (await reconcileOpenReviewPhotoStorage(storeId, error.mediaId))
                .status === "confirmed";
          } catch {
            // Do not return provider/configuration details to the shopper.
          }
          if (!confirmed)
            throw new ReviewError(
              "unavailable",
              "Photo storage outcome requires reconciliation",
            );
          // Recovery only settles the remote attempt. Authorization and every
          // reservation constraint are checked again before any finalization.
          return withReviewMutation(
            storeId,
            reservation,
            installationGeneration,
          );
        }
      }
      const photo = await reservationWithRecovery();
      return withDistributedLock({
        key: `weletic:reviews:media:${storeId}:${photo.id}`,
        ttlSeconds: 300,
        fn: async () => {
          const current = await reservationWithRecovery();
          if (current.id !== photo.id)
            throw new ReviewError("conflict", "Photo reservation changed");
          if (current.status === "uploaded") return { id: current.id };
          if (current.storageWriteState === "not_started") {
            const writeToken = randomBytes(32).toString("hex");
            await withReviewMutation(
              storeId,
              async (tx) => {
                const ready = await reservation(tx);
                if (ready.id !== current.id)
                  throw new ReviewError(
                    "conflict",
                    "Photo reservation changed",
                  );
                await claimOpenPhotoStorageWrite(
                  tx,
                  storeId,
                  current.id,
                  writeToken,
                );
              },
              installationGeneration,
            );
            try {
              await storage.upload({
                key: current.objectKey,
                bucket: "private",
                body: normalized,
                opts: {
                  contentType: "image/webp",
                  singleAttempt: true,
                  headers: {
                    "x-amz-meta-weletic-upload-proof": openPhotoUploadProof(
                      storeId,
                      current.id,
                      writeToken,
                    ),
                  },
                  signal: AbortSignal.timeout(30_000),
                },
              });
            } catch {
              // A timeout is not proof of non-delivery. Never issue another PUT
              // or let cleanup report erasure until this attempt is reconciled.
              await prisma.$transaction((tx) =>
                recordOpenPhotoStorageOutcome(
                  tx,
                  storeId,
                  current.id,
                  writeToken,
                  "ambiguous",
                ),
              );
              throw new ReviewError(
                "unavailable",
                "Photo storage outcome requires reconciliation",
              );
            }
            await prisma.$transaction((tx) =>
              recordOpenPhotoStorageOutcome(
                tx,
                storeId,
                current.id,
                writeToken,
                "confirmed",
              ),
            );
          }
          try {
            await withReviewMutation(
              storeId,
              async (tx) => {
                const ready = await reservation(tx);
                if (
                  ready.id !== current.id ||
                  ready.status !== "reserved" ||
                  ready.storageWriteState !== "confirmed"
                )
                  throw new ReviewError(
                    "conflict",
                    "Photo reservation changed",
                  );
                const updated = await tx.weleticReviewMedia.updateMany({
                  where: {
                    id: current.id,
                    storeId,
                    requestId: null,
                    reviewId: null,
                    status: "reserved",
                    uploadExpiresAt: current.uploadExpiresAt,
                  },
                  data: { status: "uploaded" },
                });
                if (updated.count !== 1)
                  throw new ReviewError(
                    "conflict",
                    "Photo reservation changed",
                  );
              },
              installationGeneration,
            );
            return { id: current.id };
          } catch {
            // The PUT is durably known complete. Retrying finalization does not
            // PUT again; uploaded/confirmed state also survives a lost DB reply.
            // Existing expiry/privacy cleanup retains ownership of compensation.
            throw new ReviewError(
              "unavailable",
              "Photo upload could not be confirmed; retry the same upload",
            );
          }
        },
      });
    },
  });
}
