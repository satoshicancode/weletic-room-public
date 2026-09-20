import { z } from "zod/v4";

export const manualReviewLocaleSchema = z.enum(["en", "ja", "vi"]);
const revision = z.number().int().min(0).max(2147483646);
const identity = {
  reviewId: z.string().min(1).max(191),
  expectedInstallationGeneration: z.string().min(1).max(64),
  expectedReviewVersion: revision.refine((value) => value > 0),
  expectedTranslationRevision: revision,
  locale: manualReviewLocaleSchema,
};

/** Signed merchant input only. Store/actor/source digest come from locked server
 * state, never from the caller. Unknown original language stays explicitly null.
 */
export const manualReviewTranslationInputSchema = z.discriminatedUnion(
  "action",
  [
    z
      .object({
        ...identity,
        action: z.literal("save"),
        sourceLocale: manualReviewLocaleSchema.nullable(),
        title: z.string().trim().min(1).max(120),
        body: z.string().trim().min(1).max(10000),
      })
      .strict()
      .refine(
        (value) =>
          value.sourceLocale === null || value.sourceLocale !== value.locale,
        {
          message:
            "Translation locale must differ from the known source locale",
        },
      ),
    z.object({ ...identity, action: z.literal("remove") }).strict(),
  ],
);

export type ManualReviewTranslationInput = z.infer<
  typeof manualReviewTranslationInputSchema
>;

export const manualReviewTranslationWriteResponseSchema = z
  .object({
    reviewId: identity.reviewId,
    locale: manualReviewLocaleSchema,
    revision: z.number().int().min(1).max(2147483647),
    status: z.enum(["active", "removed"]),
  })
  .strict();

export const manualReviewTranslationReadInputSchema = z
  .object({ reviewId: identity.reviewId })
  .strict();

export const manualReviewTranslationReadResponseSchema = z
  .object({
    reviewId: identity.reviewId,
    installationGeneration: identity.expectedInstallationGeneration,
    reviewVersion: z.number().int().min(1).max(2147483647),
    original: z
      .object({
        title: z.string().max(120),
        body: z.string().max(10000),
        status: z.enum(["pending", "published", "hidden", "rejected"]),
      })
      .strict(),
    translations: z
      .array(
        z
          .object({
            locale: manualReviewLocaleSchema,
            revision: z.number().int().min(1).max(2147483647),
            status: z.enum(["active", "stale", "removed", "redacted"]),
            sourceLocale: manualReviewLocaleSchema.nullable(),
            title: z.string().max(120).nullable(),
            body: z.string().max(10000).nullable(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

export type ManualReviewTranslationPage = z.infer<
  typeof manualReviewTranslationReadResponseSchema
>;
