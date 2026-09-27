import {
  assertCoreLaunchJob,
  assertCoreLaunchOperationalAction,
  assertCoreLaunchReviewAward,
  assertCoreLaunchReward,
  CoreLaunchDeferredError,
  isCoreLaunch,
} from "@/lib/weletic/core-launch-policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCoreLaunchMerchantRoute } from "../../../../packages/shopify-app/app/core-launch-routes.server";

afterEach(() => vi.unstubAllEnvs());
describe("core launch boundaries", () => {
  it("rejects misspelled profiles instead of enabling legacy capabilities", () => {
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-vl");
    expect(() => isCoreLaunch()).toThrow("Unknown");
  });
  it("blocks new deferred work while preserving correction and privacy work", () => {
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
    expect(() =>
      assertCoreLaunchOperationalAction("signup_points_earn"),
    ).toThrow(CoreLaunchDeferredError);
    expect(() =>
      assertCoreLaunchOperationalAction("loyalty_referral_configuration_write"),
    ).toThrow(CoreLaunchDeferredError);
    for (const job of [
      "HISTORICAL_IMPORT_COMMIT",
      "BIRTHDAY_REWARD",
      "TIER_REVIEW",
    ])
      expect(() => assertCoreLaunchJob(job, {})).toThrow(
        CoreLaunchDeferredError,
      );
    for (const job of [
      "DISCOUNT_ISSUE",
      "DISCOUNT_REVOKE",
      "PRIVACY_REDACT",
      "HISTORICAL_IMPORT_ROLLBACK",
    ])
      expect(() => assertCoreLaunchJob(job, {})).not.toThrow();
    expect(() =>
      assertCoreLaunchJob("REVIEW_REQUEST_EMAIL", { requestId: "initial" }),
    ).not.toThrow();
    expect(() =>
      assertCoreLaunchJob("REVIEW_REQUEST_EMAIL", { reminderId: "reminder" }),
    ).toThrow(CoreLaunchDeferredError);
    expect(() =>
      assertCoreLaunchJob("FLOW_TRIGGER", {
        handle: "weletic-review-published",
      }),
    ).not.toThrow();
    expect(() =>
      assertCoreLaunchJob("FLOW_TRIGGER", {
        handle: "weletic-vip-tier-changed",
      }),
    ).toThrow(CoreLaunchDeferredError);
  });
  it("allows fixed one-time coupons and neutral participation awards only", () => {
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
    expect(() =>
      assertCoreLaunchReward({
        rewardType: "amount_off",
        exchangeType: "fixed",
        purchaseType: "one_time",
      }),
    ).not.toThrow();
    expect(() =>
      assertCoreLaunchReward({
        rewardType: "amount_off",
        exchangeType: "fixed",
        purchaseType: "both",
      }),
    ).toThrow(CoreLaunchDeferredError);
    expect(() =>
      assertCoreLaunchReviewAward({
        kind: "points",
        photoBonusPoints: "0",
        videoBonusPoints: "0",
      }),
    ).not.toThrow();
    expect(() =>
      assertCoreLaunchReviewAward({
        kind: "points",
        photoBonusPoints: "10",
        videoBonusPoints: "0",
      }),
    ).toThrow(CoreLaunchDeferredError);
  });
  it("rejects direct Remix URLs including trailing slashes, retaining operational row exports", () => {
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
    for (const path of [
      "/loyalty-imports",
      "/api/merchant/referral-configuration/",
      "/api/merchant/analytics",
    ])
      expect(() =>
        assertCoreLaunchMerchantRoute(
          new Request(`https://app.example${path}`),
        ),
      ).toThrow();
    expect(() =>
      assertCoreLaunchMerchantRoute(
        new Request("https://app.example/api/merchant/analytics/ledger-rows"),
      ),
    ).not.toThrow();
  });
});
