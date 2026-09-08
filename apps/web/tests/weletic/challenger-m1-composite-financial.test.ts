import { getGroupOrThrow } from "@/lib/api/groups/get-group-or-throw";
import { getPartnerForProgram } from "@/lib/api/partner-profile/get-partner-for-program";
import { getBountiesForPartner } from "@/lib/bounty/api/get-bounties-for-partner";
import { prisma } from "@/lib/prisma";
import {
  EnrolledPartnerCompositeSchema,
  EnrolledPartnerSchemaExtended,
} from "@/lib/zod/schemas/partners";
import { toCentsNumber } from "@dub/utils";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    programEnrollment: {
      findUnique: vi.fn(),
      aggregate: vi.fn(),
    },
    partner: {
      findUnique: vi.fn(),
    },
    partnerComment: {
      count: vi.fn(),
    },
    fraudEventGroup: {
      count: vi.fn(),
    },
  },
}));

vi.mock("@/lib/api/groups/get-group-or-throw", () => ({
  getGroupOrThrow: vi.fn(),
}));

vi.mock("@/lib/bounty/api/get-bounties-for-partner", () => ({
  getBountiesForPartner: vi.fn(),
}));

describe("Challenger M1: Composite Partner Query & Financial Precision Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const basePartnerRecord = {
    id: "pn_adv_1",
    name: "Empirical Tester",
    username: "empirical_tester",
    email: "tester@weletic.com",
    image: "https://avatar.com/test.png",
    description: "Stress Testing Partner",
    country: "US",
    preferredLocale: "en",
    timeZone: "UTC",
    preferredDisplayCurrency: "USD",
    preferredPayoutCurrency: "USD",
    companyName: null,
    profileType: "individual" as const,
    networkStatus: "approved" as const,
    defaultPayoutMethod: "connect" as const,
    paypalEmail: null,
    stripeConnectId: "acct_test",
    stripeRecipientId: null,
    payoutsEnabledAt: new Date("2026-01-01"),
    identityVerifiedAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    monthlyTraffic: null,
    industryInterests: [{ industryInterest: "Health_And_Fitness" }],
    preferredEarningStructures: [
      { preferredEarningStructure: "Revenue_Share" },
    ],
    salesChannels: [{ salesChannel: "Social_Media" }],
    programPartnerTags: [],
    platforms: [],
  };

  const baseEnrollmentRecord = {
    partnerId: "pn_adv_1",
    programId: "prog_adv_1",
    groupId: "grp_test",
    tenantId: "t_1",
    status: "approved" as const,
    totalClicks: 100,
    totalLeads: 20,
    totalConversions: 5,
    totalSales: 8,
    totalSaleAmount: 50000,
    totalCommissions: 10000,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const baseLinks = [
    {
      id: "lnk_adv_1",
      domain: "dub.sh",
      key: "emp1",
      url: "https://weletic.com",
      shortLink: "https://dub.sh/emp1",
      clicks: 100,
      leads: 20,
      conversions: 5,
      sales: 8,
      saleAmount: 50000,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      partnerGroupDefaultLinkId: null,
      lastLeadAt: new Date("2026-01-15"),
      lastConversionAt: new Date("2026-01-20"),
      comments: null,
    },
  ];

  describe("1. includeComposite=false Backward Compatibility Verification", () => {
    it("returns pristine payload matching EnrolledPartnerSchemaExtended without composite overhead", async () => {
      (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
        ...baseEnrollmentRecord,
        partner: basePartnerRecord,
        links: baseLinks,
        discount: null,
        applicationEvent: null,
      });

      const result = await getPartnerForProgram({
        partnerId: "pn_adv_1",
        programId: "prog_adv_1",
        includeComposite: false,
      });

      expect(result).toBeDefined();
      expect(result?.id).toBe("pn_adv_1");
      expect(result?.netRevenue).toBe(40000); // 50000 - 10000
      expect((result as any).group).toBeUndefined();
      expect((result as any).discountCodes).toBeUndefined();
      expect((result as any).referral).toBeUndefined();
      expect((result as any).eligibleBounties).toBeUndefined();
      expect((result as any).commentsCount).toBeUndefined();
      expect((result as any).fraudCount).toBeUndefined();

      // Zero side-effect database calls
      expect(prisma.programEnrollment.aggregate).not.toHaveBeenCalled();
      expect(prisma.partnerComment.count).not.toHaveBeenCalled();
      expect(prisma.fraudEventGroup.count).not.toHaveBeenCalled();
      expect(prisma.partner.findUnique).not.toHaveBeenCalled();
      expect(getGroupOrThrow).not.toHaveBeenCalled();
      expect(getBountiesForPartner).not.toHaveBeenCalled();

      // Validate against EnrolledPartnerSchemaExtended
      const parsed = EnrolledPartnerSchemaExtended.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it("defaults includeComposite to false when omitted", async () => {
      (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
        ...baseEnrollmentRecord,
        partner: basePartnerRecord,
        links: baseLinks,
        discount: null,
        applicationEvent: null,
      });

      const result = await getPartnerForProgram({
        partnerId: "pn_adv_1",
        programId: "prog_adv_1",
      });

      expect(result).toBeDefined();
      expect((result as any).group).toBeUndefined();
      expect(prisma.programEnrollment.aggregate).not.toHaveBeenCalled();
    });
  });

  describe("2. includeComposite=true Boundary Stress Testing", () => {
    it("handles fallback to default group when partnerGroup is null", async () => {
      const mockFallbackGroup = {
        id: "grp_default_123",
        name: "Default Partner Group",
        slug: "default",
        color: null,
        logo: null,
        wordmark: null,
        brandColor: null,
        holdingPeriodDays: 30,
        autoApprovePartnersEnabledAt: null,
        clickReward: null,
        leadReward: null,
        saleReward: null,
        referralReward: null,
        discount: null,
        utmTemplate: null,
        additionalLinks: null,
        maxPartnerLinks: 5,
        linkStructure: "short" as const,
        applicationFormData: null,
        applicationFormPublishedAt: null,
        landerData: null,
        landerPublishedAt: null,
        program: {
          id: "prog_adv_1",
          name: "Acme",
          slug: "acme",
          logo: null,
          domain: null,
          url: null,
          description: null,
          primaryRewardEvent: "sale" as const,
          minPayoutAmount: 5000,
          accountingCurrency: "USD",
          addedToMarketplaceAt: null,
          messagingEnabledAt: null,
          partnerNetworkEnabledAt: null,
          payoutMode: "internal" as const,
          defaultFolderId: "fld_1",
          defaultGroupId: "grp_default_123",
          supportEmail: null,
          helpUrl: null,
          termsUrl: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          startedAt: null,
          deactivatedAt: null,
        },
      };

      (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
        ...baseEnrollmentRecord,
        partner: basePartnerRecord,
        links: baseLinks,
        discount: null,
        applicationEvent: null,
        partnerGroup: null, // NULL partnerGroup triggers fallback
        discountCodes: null,
        program: {
          id: "prog_adv_1",
          defaultGroupId: "grp_default_123",
        },
      });

      (getGroupOrThrow as any).mockResolvedValueOnce(mockFallbackGroup);
      (prisma.programEnrollment.aggregate as any).mockResolvedValueOnce({
        _count: { _all: 0 },
        _sum: { totalConversions: null, totalSaleAmount: null },
      });
      (getBountiesForPartner as any).mockResolvedValueOnce([]);
      (prisma.partnerComment.count as any).mockResolvedValueOnce(0);
      (prisma.fraudEventGroup.count as any).mockResolvedValueOnce(0);

      const result = await getPartnerForProgram({
        partnerId: "pn_adv_1",
        programId: "prog_adv_1",
        includeComposite: true,
      });

      expect(getGroupOrThrow).toHaveBeenCalledWith({
        programId: "prog_adv_1",
        groupId: "grp_default_123",
        includeExpandedFields: true,
        includeBounties: true,
      });

      expect(result).toBeDefined();
      expect((result as any).group?.id).toBe("grp_default_123");
      expect((result as any).discountCodes).toEqual([]);
      expect((result as any).eligibleBounties).toEqual([]);
      expect((result as any).commentsCount).toBe(0);
      expect((result as any).fraudCount).toBe(0);
      expect((result as any).referral).toEqual({
        referredBy: null,
        stats: {
          totalPartners: 0,
          totalConversions: 0,
          totalSaleAmount: 0,
        },
      });

      const parsed = EnrolledPartnerCompositeSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it("correctly resolves referral stats with null sums and zero counts", async () => {
      (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
        ...baseEnrollmentRecord,
        partner: basePartnerRecord,
        links: baseLinks,
        discount: null,
        applicationEvent: {
          referralSource: "organic",
          referredByPartnerId: "pn_non_existent",
        },
        partnerGroup: null,
        discountCodes: [],
        program: {
          id: "prog_adv_1",
          defaultGroupId: "grp_default_123",
        },
      });

      (getGroupOrThrow as any).mockResolvedValueOnce(null);
      // Referred partner query returns null (partner was deleted or not found)
      (prisma.partner.findUnique as any).mockResolvedValueOnce(null);
      (prisma.programEnrollment.aggregate as any).mockResolvedValueOnce({
        _count: { _all: 0 },
        _sum: { totalConversions: null, totalSaleAmount: null },
      });
      (getBountiesForPartner as any).mockResolvedValueOnce(null);
      (prisma.partnerComment.count as any).mockResolvedValueOnce(0);
      (prisma.fraudEventGroup.count as any).mockResolvedValueOnce(0);

      const result = await getPartnerForProgram({
        partnerId: "pn_adv_1",
        programId: "prog_adv_1",
        includeComposite: true,
      });

      expect((result as any).referral?.referredBy).toBeNull();
      expect((result as any).referral?.stats).toEqual({
        totalPartners: 0,
        totalConversions: 0,
        totalSaleAmount: 0,
      });
      expect((result as any).eligibleBounties).toEqual([]);
      expect((result as any).discountCodes).toEqual([]);
    });

    it("handles workflow triggerConditions mapping to moveRules cleanly", async () => {
      const mockWorkflowGroup = {
        id: "grp_rules",
        name: "Auto-Promote Group",
        slug: "auto-promote",
        workflow: {
          triggerConditions: [
            { type: "sales_count_threshold", value: 50 },
            { type: "revenue_threshold", value: 1000000 },
          ],
        },
      };

      (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
        ...baseEnrollmentRecord,
        partner: basePartnerRecord,
        links: baseLinks,
        discount: null,
        applicationEvent: null,
        partnerGroup: mockWorkflowGroup,
        discountCodes: [],
        program: {
          id: "prog_adv_1",
          defaultGroupId: "grp_default_123",
        },
      });

      (prisma.programEnrollment.aggregate as any).mockResolvedValueOnce({
        _count: { _all: 2 },
        _sum: { totalConversions: 10, totalSaleAmount: 50000 },
      });
      (getBountiesForPartner as any).mockResolvedValueOnce([]);
      (prisma.partnerComment.count as any).mockResolvedValueOnce(2);
      (prisma.fraudEventGroup.count as any).mockResolvedValueOnce(1);

      const result = await getPartnerForProgram({
        partnerId: "pn_adv_1",
        programId: "prog_adv_1",
        includeComposite: true,
      });

      expect((result as any).group.moveRules).toEqual([
        { type: "sales_count_threshold", value: 50 },
        { type: "revenue_threshold", value: 1000000 },
      ]);
    });
  });

  describe("3. Financial Precision & toCentsNumber Invariants", () => {
    it("guarantees null and undefined values resolve to exact integer 0", () => {
      expect(toCentsNumber(null)).toBe(0);
      expect(toCentsNumber(undefined)).toBe(0);
    });

    it("guarantees BigInt conversions preserve exact integer precision", () => {
      expect(toCentsNumber(BigInt(0))).toBe(0);
      expect(toCentsNumber(BigInt(100))).toBe(100);
      expect(toCentsNumber(BigInt(500000000))).toBe(500000000);
      expect(toCentsNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it("preserves exact integer minor-unit netRevenue calculations without floating drift", () => {
      // Test cases with potential binary float representation issues (e.g. 0.1 + 0.2 != 0.3 in dollars, but 10 + 20 === 30 in cents)
      const testCases = [
        { sale: 1999, comm: 299, expectedNet: 1700 },
        { sale: 10005, comm: 3005, expectedNet: 7000 },
        { sale: 12345678, comm: 2345678, expectedNet: 10000000 },
        { sale: 0, comm: 0, expectedNet: 0 },
        { sale: 500, comm: 1000, expectedNet: -500 }, // Clawback/negative net
        { sale: 999999999999, comm: 111111111111, expectedNet: 888888888888 },
      ];

      for (const tc of testCases) {
        const net = toCentsNumber(tc.sale) - toCentsNumber(tc.comm);
        expect(net).toBe(tc.expectedNet);
        expect(Number.isInteger(net)).toBe(true);
      }
    });

    it("Property-based fuzzing: netRevenue invariant holds across 10,000 arbitrary integer and BigInt pairs", () => {
      fc.assert(
        fc.property(
          fc.tuple(
            fc.oneof(
              fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
              fc.bigInt({
                min: BigInt(-1_000_000_000),
                max: BigInt(1_000_000_000),
              }),
              fc.constant(null),
              fc.constant(undefined),
            ),
            fc.oneof(
              fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
              fc.bigInt({
                min: BigInt(-1_000_000_000),
                max: BigInt(1_000_000_000),
              }),
              fc.constant(null),
              fc.constant(undefined),
            ),
          ),
          ([sales, commissions]) => {
            const numSales = toCentsNumber(sales as any);
            const numCommissions = toCentsNumber(commissions as any);
            const net = numSales - numCommissions;

            expect(typeof net).toBe("number");
            expect(Number.isFinite(net)).toBe(true);
            expect(Number.isInteger(net)).toBe(true);
            expect(net).toBe(numSales - numCommissions);
          },
        ),
        { numRuns: 10000 },
      );
    });
  });

  describe("4. Adversarial Edge Case & Schema Conformance", () => {
    it("handles partner not found returning null cleanly", async () => {
      (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce(null);

      const result = await getPartnerForProgram({
        partnerId: "pn_non_existent",
        programId: "prog_123",
        includeComposite: true,
      });

      expect(result).toBeNull();
    });

    it("handles links with missing lead and conversion timestamps", async () => {
      (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
        ...baseEnrollmentRecord,
        partner: basePartnerRecord,
        links: [
          {
            ...baseLinks[0],
            lastLeadAt: null,
            lastConversionAt: null,
          },
          {
            ...baseLinks[0],
            id: "lnk_2",
            lastLeadAt: undefined,
            lastConversionAt: undefined,
          },
        ],
        discount: null,
        applicationEvent: null,
      });

      const result = await getPartnerForProgram({
        partnerId: "pn_adv_1",
        programId: "prog_adv_1",
        includeComposite: false,
      });

      expect(result?.lastLeadAt).toBeUndefined();
      expect(result?.lastConversionAt).toBeUndefined();
    });

    it("filters tags strictly to current programId", async () => {
      (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
        ...baseEnrollmentRecord,
        partner: {
          ...basePartnerRecord,
          programPartnerTags: [
            {
              partnerTag: { id: "tag_1", name: "VIP", programId: "prog_adv_1" },
            },
            {
              partnerTag: {
                id: "tag_2",
                name: "Foreign",
                programId: "prog_OTHER",
              },
            },
            { partnerTag: { id: "tag_3", name: "Global", programId: null } },
          ],
        },
        links: baseLinks,
        discount: null,
        applicationEvent: null,
      });

      const result = await getPartnerForProgram({
        partnerId: "pn_adv_1",
        programId: "prog_adv_1",
        includeComposite: false,
      });

      expect(result?.tags).toHaveLength(1);
      expect(result?.tags[0].id).toBe("tag_1");
    });
  });
});
