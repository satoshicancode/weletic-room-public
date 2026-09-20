import { manualReviewLocaleSchema } from "./translation-contract";
import { reviewTranslationSourceDigest } from "./translation-source";

type Source = {
  storeId: string;
  id: string;
  version: number;
  status: string;
  redactedAt: Date | null;
  title: string;
  body: string;
};
type Translation = {
  storeId: string;
  reviewId: string;
  locale: string;
  status: string;
  redactedAt: Date | null;
  sourceReviewVersion: number;
  sourceDigest: string | null;
  sourceLocale: string | null;
  title: string | null;
  body: string | null;
};

/** Projection only, not an authorization boundary. Caller must first establish
 * current store/module/shopper privacy authority. Never render these strings as
 * HTML. No identifiers or audit/freshness metadata enter the public result.
 */
export function projectManualReviewTranslation({
  storeId,
  source,
  translation,
  locale,
}: {
  storeId: string;
  source: Source;
  translation: Translation | null;
  locale: string;
}) {
  if (
    source.storeId !== storeId ||
    source.status !== "published" ||
    source.redactedAt !== null
  )
    return null;
  const original = {
    title: source.title,
    body: source.body,
    translated: false as const,
  };
  if (!translation || !manualReviewLocaleSchema.safeParse(locale).success)
    return original;
  if (
    translation.storeId !== storeId ||
    translation.reviewId !== source.id ||
    translation.locale !== locale ||
    translation.status !== "active" ||
    translation.redactedAt !== null ||
    !Number.isInteger(translation.sourceReviewVersion) ||
    translation.sourceReviewVersion < 1 ||
    translation.sourceReviewVersion > source.version ||
    (translation.sourceLocale !== null &&
      (!manualReviewLocaleSchema.safeParse(translation.sourceLocale).success ||
        translation.sourceLocale === locale)) ||
    typeof translation.title !== "string" ||
    !translation.title.trim() ||
    translation.title.length > 120 ||
    typeof translation.body !== "string" ||
    !translation.body.trim() ||
    translation.body.length > 10000 ||
    translation.sourceDigest !==
      reviewTranslationSourceDigest({
        storeId,
        reviewId: source.id,
        title: source.title,
        body: source.body,
      })
  )
    return original;
  return {
    title: translation.title,
    body: translation.body,
    translated: true as const,
  };
}
