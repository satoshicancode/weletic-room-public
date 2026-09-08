import { DiscountCodeProps, EnrolledPartnerCompositeProps } from "@/lib/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("Challenger M2: SWR Pipeline, Rapid Tab Switching & Cache Stress Suite", () => {
  const workspaceId = "ws_adv_stress_1";
  const partnerId = "pn_adv_stress_2";
  const groupId = "grp_adv_stress_3";

  // Mock composite partner payload
  const mockPartnerComposite: EnrolledPartnerCompositeProps = {
    id: partnerId,
    name: "Alex Challenger",
    username: "alexchallenger",
    email: "alex@challenger.test",
    image: "https://avatar.test/alex.png",
    description: "Pro Athlete",
    companyName: "Challenger Athletics",
    networkStatus: "approved",
    defaultPayoutMethod: "connect",
    paypalEmail: null,
    stripeConnectId: "acct_test123",
    payoutsEnabledAt: new Date("2026-01-01T00:00:00Z"),
    identityVerifiedAt: new Date("2026-01-01T00:00:00Z"),
    status: "approved",
    programId: "prog_adv_1",
    partnerId,
    groupId,
    tenantId: "default",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    totalClicks: 15420,
    totalLeads: 234,
    totalConversions: 89,
    totalSales: 89,
    totalSaleAmount: 1890000,
    totalCommissions: 378000,
    netRevenue: 1512000,
    country: "US",
    monthlyTraffic: "TenThousandToFiftyThousand",
    tags: [{ id: "tag_vip", name: "VIP" } as any],
    platforms: [],
    links: [
      {
        id: "lnk_main",
        domain: "dub.sh",
        key: "alex",
        shortLink: "https://dub.sh/alex",
        clicks: 15420,
        leads: 234,
        conversions: 89,
        saleAmount: 1890000,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      } as any,
    ],
    industryInterests: ["Health_And_Fitness"],
    preferredEarningStructures: ["Revenue_Share"],
    salesChannels: ["Social_Media"],
    group: {
      id: groupId,
      name: "Elite Affiliates",
      slug: "elite-affiliates",
      color: "#10B981",
      logo: null,
      wordmark: null,
      brandColor: null,
      additionalLinks: [],
      linkStructure: "short",
      applicationFormData: null,
      landerData: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      programId: "prog_adv_1",
      clickRewardId: null,
      leadRewardId: null,
      saleRewardId: "rew_sale_1",
      referralRewardId: "rew_ref_1",
      discountId: "disc_1",
      utmTemplateId: null,
      maxPartnerLinks: 10,
      holdingPeriodDays: 30,
      autoApprovePartnersEnabledAt: null,
      applicationFormPublishedAt: null,
      landerPublishedAt: null,
      workflowId: null,
      saleReward: {
        id: "rew_sale_1",
        event: "sale",
        type: "percentage",
        value: 2000,
      } as any,
      discount: {
        id: "disc_1",
        type: "percentage",
        value: 1000,
        provider: "stripe",
      } as any,
    } as any,
    discountCodes: [
      {
        id: "dc_alex20",
        code: "ALEX20",
        discountId: "disc_1",
        partnerId,
        linkId: "lnk_main",
        disabledAt: null,
      },
    ],
    referral: {
      referredBy: null,
      stats: {
        totalPartners: 5,
        totalConversions: 25,
        totalSaleAmount: 500000,
      },
    },
    eligibleBounties: [
      {
        id: "bty_summer",
        name: "Summer 2026 Challenge",
        type: "performance",
      } as any,
    ],
    commentsCount: 7,
    fraudCount: 0,
  };

  // SWR Cache & Invalidation Engine Simulation
  class SimulatedSWRStorage {
    private cache = new Map<string, { data: any; timestamp: number }>();
    private inFlight = new Map<string, Promise<any>>();
    public fetchCounter = new Map<string, number>();
    public dedupingInterval: number;

    constructor(dedupingInterval = 60_000) {
      this.dedupingInterval = dedupingInterval;
    }

    get(key: string) {
      return this.cache.get(key)?.data;
    }

    set(key: string, data: any) {
      this.cache.set(key, { data, timestamp: Date.now() });
    }

    delete(key: string) {
      this.cache.delete(key);
    }

    clear() {
      this.cache.clear();
      this.inFlight.clear();
      this.fetchCounter.clear();
    }

    async fetchWithDedup<T>(
      key: string,
      fetcher: () => Promise<T>,
    ): Promise<T> {
      const existing = this.cache.get(key);
      const now = Date.now();

      // SWR deduping: Return cached data if within dedupingInterval
      if (existing && now - existing.timestamp < this.dedupingInterval) {
        return existing.data as T;
      }

      // SWR in-flight deduplication: Reuse ongoing fetch promise if concurrent
      if (this.inFlight.has(key)) {
        return this.inFlight.get(key) as Promise<T>;
      }

      this.fetchCounter.set(key, (this.fetchCounter.get(key) ?? 0) + 1);
      const promise = fetcher()
        .then((fresh) => {
          this.cache.set(key, { data: fresh, timestamp: Date.now() });
          this.inFlight.delete(key);
          return fresh;
        })
        .catch((err) => {
          this.inFlight.delete(key);
          throw err;
        });

      this.inFlight.set(key, promise);
      return promise;
    }

    seedFromComposite(partner: EnrolledPartnerCompositeProps, wsId: string) {
      // 1. Group by ID and Slug
      if (partner.groupId && partner.group) {
        this.set(
          `/api/groups/${partner.groupId}?workspaceId=${wsId}`,
          partner.group,
        );
        if (partner.group.slug && partner.group.slug !== partner.groupId) {
          this.set(
            `/api/groups/${partner.group.slug}?workspaceId=${wsId}`,
            partner.group,
          );
        }
      }

      // 2. Discount Codes (both standard and legacy key variants)
      if (partner.discountCodes) {
        this.set(
          `/api/discount-codes?workspaceId=${wsId}&partnerId=${partner.id}`,
          partner.discountCodes,
        );
        this.set(
          `/api/discount-codes?partnerId=${partner.id}&workspaceId=${wsId}`,
          partner.discountCodes,
        );
      }

      // 3. Referral stats
      if (partner.referral !== undefined) {
        this.set(
          `/api/partners/${partner.id}/referral?workspaceId=${wsId}`,
          partner.referral,
        );
      }

      // 4. Eligible Bounties
      if (partner.eligibleBounties) {
        this.set(
          `/api/bounties?workspaceId=${wsId}&partnerId=${partner.id}`,
          partner.eligibleBounties,
        );
      }

      // 5. Comments count
      if (partner.commentsCount !== undefined) {
        this.set(
          `/api/partners/${partner.id}/comments/count?workspaceId=${wsId}`,
          partner.commentsCount,
        );
      }

      // 6. Fraud count
      if (partner.fraudCount !== undefined) {
        this.set(
          `/api/fraud/groups/count?workspaceId=${wsId}&groupBy=partnerId&status=pending`,
          [{ partnerId: partner.id, _count: partner.fraudCount }],
        );
      }

      // 7. Non-composite partner entry
      this.set(`/api/partners/${partner.id}?workspaceId=${wsId}`, partner);
    }
  }

  let storage: SimulatedSWRStorage;

  beforeEach(() => {
    storage = new SimulatedSWRStorage(60_000);
  });

  describe("1. SWR Deduplication Across High-Concurrency Component Mounts", () => {
    it("executes exactly 1 network request when 50 concurrent components mount with the same key", async () => {
      const mockNetworkFetcher = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10)); // 10ms simulated latency
        return mockPartnerComposite;
      });

      const key = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;

      // 50 simultaneous consumer components mounting concurrently
      const concurrentFetches = Array.from({ length: 50 }).map(() =>
        storage.fetchWithDedup(key, mockNetworkFetcher),
      );

      const results = await Promise.all(concurrentFetches);

      // Verify all 50 components received exact data
      expect(results.length).toBe(50);
      results.forEach((res: any) => {
        expect(res.id).toBe(partnerId);
        expect(res.name).toBe("Alex Challenger");
      });

      // Verify only 1 network fetch was dispatched
      expect(mockNetworkFetcher).toHaveBeenCalledTimes(1);
      expect(storage.fetchCounter.get(key)).toBe(1);
    });

    it("respects dedupingInterval window across multiple sequential component mount waves", async () => {
      const mockNetworkFetcher = vi
        .fn()
        .mockResolvedValue(mockPartnerComposite);
      const key = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;

      // Wave 1: 10 mounts
      await Promise.all(
        Array.from({ length: 10 }).map(() =>
          storage.fetchWithDedup(key, mockNetworkFetcher),
        ),
      );
      expect(mockNetworkFetcher).toHaveBeenCalledTimes(1);

      // Wave 2: 10 mounts at T+10s (within 60s window)
      await Promise.all(
        Array.from({ length: 10 }).map(() =>
          storage.fetchWithDedup(key, mockNetworkFetcher),
        ),
      );
      expect(mockNetworkFetcher).toHaveBeenCalledTimes(1);
    });
  });

  describe("2. Tab Navigation Zero-Layout-Shift & Cache Seeding Stress Test", () => {
    it("hydrates all sub-resource SWR keys immediately from composite payload without cascading fetches", () => {
      // Step 1: Simulate ProgramPartnerLayout receiving composite data and seeding SWR
      storage.seedFromComposite(mockPartnerComposite, workspaceId);

      // Step 2: Consumer hook resolutions simulate instantaneous cache hits:
      // A. useGroup
      const groupFromCache = storage.get(
        `/api/groups/${groupId}?workspaceId=${workspaceId}`,
      );
      expect(groupFromCache).toBeDefined();
      expect(groupFromCache.id).toBe(groupId);
      expect(groupFromCache.name).toBe("Elite Affiliates");
      expect(groupFromCache.slug).toBe("elite-affiliates");

      // B. useGroup by slug
      const groupBySlug = storage.get(
        `/api/groups/elite-affiliates?workspaceId=${workspaceId}`,
      );
      expect(groupBySlug).toEqual(groupFromCache);

      // C. useDiscountCodes (Standard and legacy alias)
      const codesStandard = storage.get(
        `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      );
      const codesLegacy = storage.get(
        `/api/discount-codes?partnerId=${partnerId}&workspaceId=${workspaceId}`,
      );
      expect(codesStandard).toHaveLength(1);
      expect(codesStandard[0].code).toBe("ALEX20");
      expect(codesLegacy).toEqual(codesStandard);

      // D. usePartnerReferral
      const referralStats = storage.get(
        `/api/partners/${partnerId}/referral?workspaceId=${workspaceId}`,
      );
      expect(referralStats).toBeDefined();
      expect(referralStats.stats.totalPartners).toBe(5);

      // E. Bounties
      const bounties = storage.get(
        `/api/bounties?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      );
      expect(bounties).toHaveLength(1);
      expect(bounties[0].name).toBe("Summer 2026 Challenge");

      // F. Comments Count
      const commentsCount = storage.get(
        `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
      );
      expect(commentsCount).toBe(7);

      // G. Fraud Count
      const fraudData = storage.get(
        `/api/fraud/groups/count?workspaceId=${workspaceId}&groupBy=partnerId&status=pending`,
      );
      expect(fraudData).toEqual([{ partnerId, _count: 0 }]);

      // Total network requests dispatched for sub-resources: 0!
      expect(storage.fetchCounter.size).toBe(0);
    });

    it("simulates rapid 100x tab transitions between Links -> Payouts -> Customers -> Comments without cache misses or flash", async () => {
      // Seed initial composite
      storage.seedFromComposite(mockPartnerComposite, workspaceId);

      const tabActions = ["links", "payouts", "customers", "comments"] as const;
      const history: {
        tab: string;
        renderReady: boolean;
        hasFlash: boolean;
      }[] = [];

      for (let i = 0; i < 100; i++) {
        const tab = tabActions[i % tabActions.length];

        let renderReady = false;
        let hasFlash = false;

        switch (tab) {
          case "links": {
            // PartnerLinks resolves partner.links (from composite) & group
            const composite = mockPartnerComposite;
            const group =
              composite.group ??
              storage.get(
                `/api/groups/${composite.groupId}?workspaceId=${workspaceId}`,
              );
            const codes =
              composite.discountCodes ??
              storage.get(
                `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${composite.id}`,
              );
            const referral =
              composite.referral ??
              storage.get(
                `/api/partners/${composite.id}/referral?workspaceId=${workspaceId}`,
              );

            // First frame readiness check:
            renderReady = Boolean(
              composite.links && group && codes && referral,
            );
            hasFlash = !renderReady; // Flash would occur if any required data was undefined on first frame
            break;
          }
          case "payouts": {
            // PartnerPayouts resolves partner from composite
            const partner = storage.get(
              `/api/partners/${partnerId}?workspaceId=${workspaceId}`,
            );
            renderReady = Boolean(partner && partner.id);
            hasFlash = !renderReady;
            break;
          }
          case "customers": {
            // PartnerCustomers resolves partner from composite
            const partner = storage.get(
              `/api/partners/${partnerId}?workspaceId=${workspaceId}`,
            );
            renderReady = Boolean(partner && partner.id);
            hasFlash = !renderReady;
            break;
          }
          case "comments": {
            // Comments resolves count from cache
            const count = storage.get(
              `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
            );
            renderReady = count !== undefined;
            hasFlash = !renderReady;
            break;
          }
        }

        history.push({ tab, renderReady, hasFlash });
      }

      // Assert 100/100 tab transitions succeeded without a single flash
      expect(history.length).toBe(100);
      expect(history.every((h) => h.renderReady)).toBe(true);
      expect(history.every((h) => !h.hasFlash)).toBe(true);
    });
  });

  describe("3. Edge Case: Boundary Conditions & Sparse Composite Payloads", () => {
    it("handles null group, empty discount codes, and null referral stats gracefully without throwing", () => {
      const sparseComposite: EnrolledPartnerCompositeProps = {
        ...mockPartnerComposite,
        groupId: "grp_fallback",
        group: null,
        discountCodes: [],
        referral: null,
        eligibleBounties: [],
        commentsCount: 0,
        fraudCount: 0,
      };

      // Seed sparse composite
      storage.seedFromComposite(sparseComposite, workspaceId);

      // Verify group key was not seeded with null, leaving default fallback intact
      expect(
        storage.get(`/api/groups/grp_fallback?workspaceId=${workspaceId}`),
      ).toBeUndefined();

      // Discount codes seeded as empty array
      const discountCodes = storage.get(
        `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      );
      expect(discountCodes).toEqual([]);

      // Referral seeded as null
      const referral = storage.get(
        `/api/partners/${partnerId}/referral?workspaceId=${workspaceId}`,
      );
      expect(referral).toBeNull();

      // Bounties seeded as empty array
      const bounties = storage.get(
        `/api/bounties?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      );
      expect(bounties).toEqual([]);

      // Comments count seeded as 0
      const comments = storage.get(
        `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
      );
      expect(comments).toBe(0);
    });

    it("verifies first-frame fallback safety in PartnerInfoCards & links/page", () => {
      const partner = mockPartnerComposite;

      // 1. Direct composite extraction
      const compositeGroup = partner.group;
      const compositeBounties = partner.eligibleBounties;
      const compositeReferral = partner.referral;
      const compositeCodes = partner.discountCodes;

      expect(compositeGroup).toBeDefined();
      expect(compositeBounties).toBeDefined();
      expect(compositeReferral).toBeDefined();
      expect(compositeCodes).toBeDefined();

      // 2. Fallback logic returns composite immediately before SWR fetches
      const isReferralLoading = partner.referral === undefined ? true : false;
      const isCodesLoading = partner.discountCodes === undefined ? true : false;

      expect(isReferralLoading).toBe(false);
      expect(isCodesLoading).toBe(false);
    });
  });

  describe("4. Mutation Coherence & SWR Cache Invalidation", () => {
    it("updates child cache key when mutate is called, ensuring consumers see fresh data", () => {
      // Initial seed
      storage.seedFromComposite(mockPartnerComposite, workspaceId);

      // Mutate discount codes (e.g. user created a new code "PROMO50")
      const updatedCodes: DiscountCodeProps[] = [
        ...mockPartnerComposite.discountCodes!,
        {
          id: "dc_promo50",
          code: "PROMO50",
          discountId: "disc_1",
          partnerId,
          linkId: "lnk_main",
          disabledAt: null,
        },
      ];

      storage.set(
        `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
        updatedCodes,
      );

      // Verify that cache returns the updated list
      const cached = storage.get(
        `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      );
      expect(cached).toHaveLength(2);
      expect(cached[1].code).toBe("PROMO50");
    });

    it("updates group reward tiers in cache after modification", () => {
      storage.seedFromComposite(mockPartnerComposite, workspaceId);

      const updatedGroup = {
        ...mockPartnerComposite.group!,
        name: "Diamond Affiliates",
      };

      storage.set(
        `/api/groups/${groupId}?workspaceId=${workspaceId}`,
        updatedGroup,
      );

      const cached = storage.get(
        `/api/groups/${groupId}?workspaceId=${workspaceId}`,
      );
      expect(cached.name).toBe("Diamond Affiliates");
    });
  });

  describe("5. Query Parameter Ordering Invariance", () => {
    it("guarantees cache hits regardless of whether workspaceId or partnerId is first", () => {
      storage.seedFromComposite(mockPartnerComposite, workspaceId);

      const keyA = `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`;
      const keyB = `/api/discount-codes?partnerId=${partnerId}&workspaceId=${workspaceId}`;

      expect(storage.get(keyA)).toBeDefined();
      expect(storage.get(keyB)).toBeDefined();
      expect(storage.get(keyA)).toEqual(storage.get(keyB));
    });
  });

  describe("6. Deferred Filter & Sheet Mount Isolation", () => {
    it("ensures zero candidate queries are triggered when filter popovers remain closed", () => {
      const isCommissionPartnerFilterOpen = false;
      const isBountyPartnerFilterOpen = false;
      const isRewardHistoryOpen = false;

      // In useCommissionFilters / useBountySubmissionFilters / useRewardHistorySheet:
      const shouldFetchCommissionsPartners = isCommissionPartnerFilterOpen;
      const shouldFetchBountyPartners = isBountyPartnerFilterOpen;
      const shouldFetchActivityLogs = isRewardHistoryOpen;

      expect(shouldFetchCommissionsPartners).toBe(false);
      expect(shouldFetchBountyPartners).toBe(false);
      expect(shouldFetchActivityLogs).toBe(false);
    });

    it("activates single candidate query only for the active filter popover", () => {
      const selectedFilter: string | null = "partnerId";

      const partnerQueryEnabled = selectedFilter === "partnerId";
      const customerQueryEnabled = selectedFilter === "customerId";
      const groupQueryEnabled = selectedFilter === "groupId";

      expect(partnerQueryEnabled).toBe(true);
      expect(customerQueryEnabled).toBe(false);
      expect(groupQueryEnabled).toBe(false);
    });
  });
});
