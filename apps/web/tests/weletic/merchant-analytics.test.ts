import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  merchantAnalyticsRequestSchema,
  verifyMerchantAnalyticsResponse,
} from "../../lib/weletic/loyalty/merchant-analytics-contract";
import { readShopifyMerchantAnalyticsInTransaction } from "../../lib/weletic/shopify/merchant-analytics";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  overview: vi.fn(),
  store: vi.fn(),
  rewards: vi.fn(),
  referrals: vi.fn(),
}));
vi.mock("../../lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.authorize,
  ShopifyStaffAuthorizationError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));
vi.mock("../../lib/weletic/loyalty/analytics", () => ({
  getLoyaltyDashboardOverview: mocks.overview,
}));
const tx = {
  weleticShopifyStore: { findUnique: mocks.store },
  weleticRewardRedemption: { groupBy: mocks.rewards },
  weleticLoyaltyReferral: { groupBy: mocks.referrals },
} as unknown as Prisma.TransactionClient;
const filter = {
  startAt: "2026-09-01T00:00:00.000Z",
  endAt: "2026-09-30T23:59:59.999Z",
};
const read = { operation: "read", filter } as const;
const context = {
  tx,
  envelope: {},
  request: read,
  now: new Date("2026-09-09T00:00:00Z"),
};
const actor = {
  storeId: "store-a",
  projectId: "project-a",
  installationGeneration: "g1",
  owner: true,
};
const huge = BigInt("9007199254740993");
function overview() {
  return {
    liability: {
      totalCirculatingPoints: huge,
      totalPendingPoints: BigInt(5),
      negativeBalancePointsDebt: BigInt(3),
      totalLiabilityMinorUnits: huge,
      totalPendingLiabilityMinorUnits: BigInt(5),
      totalPotentialLiabilityMinorUnits: huge + BigInt(5),
      totalMembersCount: 2,
      activeMembersCount: 1,
    },
    healthMetrics: {
      totalPointsEarned: huge,
      totalPointsRedeemed: BigInt(2),
      totalPointsRefundReversed: BigInt(1),
      totalPointsExpired: BigInt(0),
      totalPointsBackfilled: BigInt(0),
      totalPointsBackfillCorrected: BigInt(0),
      totalManualAdjustmentCredits: BigInt(0),
      totalManualAdjustmentDebits: BigInt(0),
      financialDataQuality: { status: "available", reason: null },
      referralMetrics: {
        totalReferrals: 1,
        successfulReferrals: 1,
        referralRevenueMinorUnits: huge,
        referralRewardCostMinorUnits: BigInt(10),
      },
    },
    tierDistribution: [
      {
        name: '=HYPERLINK("https://invalid.example")',
        memberCount: 1,
        totalPointsBalance: huge,
        totalRollingSpend: huge,
      },
    ],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue(actor);
  mocks.store.mockResolvedValue({
    projectId: "project-a",
    program: { accountingCurrency: "JPY" },
    loyaltyProgram: {
      liabilityValuationCurrency: "JPY",
      liabilityMinorUnitsNumerator: BigInt(1),
      liabilityPointsDenominator: BigInt(1),
    },
  });
  mocks.overview.mockResolvedValue(overview());
  mocks.rewards.mockResolvedValue([
    {
      status: "used",
      artifactKind: "discount_code",
      _count: { _all: 2 },
      _sum: { pointsSpent: huge },
    },
  ]);
  mocks.referrals.mockResolvedValue([
    { status: "rewarded", _count: { _all: 1 } },
  ]);
});
describe("merchant analytics", () => {
  it("uses one authorized store and transaction and retains exact values", async () => {
    const result = await readShopifyMerchantAnalyticsInTransaction(context);
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope: {},
      permission: "analytics.read",
    });
    expect(mocks.overview).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        storeId: "store-a",
        dateRange: {
          startDate: new Date(filter.startAt),
          endDate: new Date(filter.endAt),
        },
      }),
    );
    for (const query of [mocks.rewards, mocks.referrals])
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            storeId: "store-a",
            createdAt: {
              gte: new Date(filter.startAt),
              lte: new Date(filter.endAt),
            },
          },
        }),
      );
    expect(result.snapshot.liability.currentMinorUnits).toBe(huge.toString());
    expect(result.snapshot.rewards[0].pointsSpent).toBe(huge.toString());
    expect(result.download).toBeNull();
    expect(verifyMerchantAnalyticsResponse(read, result)).toEqual(result);
    expect(JSON.stringify(result)).not.toMatch(/shopperId|email|discountCode/);
  });
  it("fails closed on cross-workspace identity before analytics reads", async () => {
    mocks.store.mockResolvedValue({ projectId: "project-b" });
    await expect(
      readShopifyMerchantAnalyticsInTransaction(context),
    ).rejects.toThrow("invalid_actor");
    expect(mocks.overview).not.toHaveBeenCalled();
  });
  it("does not query financial data when authorization fails", async () => {
    mocks.authorize.mockRejectedValue(new Error("denied"));
    await expect(
      readShopifyMerchantAnalyticsInTransaction(context),
    ).rejects.toThrow("denied");
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("shows missing valuations as null, not a fabricated 1:1 monetary value", async () => {
    mocks.store.mockResolvedValue({
      projectId: "project-a",
      program: { accountingCurrency: "JPY" },
      loyaltyProgram: null,
    });
    const { snapshot } =
      await readShopifyMerchantAnalyticsInTransaction(context);
    expect(snapshot.financialStatus).toBe("temporarily_unavailable");
    expect(snapshot.liability.currentMinorUnits).toBeNull();
    expect(snapshot.referralEconomics.revenueMinorUnits).toBeNull();
    expect(snapshot.liability.circulatingPoints).toBe(huge.toString());
  });
  it("isolates referral currency errors without hiding valid liability", async () => {
    const value = overview();
    value.healthMetrics.financialDataQuality = {
      status: "data_quality_error",
      reason: "Currency mismatch",
    } as any;
    mocks.overview.mockResolvedValue(value);
    const { snapshot } =
      await readShopifyMerchantAnalyticsInTransaction(context);
    expect(snapshot.financialStatus).toBe("data_quality_error");
    expect(snapshot.liability.currentMinorUnits).toBe(huge.toString());
    expect(snapshot.referralEconomics.costMinorUnits).toBeNull();
  });
  it.each(["csv", "json"] as const)(
    "exports the same exact aggregate snapshot as %s",
    async (format) => {
      const request = {
        operation: "export",
        filter,
        format,
        expectedInstallationGeneration: "g1",
      } as const;
      const result = await readShopifyMerchantAnalyticsInTransaction({
        ...context,
        request,
      });
      expect(mocks.authorize).toHaveBeenCalledWith(
        expect.objectContaining({ permission: "analytics.export" }),
      );
      expect(verifyMerchantAnalyticsResponse(request, result)).toEqual(result);
      if (format === "json")
        expect(JSON.parse(result.download!.content)).toEqual(result.snapshot);
      else {
        expect(result.download!.content).toContain("\"'=HYPERLINK");
        expect(result.download!.content).toContain(huge.toString());
      }
    },
  );
  it.each([
    { owner: false, generation: "g1", error: "access_denied" },
    { owner: true, generation: "old", error: "invalid_actor" },
  ])("rejects unsafe export %j", async ({ owner, generation, error }) => {
    mocks.authorize.mockResolvedValue({ ...actor, owner });
    await expect(
      readShopifyMerchantAnalyticsInTransaction({
        ...context,
        request: {
          operation: "export",
          filter,
          format: "json",
          expectedInstallationGeneration: generation,
        },
      }),
    ).rejects.toThrow(error);
    expect(mocks.overview).not.toHaveBeenCalled();
  });
  it.each([
    { ...read, storeId: "store-b" },
    { ...read, filter: { ...filter, startAt: "bad" } },
    { ...read, filter: { ...filter, startAt: "2027-01-01T00:00:00Z" } },
    { operation: "export", filter, format: "json" },
  ])("rejects malformed and tenant-injected input %j", (input) => {
    expect(merchantAnalyticsRequestSchema.safeParse(input).success).toBe(false);
  });
  it("rejects mismatched filters and unexpected fields from the gateway", async () => {
    const result = await readShopifyMerchantAnalyticsInTransaction(context);
    expect(() =>
      verifyMerchantAnalyticsResponse(read, {
        ...result,
        snapshot: {
          ...result.snapshot,
          filter: { startAt: null, endAt: null },
        },
      }),
    ).toThrow();
    expect(() =>
      verifyMerchantAnalyticsResponse(read, {
        ...result,
        shopperEmail: "private@example.com",
      }),
    ).toThrow();
  });
});
