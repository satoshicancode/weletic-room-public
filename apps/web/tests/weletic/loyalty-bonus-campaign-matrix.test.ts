import {
  assertNoCampaignOverlap,
  assertRunningCampaignImmutability,
  BonusCampaignPolicyError,
  bonusCampaignsOverlap,
  isTierEligibleForBonusCampaign,
  MAX_BONUS_CAMPAIGN_DURATION_DAYS,
  normalizeEligibleTierIds,
  parseBonusCampaignSchedule,
  resolveActiveBonusCampaign,
} from "@/lib/weletic/loyalty/bonus-campaign-policy";
import {
  calculateOrderEarn,
  calculateRefundPointsReversal,
  processOrderPointsEarn,
} from "@/lib/weletic/loyalty/earn";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// MOCKS & PRISMA HARNESS
// =============================================================================

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  accountUpdate: vi.fn(),
  grantFindUnique: vi.fn(),
  grantCreate: vi.fn(),
  grantUpdateMany: vi.fn(),
  orderLineEarnCreateMany: vi.fn(),
  orderLineEarnUpdateMany: vi.fn(),
  orderFindUnique: vi.fn(),
  programFindUnique: vi.fn(),
  ledgerAppend: vi.fn(),
  outboxJobEnqueue: vi.fn(),
  tierReviewSchedule: vi.fn(),
  resolvePolicyRevision: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const client: any = {
    weleticCommerceOrder: {
      findUnique: mocks.orderFindUnique,
    },
    weleticLoyaltyEarnGrant: {
      findUnique: mocks.grantFindUnique,
      create: mocks.grantCreate,
      updateMany: mocks.grantUpdateMany,
    },
    weleticLoyaltyOrderLineEarn: {
      createMany: mocks.orderLineEarnCreateMany,
      updateMany: mocks.orderLineEarnUpdateMany,
    },
    weleticLoyaltyAccount: {
      findUnique: mocks.accountFindUnique,
      update: mocks.accountUpdate,
    },
    weleticShopifyStore: {
      findUnique: vi.fn().mockResolvedValue({
        id: "store_123",
        operationalStatus: "ACTIVE",
        installationGeneration: 1,
      }),
    },
    weleticPointsLedgerEntry: {
      findFirst: vi.fn().mockResolvedValue({ sequenceNumber: 1 }),
      findUnique: vi.fn(),
      create: mocks.ledgerAppend,
    },
    weleticLoyaltyOutboxJob: {
      create: mocks.outboxJobEnqueue,
    },
    weleticLoyaltyProgram: {
      findUnique: mocks.programFindUnique,
      findFirst: vi.fn().mockResolvedValue({
        id: "prog_1",
        storeId: "store_123",
        status: "active",
        pointsPerCurrencyUnit: "1.0" as any,
      }),
    },
    weleticReconciliationIssue: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  client.$transaction = vi.fn(async (cb: any) => cb(client));
  return { prisma: client };
});

vi.mock(
  "@/lib/weletic/loyalty/earn-policy-revision",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, any>>();
    return {
      ...actual,
      resolveLoyaltyEarnPolicyRevisionAt: mocks.resolvePolicyRevision,
    };
  },
);

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: vi.fn(async (params: any) => {
    mocks.ledgerAppend(params);
    return {
      id: "ledger_entry_1",
      sequenceNumber: 2,
      pointsDelta: params.pointsDelta,
      balanceAfter: BigInt(1_000) + BigInt(params.pointsDelta),
      metadata: params.metadata,
    };
  }),
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn(async (params: any) => {
    mocks.outboxJobEnqueue(params);
    return { id: "outbox_1" };
  }),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: vi.fn(async (params: any) => {
    mocks.tierReviewSchedule(params);
  }),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn().mockResolvedValue(true),
  assertShopifyStoreMatchesInstallationGeneration: vi
    .fn()
    .mockResolvedValue(true),
}));

// =============================================================================
// DETERMINISTIC MATRIX SUITE
// =============================================================================

describe("Bonus Points Campaigns Engine — Matrix Test Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Matrix 1: Parameter Bounds & Schedule Validation
  // ---------------------------------------------------------------------------
  describe("Matrix 1: Parameter Bounds & Schedule Validation", () => {
    it("accepts valid multipliers within [1.5, 10.0] inclusive", () => {
      const validMultipliers = [
        1.5, 1.75, 2.0, 2.5, 3.3333, 5.0, 7.5, 9.99, 10.0,
      ];
      for (const multiplier of validMultipliers) {
        const schedule = parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-09-15T00:00:00.000Z",
          multiplier,
        });
        expect(schedule.multiplier).toBe(multiplier);
        expect(schedule.startAt).toEqual(new Date("2026-09-01T00:00:00.000Z"));
        expect(schedule.endAt).toEqual(new Date("2026-09-15T00:00:00.000Z"));
      }
    });

    it("rejects multipliers strictly below 1.5", () => {
      const invalidLow = [1.49, 1.4999, 1.0, 0.5, 0, -1.0, -10.0];
      for (const multiplier of invalidLow) {
        expect(() =>
          parseBonusCampaignSchedule({
            startAt: "2026-09-01T00:00:00.000Z",
            endAt: "2026-09-10T00:00:00.000Z",
            multiplier,
          }),
        ).toThrow(BonusCampaignPolicyError);
      }
    });

    it("rejects multipliers strictly above 10.0", () => {
      const invalidHigh = [10.01, 10.1, 11.0, 15.0, 100.0];
      for (const multiplier of invalidHigh) {
        expect(() =>
          parseBonusCampaignSchedule({
            startAt: "2026-09-01T00:00:00.000Z",
            endAt: "2026-09-10T00:00:00.000Z",
            multiplier,
          }),
        ).toThrow(BonusCampaignPolicyError);
      }
    });

    it("accepts durations up to exactly 31 days and rejects anything longer", () => {
      // Exactly 31 days
      const exact31 = parseBonusCampaignSchedule({
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-10-02T00:00:00.000Z", // 31 days
        multiplier: 2.0,
      });
      expect(exact31).toBeDefined();

      // 31 days + 1 millisecond
      expect(() =>
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-10-02T00:00:00.001Z",
          multiplier: 2.0,
        }),
      ).toThrow(
        `Bonus campaigns can run for at most ${MAX_BONUS_CAMPAIGN_DURATION_DAYS} days.`,
      );

      // 60 days
      expect(() =>
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-10-31T00:00:00.000Z",
          multiplier: 2.0,
        }),
      ).toThrow(BonusCampaignPolicyError);
    });

    it("enforces that campaign end must be strictly after start", () => {
      // Start === End
      expect(() =>
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-09-01T00:00:00.000Z",
          multiplier: 2.0,
        }),
      ).toThrow("Campaign end must be after its start.");

      // End < Start
      expect(() =>
        parseBonusCampaignSchedule({
          startAt: "2026-09-10T00:00:00.000Z",
          endAt: "2026-09-01T00:00:00.000Z",
          multiplier: 2.0,
        }),
      ).toThrow("Campaign end must be after its start.");
    });

    it("rejects invalid or unparseable timestamps and NaN multipliers", () => {
      expect(() =>
        parseBonusCampaignSchedule({
          startAt: "invalid-date",
          endAt: "2026-09-10T00:00:00.000Z",
          multiplier: 2.0,
        }),
      ).toThrow("Campaign start and end must be valid timestamps.");

      expect(() =>
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "invalid-date",
          multiplier: 2.0,
        }),
      ).toThrow("Campaign start and end must be valid timestamps.");

      expect(() =>
        parseBonusCampaignSchedule({
          startAt: "2026-09-01T00:00:00.000Z",
          endAt: "2026-09-10T00:00:00.000Z",
          multiplier: "not-a-number",
        }),
      ).toThrow(BonusCampaignPolicyError);
    });
  });

  // ---------------------------------------------------------------------------
  // Matrix 2: Half-Open Scheduling Windows [startAt, endAt)
  // ---------------------------------------------------------------------------
  describe("Matrix 2: Half-Open Scheduling Windows [startAt, endAt)", () => {
    const campaignA = {
      startAt: new Date("2026-09-01T00:00:00.000Z"),
      endAt: new Date("2026-09-08T00:00:00.000Z"),
    };

    it("confirms adjacent campaigns touching boundaries do NOT overlap", () => {
      // Campaign B starts exactly when Campaign A ends: [A.startAt, A.endAt) and [A.endAt, B.endAt)
      const campaignB = {
        startAt: campaignA.endAt, // 2026-09-08T00:00:00.000Z
        endAt: new Date("2026-09-15T00:00:00.000Z"),
      };
      expect(bonusCampaignsOverlap(campaignA, campaignB)).toBe(false);
      expect(bonusCampaignsOverlap(campaignB, campaignA)).toBe(false);

      // Campaign Preceding ends exactly when Campaign A starts
      const campaignPreceding = {
        startAt: new Date("2026-08-25T00:00:00.000Z"),
        endAt: campaignA.startAt, // 2026-09-01T00:00:00.000Z
      };
      expect(bonusCampaignsOverlap(campaignPreceding, campaignA)).toBe(false);
      expect(bonusCampaignsOverlap(campaignA, campaignPreceding)).toBe(false);
    });

    it("confirms overlap even by 1 millisecond intersection", () => {
      const campaignOverlappingBy1Ms = {
        startAt: new Date("2026-09-07T23:59:59.999Z"), // 1ms before A ends
        endAt: new Date("2026-09-15T00:00:00.000Z"),
      };
      expect(bonusCampaignsOverlap(campaignA, campaignOverlappingBy1Ms)).toBe(
        true,
      );
      expect(bonusCampaignsOverlap(campaignOverlappingBy1Ms, campaignA)).toBe(
        true,
      );
    });

    it("confirms overlap for subsets, supersets, and identical spans", () => {
      // Subset (enclosed within)
      const enclosed = {
        startAt: new Date("2026-09-02T00:00:00.000Z"),
        endAt: new Date("2026-09-07T00:00:00.000Z"),
      };
      expect(bonusCampaignsOverlap(campaignA, enclosed)).toBe(true);

      // Superset (enclosing)
      const enclosing = {
        startAt: new Date("2026-08-30T00:00:00.000Z"),
        endAt: new Date("2026-09-10T00:00:00.000Z"),
      };
      expect(bonusCampaignsOverlap(campaignA, enclosing)).toBe(true);

      // Identical
      expect(bonusCampaignsOverlap(campaignA, { ...campaignA })).toBe(true);
    });

    it("confirms disjoint campaigns with gaps do NOT overlap", () => {
      const campaignFarFuture = {
        startAt: new Date("2026-09-20T00:00:00.000Z"),
        endAt: new Date("2026-09-25T00:00:00.000Z"),
      };
      expect(bonusCampaignsOverlap(campaignA, campaignFarFuture)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Matrix 3: Store Non-Overlapping Invariant (assertNoCampaignOverlap)
  // ---------------------------------------------------------------------------
  describe("Matrix 3: Store Non-Overlapping Invariant (assertNoCampaignOverlap)", () => {
    const existingActiveCampaign = {
      id: "camp_existing_1",
      startAt: new Date("2026-09-01T00:00:00.000Z"),
      endAt: new Date("2026-09-08T00:00:00.000Z"),
      isActive: true,
      deletedAt: null,
    };

    it("throws BonusCampaignPolicyError when a new campaign overlaps with active store campaign", () => {
      expect(() =>
        assertNoCampaignOverlap({
          proposed: {
            id: "camp_new_overlap",
            startAt: new Date("2026-09-05T00:00:00.000Z"),
            endAt: new Date("2026-09-12T00:00:00.000Z"),
            isActive: true,
          },
          existingCampaigns: [existingActiveCampaign],
        }),
      ).toThrow(
        "Campaign schedule overlaps with an existing active campaign for this store.",
      );
    });

    it("allows non-overlapping proposed campaign (adjacent or separated by gap)", () => {
      // Adjacent
      expect(() =>
        assertNoCampaignOverlap({
          proposed: {
            id: "camp_adjacent",
            startAt: new Date("2026-09-08T00:00:00.000Z"),
            endAt: new Date("2026-09-15T00:00:00.000Z"),
            isActive: true,
          },
          existingCampaigns: [existingActiveCampaign],
        }),
      ).not.toThrow();

      // Separated by gap
      expect(() =>
        assertNoCampaignOverlap({
          proposed: {
            id: "camp_with_gap",
            startAt: new Date("2026-09-10T00:00:00.000Z"),
            endAt: new Date("2026-09-15T00:00:00.000Z"),
            isActive: true,
          },
          existingCampaigns: [existingActiveCampaign],
        }),
      ).not.toThrow();
    });

    it("allows updating an existing campaign without self-overlap conflict", () => {
      // Updating camp_existing_1 with same or shifted dates against the store list
      expect(() =>
        assertNoCampaignOverlap({
          proposed: {
            id: "camp_existing_1",
            startAt: new Date("2026-09-02T00:00:00.000Z"),
            endAt: new Date("2026-09-07T00:00:00.000Z"),
            isActive: true,
          },
          existingCampaigns: [existingActiveCampaign],
        }),
      ).not.toThrow();
    });

    it("ignores soft-deleted or inactive campaigns during overlap checks", () => {
      const softDeletedCampaign = {
        id: "camp_deleted",
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-08T00:00:00.000Z"),
        isActive: true,
        deletedAt: new Date("2026-08-31T00:00:00.000Z"),
      };

      const inactiveCampaign = {
        id: "camp_inactive",
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-08T00:00:00.000Z"),
        isActive: false,
        deletedAt: null,
      };

      // Proposed overlaps with deleted/inactive campaigns -> must NOT throw
      expect(() =>
        assertNoCampaignOverlap({
          proposed: {
            id: "camp_new",
            startAt: new Date("2026-09-02T00:00:00.000Z"),
            endAt: new Date("2026-09-05T00:00:00.000Z"),
            isActive: true,
          },
          existingCampaigns: [softDeletedCampaign, inactiveCampaign],
        }),
      ).not.toThrow();
    });

    it("allows proposed inactive campaign (isActive: false) even if overlapping", () => {
      expect(() =>
        assertNoCampaignOverlap({
          proposed: {
            id: "camp_proposed_inactive",
            startAt: new Date("2026-09-02T00:00:00.000Z"),
            endAt: new Date("2026-09-05T00:00:00.000Z"),
            isActive: false, // Inactive
          },
          existingCampaigns: [existingActiveCampaign],
        }),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Matrix 4: Running Campaign Immutability (assertRunningCampaignImmutability)
  // ---------------------------------------------------------------------------
  describe("Matrix 4: Running Campaign Immutability (assertRunningCampaignImmutability)", () => {
    const runningCampaign = {
      startAt: new Date("2026-09-01T00:00:00.000Z"),
      endAt: new Date("2026-09-10T00:00:00.000Z"),
      multiplier: 2.5,
      isActive: true,
    };
    const midFlightNow = new Date("2026-09-05T12:00:00.000Z");

    it("rejects mid-flight modifications to multiplier", () => {
      expect(() =>
        assertRunningCampaignImmutability({
          existing: runningCampaign,
          updates: { multiplier: 3.0 },
          now: midFlightNow,
        }),
      ).toThrow(
        "Active running campaigns cannot have their multiplier modified mid-flight.",
      );
    });

    it("rejects mid-flight modifications to startAt", () => {
      expect(() =>
        assertRunningCampaignImmutability({
          existing: runningCampaign,
          updates: { startAt: "2026-09-02T00:00:00.000Z" },
          now: midFlightNow,
        }),
      ).toThrow(
        "Active running campaigns cannot have their start date modified mid-flight.",
      );
    });

    it("rejects mid-flight modifications to endAt", () => {
      expect(() =>
        assertRunningCampaignImmutability({
          existing: runningCampaign,
          updates: { endAt: "2026-09-09T00:00:00.000Z" },
          now: midFlightNow,
        }),
      ).toThrow(
        "Active running campaigns cannot have their end date modified mid-flight.",
      );
    });

    it("permits mid-flight early deactivation (isActive: false)", () => {
      expect(() =>
        assertRunningCampaignImmutability({
          existing: runningCampaign,
          updates: { isActive: false },
          now: midFlightNow,
        }),
      ).not.toThrow();
    });

    it("permits mid-flight updates to name or description", () => {
      expect(() =>
        assertRunningCampaignImmutability({
          existing: runningCampaign,
          updates: {
            name: "Updated Campaign Title",
            description: "Updated Campaign Description",
          },
          now: midFlightNow,
        }),
      ).not.toThrow();
    });

    it("permits passing unchanged multiplier or timestamps without throwing", () => {
      expect(() =>
        assertRunningCampaignImmutability({
          existing: runningCampaign,
          updates: {
            multiplier: 2.5,
            startAt: runningCampaign.startAt.toISOString(),
            endAt: runningCampaign.endAt,
          },
          now: midFlightNow,
        }),
      ).not.toThrow();
    });

    it("permits modifications when campaign is NOT running (future, past, or inactive)", () => {
      // Future campaign (now < startAt)
      expect(() =>
        assertRunningCampaignImmutability({
          existing: runningCampaign,
          updates: { multiplier: 5.0, startAt: "2026-09-02T00:00:00.000Z" },
          now: new Date("2026-08-31T00:00:00.000Z"),
        }),
      ).not.toThrow();

      // Past campaign (now >= endAt)
      expect(() =>
        assertRunningCampaignImmutability({
          existing: runningCampaign,
          updates: { multiplier: 5.0 },
          now: new Date("2026-09-11T00:00:00.000Z"),
        }),
      ).not.toThrow();

      // Inactive campaign
      expect(() =>
        assertRunningCampaignImmutability({
          existing: { ...runningCampaign, isActive: false },
          updates: { multiplier: 5.0 },
          now: midFlightNow,
        }),
      ).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // Matrix 5: VIP Tier Targeting & Broadcast Resolution
  // ---------------------------------------------------------------------------
  describe("Matrix 5: VIP Tier Targeting & Broadcast Resolution", () => {
    it("handles broadcast campaigns (null, undefined, or empty eligibleTierIds)", () => {
      const broadcast1 = { eligibleTierIds: null };
      const broadcast2 = { eligibleTierIds: undefined };
      const broadcast3 = { eligibleTierIds: [] };

      // Eligible for shoppers with any tier or no tier
      expect(isTierEligibleForBonusCampaign(broadcast1, "wtier_gold")).toBe(
        true,
      );
      expect(isTierEligibleForBonusCampaign(broadcast1, null)).toBe(true);
      expect(isTierEligibleForBonusCampaign(broadcast2, "wtier_silver")).toBe(
        true,
      );
      expect(isTierEligibleForBonusCampaign(broadcast2, undefined)).toBe(true);
      expect(isTierEligibleForBonusCampaign(broadcast3, "wtier_bronze")).toBe(
        true,
      );
      expect(isTierEligibleForBonusCampaign(broadcast3, null)).toBe(true);
    });

    it("handles tier-targeted campaigns strictly matching eligible tier IDs", () => {
      const targeted = {
        eligibleTierIds: ["wtier_gold", "wtier_platinum"],
      };

      expect(isTierEligibleForBonusCampaign(targeted, "wtier_gold")).toBe(true);
      expect(isTierEligibleForBonusCampaign(targeted, "wtier_platinum")).toBe(
        true,
      );
      expect(isTierEligibleForBonusCampaign(targeted, "wtier_bronze")).toBe(
        false,
      );
      expect(isTierEligibleForBonusCampaign(targeted, null)).toBe(false);
      expect(isTierEligibleForBonusCampaign(targeted, undefined)).toBe(false);
    });

    it("normalizes eligible tier IDs and validates format", () => {
      expect(normalizeEligibleTierIds(null)).toEqual([]);
      expect(normalizeEligibleTierIds(undefined)).toEqual([]);
      expect(
        normalizeEligibleTierIds(["wtier_vip_1", "wtier_vip_1", "wtier_vip_2"]),
      ).toEqual(["wtier_vip_1", "wtier_vip_2"]);

      expect(() => normalizeEligibleTierIds(["invalid_tier_prefix"])).toThrow(
        "eligibleTierIds contains an invalid VIP tier ID.",
      );
      expect(() => normalizeEligibleTierIds("not-an-array")).toThrow(
        "eligibleTierIds must be an array of at most 100 tier IDs.",
      );
    });

    it("resolves active bonus campaign matching timestamp and tier filter", () => {
      const campaigns = [
        {
          id: "camp_past",
          startAt: new Date("2026-08-01T00:00:00.000Z"),
          endAt: new Date("2026-08-10T00:00:00.000Z"),
          multiplier: 2.0,
          isActive: true,
        },
        {
          id: "camp_current_targeted",
          startAt: new Date("2026-09-01T00:00:00.000Z"),
          endAt: new Date("2026-09-10T00:00:00.000Z"),
          multiplier: 3.0,
          isActive: true,
          eligibleTierIds: ["wtier_gold"],
        },
        {
          id: "camp_future",
          startAt: new Date("2026-09-15T00:00:00.000Z"),
          endAt: new Date("2026-09-20T00:00:00.000Z"),
          multiplier: 2.5,
          isActive: true,
        },
      ];

      const checkTime = new Date("2026-09-05T00:00:00.000Z");

      // Matching customer tier
      const resolvedGold = resolveActiveBonusCampaign({
        campaigns,
        occurredAt: checkTime,
        customerTierId: "wtier_gold",
      });
      expect(resolvedGold?.id).toBe("camp_current_targeted");

      // Non-matching customer tier
      const resolvedSilver = resolveActiveBonusCampaign({
        campaigns,
        occurredAt: checkTime,
        customerTierId: "wtier_silver",
      });
      expect(resolvedSilver).toBeNull();

      // Outside window (before campaign started)
      const resolvedBefore = resolveActiveBonusCampaign({
        campaigns,
        occurredAt: new Date("2026-08-25T00:00:00.000Z"),
        customerTierId: "wtier_gold",
      });
      expect(resolvedBefore).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Matrix 6: Multi-Currency Rational Order Earn Arithmetic (calculateOrderEarn)
  // ---------------------------------------------------------------------------
  describe("Matrix 6: Multi-Currency Rational Order Earn Arithmetic (calculateOrderEarn)", () => {
    it("calculates exact points for USD ($100.00 with 2x campaign, 1.0 rate)", () => {
      const result = calculateOrderEarn({
        netAmountCents: 10000, // $100.00 (2 decimals -> scale 100)
        currency: "USD",
        campaignMultiplier: 2.0,
        pointsPerCurrencyUnit: 1.0,
        ruleMultiplier: 1.0,
        tierMultiplier: 1.0,
      });

      expect(result.grossPoints).toBe(BigInt(200));
      expect(result.eligibleSubtotal).toBe(BigInt(10000));
      expect(result.effectiveMultiplier).toBe(2.0);
      expect(result.combinedFraction).toEqual({
        num: BigInt(2),
        den: BigInt(1),
      });
      expect(result.selectedCampaignId).toBeNull();
    });

    it("calculates exact points for JPY (¥10,000 zero-decimal currency with 1.5x campaign)", () => {
      const result = calculateOrderEarn({
        netAmountCents: 10000, // ¥10,000 (0 decimals -> scale 1)
        currency: "JPY",
        campaignMultiplier: 1.5,
      });

      // 10,000 * 1.5 = 15,000 points
      expect(result.grossPoints).toBe(BigInt(15000));
      expect(result.eligibleSubtotal).toBe(BigInt(10000));
      expect(result.effectiveMultiplier).toBe(1.5);
    });

    it("calculates exact points for VND (500,000₫ zero-decimal currency with 3.5x campaign)", () => {
      const result = calculateOrderEarn({
        netAmountCents: 500000, // 500,000₫ (0 decimals -> scale 1)
        currency: "VND",
        campaignMultiplier: 3.5,
      });

      // 500,000 * 3.5 = 1,750,000 points
      expect(result.grossPoints).toBe(BigInt(1750000));
      expect(result.eligibleSubtotal).toBe(BigInt(500000));
      expect(result.effectiveMultiplier).toBe(3.5);
    });

    it("calculates exact points for EUR (€50.50 with 2.5x campaign, 1.2x tier multiplier)", () => {
      const result = calculateOrderEarn({
        netAmountCents: 5050, // €50.50 (2 decimals -> scale 100)
        currency: "EUR",
        campaignMultiplier: 2.5,
        tierMultiplier: 1.2,
      });

      // 2.5 * 1.2 = 3.0 effective multiplier
      // 5050 * 3.0 / 100 = 15150 / 100 = 151.5 -> floor is 151 points
      expect(result.effectiveMultiplier).toBe(3.0);
      expect(result.grossPoints).toBe(BigInt(151));
    });

    it("calculates exact points for BHD (25.500 BHD 3-decimal currency with 2x campaign)", () => {
      const result = calculateOrderEarn({
        netAmountCents: 25500, // 25.500 BHD (3 decimals -> scale 1000)
        currency: "BHD",
        campaignMultiplier: 2.0,
      });

      // 25500 * 2 / 1000 = 51000 / 1000 = 51 points
      expect(result.grossPoints).toBe(BigInt(51));
    });

    it("allocates points proportionally across multi-line orders with exact penny conservation", () => {
      const result = calculateOrderEarn({
        currency: "USD",
        campaignMultiplier: 2.0,
        lines: [
          {
            orderLineId: "line_1",
            lineNetAmount: BigInt(6000),
            title: "Product A",
          }, // $60.00
          {
            orderLineId: "line_2",
            lineNetAmount: BigInt(4000),
            title: "Product B",
          }, // $40.00
        ],
      });

      expect(result.eligibleSubtotal).toBe(BigInt(10000));
      expect(result.grossPoints).toBe(BigInt(200));
      expect(result.lineAllocations).toHaveLength(2);

      const [line1, line2] = result.lineAllocations!;
      expect(line1.awardedPoints).toBe(BigInt(120));
      expect(line2.awardedPoints).toBe(BigInt(80));

      // Penny conservation guarantee
      const sumAllocated = line1.awardedPoints + line2.awardedPoints;
      expect(sumAllocated).toBe(result.grossPoints);
    });

    it("excludes excluded lines from earning points while non-excluded items earn points", () => {
      const result = calculateOrderEarn({
        currency: "USD",
        campaignMultiplier: 2.0,
        lines: [
          {
            orderLineId: "line_gift_card",
            lineNetAmount: BigInt(5000),
            isExcluded: true,
            exclusionReason: "gift_card",
          },
          {
            orderLineId: "line_merch",
            lineNetAmount: BigInt(5000),
            isExcluded: false,
          },
        ],
      });

      expect(result.eligibleSubtotal).toBe(BigInt(5000)); // Only line_merch is eligible
      expect(result.grossPoints).toBe(BigInt(100)); // 5000 * 2 / 100 = 100

      const [giftCardLine, merchLine] = result.lineAllocations!;
      expect(giftCardLine.awardedPoints).toBe(BigInt(0));
      expect(giftCardLine.isExcluded).toBe(true);
      expect(merchLine.awardedPoints).toBe(BigInt(100));
      expect(merchLine.isExcluded).toBe(false);
    });

    it("enforces minimum order subtotal requirement (minOrderSubtotalCents)", () => {
      const belowMin = calculateOrderEarn({
        netAmountCents: 2000, // $20.00
        minOrderSubtotalCents: 5000, // Min $50.00
        currency: "USD",
        campaignMultiplier: 2.0,
      });
      expect(belowMin.grossPoints).toBe(BigInt(0));

      const aboveMin = calculateOrderEarn({
        netAmountCents: 5500, // $55.00
        minOrderSubtotalCents: 5000, // Min $50.00
        currency: "USD",
        campaignMultiplier: 2.0,
      });
      expect(aboveMin.grossPoints).toBe(BigInt(110));
    });

    it("enforces maximum points per event cap (maxPointsPerEvent)", () => {
      const capped = calculateOrderEarn({
        netAmountCents: 100000, // $1,000.00 -> 2,000 points without cap
        currency: "USD",
        campaignMultiplier: 2.0,
        maxPointsPerEvent: 500, // Max 500 points
      });
      expect(capped.grossPoints).toBe(BigInt(500));
    });

    it("resolves active campaign from campaigns array and returns selectedCampaignId", () => {
      const campaigns = [
        {
          id: "camp_black_friday",
          multiplier: 3.0,
          startAt: "2026-11-20T00:00:00.000Z",
          endAt: "2026-11-30T00:00:00.000Z",
          isActive: true,
        },
      ];

      const orderTime = new Date("2026-11-25T12:00:00.000Z");

      const result = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns,
        orderOccurredAt: orderTime,
      });

      expect(result.selectedCampaignId).toBe("camp_black_friday");
      expect(result.campaignMultiplier).toBe(3.0);
      expect(result.grossPoints).toBe(BigInt(300));
    });

    it("applies an SKU-targeted multiplier only to matching lines", () => {
      const result = calculateOrderEarn({
        currency: "USD",
        orderOccurredAt: "2026-11-25T12:00:00.000Z",
        campaigns: [
          {
            id: "camp_sku",
            multiplier: 2,
            startAt: "2026-11-20T00:00:00.000Z",
            endAt: "2026-11-30T00:00:00.000Z",
            eligibleSkus: ["SKU-BONUS"],
          },
        ],
        lines: [
          {
            orderLineId: "line_match",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BONUS",
          },
          {
            orderLineId: "line_base",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BASE",
          },
        ],
      });

      expect(result.grossPoints).toBe(BigInt(300));
      expect(result.effectiveMultiplier).toBe(1.5);
      expect(
        result.lineAllocations?.map((line) => ({
          id: line.orderLineId,
          points: line.awardedPoints,
          matched: line.campaignMatched,
          multiplier: line.appliedCampaignMultiplier,
        })),
      ).toEqual([
        {
          id: "line_match",
          points: BigInt(200),
          matched: true,
          multiplier: "2",
        },
        {
          id: "line_base",
          points: BigInt(100),
          matched: false,
          multiplier: "1",
        },
      ]);
    });

    it("preserves Hare–Niemeyer base awards on nonmatching lines", () => {
      const lines = [
        {
          orderLineId: "line_base_a",
          lineNetAmount: BigInt(67),
          sku: "SKU-BASE-A",
        },
        {
          orderLineId: "line_base_b",
          lineNetAmount: BigInt(67),
          sku: "SKU-BASE-B",
        },
        {
          orderLineId: "line_bonus",
          lineNetAmount: BigInt(66),
          sku: "SKU-BONUS",
        },
      ];
      const base = calculateOrderEarn({ currency: "USD", lines });
      const targeted = calculateOrderEarn({
        currency: "USD",
        orderOccurredAt: "2026-11-25T12:00:00.000Z",
        campaigns: [
          {
            id: "camp_rounding",
            multiplier: 10,
            startAt: "2026-11-20T00:00:00.000Z",
            endAt: "2026-11-30T00:00:00.000Z",
            eligibleSkus: ["SKU-BONUS"],
          },
        ],
        lines,
      });

      expect(base.lineAllocations?.map((line) => line.awardedPoints)).toEqual([
        BigInt(1),
        BigInt(1),
        BigInt(0),
      ]);
      expect(
        targeted.lineAllocations?.map((line) => line.awardedPoints),
      ).toEqual([BigInt(1), BigInt(1), BigInt(5)]);
      expect(
        targeted.lineAllocations?.reduce(
          (sum, line) => sum + line.awardedPoints,
          BigInt(0),
        ),
      ).toBe(targeted.grossPoints);
    });

    it("caps only campaign bonus while base points still fit", () => {
      const result = calculateOrderEarn({
        currency: "USD",
        maxPointsPerEvent: 250,
        orderOccurredAt: "2026-11-25T12:00:00.000Z",
        campaigns: [
          {
            id: "camp_capped",
            multiplier: 2,
            startAt: "2026-11-20T00:00:00.000Z",
            endAt: "2026-11-30T00:00:00.000Z",
            eligibleSkus: ["SKU-BONUS"],
          },
        ],
        lines: [
          {
            orderLineId: "line_bonus",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BONUS",
          },
          {
            orderLineId: "line_base",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BASE",
          },
        ],
      });

      expect(result.grossPoints).toBe(BigInt(250));
      expect(result.lineAllocations?.map((line) => line.awardedPoints)).toEqual(
        [BigInt(150), BigInt(100)],
      );
      expect(
        result.lineAllocations?.reduce(
          (sum, line) => sum + line.awardedPoints,
          BigInt(0),
        ),
      ).toBe(BigInt(250));
    });

    it("matches collection-only campaigns against captured order-line membership", () => {
      const result = calculateOrderEarn({
        currency: "USD",
        orderOccurredAt: "2026-11-25T12:00:00.000Z",
        campaigns: [
          {
            id: "camp_collection",
            multiplier: 3,
            startAt: "2026-11-20T00:00:00.000Z",
            endAt: "2026-11-30T00:00:00.000Z",
            eligibleCollectionIds: ["gid://shopify/Collection/42"],
          },
        ],
        lines: [
          {
            orderLineId: "line_base",
            lineNetAmount: BigInt(10_000),
            collectionExternalIds: ["gid://shopify/Collection/7"],
          },
          {
            orderLineId: "line_match",
            lineNetAmount: BigInt(10_000),
            collectionExternalIds: ["gid://shopify/Collection/42"],
          },
        ],
      });

      expect(result.grossPoints).toBe(BigInt(400));
      expect(result.lineAllocations?.map((line) => line.awardedPoints)).toEqual(
        [BigInt(100), BigInt(300)],
      );
    });

    it("uses match-any semantics across combined SKU and collection lists", () => {
      const result = calculateOrderEarn({
        currency: "USD",
        orderOccurredAt: "2026-11-25T12:00:00.000Z",
        campaigns: [
          {
            id: "camp_combined",
            multiplier: 2,
            startAt: "2026-11-20T00:00:00.000Z",
            endAt: "2026-11-30T00:00:00.000Z",
            eligibleSkus: ["SKU-BONUS"],
            eligibleCollectionIds: ["gid://shopify/Collection/42"],
          },
        ],
        lines: [
          {
            orderLineId: "line_sku",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BONUS",
          },
          {
            orderLineId: "line_collection",
            lineNetAmount: BigInt(10_000),
            collectionExternalIds: ["gid://shopify/Collection/42"],
          },
          {
            orderLineId: "line_base",
            lineNetAmount: BigInt(10_000),
          },
        ],
      });

      expect(result.grossPoints).toBe(BigInt(500));
      expect(result.lineAllocations?.map((line) => line.awardedPoints)).toEqual(
        [BigInt(200), BigInt(200), BigInt(100)],
      );
    });

    it("intersects VIP eligibility with product targeting and fails missing snapshots as nonmatches", () => {
      const campaign = {
        id: "camp_gold_sku",
        multiplier: 2,
        startAt: "2026-11-20T00:00:00.000Z",
        endAt: "2026-11-30T00:00:00.000Z",
        eligibleTierIds: ["wtier_gold"],
        eligibleSkus: ["SKU-BONUS"],
      };
      const lines = [
        {
          orderLineId: "line_missing_snapshot",
          lineNetAmount: BigInt(10_000),
        },
      ];

      const gold = calculateOrderEarn({
        currency: "USD",
        orderOccurredAt: "2026-11-25T12:00:00.000Z",
        customerTierId: "wtier_gold",
        campaigns: [campaign],
        lines,
      });
      const silver = calculateOrderEarn({
        currency: "USD",
        orderOccurredAt: "2026-11-25T12:00:00.000Z",
        customerTierId: "wtier_silver",
        campaigns: [campaign],
        lines,
      });

      expect(gold.selectedCampaignId).toBe("camp_gold_sku");
      expect(gold.grossPoints).toBe(BigInt(100));
      expect(gold.lineAllocations?.[0].campaignMatched).toBe(false);
      expect(silver.selectedCampaignId).toBeNull();
      expect(silver.grossPoints).toBe(BigInt(100));
    });

    it("claws back the exact awarded points from a refunded targeted line", () => {
      const earned = calculateOrderEarn({
        currency: "USD",
        orderOccurredAt: "2026-11-25T12:00:00.000Z",
        campaigns: [
          {
            id: "camp_refund",
            multiplier: 2,
            startAt: "2026-11-20T00:00:00.000Z",
            endAt: "2026-11-30T00:00:00.000Z",
            eligibleSkus: ["SKU-BONUS"],
          },
        ],
        lines: [
          {
            orderLineId: "line_bonus",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BONUS",
          },
          {
            orderLineId: "line_base",
            lineNetAmount: BigInt(10_000),
            sku: "SKU-BASE",
          },
        ],
      });
      const lineEarns = earned.lineAllocations!.map((line, index) => ({
        id: `line_earn_${index}`,
        orderLineId: line.orderLineId,
        lineNetAmount: line.lineNetAmount,
        awardedPoints: line.awardedPoints,
        reversedPoints: BigInt(0),
        isExcluded: line.isExcluded,
      }));

      const reversal = calculateRefundPointsReversal({
        originalGrant: {
          id: "grant_targeted",
          grossPoints: earned.grossPoints,
          pendingPoints: BigInt(0),
          settledPoints: earned.grossPoints,
          reversedPoints: BigInt(0),
          eligibleSubtotalAmount: earned.eligibleSubtotal,
          lineEarns,
        },
        refundedLines: [
          { orderLineId: "line_bonus", cumulativeShopAmount: BigInt(10_000) },
        ],
      });

      expect(reversal.totalPointsToClawback).toBe(BigInt(200));
      expect(reversal.debitSettledPoints).toBe(BigInt(200));
      expect(reversal.lineClawbacks).toEqual([
        { orderLineId: "line_bonus", lineClawback: BigInt(200) },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  // Matrix 7: Immutable Ledger Metadata Tracking
  // ---------------------------------------------------------------------------
  describe("Matrix 7: Immutable Ledger Metadata Tracking", () => {
    it("records selectedCampaignId and campaignMultiplier in ledger entry during processOrderPointsEarn", async () => {
      const orderDate = new Date("2026-09-05T00:00:00.000Z");
      const order = {
        id: "order_test_1",
        storeId: "store_123",
        externalId: "gid://shopify/Order/111",
        orderName: "#1001",
        shopTotal: BigInt(20000),
        shopNet: BigInt(20000),
        currency: "USD",
        status: "paid",
        processedAt: orderDate,
        occurredAt: orderDate,
        createdAt: orderDate,
        shopper: {
          id: "shopper_1",
          storeId: "store_123",
          loyaltyAccount: {
            id: "acc_1",
            storeId: "store_123",
            status: "active",
            cachedPointsBalance: BigInt(500),
            programId: "prog_1",
            program: { id: "prog_1", storeId: "store_123" },
            currentTierId: null,
            currentTier: null,
            tierHistory: [],
          },
        },
        lines: [
          {
            id: "line_1",
            orderLineId: "line_1",
            shopGross: BigInt(10000),
            shopNet: BigInt(10000),
            shopDiscount: BigInt(0),
            quantity: 1,
            productId: "prod_1",
            variantId: "var_1",
            sku: "SKU-PROMO",
            collectionExternalIds: ["gid://shopify/Collection/42"],
            title: "Test Item",
          },
          {
            id: "line_2",
            orderLineId: "line_2",
            shopGross: BigInt(10000),
            shopNet: BigInt(10000),
            shopDiscount: BigInt(0),
            quantity: 1,
            productId: "prod_2",
            variantId: "var_2",
            sku: "SKU-BASE",
            collectionExternalIds: [],
            title: "Base Item",
          },
        ],
        refunds: [],
      };

      const campaign = {
        id: "camp_promo_99",
        multiplier: new Prisma.Decimal(2.5),
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-10T00:00:00.000Z"),
        isActive: true,
        eligibleTierIds: null,
        eligibleSkus: ["SKU-PROMO"],
        eligibleCollectionIds: [],
      };

      mocks.orderFindUnique.mockResolvedValue(order);
      mocks.accountFindUnique.mockResolvedValue(order.shopper.loyaltyAccount);
      mocks.accountUpdate.mockResolvedValue(order.shopper.loyaltyAccount);
      mocks.programFindUnique.mockResolvedValue({
        id: "prog_1",
        storeId: "store_123",
        status: "active",
        pointsPerCurrencyUnit: "1.0",
        rules: [
          {
            id: "rule_1",
            ruleType: "multiplier",
            multiplier: "1.0",
            isActive: true,
          },
        ],
        bonusCampaigns: [campaign],
        tiers: [],
      });
      mocks.grantFindUnique.mockResolvedValue(null);
      mocks.grantCreate.mockResolvedValue({
        id: "grant_123",
        selectedCampaignId: campaign.id,
        campaignMultiplier: campaign.multiplier,
      });

      const programData = {
        id: "prog_1",
        storeId: "store_123",
        status: "active",
        pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
        holdingPeriodDays: 0,
        pointsExpiryMonths: 12,
        earningRules: [
          {
            id: "rule_1",
            triggerCode: "order_paid",
            ruleType: "multiplier",
            priority: 1,
            multiplier: new Prisma.Decimal(1.0),
            isActive: true,
            eligibleTierIds: null,
            conditions: null,
            excludeDiscountedItems: false,
            excludeTaxesAndShipping: true,
            minOrderSubtotal: null,
            maxPointsPerEvent: null,
          },
        ],
        bonusCampaigns: [campaign],
      };
      mocks.programFindUnique.mockResolvedValue(programData);

      mocks.resolvePolicyRevision.mockResolvedValue({
        revisionId: "rev_1",
        revisionVersion: 1,
        revisionFingerprint: "fp_1",
        policy: {
          program: {
            id: "prog_1",
            status: "active",
            pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
            pointsExpiryMonths: 12,
            holdingPeriodDays: 0,
          },
          earningRules: [
            {
              id: "rule_1",
              triggerCode: "order_paid",
              ruleType: "multiplier",
              priority: 1,
              multiplier: new Prisma.Decimal(1.0),
              isActive: true,
              eligibleTierIds: null,
              conditions: null,
              excludeDiscountedItems: false,
              excludeTaxesAndShipping: true,
              minOrderSubtotal: null,
              maxPointsPerEvent: null,
            },
          ],
          bonusCampaigns: [campaign],
          tiers: [],
        },
      });

      await processOrderPointsEarn({
        storeId: "store_123",
        orderId: "order_test_1",
      });

      // Verify ledgerAppend received metadata with selectedCampaignId and campaignMultiplier
      expect(mocks.ledgerAppend).toHaveBeenCalled();
      const lastCall = mocks.ledgerAppend.mock.calls[0][0];
      expect(lastCall.entryType).toBe(WeleticPointsLedgerEntryType.EARN_ORDER);
      expect(lastCall.metadata).toMatchObject({
        selectedCampaignId: "camp_promo_99",
        campaignMultiplier: "2.5",
      });
      expect(mocks.grantCreate.mock.calls[0][0].data).toMatchObject({
        grossPoints: BigInt(350),
        calculationSnapshot: {
          campaignTargets: {
            eligibleSkus: ["SKU-PROMO"],
            eligibleCollectionIds: [],
          },
          lines: [
            {
              orderLineId: "line_1",
              campaignMatched: true,
              appliedCampaignMultiplier: "2.5",
              sku: "SKU-PROMO",
              collectionExternalIds: ["gid://shopify/Collection/42"],
            },
            {
              orderLineId: "line_2",
              campaignMatched: false,
              appliedCampaignMultiplier: "1",
              sku: "SKU-BASE",
              collectionExternalIds: [],
            },
          ],
        },
      });
      expect(mocks.orderLineEarnCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            orderLineId: "line_1",
            awardedPoints: BigInt(250),
            metadata: {
              sku: "SKU-PROMO",
              collectionExternalIds: ["gid://shopify/Collection/42"],
              selectedCampaignId: "camp_promo_99",
              campaignMatched: true,
              appliedCampaignMultiplier: "2.5",
            },
          }),
          expect.objectContaining({
            orderLineId: "line_2",
            awardedPoints: BigInt(100),
            metadata: {
              sku: "SKU-BASE",
              collectionExternalIds: [],
              selectedCampaignId: "camp_promo_99",
              campaignMatched: false,
              appliedCampaignMultiplier: "1",
            },
          }),
        ],
      });
    });

    it("records selectedCampaignId and campaignMultiplier in releaseHoldingPeriodGrant ledger entry", async () => {
      const grant = {
        id: "grant_holding_1",
        storeId: "store_123",
        accountId: "acc_1",
        orderId: "order_holding_1",
        status: "pending",
        grossPoints: BigInt(250),
        pendingPoints: BigInt(250),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        selectedCampaignId: "camp_summer_boost",
        campaignMultiplier: new Prisma.Decimal(2.5),
        order: {
          id: "order_holding_1",
          orderName: "#2001",
          status: "open",
        },
        lineEarns: [],
      };

      mocks.grantFindUnique.mockResolvedValue(grant);
      mocks.grantUpdateMany.mockResolvedValue({ count: 1 });
      mocks.accountFindUnique.mockResolvedValue({
        id: "acc_1",
        storeId: "store_123",
        status: "active",
        cachedPendingPoints: BigInt(250),
      });

      await releaseHoldingPeriodGrant({
        grantId: grant.id,
        storeId: "store_123",
      });

      expect(mocks.ledgerAppend).toHaveBeenCalled();
      const releaseCall = mocks.ledgerAppend.mock.calls[0][0];
      expect(releaseCall.entryType).toBe(
        WeleticPointsLedgerEntryType.EARN_ORDER,
      );
      expect(releaseCall.pointsDelta).toBe(BigInt(250));
      expect(releaseCall.pendingDelta).toBe(BigInt(-250));
      expect(releaseCall.metadata).toMatchObject({
        grantId: grant.id,
        orderId: grant.orderId,
        grossPoints: "250",
        releasedPoints: "250",
        selectedCampaignId: "camp_summer_boost",
        campaignMultiplier: "2.5",
      });
    });
  });
});
