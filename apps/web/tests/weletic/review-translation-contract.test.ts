import { describe, expect, it } from "vitest";
import { manualReviewTranslationInputSchema } from "../../lib/weletic/reviews/translation-contract";
import { reviewTranslationSourceDigest } from "../../lib/weletic/reviews/translation-source";

const save = {
  action: "save",
  reviewId: "review-1",
  locale: "ja",
  sourceLocale: "en",
  expectedInstallationGeneration: "generation-1",
  expectedReviewVersion: 1,
  expectedTranslationRevision: 0,
  title: "手動翻訳",
  body: "短い文章",
};
const source = {
  storeId: "store-1",
  reviewId: "review-1",
  title: "Original",
  body: "Original content",
};

describe("manual review translation merchant contract", () => {
  it("accepts an explicit first translation and shorter translated text", () => {
    expect(manualReviewTranslationInputSchema.parse(save)).toEqual(save);
  });
  it.each(["en", "ja", "vi"])(
    "supports %s without guessing the original language",
    (locale) => {
      expect(
        manualReviewTranslationInputSchema.parse({
          ...save,
          locale,
          sourceLocale: null,
        }),
      ).toMatchObject({ sourceLocale: null });
    },
  );
  it.each([
    { locale: "fr" },
    { sourceLocale: "ja" },
    { sourceLocale: "" },
    { title: " " },
    { body: " " },
    { title: "a".repeat(121) },
    { body: "a".repeat(10001) },
    { expectedReviewVersion: 0 },
    { expectedTranslationRevision: -1 },
    { expectedTranslationRevision: 1.5 },
    { expectedInstallationGeneration: "" },
    { expectedTranslationRevision: 2147483647 },
    { storeId: "foreign" },
    { actorId: "forged-owner" },
    { sourceDigest: "forged" },
    { rating: 5 },
    { verifiedPurchase: true },
    { incentivized: true },
    { publish: true },
  ])("rejects invalid input or unrelated authority %j", (patch) => {
    expect(
      manualReviewTranslationInputSchema.safeParse({ ...save, ...patch })
        .success,
    ).toBe(false);
  });
  it("requires explicit locale knowledge or null", () => {
    const { sourceLocale: omitted, ...missing } = save;
    expect(omitted).toBe("en");
    expect(manualReviewTranslationInputSchema.safeParse(missing).success).toBe(
      false,
    );
  });
  it("removes via a revision-fenced operation without content or publication authority", () => {
    const { title, body, sourceLocale, ...identity } = save;
    expect([title, body, sourceLocale]).toHaveLength(3);
    const remove = {
      ...identity,
      action: "remove",
      expectedTranslationRevision: 2,
    };
    expect(manualReviewTranslationInputSchema.parse(remove)).toEqual(remove);
    expect(
      manualReviewTranslationInputSchema.safeParse({
        ...remove,
        body: "replacement",
      }).success,
    ).toBe(false);
  });
});

describe("review translation source evidence", () => {
  it("is deterministic without leaking the original text", () => {
    const digest = reviewTranslationSourceDigest(source);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(reviewTranslationSourceDigest({ ...source }));
  });
  it.each([
    { storeId: "store-2" },
    { reviewId: "review-2" },
    { title: "Edited" },
    { body: "Edited" },
    { body: "Original content " },
  ])("distinguishes source/ownership changes %j", (patch) => {
    expect(reviewTranslationSourceDigest({ ...source, ...patch })).not.toBe(
      reviewTranslationSourceDigest(source),
    );
  });
  it("does not concatenate ambiguous field boundaries", () => {
    expect(
      reviewTranslationSourceDigest({ ...source, title: "ab", body: "c" }),
    ).not.toBe(
      reviewTranslationSourceDigest({ ...source, title: "a", body: "bc" }),
    );
  });
});
