import { reviewIncentiveDisclosure } from "@/lib/weletic/reviews/incentive-disclosure";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: vi.fn(),
}));
afterEach(() => vi.unstubAllEnvs());

describe("saved invitation disclosure", () => {
  it.each([
    ["100", "100", "100"],
    ["100", "40", "40"],
    ["9007199254740993", "9223372036854775807", "9007199254740993"],
    ["100", "0", "0"],
  ])(
    "core participation disclosure uses the exact capped award %s/%s",
    (basePoints, maxPoints, expected) => {
      vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
      const result = reviewIncentiveDisclosure({
        version: 1,
        award: {
          kind: "points",
          basePoints,
          maxPoints,
          photoBonusPoints: "0",
          videoBonusPoints: "0",
        },
      })!;
      for (const locale of ["en", "ja", "vi"] as const) {
        expect(result[locale]).toHaveLength(3);
        expect(result[locale][0]).toContain(expected);
        expect(result[locale].join(" ")).not.toMatch(
          /video|store review|bonus|動画|写真|ストアレビュー|thưởng ảnh|cửa hàng/i,
        );
      }
      expect(result.en.join(" ")).toContain("At most one reward per order");
      expect(result.en.join(" ")).toContain(
        "independent of rating or publication",
      );
      expect(result.en.join(" ")).toContain(
        "does not enroll you automatically",
      );
      expect(result.ja.join(" ")).toContain("評価や公開状況に左右されず");
      expect(result.ja.join(" ")).toContain("自動登録はされません");
      expect(result.vi.join(" ")).toContain(
        "không phụ thuộc xếp hạng hay việc đăng công khai",
      );
      expect(result.vi.join(" ")).toContain("không tự động đăng ký");
    },
  );
  it("keeps saved media-bonus promises identical across release profiles", () => {
    const snapshot = {
      version: 1,
      award: {
        kind: "points",
        basePoints: "100",
        maxPoints: "150",
        photoBonusPoints: "10",
        videoBonusPoints: "20",
      },
    };
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "legacy");
    const legacy = reviewIncentiveDisclosure(snapshot);
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
    expect(reviewIncentiveDisclosure(snapshot)).toEqual(legacy);
  });
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
