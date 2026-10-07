import { describe, expect, it } from "vitest";
import {
  CORE_FLOW_HANDLES,
  CoreLaunchDeferredError,
  assertCoreLaunchOperationalAction,
  isCoreLaunch,
} from "../src/core-launch-policy";
import { escapeCsvCell, escapeCsvUntrustedTextCell } from "../src/loyalty/csv";

describe("@weletic/contracts Contract Suite", () => {
  describe("Core Launch Policy", () => {
    it("identifies core launch profile correctly", () => {
      expect(isCoreLaunch({ WELETIC_FEATURE_PROFILE: "core-v1" })).toBe(true);
      expect(isCoreLaunch({ WELETIC_FEATURE_PROFILE: "legacy" })).toBe(false);
      expect(isCoreLaunch({})).toBe(false);
      expect(() =>
        isCoreLaunch({ WELETIC_FEATURE_PROFILE: "invalid-profile" }),
      ).toThrow("Unknown Weletic release profile");
    });

    it("defines immutable flow handles", () => {
      expect(CORE_FLOW_HANDLES).toContain("weletic-points-earned");
      expect(CORE_FLOW_HANDLES).toContain("weletic-reward-redeemed");
      expect(CORE_FLOW_HANDLES).toContain("weletic-review-submitted");
      expect(CORE_FLOW_HANDLES).toContain("weletic-review-published");
      expect(Object.isFrozen(CORE_FLOW_HANDLES)).toBe(true);
    });

    it("blocks deferred actions during core launch", () => {
      const origEnv = process.env.WELETIC_FEATURE_PROFILE;
      try {
        process.env.WELETIC_FEATURE_PROFILE = "core-v1";
        expect(() =>
          assertCoreLaunchOperationalAction("activity_points_earn"),
        ).toThrow(CoreLaunchDeferredError);
        expect(() =>
          assertCoreLaunchOperationalAction("loyalty_vip_campaign_write"),
        ).toThrow(CoreLaunchDeferredError);
      } finally {
        process.env.WELETIC_FEATURE_PROFILE = origEnv;
      }
    });

    it("permits allowed actions during core launch", () => {
      const origEnv = process.env.WELETIC_FEATURE_PROFILE;
      try {
        process.env.WELETIC_FEATURE_PROFILE = "core-v1";
        expect(() =>
          assertCoreLaunchOperationalAction("points_refund_clawback"),
        ).not.toThrow();
      } finally {
        process.env.WELETIC_FEATURE_PROFILE = origEnv;
      }
    });
  });

  describe("CSV Sanitization and Export Security", () => {
    it("escapes cells containing commas, quotes, and newlines", () => {
      expect(escapeCsvCell('Hello, "World"')).toBe('"Hello, ""World"""');
      expect(escapeCsvCell("Line1\nLine2")).toBe('"Line1\nLine2"');
      expect(escapeCsvCell(12345)).toBe("12345");
      expect(escapeCsvCell(null)).toBe("");
      expect(escapeCsvCell(undefined)).toBe("");
    });

    it("neutralizes CSV formula injection attacks in untrusted cells", () => {
      expect(escapeCsvUntrustedTextCell("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
      expect(escapeCsvUntrustedTextCell("+cmd|' /C calc'!A0")).toBe(
        "'+cmd|' /C calc'!A0",
      );
      expect(escapeCsvUntrustedTextCell("-100")).toBe("'-100");
      expect(escapeCsvUntrustedTextCell("@mention")).toBe("'@mention");
      expect(escapeCsvUntrustedTextCell("Safe Text")).toBe("Safe Text");
    });
  });
});
