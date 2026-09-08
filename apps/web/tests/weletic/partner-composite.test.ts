import { getPartnerForProgram } from "@/lib/api/partner-profile/get-partner-for-program";
import { prisma } from "@/lib/prisma";
import { EnrolledPartnerCompositeSchema } from "@/lib/zod/schemas/partners";
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
  getGroupOrThrow: vi.fn().mockResolvedValue({
    id: "grp_default",
    name: "Default Group",
    slug: "default",
    workflow: null,
  }),
}));

vi.mock("@/lib/bounty/api/get-bounties-for-partner", () => ({
  getBountiesForPartner: vi.fn().mockResolvedValue([
    {
      id: "bty_123",
      name: "Launch Promo",
      type: "submission",
    },
  ]),
}));

describe("Consolidated Composite Partner API & Selective Projections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockBasePartner = {
    id: "pn_test123",
    name: "Alex Creator",
    username: "alexcreator",
    email: "alex@creator.com",
    image: "https://avatar.com/alex.png",
    description: "Fitness Influencer",
    country: "US",
    preferredLocale: "en",
    timeZone: "America/New_York",
    preferredDisplayCurrency: "USD",
    preferredPayoutCurrency: "USD",
    companyName: null,
    profileType: "individual" as const,
    networkStatus: "approved" as const,
    defaultPayoutMethod: "connect" as const,
    paypalEmail: null,
    stripeConnectId: "acct_123",
    stripeRecipientId: null,
    payoutsEnabledAt: new Date("2026-01-01"),
    identityVerifiedAt: new Date("2026-01-01"),
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    monthlyTraffic: null,
    industryInterests: ["Health_And_Fitness"],
    preferredEarningStructures: ["Revenue_Share"],
    salesChannels: ["Social_Media"],
    programPartnerTags: [],
    platforms: [],
  };

  const mockEnrollment = {
    partnerId: "pn_test123",
    programId: "prog_123",
    groupId: "grp_vip",
    tenantId: "default",
    status: "approved" as const,
    totalClicks: 150,
    totalLeads: 25,
    totalConversions: 10,
    totalSales: 12,
    totalSaleAmount: 120000, // $1,200.00 in minor units (cents)
    totalCommissions: 24000, // $240.00 in minor units (cents)
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  };

  const mockLinks = [
    {
      id: "lnk_1",
      domain: "dub.sh",
      key: "alex",
      url: "https://weletic.com",
      shortLink: "https://dub.sh/alex",
      clicks: 150,
      leads: 25,
      conversions: 10,
      sales: 12,
      saleAmount: 120000,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      partnerGroupDefaultLinkId: null,
      lastLeadAt: new Date("2026-02-01"),
      lastConversionAt: new Date("2026-02-01"),
      comments: null,
    },
  ];

  it("validates EnrolledPartnerCompositeSchema with full composite structure", () => {
    const compositePayload = {
      ...mockBasePartner,
      ...mockEnrollment,
      netRevenue: 96000, // $960.00 in minor units
      tags: [],
      links: mockLinks,
      group: {
        id: "grp_vip",
        name: "VIP Group",
        slug: "vip",
        color: "#6366F1",
        logo: null,
        wordmark: null,
        brandColor: null,
        additionalLinks: [],
        linkStructure: "short",
        applicationFormData: null,
        landerData: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        programId: "prog_123",
        clickRewardId: null,
        leadRewardId: null,
        saleRewardId: null,
        referralRewardId: null,
        discountId: null,
        utmTemplateId: null,
        maxPartnerLinks: 5,
        holdingPeriodDays: 30,
        autoApprovePartnersEnabledAt: null,
        applicationFormPublishedAt: null,
        landerPublishedAt: null,
        workflowId: null,
        program: {
          id: "prog_123",
          name: "Acme Partners",
          slug: "acme",
          logo: null,
          domain: null,
          url: null,
          description: null,
          primaryRewardEvent: "sale",
          minPayoutAmount: 5000,
          accountingCurrency: "USD",
          addedToMarketplaceAt: null,
          messagingEnabledAt: null,
          partnerNetworkEnabledAt: null,
          payoutMode: "internal",
          defaultFolderId: "fld_123",
          defaultGroupId: "grp_vip",
          supportEmail: null,
          helpUrl: null,
          termsUrl: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          startedAt: null,
          deactivatedAt: null,
          workspaceId: "ws_123",
          brandColor: null,
          wordmark: null,
          cookieDuration: 90,
          applicationFormPublishedAt: null,
          landerPublishedAt: null,
          autoApprovePartnersEnabledAt: null,
        },
      },
      discountCodes: [
        {
          id: "dsc_1",
          code: "ALEX20",
          discountId: "d_1",
          partnerId: "pn_test123",
          linkId: "lnk_1",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      referral: {
        referredBy: {
          id: "pn_sponsor",
          name: "Top Sponsor",
          image: null,
        },
        stats: {
          totalPartners: 5,
          totalConversions: 15,
          totalSaleAmount: 150000,
        },
      },
      eligibleBounties: [],
      commentsCount: 3,
      fraudCount: 0,
    };

    const parsed = EnrolledPartnerCompositeSchema.parse(compositePayload);
    expect(parsed.id).toBe("pn_test123");
    expect(parsed.group?.slug).toBe("vip");
    expect(parsed.referral?.stats.totalSaleAmount).toBe(150000);
    expect(parsed.commentsCount).toBe(3);
    expect(parsed.fraudCount).toBe(0);
  });

  it("executes standard single query when includeComposite is false", async () => {
    (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
      ...mockEnrollment,
      partner: mockBasePartner,
      links: mockLinks,
      discount: null,
      applicationEvent: null,
    });

    const result = await getPartnerForProgram({
      partnerId: "pn_test123",
      programId: "prog_123",
      includeComposite: false,
    });

    expect(result).toBeDefined();
    expect(result?.id).toBe("pn_test123");
    expect(result?.netRevenue).toBe(96000);
    expect((result as any).group).toBeUndefined();
    expect(prisma.programEnrollment.aggregate).not.toHaveBeenCalled();
    expect(prisma.partnerComment.count).not.toHaveBeenCalled();
  });

  it("eagerly resolves all composite dependencies in parallel when includeComposite is true", async () => {
    (prisma.programEnrollment.findUnique as any).mockResolvedValueOnce({
      ...mockEnrollment,
      partner: mockBasePartner,
      links: mockLinks,
      discount: null,
      applicationEvent: {
        referralSource: "friend",
        referredByPartnerId: "pn_sponsor1",
      },
      discountCodes: [],
      partnerGroup: {
        id: "grp_vip",
        name: "VIP",
        slug: "vip",
        workflow: {
          triggerConditions: [{ type: "sales_threshold", value: 10 }],
        },
      },
      program: {
        id: "prog_123",
        defaultGroupId: "grp_default",
      },
    });

    (prisma.partner.findUnique as any).mockResolvedValueOnce({
      id: "pn_sponsor1",
      name: "Sponsor Partner",
      image: "https://avatar.com/sponsor.png",
    });

    (prisma.programEnrollment.aggregate as any).mockResolvedValueOnce({
      _count: { _all: 8 },
      _sum: {
        totalConversions: 20,
        totalSaleAmount: 200000,
      },
    });

    (prisma.partnerComment.count as any).mockResolvedValueOnce(5);
    (prisma.fraudEventGroup.count as any).mockResolvedValueOnce(1);

    const result = await getPartnerForProgram({
      partnerId: "pn_test123",
      programId: "prog_123",
      includeComposite: true,
    });

    expect(result).toBeDefined();
    expect((result as any).group).toBeDefined();
    expect((result as any).group.moveRules).toEqual([
      { type: "sales_threshold", value: 10 },
    ]);
    expect((result as any).referral.referredBy.name).toBe("Sponsor Partner");
    expect((result as any).referral.stats.totalPartners).toBe(8);
    expect((result as any).referral.stats.totalSaleAmount).toBe(200000);
    expect((result as any).commentsCount).toBe(5);
    expect((result as any).fraudCount).toBe(1);
    expect((result as any).eligibleBounties).toHaveLength(1);
  });
});
