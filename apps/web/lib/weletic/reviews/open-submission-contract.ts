import { createHash } from "node:crypto";
import { z } from "zod";
import { reviewSubmissionBaseSchema } from "./contracts";

export const OPEN_REVIEW_DISCLOSURE_REVISION = "open_unverified_unrewarded_v1";

/** Shopper content only. Identity, source and purchase/incentive authority must
 * come from the verified gateway and locked persisted state, never this JSON.
 * This schema does not authenticate the caller or enable an open writer.
 */
export const openReviewSubmissionSchema = reviewSubmissionBaseSchema
  .omit({ token: true })
  .extend({
    submissionId: z
      .string()
      .regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      .transform((value) => value.toLowerCase()),
    productId: z.string().regex(/^gid:\/\/shopify\/Product\/[1-9][0-9]{0,19}$/),
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedSettingsRevision: z.number().int().min(1).max(2147483647),
    locale: z.enum(["en", "ja", "vi"]),
    disclosureRevision: z.literal(OPEN_REVIEW_DISCLOSURE_REVISION),
  })
  .strict()
  .refine(
    (value) => new Set(value.mediaIds).size === value.mediaIds.length,
    "Duplicate photos",
  );

export type OpenReviewSubmissionInput = z.infer<
  typeof openReviewSubmissionSchema
>;

const scopeSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    shopperId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    source: z.enum(["app_proxy", "customer_account"]),
  })
  .strict();

/** Internal scope AFTER authorization. Structural validation is not proof that
 * Shopify authenticated this customer; the caller must establish that first.
 */
export type OpenReviewSubmissionScope = z.infer<typeof scopeSchema>;

function digest(parts: unknown[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function openReviewOperationKey(
  scopeInput: OpenReviewSubmissionScope,
  submissionId: string,
) {
  const scope = scopeSchema.parse(scopeInput);
  const operation =
    openReviewSubmissionSchema.shape.submissionId.parse(submissionId);
  return digest([
    "weletic-open-review-operation-v1",
    scope.storeId,
    scope.shopperId,
    scope.installationGeneration,
    operation,
  ]);
}

export function openReviewSubmissionEvidence(
  scopeInput: OpenReviewSubmissionScope,
  input: unknown,
) {
  const scope = scopeSchema.parse(scopeInput);
  const submission = openReviewSubmissionSchema.parse(input);
  if (
    scope.installationGeneration !== submission.expectedInstallationGeneration
  )
    throw new Error("Open review installation changed");
  // Source is intentionally absent from the retry identity: switching between
  // authenticated surfaces cannot spend the same operation twice. The immutable
  // stored source remains that of the first accepted submission.
  const idempotencyKey = openReviewOperationKey(scope, submission.submissionId);
  // Do not store the raw client operation ID or duplicate review text here.
  // This digest is private content evidence and must be cleared on erasure.
  const contentDigest = digest([
    "weletic-open-review-content-v1",
    idempotencyKey,
    submission.productId,
    submission.expectedSettingsRevision,
    submission.locale,
    submission.disclosureRevision,
    submission.publishConsent,
    submission.rating,
    submission.title,
    submission.body,
    submission.displayName,
    [...submission.mediaIds].sort(),
  ]);
  return { idempotencyKey, contentDigest };
}

/** Replays never reactivate erased evidence. The caller must first verify the
 * stored row belongs to the same locked store/shopper/generation scope.
 */
export function classifyOpenReviewReplay(
  stored: {
    idempotencyKey: string;
    contentDigest: string | null;
    redactedAt: Date | null;
  },
  expected: { idempotencyKey: string; contentDigest: string },
): "duplicate" | "conflict" | "suppressed" {
  if (stored.redactedAt || !stored.contentDigest) return "suppressed";
  return stored.idempotencyKey === expected.idempotencyKey &&
    stored.contentDigest === expected.contentDigest
    ? "duplicate"
    : "conflict";
}
