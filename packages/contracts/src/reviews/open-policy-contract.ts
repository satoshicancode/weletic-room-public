import { z } from "zod";

export const openReviewPolicyReadSchema = z.object({}).strict();

/** Stored immutable policy payload. Purchase proof, incentives and publication
 * status are deliberately not configurable for open submissions.
 */
export const openReviewPolicySchema = z
  .object({
    enabled: z.boolean(),
    photoUploadsEnabled: z.boolean(),
    maxSubmissionsPer24Hours: z.number().int().min(1).max(20),
  })
  .strict();

export const DEFAULT_OPEN_REVIEW_POLICY = Object.freeze({
  enabled: false,
  photoUploadsEnabled: false,
  maxSubmissionsPer24Hours: 3,
});

export const openReviewPolicyWriteSchema = z
  .object({
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: z.number().int().min(0).max(2147483646),
    policy: openReviewPolicySchema,
  })
  .strict();

export const openReviewPolicyWriteResponseSchema = z
  .object({
    revision: z.number().int().min(1).max(2147483647),
    policy: openReviewPolicySchema,
  })
  .strict();

export const openReviewPolicyReadResponseSchema = z
  .object({
    revision: z.number().int().min(0).max(2147483647),
    policy: openReviewPolicySchema,
    installationGeneration: z.string().min(1).max(64),
    requiresReauthorization: z.boolean(),
    policyEnabledForInstallation: z.boolean(),
  })
  .strict()
  .refine(
    (value) =>
      value.policyEnabledForInstallation ===
      (value.policy.enabled && !value.requiresReauthorization),
    "Inconsistent policy state",
  );
