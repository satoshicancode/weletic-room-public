import { reviewIncentiveDisclosure } from "@/lib/weletic/reviews/incentive-disclosure";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));

describe("saved invitation disclosure", () => {
  it("keeps historical null distinct from an explicit no-incentive promise", () => {
    expect(reviewIncentiveDisclosure(null)).toBeNull();
    const none = reviewIncentiveDisclosure({
      version: 1,
      award: { kind: "none" },
    });
    expect(none?.en[0]).toContain("No points or coupon");
    expect(none?.ja[0]).toContain("特典はありません");
    expect(none?.vi[0]).toContain("không có thưởng");
  });
  it.each(["en", "ja", "vi"] as const)(
    "preserves exact numbers in %s without floating-point rounding",
    (locale) => {
      const result = reviewIncentiveDisclosure({
        version: 1,
        award: {
          kind: "points",
          basePoints: "9007199254740993",
          photoBonusPoints: "7",
          videoBonusPoints: "12",
          maxPoints: "9223372036854775807",
        },
      });
      expect(result?.[locale][0]).toContain("9007199254740993");
      expect(result?.[locale][0]).toContain("9223372036854775807");
      expect(result?.[locale]).toHaveLength(4);
      expect(result?.[locale][0]).toContain(
        {
          en: "currently unavailable",
          ja: "現在は獲得できません",
          vi: "hiện chưa thể nhận",
        }[locale],
      );
      expect(JSON.stringify(result)).not.toContain("rewardDefinitionId");
    },
  );
  it("rejects malformed promises rather than displaying a generic reward", () => {
    expect(() => reviewIncentiveDisclosure(undefined)).toThrow();
    expect(() =>
      reviewIncentiveDisclosure({ version: 1, award: { kind: "points" } }),
    ).toThrow();
  });
});
