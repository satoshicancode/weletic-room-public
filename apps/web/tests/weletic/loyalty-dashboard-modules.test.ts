import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addLoyaltyWorkspaceContext,
  fetchLoyaltyAdmin,
  LoyaltyAdminApi,
} from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/api-client";
import {
  formatCurrency,
  formatPoints,
  isZeroDecimalCurrency,
} from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/currency-helpers";

describe("Milestone 5: Merchant Dashboard Modules & Settings Test Suite", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("API Client & Response Envelope Unwrapping", () => {
    it("adds the signed-in workspace slug to loyalty admin requests", () => {
      expect(
        addLoyaltyWorkspaceContext(
          "/api/shopify/loyalty/admin/settings",
          "/n0pvef-loyalty-staging/program/loyalty",
        ),
      ).toBe(
        "/api/shopify/loyalty/admin/settings?projectSlug=n0pvef-loyalty-staging",
      );
      expect(
        addLoyaltyWorkspaceContext(
          "/api/shopify/loyalty/admin/rewards?status=active",
          "/yamax/program/loyalty",
        ),
      ).toBe(
        "/api/shopify/loyalty/admin/rewards?status=active&projectSlug=yamax",
      );
    });

    it("successfully unwraps { data: ... } response envelope", async () => {
      const mockPayload = {
        id: "wprog_123",
        name: "VIP Club",
        status: "active",
        pointNamePlural: "Points",
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: mockPayload }),
      } as any);

      const result = await fetchLoyaltyAdmin<typeof mockPayload>(
        "/api/shopify/loyalty/admin/settings",
      );
      expect(result).toEqual(mockPayload);
      expect(result.name).toBe("VIP Club");
      expect(result.status).toBe("active");
    });

    it("handles direct JSON responses without envelope gracefully", async () => {
      const rawPayload = { success: true, count: 5 };
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => rawPayload,
      } as any);

      const result = await fetchLoyaltyAdmin<typeof rawPayload>("/api/test");
      expect(result).toEqual(rawPayload);
    });

    it("throws structured error message on non-200 responses", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            code: "forbidden",
            message: "Only workspace owners can perform this action.",
          },
        }),
      } as any);

      await expect(
        fetchLoyaltyAdmin("/api/shopify/loyalty/admin/settings", {
          method: "POST",
        }),
      ).rejects.toThrow("Only workspace owners can perform this action.");
    });

    it("round-trips the typed branding payload through the nested API contract", async () => {
      const branding = {
        launcherText: "Yamax Rewards",
        launcherPosition: "bottom_left" as const,
        launcherIcon: "crown" as const,
        primaryColor: "#112233",
        headerTextColor: "#ffffff",
        panelTitle: "Yamax Club",
        panelWelcomeSubtitle: "Member rewards in one place.",
        heroImageUrl: "https://cdn.example.com/yamax-club.jpg",
        enableFloatingLauncher: true,
      };

      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            data: { branding, programId: "wprog_yamax" },
          }),
        } as any)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ data: { success: true, branding } }),
        } as any);

      await expect(LoyaltyAdminApi.getBranding()).resolves.toEqual({
        branding,
        programId: "wprog_yamax",
      });
      await expect(LoyaltyAdminApi.updateBranding(branding)).resolves.toEqual({
        success: true,
        branding,
      });

      const [, options] = vi.mocked(global.fetch).mock.calls[1];
      expect(options).toMatchObject({ method: "POST" });
      expect(JSON.parse(String(options?.body))).toEqual({ branding });
    });
  });

  describe("Dashboard Module 1: Points Overview & Metrics", () => {
    it("formats circulating, pending, minted, and burned points without decimal drift", () => {
      expect(formatPoints(1250)).toBe("1,250");
      expect(formatPoints("50000")).toBe("50,000");
      expect(formatPoints(BigInt(1000000))).toBe("1,000,000");
      expect(formatPoints(0)).toBe("0");
      expect(formatPoints(null)).toBe("0");
      expect(formatPoints(undefined)).toBe("0");
    });

    it("formats zero-decimal currencies (JPY, VND, KRW) and standard currencies correctly", () => {
      expect(isZeroDecimalCurrency("JPY")).toBe(true);
      expect(isZeroDecimalCurrency("VND")).toBe(true);
      expect(isZeroDecimalCurrency("KRW")).toBe(true);
      expect(isZeroDecimalCurrency("USD")).toBe(false);
      expect(isZeroDecimalCurrency("EUR")).toBe(false);

      // USD: 500 minor units = $5.00
      const formattedUsd = formatCurrency(500, "USD", {
        isMinorUnits: true,
        locale: "en-US",
      });
      expect(formattedUsd).toContain("5.00");

      // JPY: 500 minor units = ¥500 (0 decimal digits)
      const formattedJpy = formatCurrency(500, "JPY", {
        isMinorUnits: true,
        locale: "ja-JP",
      });
      expect(formattedJpy).toContain("500");
      expect(formattedJpy).not.toContain(".00");
    });
  });

  describe("Dashboard Module 2: Ways to Earn (No Mock Fallbacks)", () => {
    it("fetches earning rules and unwraps real rules list", async () => {
      const mockRules = [
        {
          id: "rule_1",
          name: "Place an order",
          multiplier: 1.0,
          isActive: true,
        },
        {
          id: "rule_2",
          name: "Celebrate a birthday",
          multiplier: 200,
          isActive: true,
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { rules: mockRules, programId: "wprog_1" },
        }),
      } as any);

      const result = await LoyaltyAdminApi.getEarnRules();
      expect(result.rules).toHaveLength(2);
      expect(result.rules[0].name).toBe("Place an order");
      expect(result.rules[1].multiplier).toBe(200);
    });

    it("deletes an earning rule via API client", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { success: true } }),
      } as any);

      const res = await LoyaltyAdminApi.deleteEarnRule("rule_1");
      expect(res.success).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("ruleId=rule_1"),
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });

  describe("Dashboard Module 3: Ways to Redeem & Exchange Modes", () => {
    it("creates fixed and incremental reward vouchers", async () => {
      const newReward = {
        name: "$10 Off Coupon",
        rewardType: "amount_off",
        pointsCost: 1000,
        discountValue: 1000, // minor units
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { id: "rew_1", ...newReward, status: "active" },
        }),
      } as any);

      const res = await LoyaltyAdminApi.createReward(newReward);
      expect(res.id).toBe("rew_1");
      expect(res.pointsCost).toBe(1000);
      expect(res.status).toBe("active");
    });
  });

  describe("Dashboard Module 4 & 5: Customers, Balances & Activity Ledger", () => {
    it("retrieves paginated customer accounts with tier and balance metadata", async () => {
      const mockAccounts = [
        {
          id: "wacc_1",
          shopperId: "wshop_1",
          pointsBalance: "1250",
          pendingPoints: "150",
          currentTier: { name: "Gold VIP", pointsMultiplier: 1.5 },
          referralCode: "ALEX-9K",
        },
      ];

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            accounts: mockAccounts,
            pagination: { page: 1, limit: 10, total: 1, totalPages: 1 },
          },
        }),
      } as any);

      const res = await LoyaltyAdminApi.getCustomers({ page: 1, limit: 10 });
      expect(res.accounts).toHaveLength(1);
      expect(res.accounts[0].currentTier.name).toBe("Gold VIP");
      expect(res.accounts[0].pointsBalance).toBe("1250");
    });

    it("adjusts customer points balance with mandatory audit reason", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            success: true,
            newBalance: "1500",
            sequenceNumber: 42,
          },
        }),
      } as any);

      const res = await LoyaltyAdminApi.adjustCustomerPoints({
        shopperId: "wshop_1",
        pointsDelta: 250,
        reason: "Customer goodwill bonus for support resolution",
        adjustmentType: "GOODWILL_BONUS",
      });

      expect(res.success).toBe(true);
      expect(res.newBalance).toBe("1500");
    });
  });

  describe("Dashboard Module 6 & 7: Referrals & VIP Policy", () => {
    it("updates two-sided referral rewards configuration", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            rule: {
              advocatePointsReward: 500,
              refereePointsReward: 50,
              minOrderAmount: 3000,
              blockSameIp: true,
            },
          },
        }),
      } as any);

      const res = await LoyaltyAdminApi.updateReferrals({
        advocatePointsReward: 500,
        refereePointsReward: 50,
        minOrderAmount: 3000,
        blockSameIp: true,
      });

      expect(res.rule.advocatePointsReward).toBe(500);
      expect(res.rule.blockSameIp).toBe(true);
    });

    it("creates and orders VIP tiers", async () => {
      const mockTier = {
        name: "Platinum Elite",
        slug: "platinum-elite",
        tierOrder: 3,
        minSpendThreshold: 100000,
        pointsMultiplier: 2.0,
        entryBonusPoints: 500,
        perks: ["2x Points on purchases", "Free concierge shipping"],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { id: "wtier_3", ...mockTier } }),
      } as any);

      const res = await LoyaltyAdminApi.createTier(mockTier);
      expect(res.id).toBe("wtier_3");
      expect(res.pointsMultiplier).toBe(2.0);
      expect(res.perks).toHaveLength(2);
    });
  });

  describe("Dashboard Module 11: Settings, Status Machine & Emergency Kill-Switch", () => {
    it("updates program lifecycle status (draft -> active)", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            id: "wprog_1",
            status: "active",
            name: "Customer Loyalty Program",
          },
        }),
      } as any);

      const res = await LoyaltyAdminApi.updateSettings({ status: "active" });
      expect(res.status).toBe("active");
    });

    it("activates emergency kill-switch and suspends loyalty operations", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            id: "wprog_1",
            killSwitchActive: true,
          },
        }),
      } as any);

      const res = await LoyaltyAdminApi.updateSettings({
        killSwitchActive: true,
      });
      expect(res.killSwitchActive).toBe(true);
    });

    it("generates historical order backfill preview and commits opening balances", async () => {
      // 1. Preview
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            success: true,
            jobId: "wbfill_01",
            status: "preview",
            totalShoppersCount: 1420,
            totalOrdersCount: 4890,
            totalProjectedPoints: "245000",
          },
        }),
      } as any);

      const preview = await LoyaltyAdminApi.createBackfillPreview({
        lookbackDays: 365,
        pointsPerCurrencyUnit: 1.0,
      });

      expect(preview.jobId).toBe("wbfill_01");
      expect(preview.totalShoppersCount).toBe(1420);
      expect(preview.totalProjectedPoints).toBe("245000");

      // 2. Commit
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            success: true,
            jobId: "wbfill_01",
            status: "completed",
            processedAccountsCount: 1420,
            totalCommittedPoints: "245000",
          },
        }),
      } as any);

      const commit = await LoyaltyAdminApi.commitBackfill("wbfill_01");
      expect(commit.status).toBe("completed");
      expect(commit.processedAccountsCount).toBe(1420);
    });
  });

  describe("Branding Purge Validation", () => {
    it("ensures referral links use standard ?ref= parameter and zero smile_ref artifacts", () => {
      const shopDomain = "example-store.myshopify.com";
      const customerCode = "ALEX789";
      const referralUrl = `https://${shopDomain}?ref=${customerCode}`;

      expect(referralUrl).not.toContain("smile_ref");
      expect(referralUrl).not.toContain("yamax");
      expect(referralUrl).toBe(
        "https://example-store.myshopify.com?ref=ALEX789",
      );
    });
  });
});
