import { reviewParticipationContentDigest } from "@/lib/weletic/reviews/incentive-claims";
import {
  reviewIncentivePolicyDigest,
  reviewIncentivePolicySnapshotSchema,
  selectReviewIncentiveAward,
} from "@/lib/weletic/reviews/incentive-policy";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));
const policy = {
  version: 1,
  award: {
    kind: "points",
    basePoints: "9007199254740993",
    photoBonusPoints: "7",
    videoBonusPoints: "12",
    maxPoints: "9223372036854775807",
  },
};

describe("immutable review incentive contracts", () => {
  it("selects one exact BigInt total with the existing max-media-bonus rule", () => {
    expect(
      selectReviewIncentiveAward(policy, { hasPhoto: true, hasVideo: true }),
    ).toEqual({ kind: "points", points: "9007199254741005" });
  });
  it("caps only the combined total without overflowing the ledger range", () => {
    expect(
      selectReviewIncentiveAward(
        {
          ...policy,
          award: {
            ...policy.award,
            basePoints: "9223372036854775807",
            maxPoints: "9223372036854775807",
          },
        },
        { hasPhoto: true, hasVideo: true },
      ),
    ).toEqual({ kind: "points", points: "9223372036854775807" });
  });
  it.each(["-1", "01", "1.5", "abc", "9223372036854775808"])(
    "rejects invalid point values %s",
    (basePoints) => {
      expect(
        reviewIncentivePolicySnapshotSchema.safeParse({
          ...policy,
          award: { ...policy.award, basePoints },
        }).success,
      ).toBe(false);
    },
  );
  it("rejects mixed points and coupon policies", () => {
    expect(() =>
      reviewIncentivePolicySnapshotSchema.parse({
        ...policy,
        award: { ...policy.award, terms: {} },
      }),
    ).toThrow();
  });
  it("canonicalizes property order and detects changed promises", () => {
    expect(
      reviewIncentivePolicyDigest({ award: policy.award, version: 1 }),
    ).toBe(reviewIncentivePolicyDigest(policy));
    expect(
      reviewIncentivePolicyDigest({
        ...policy,
        award: { ...policy.award, basePoints: "1" },
      }),
    ).not.toBe(reviewIncentivePolicyDigest(policy));
  });
  it("binds participation evidence to content and attached media, independent of array ordering", () => {
    const content = {
      id: "review",
      requestId: "request",
      title: "Honest feedback",
      body: "Disappointing purchase",
      mediaIds: ["b", "a"],
    };
    expect(reviewParticipationContentDigest(content)).toBe(
      reviewParticipationContentDigest({ ...content, mediaIds: ["a", "b"] }),
    );
    expect(reviewParticipationContentDigest(content)).not.toBe(
      reviewParticipationContentDigest({ ...content, body: "Changed content" }),
    );
  });
});
