import {
  DEFAULT_OPEN_REVIEW_POLICY,
  openReviewPolicySchema,
  openReviewPolicySnapshot,
  openReviewPolicyWriteSchema,
  openReviewRateCountWhere,
} from "@/lib/weletic/reviews/open-submission-policy";
import { describe, expect, it } from "vitest";

describe("open review policy contract", () => {
  it("defaults to no open writer or uploads", () => {
    expect(openReviewPolicySchema.parse(DEFAULT_OPEN_REVIEW_POLICY)).toEqual({
      enabled: false,
      photoUploadsEnabled: false,
      maxSubmissionsPer24Hours: 3,
    });
    expect(Object.isFrozen(DEFAULT_OPEN_REVIEW_POLICY)).toBe(true);
  });
  it.each([0, -1, 21, 1.5, Infinity, NaN, "3"])(
    "rejects an invalid submission limit %s",
    (maxSubmissionsPer24Hours) => {
      expect(
        openReviewPolicySchema.safeParse({
          ...DEFAULT_OPEN_REVIEW_POLICY,
          maxSubmissionsPer24Hours,
        }).success,
      ).toBe(false);
    },
  );
  it.each(["autoPublish", "verifiedPurchase", "incentive", "minimumRating"])(
    "rejects unsupported authority %s",
    (key) => {
      expect(
        openReviewPolicySchema.safeParse({
          ...DEFAULT_OPEN_REVIEW_POLICY,
          [key]: true,
        }).success,
      ).toBe(false);
    },
  );
  it("requires generation and a revision with room for the next INT", () => {
    const input = {
      expectedInstallationGeneration: "generation",
      expectedRevision: 0,
      policy: DEFAULT_OPEN_REVIEW_POLICY,
    };
    expect(openReviewPolicyWriteSchema.parse(input)).toEqual(input);
    for (const expectedRevision of [-1, 1.5, 2147483647]) {
      expect(
        openReviewPolicyWriteSchema.safeParse({ ...input, expectedRevision })
          .success,
      ).toBe(false);
    }
    expect(
      openReviewPolicyWriteSchema.safeParse({
        ...input,
        expectedInstallationGeneration: "",
      }).success,
    ).toBe(false);
  });
  it("has a stable digest and preserves explicit disabled revisions", () => {
    const original = openReviewPolicySnapshot(DEFAULT_OPEN_REVIEW_POLICY);
    expect(
      openReviewPolicySnapshot({
        maxSubmissionsPer24Hours: 3,
        photoUploadsEnabled: false,
        enabled: false,
      }),
    ).toEqual(original);
    for (const change of [
      { enabled: true },
      { photoUploadsEnabled: true },
      { maxSubmissionsPer24Hours: 4 },
    ]) {
      expect(
        openReviewPolicySnapshot({ ...DEFAULT_OPEN_REVIEW_POLICY, ...change })
          .contentDigest,
      ).not.toBe(original.contentDigest);
    }
  });
  it("counts owned attempts across generations, surfaces and moderation outcomes", () => {
    expect(
      openReviewRateCountWhere({
        storeId: "store",
        shopperId: "shopper",
        now: new Date("2026-09-20T12:00:00.000Z"),
      }),
    ).toEqual({
      storeId: "store",
      shopperId: "shopper",
      createdAt: { gt: new Date("2026-09-19T12:00:00.000Z") },
    });
  });
  it("rejects missing ownership and invalid clock values", () => {
    for (const change of [
      { storeId: "" },
      { shopperId: "" },
      { now: new Date(NaN) },
      { now: new Date(-8640000000000000) },
    ]) {
      expect(() =>
        openReviewRateCountWhere({
          storeId: "store",
          shopperId: "shopper",
          now: new Date(),
          ...change,
        }),
      ).toThrow();
    }
  });
});
