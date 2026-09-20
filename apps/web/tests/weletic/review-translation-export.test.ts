import { describe, expect, it } from "vitest";
import { reviewTranslationExportSelection } from "../../lib/weletic/reviews/translation-export";

describe("private shopper translation export selection", () => {
  it("bounds the owned-review relation and repeats the tenant predicate", () => {
    const selection = reviewTranslationExportSelection("store_1");
    expect(selection.where).toEqual({
      storeId: "store_1",
      locale: { in: ["en", "ja", "vi"] },
    });
    expect(selection.take).toBe(3);
    expect(selection.orderBy).toEqual({ locale: "asc" });
    expect(selection.where).not.toHaveProperty("status");
  });

  it("exports retained content and state but no internal authority or digest", () => {
    expect(
      Object.keys(reviewTranslationExportSelection("store_1").select).sort(),
    ).toEqual(
      [
        "body",
        "createdAt",
        "locale",
        "redactedAt",
        "revision",
        "sourceLocale",
        "sourceReviewVersion",
        "status",
        "title",
        "updatedAt",
      ].sort(),
    );
  });
});
