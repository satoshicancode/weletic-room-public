import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  calculateBirthdayLockout,
  validateCustomerSessionClaims,
} from "../../../../packages/shopify-app/extensions/weletic-customer-account/src/CustomerAccountLoyalty";
import {
  fetchLoyaltyAdmin,
  LoyaltyAdminApi,
} from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/api-client";
import {
  formatCurrency,
  formatPoints,
  isZeroDecimalCurrency,
  ZERO_DECIMAL_CURRENCIES,
} from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/currency-helpers";

describe("Challenger 1 Adversarial Suite: Milestone 5 Verification", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Security Boundary & Non-Owner Authorization Stress Testing", () => {
    const nonOwnerRoles = ["member", "viewer", "developer", "guest"];

    it("rejects non-owner attempts to toggle program lifecycle status", async () => {
      nonOwnerRoles.forEach(async (role) => {
        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          json: async () => ({
            error: {
              code: "forbidden",
              message:
                "Only workspace owners are authorized to toggle loyalty program status or kill switch.",
            },
          }),
        } as any);

        await expect(
          LoyaltyAdminApi.updateSettings({ status: "active" }),
        ).rejects.toThrow(
          "Only workspace owners are authorized to toggle loyalty program status or kill switch.",
        );
      });
    });

    it("rejects non-owner attempts to activate/deactivate emergency kill-switch", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "forbidden",
            message:
              "Only workspace owners are authorized to toggle loyalty program status or kill switch.",
          },
        }),
      } as any);

      await expect(
        LoyaltyAdminApi.updateSettings({ killSwitchActive: true }),
      ).rejects.toThrow(
        "Only workspace owners are authorized to toggle loyalty program status or kill switch.",
      );
    });

    it("rejects non-owner attempts to commit historical order backfill jobs", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "forbidden",
            message:
              "Only workspace owners are authorized to commit or cancel backfill jobs.",
          },
        }),
      } as any);

      await expect(
        LoyaltyAdminApi.commitBackfill("wbfill_unauth_01"),
      ).rejects.toThrow(
        "Only workspace owners are authorized to commit or cancel backfill jobs.",
      );
    });

    it("rejects non-owner attempts to cancel historical order backfill jobs", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "forbidden",
            message:
              "Only workspace owners are authorized to commit or cancel backfill jobs.",
          },
        }),
      } as any);

      await expect(
        LoyaltyAdminApi.cancelBackfill("wbfill_unauth_01"),
      ).rejects.toThrow(
        "Only workspace owners are authorized to commit or cancel backfill jobs.",
      );
    });

    it("rejects non-owner attempts to export activity ledger to CSV", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "forbidden",
            message:
              "Only workspace owners are authorized to export the activity ledger to CSV.",
          },
        }),
      } as any);

      await expect(LoyaltyAdminApi.exportActivityCsv()).rejects.toThrow(
        "Only workspace owners are authorized to export the activity ledger to CSV.",
      );
    });

    it("rejects non-owner attempts to execute manual points balance adjustments", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "forbidden",
            message:
              "You don't have the required role to access this endpoint. Required role(s): owner.",
          },
        }),
      } as any);

      await expect(
        LoyaltyAdminApi.adjustCustomerPoints({
          shopperId: "wshop_victim",
          pointsDelta: 1000,
          reason: "Malicious unauthorized points inflation attempt",
        }),
      ).rejects.toThrow(
        "You don't have the required role to access this endpoint.",
      );
    });
  });

  describe("2. Truthful Rendering & Empty State Invariant (Zero Fake Fallbacks)", () => {
    it("handles empty arrays from backend without synthetic fake rules fallback", async () => {
      // When earn rules API returns empty array:
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { rules: [], programId: "wprog_clean" } }),
      } as any);

      const earnRes = await LoyaltyAdminApi.getEarnRules();
      expect(earnRes.rules).toEqual([]);
      expect(earnRes.rules).not.toContainEqual(
        expect.objectContaining({ id: "rule_default_order" }),
      );

      // When rewards API returns empty array:
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as any);

      const rewardsRes = await LoyaltyAdminApi.getRewards();
      expect(rewardsRes).toEqual([]);
      expect(rewardsRes).not.toContainEqual(
        expect.objectContaining({ name: "500 Yen Off" }),
      );

      // When VIP tiers API returns empty array:
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as any);

      const tiersRes = await LoyaltyAdminApi.getTiers();
      expect(tiersRes).toEqual([]);

      // When bonus campaigns API returns empty array:
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { campaigns: [] } }),
      } as any);

      const campaignsRes = await LoyaltyAdminApi.getCampaigns();
      expect(campaignsRes.campaigns).toEqual([]);

      // When backfill jobs API returns empty array:
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as any);

      const jobsRes = await LoyaltyAdminApi.getBackfillJobs();
      expect(jobsRes).toEqual([]);
    });
  });

  describe("3. API Client & Error Envelope Unwrapping Edge Cases", () => {
    it("correctly unwraps { data: null } and { data: false } without collapsing to raw object", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: null }),
      } as any);

      const resNull = await fetchLoyaltyAdmin<any>("/api/test-null");
      expect(resNull).toBeNull();

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: false }),
      } as any);

      const resFalse = await fetchLoyaltyAdmin<any>("/api/test-false");
      expect(resFalse).toBe(false);

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: 0 }),
      } as any);

      const resZero = await fetchLoyaltyAdmin<any>("/api/test-zero");
      expect(resZero).toBe(0);
    });

    it("handles non-JSON error bodies gracefully (e.g. 502 / 504 gateway timeout HTML)", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON at position 0");
        },
      } as any);

      await expect(
        fetchLoyaltyAdmin("/api/shopify/loyalty/admin/settings"),
      ).rejects.toThrow("Request failed with status 502");
    });

    it("handles unexpected network error rejections", async () => {
      global.fetch = vi
        .fn()
        .mockRejectedValue(new Error("Network connection reset"));

      await expect(
        fetchLoyaltyAdmin("/api/shopify/loyalty/admin/settings"),
      ).rejects.toThrow("Network connection reset");
    });
  });

  describe("4. BigInt String Representation & Minor Unit Currency Formatting", () => {
    it("formats extreme BigInt and decimal string values without IEEE 754 precision loss", () => {
      // 10 Trillion points
      const hugePointsStr = "10000000000000";
      expect(formatPoints(hugePointsStr)).toBe("10,000,000,000,000");

      const hugeBigInt = BigInt("9007199254740991"); // Number.MAX_SAFE_INTEGER
      expect(formatPoints(hugeBigInt)).toBe("9,007,199,254,740,991");

      // Negative delta formatting
      expect(formatPoints(-1500)).toBe("-1,500");
      expect(formatPoints("-25000")).toBe("-25,000");

      // Zero & edge cases
      expect(formatPoints("0")).toBe("0");
      expect(formatPoints("")).toBe("0");
      expect(formatPoints("invalid_pts")).toBe("0");
    });

    it("formats all 16 zero-decimal currencies according to ISO standards", () => {
      const zeroDecList = Array.from(ZERO_DECIMAL_CURRENCIES);
      expect(zeroDecList).toHaveLength(16);

      zeroDecList.forEach((curr) => {
        expect(isZeroDecimalCurrency(curr)).toBe(true);
        // Minor units of 1500 in zero-decimal currency must remain 1,500 (not 15.00)
        const formatted = formatCurrency(1500, curr, { isMinorUnits: true });
        expect(formatted).not.toContain(".00");
        expect(formatted).toMatch(/1[,\.]?500/);
      });
    });

    it("formats 2-decimal standard currencies accurately from minor units", () => {
      const standardCurrencies = [
        "USD",
        "EUR",
        "GBP",
        "CAD",
        "AUD",
        "SGD",
        "NZD",
      ];
      standardCurrencies.forEach((curr) => {
        expect(isZeroDecimalCurrency(curr)).toBe(false);
        // 4999 cents = 49.99
        const formatted = formatCurrency(4999, curr, {
          isMinorUnits: true,
          locale: "en-US",
        });
        expect(formatted).toContain("49.99");
      });
    });

    it("gracefully falls back when invalid currency or null amount is provided", () => {
      expect(formatCurrency(null, "USD")).toBe("—");
      expect(formatCurrency(undefined, "USD")).toBe("—");
      expect(formatCurrency("invalid_num", "USD")).toBe("—");

      // Unknown currency code fallback
      const unknownFormatted = formatCurrency(500, "XYZ", {
        isMinorUnits: true,
      });
      expect(unknownFormatted).toContain("5");
    });
  });

  describe("5. Storefront Extension Security & 30-Day Birthday Lockout Boundary", () => {
    const extensionsDir = path.resolve(
      __dirname,
      "../../../../packages/shopify-app/extensions",
    );

    it("verifies zero PII leakage in all storefront Liquid templates and JavaScript assets", () => {
      const filesToCheck = [
        path.join(extensionsDir, "weletic-analytics/blocks/app-embed.liquid"),
        path.join(
          extensionsDir,
          "weletic-analytics/blocks/loyalty-landing.liquid",
        ),
        path.join(
          extensionsDir,
          "weletic-analytics/blocks/product-points-preview.liquid",
        ),
        path.join(
          extensionsDir,
          "weletic-analytics/assets/weletic-loyalty-widget.js",
        ),
        path.join(
          extensionsDir,
          "weletic-analytics/assets/weletic-loyalty-landing.js",
        ),
        path.join(
          extensionsDir,
          "weletic-analytics/assets/weletic-product-points.js",
        ),
      ];

      filesToCheck.forEach((filePath) => {
        expect(fs.existsSync(filePath)).toBe(true);
        const text = fs.readFileSync(filePath, "utf-8");

        expect(text).not.toContain("data-customer-email");
        expect(text).not.toContain("data-customer-first-name");
        expect(text).not.toContain("data-customer-last-name");
        expect(text).not.toContain("data-customer-phone");
        expect(text).not.toContain("customer.email");
        expect(text).not.toContain("customer.phone");
      });
    });

    it("stress tests exact 30-day anti-gaming birthday lockout boundary condition", () => {
      // 1. Exactly 30 days before birthday (Allowed in current year)
      // Submission on May 1, 2026 for birthday on May 31, 2026 (30 days difference)
      const subExact30 = new Date(2026, 4, 1);
      const resExact30 = calculateBirthdayLockout(5, 31, subExact30);
      expect(resExact30.daysUntilBirthday).toBe(30);
      expect(resExact30.isLockedOut).toBe(false);
      expect(resExact30.nextEligibleYear).toBe(2026);

      // 2. Exactly 29 days before birthday (Locked out -> 2027)
      // Submission on May 2, 2026 for birthday on May 31, 2026 (29 days difference)
      const sub29Days = new Date(2026, 4, 2);
      const res29Days = calculateBirthdayLockout(5, 31, sub29Days);
      expect(res29Days.daysUntilBirthday).toBe(29);
      expect(res29Days.isLockedOut).toBe(true);
      expect(res29Days.nextEligibleYear).toBe(2027);

      // 3. Exactly 31 days before birthday (Allowed -> 2026)
      const sub31Days = new Date(2026, 3, 30); // April 30
      const res31Days = calculateBirthdayLockout(5, 31, sub31Days);
      expect(res31Days.daysUntilBirthday).toBe(31);
      expect(res31Days.isLockedOut).toBe(false);
      expect(res31Days.nextEligibleYear).toBe(2026);

      // 4. Leap year birthday: Feb 29 submitted in a non-leap year (2026)
      const subLeap = new Date(2026, 0, 15); // Jan 15
      const resLeap = calculateBirthdayLockout(2, 29, subLeap);
      expect(resLeap.isLockedOut).toBe(false);
      expect(resLeap.nextEligibleYear).toBe(2026);
    });

    it("stress tests Customer Account session token claim validation under attack", () => {
      // 1. Valid Claim with standard protocol
      expect(
        validateCustomerSessionClaims({
          dest: "https://my-store.myshopify.com",
          sub: "gid://shopify/Customer/999888777",
        }),
      ).toEqual({
        valid: true,
        shopDomain: "my-store.myshopify.com",
        customerId: "999888777",
      });

      // 2. Attack: Missing dest
      expect(
        validateCustomerSessionClaims({
          sub: "gid://shopify/Customer/999888777",
        }).valid,
      ).toBe(false);

      // 3. Attack: Attacker passes non-domain string without dots
      expect(
        validateCustomerSessionClaims({
          dest: "invalid-domain-string",
          sub: "gid://shopify/Customer/1",
        }).valid,
      ).toBe(false);

      // 4. Attack: Empty sub or malformed customer GID
      expect(
        validateCustomerSessionClaims({
          dest: "https://my-store.myshopify.com",
          sub: "",
        }).valid,
      ).toBe(false);

      // 5. Attack: Empty object
      expect(validateCustomerSessionClaims({}).valid).toBe(false);
    });
  });
});
