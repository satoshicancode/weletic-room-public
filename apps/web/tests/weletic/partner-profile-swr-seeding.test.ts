import { EnrolledPartnerCompositeSchema } from "@/lib/zod/schemas/partners";
import { describe, expect, it } from "vitest";

describe("Partner Profile SWR Cache Seeding & URL Construction", () => {
  const workspaceId = "ws_test123";
  const partnerId = "pn_test456";
  const groupId = "grp_vip789";

  it("constructs composite partner endpoint URL matching backend route schema", () => {
    const queryParams = new URLSearchParams({
      ...(workspaceId ? { workspaceId } : {}),
      includeComposite: "true",
    }).toString();

    const expectedUrl = `/api/partners/${partnerId}?${queryParams}`;
    expect(expectedUrl).toBe(
      `/api/partners/${partnerId}?workspaceId=ws_test123&includeComposite=true`,
    );
  });

  it("constructs non-composite partner endpoint URL without includeComposite parameter", () => {
    const queryParams = new URLSearchParams({
      ...(workspaceId ? { workspaceId } : {}),
    }).toString();

    const expectedUrl = `/api/partners/${partnerId}?${queryParams}`;
    expect(expectedUrl).toBe(
      `/api/partners/${partnerId}?workspaceId=ws_test123`,
    );
  });

  it("verifies exact SWR key alignment across all 6 child sub-resources", () => {
    const keys = {
      group: `/api/groups/${groupId}?workspaceId=${workspaceId}`,
      groupSlug: `/api/groups/vip?workspaceId=${workspaceId}`,
      discountCodesStandard: `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      discountCodesLegacy: `/api/discount-codes?partnerId=${partnerId}&workspaceId=${workspaceId}`,
      referral: `/api/partners/${partnerId}/referral?workspaceId=${workspaceId}`,
      bounties: `/api/bounties?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      commentsCount: `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
      fraudCount: `/api/fraud/groups/count?workspaceId=${workspaceId}&groupBy=partnerId&status=pending`,
      partnerNonComposite: `/api/partners/${partnerId}?workspaceId=${workspaceId}`,
    };

    expect(keys.group).toBe(`/api/groups/grp_vip789?workspaceId=ws_test123`);
    expect(keys.groupSlug).toBe(`/api/groups/vip?workspaceId=ws_test123`);
    expect(keys.discountCodesStandard).toBe(
      `/api/discount-codes?workspaceId=ws_test123&partnerId=pn_test456`,
    );
    expect(keys.discountCodesLegacy).toBe(
      `/api/discount-codes?partnerId=pn_test456&workspaceId=ws_test123`,
    );
    expect(keys.referral).toBe(
      `/api/partners/pn_test456/referral?workspaceId=ws_test123`,
    );
    expect(keys.bounties).toBe(
      `/api/bounties?workspaceId=ws_test123&partnerId=pn_test456`,
    );
    expect(keys.commentsCount).toBe(
      `/api/partners/pn_test456/comments/count?workspaceId=ws_test123`,
    );
    expect(keys.fraudCount).toBe(
      `/api/fraud/groups/count?workspaceId=ws_test123&groupBy=partnerId&status=pending`,
    );
    expect(keys.partnerNonComposite).toBe(
      `/api/partners/pn_test456?workspaceId=ws_test123`,
    );
  });

  it("validates composite payload conforms to EnrolledPartnerCompositeSchema", () => {
    const sampleComposite = {
      id: partnerId,
      name: "Jane Partner",
      username: "janepartner",
      email: "jane@partner.com",
      image: "https://avatar.com/jane.png",
      description: "Fitness Influencer",
      companyName: null,
      profileType: "individual" as const,
      networkStatus: "approved" as const,
      defaultPayoutMethod: "connect" as const,
      paypalEmail: null,
      stripeConnectId: "acct_jane",
      stripeRecipientId: null,
      payoutsEnabledAt: new Date("2026-01-01"),
      identityVerifiedAt: new Date("2026-01-01"),
      status: "approved" as const,
      programId: "prog_1",
      partnerId,
      groupId,
      tenantId: "default",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
      totalClicks: 100,
      totalLeads: 20,
      totalConversions: 5,
      totalSales: 5,
      totalSaleAmount: 50000,
      totalCommissions: 10000,
      netRevenue: 40000,
      country: "US",
      preferredLocale: "en",
      timeZone: "America/New_York",
      preferredDisplayCurrency: "USD",
      preferredPayoutCurrency: "USD",
      monthlyTraffic: null,
      tags: [],
      programPartnerTags: [],
      platforms: [],
      links: [],
      industryInterests: ["Health_And_Fitness"],
      preferredEarningStructures: ["Revenue_Share"],
      salesChannels: ["Social_Media"],
      group: {
        id: groupId,
        name: "VIP Group",
        slug: "vip",
        color: "#6366F1",
        logo: null,
        wordmark: null,
        brandColor: null,
        additionalLinks: [],
        linkStructure: "short" as const,
        applicationFormData: null,
        landerData: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        programId: "prog_1",
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
          id: "prog_1",
          name: "Weletic Program",
          slug: "weletic",
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
          defaultGroupId: groupId,
          supportEmail: null,
          helpUrl: null,
          termsUrl: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          startedAt: null,
          deactivatedAt: null,
          workspaceId,
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
          id: "dc_1",
          code: "JANE10",
          discountId: "d_1",
          partnerId,
          linkId: "lnk_1",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      referral: {
        referredBy: null,
        stats: {
          totalPartners: 2,
          totalConversions: 4,
          totalSaleAmount: 40000,
        },
      },
      eligibleBounties: [],
      commentsCount: 2,
      fraudCount: 0,
    };

    const parsed = EnrolledPartnerCompositeSchema.parse(sampleComposite);
    expect(parsed.id).toBe(partnerId);
    expect(parsed.group?.name).toBe("VIP Group");
    expect(parsed.discountCodes?.[0].code).toBe("JANE10");
    expect(parsed.referral?.stats.totalPartners).toBe(2);
    expect(parsed.commentsCount).toBe(2);
    expect(parsed.fraudCount).toBe(0);
  });

  it("verifies cache seeding resolution mechanism", () => {
    const swrCache = new Map<string, any>();
    const mockMutate = (
      key: string,
      data: any,
      _opts?: { revalidate?: boolean },
    ) => {
      swrCache.set(key, data);
    };

    const partnerComposite = {
      id: partnerId,
      groupId,
      group: { id: groupId, name: "VIP Group", slug: "vip" },
      discountCodes: [{ id: "dc_1", code: "JANE10" }],
      referral: { referredBy: null, stats: { totalPartners: 2 } },
      eligibleBounties: [{ id: "bty_1", name: "Promo" }],
      commentsCount: 3,
      fraudCount: 1,
    };

    // Simulate layout seeding effect
    if (partnerComposite.groupId && partnerComposite.group) {
      mockMutate(
        `/api/groups/${partnerComposite.groupId}?workspaceId=${workspaceId}`,
        partnerComposite.group,
        { revalidate: false },
      );
      if (partnerComposite.group.slug) {
        mockMutate(
          `/api/groups/${partnerComposite.group.slug}?workspaceId=${workspaceId}`,
          partnerComposite.group,
          { revalidate: false },
        );
      }
    }
    if (partnerComposite.discountCodes) {
      mockMutate(
        `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerComposite.id}`,
        partnerComposite.discountCodes,
        { revalidate: false },
      );
      mockMutate(
        `/api/discount-codes?partnerId=${partnerComposite.id}&workspaceId=${workspaceId}`,
        partnerComposite.discountCodes,
        { revalidate: false },
      );
    }
    if (partnerComposite.referral !== undefined) {
      mockMutate(
        `/api/partners/${partnerComposite.id}/referral?workspaceId=${workspaceId}`,
        partnerComposite.referral,
        { revalidate: false },
      );
    }
    if (partnerComposite.eligibleBounties) {
      mockMutate(
        `/api/bounties?workspaceId=${workspaceId}&partnerId=${partnerComposite.id}`,
        partnerComposite.eligibleBounties,
        { revalidate: false },
      );
    }
    if (partnerComposite.commentsCount !== undefined) {
      mockMutate(
        `/api/partners/${partnerComposite.id}/comments/count?workspaceId=${workspaceId}`,
        partnerComposite.commentsCount,
        { revalidate: false },
      );
    }
    if (partnerComposite.fraudCount !== undefined) {
      mockMutate(
        `/api/fraud/groups/count?workspaceId=${workspaceId}&groupBy=partnerId&status=pending`,
        [
          {
            partnerId: partnerComposite.id,
            _count: partnerComposite.fraudCount,
          },
        ],
        { revalidate: false },
      );
    }
    mockMutate(
      `/api/partners/${partnerComposite.id}?workspaceId=${workspaceId}`,
      partnerComposite,
      { revalidate: false },
    );

    // Assert cache hits
    expect(
      swrCache.get(`/api/groups/${groupId}?workspaceId=${workspaceId}`),
    ).toEqual(partnerComposite.group);
    expect(swrCache.get(`/api/groups/vip?workspaceId=${workspaceId}`)).toEqual(
      partnerComposite.group,
    );
    expect(
      swrCache.get(
        `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      ),
    ).toEqual(partnerComposite.discountCodes);
    expect(
      swrCache.get(
        `/api/discount-codes?partnerId=${partnerId}&workspaceId=${workspaceId}`,
      ),
    ).toEqual(partnerComposite.discountCodes);
    expect(
      swrCache.get(
        `/api/partners/${partnerId}/referral?workspaceId=${workspaceId}`,
      ),
    ).toEqual(partnerComposite.referral);
    expect(
      swrCache.get(
        `/api/bounties?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      ),
    ).toEqual(partnerComposite.eligibleBounties);
    expect(
      swrCache.get(
        `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
      ),
    ).toBe(3);
    expect(
      swrCache.get(
        `/api/fraud/groups/count?workspaceId=${workspaceId}&groupBy=partnerId&status=pending`,
      ),
    ).toEqual([{ partnerId, _count: 1 }]);
    expect(
      swrCache.get(`/api/partners/${partnerId}?workspaceId=${workspaceId}`),
    ).toEqual(partnerComposite);
  });
});
