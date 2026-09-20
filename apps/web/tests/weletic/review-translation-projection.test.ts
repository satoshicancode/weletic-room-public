import { describe, expect, it } from "vitest";
import { projectManualReviewTranslation } from "../../lib/weletic/reviews/translation-projection";
import { reviewTranslationSourceDigest } from "../../lib/weletic/reviews/translation-source";

const source = {
  storeId: "store-1",
  id: "review-1",
  version: 4,
  status: "published",
  redactedAt: null,
  title: "Original title",
  body: "Original body",
};
const translation = {
  storeId: source.storeId,
  reviewId: source.id,
  locale: "ja",
  status: "active",
  redactedAt: null,
  sourceReviewVersion: 2,
  sourceLocale: "en",
  title: "翻訳",
  body: "手動翻訳",
  sourceDigest: reviewTranslationSourceDigest({
    ...source,
    reviewId: source.id,
  }),
};
const input = { storeId: source.storeId, source, translation, locale: "ja" };
const original = { title: source.title, body: source.body, translated: false };

describe("manual translation public projection", () => {
  it("permits unchanged source content after moderation-only version changes", () => {
    expect(projectManualReviewTranslation(input)).toEqual({
      title: "翻訳",
      body: "手動翻訳",
      translated: true,
    });
  });
  it.each(["pending", "hidden", "rejected", "redacted", "unknown"])(
    "suppresses %s original and its translation",
    (status) => {
      expect(
        projectManualReviewTranslation({
          ...input,
          source: { ...source, status },
        }),
      ).toBeNull();
    },
  );
  it("suppresses redacted and foreign originals", () => {
    expect(
      projectManualReviewTranslation({
        ...input,
        source: { ...source, redactedAt: new Date() },
      }),
    ).toBeNull();
    expect(
      projectManualReviewTranslation({ ...input, storeId: "foreign" }),
    ).toBeNull();
  });
  it.each([
    { storeId: "foreign" },
    { reviewId: "foreign" },
    { locale: "vi" },
    { status: "stale" },
    { status: "removed" },
    { status: "redacted" },
    { redactedAt: new Date() },
    { sourceReviewVersion: 5 },
    { sourceReviewVersion: 0 },
    { sourceReviewVersion: 1.5 },
    { sourceDigest: "different" },
    { sourceDigest: null },
    { title: null },
    { body: null },
    { title: " " },
    { body: " " },
    { title: "a".repeat(121) },
    { body: "a".repeat(10001) },
    { sourceLocale: "fr" },
    { sourceLocale: "ja" },
  ])("falls back safely for unavailable or invalid translation %j", (patch) => {
    expect(
      projectManualReviewTranslation({
        ...input,
        translation: { ...translation, ...patch },
      }),
    ).toEqual(original);
  });
  it("falls back when source text changes", () => {
    const changed = { ...source, body: "Edited content" };
    expect(
      projectManualReviewTranslation({ ...input, source: changed }),
    ).toEqual({ ...original, body: changed.body });
  });
  it("falls back for missing translations and unsupported locale", () => {
    expect(
      projectManualReviewTranslation({ ...input, translation: null }),
    ).toEqual(original);
    expect(projectManualReviewTranslation({ ...input, locale: "fr" })).toEqual(
      original,
    );
  });
  it("does not guess unknown source language or expose private metadata", () => {
    expect(
      projectManualReviewTranslation({
        ...input,
        translation: { ...translation, sourceLocale: null },
      }),
    ).toEqual({ title: "翻訳", body: "手動翻訳", translated: true });
  });
});
