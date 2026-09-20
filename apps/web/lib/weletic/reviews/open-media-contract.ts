import { createHash } from "node:crypto";
import { z } from "zod";
import { REVIEW_MAX_PHOTO_BYTES, ReviewError } from "./contracts";
import {
  openReviewOperationKey,
  openReviewSubmissionSchema,
  type OpenReviewSubmissionScope,
} from "./open-submission-contract";

/** Content metadata only. Trusted identity/source comes from the verified gateway.
 * Bytes are supplied separately after the gateway's bounded transport decoding.
 */
export const openReviewPhotoSchema = z
  .object({
    submissionId: openReviewSubmissionSchema.shape.submissionId,
    uploadId: openReviewSubmissionSchema.shape.submissionId,
    productId: openReviewSubmissionSchema.shape.productId,
    expectedInstallationGeneration:
      openReviewSubmissionSchema.shape.expectedInstallationGeneration,
    expectedSettingsRevision:
      openReviewSubmissionSchema.shape.expectedSettingsRevision,
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  })
  .strict();
export type OpenReviewPhotoInput = z.infer<typeof openReviewPhotoSchema>;

export function openReviewPhotoEvidence(
  scope: OpenReviewSubmissionScope,
  input: OpenReviewPhotoInput,
  bytes: Buffer,
  normalized: Buffer,
) {
  const data = openReviewPhotoSchema.parse(input);
  if (data.expectedInstallationGeneration !== scope.installationGeneration)
    throw new ReviewError("conflict", "Installation changed");
  if (
    ![bytes, normalized].every(
      (value) =>
        Buffer.isBuffer(value) &&
        value.length > 0 &&
        value.length <= REVIEW_MAX_PHOTO_BYTES,
    )
  )
    throw new ReviewError("bad_request", "Photo exceeds the permitted size");
  const hash = (value: unknown[]) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const submissionKey = openReviewOperationKey(scope, data.submissionId);
  // Not scoped to product/submission: reusing one upload UUID for different
  // content cannot silently create a second upload. Source is display attribution.
  const idempotencyKey = hash([
    "weletic-open-photo-operation-v1",
    scope.storeId,
    scope.shopperId,
    scope.installationGeneration,
    data.uploadId,
  ]);
  const contentDigest = hash([
    "weletic-open-photo-content-v1",
    idempotencyKey,
    submissionKey,
    data.productId,
    data.expectedSettingsRevision,
    data.contentType,
    createHash("sha256").update(bytes).digest("hex"),
    createHash("sha256").update(normalized).digest("hex"),
  ]);
  return { submissionKey, idempotencyKey, contentDigest };
}
