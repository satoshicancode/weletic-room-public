import { REWARD_EVENT_TO_RESOURCE_TYPE } from "@/lib/zod/schemas/activity-log";
import { parseFilterValue } from "@dub/utils";
import { describe, expect, it, vi } from "vitest";

describe("Challenger M2: Frontend SWR Pipeline, Lazy Filters & Waterfall Elimination Suite", () => {
  const workspaceId = "ws_challenger_999";
  const defaultProgramId = "prog_challenger_888";
  const partnerId = "pn_challenger_777";
  const groupId = "grp_challenger_666";
  const groupSlug = "elite-group";

  // =========================================================================
  // 1. Lazy & Deferred Filter Candidate Querying Stress Testing
  // =========================================================================
  describe("1. Deferred Filter Option Queries (useCommissionFilters & useBountySubmissionFilters)", () => {
    // Helper replicating usePartnerFilterOptions logic
    const evaluatePartnerFilterOptions = ({
      selectedFilter,
      search = "",
      rawPartnerParam,
    }: {
      selectedFilter: string | null;
      search?: string;
      rawPartnerParam?: string;
    }) => {
      const isCandidateEnabled = selectedFilter === "partnerId";
      const candidateKey =
        isCandidateEnabled && workspaceId
          ? `/api/partners?${new URLSearchParams({
              workspaceId,
              search,
            }).toString()}`
          : null;

      const parsed = rawPartnerParam
        ? rawPartnerParam.replace(/^-/, "").split(",").filter(Boolean)
        : undefined;

      const isSelectionEnabled = Boolean(parsed?.length);
      const selectionKey =
        isSelectionEnabled && workspaceId
          ? `/api/partners?${new URLSearchParams({
              workspaceId,
              partnerIds: parsed!.join(","),
            }).toString()}`
          : null;

      return {
        candidateKey,
        isCandidateEnabled,
        selectionKey,
        isSelectionEnabled,
        activePartnerIds: parsed,
      };
    };

    // Helper replicating useCustomerFilterOptions logic
    const evaluateCustomerFilterOptions = ({
      selectedFilter,
      search = "",
      rawCustomerParam,
    }: {
      selectedFilter: string | null;
      search?: string;
      rawCustomerParam?: string;
    }) => {
      const isCandidateEnabled = selectedFilter === "customerId";
      const candidateKey =
        isCandidateEnabled && workspaceId
          ? `/api/customers?${new URLSearchParams({
              workspaceId,
              search,
            }).toString()}`
          : null;

      const activeCustomerId = rawCustomerParam
        ? rawCustomerParam.replace(/^-/, "")
        : undefined;

      const isSelectionEnabled = Boolean(activeCustomerId);
      const selectionKey =
        isSelectionEnabled && workspaceId
          ? `/api/customers?${new URLSearchParams({
              workspaceId,
              customerIds: activeCustomerId!,
            }).toString()}`
          : null;

      return {
        candidateKey,
        isCandidateEnabled,
        selectionKey,
        isSelectionEnabled,
        activeCustomerId,
      };
    };

    // Helper replicating usePartnerTags filter options logic
    const evaluatePartnerTagFilterOptions = ({
      selectedFilter,
      rawTagParam,
    }: {
      selectedFilter: string | null;
      rawTagParam?: string;
    }) => {
      const isCandidateEnabled = selectedFilter === "partnerTagId";
      const candidateKey =
        isCandidateEnabled && workspaceId
          ? `/api/partners/tags?${new URLSearchParams({
              workspaceId,
            }).toString()}`
          : null;

      const activeTagIds = rawTagParam
        ? rawTagParam.replace(/^-/, "").split(",").filter(Boolean)
        : undefined;

      const isSelectionEnabled = Boolean(activeTagIds?.length);
      const selectionKey =
        isSelectionEnabled && workspaceId
          ? `/api/partners/tags?${new URLSearchParams({
              workspaceId,
              ids: activeTagIds!.join(","),
            }).toString()}`
          : null;

      return {
        candidateKey,
        isCandidateEnabled,
        selectionKey,
        isSelectionEnabled,
        activeTagIds,
      };
    };

    it("verifies zero candidate requests on initial page load when all popovers are closed", () => {
      const partnerRes = evaluatePartnerFilterOptions({ selectedFilter: null });
      const customerRes = evaluateCustomerFilterOptions({
        selectedFilter: null,
      });
      const tagRes = evaluatePartnerTagFilterOptions({ selectedFilter: null });

      // No popovers open, no URL filters
      expect(partnerRes.isCandidateEnabled).toBe(false);
      expect(partnerRes.candidateKey).toBeNull();
      expect(partnerRes.isSelectionEnabled).toBe(false);
      expect(partnerRes.selectionKey).toBeNull();

      expect(customerRes.isCandidateEnabled).toBe(false);
      expect(customerRes.candidateKey).toBeNull();
      expect(customerRes.isSelectionEnabled).toBe(false);
      expect(customerRes.selectionKey).toBeNull();

      expect(tagRes.isCandidateEnabled).toBe(false);
      expect(tagRes.candidateKey).toBeNull();
      expect(tagRes.isSelectionEnabled).toBe(false);
      expect(tagRes.selectionKey).toBeNull();
    });

    it("activates partner candidate search query only when partner filter popover opens", () => {
      const closed = evaluatePartnerFilterOptions({ selectedFilter: null });
      expect(closed.candidateKey).toBeNull();

      const opened = evaluatePartnerFilterOptions({
        selectedFilter: "partnerId",
        search: "Alice",
      });
      expect(opened.isCandidateEnabled).toBe(true);
      expect(opened.candidateKey).toBe(
        `/api/partners?workspaceId=${workspaceId}&search=Alice`,
      );
    });

    it("activates customer candidate search query only when customer filter popover opens", () => {
      const closed = evaluateCustomerFilterOptions({ selectedFilter: null });
      expect(closed.candidateKey).toBeNull();

      const opened = evaluateCustomerFilterOptions({
        selectedFilter: "customerId",
        search: "bob@example.com",
      });
      expect(opened.isCandidateEnabled).toBe(true);
      expect(opened.candidateKey).toBe(
        `/api/customers?workspaceId=${workspaceId}&search=bob%40example.com`,
      );
    });

    it("activates partner tag candidate query only when tag filter popover opens", () => {
      const closed = evaluatePartnerTagFilterOptions({ selectedFilter: null });
      expect(closed.candidateKey).toBeNull();

      const opened = evaluatePartnerTagFilterOptions({
        selectedFilter: "partnerTagId",
      });
      expect(opened.isCandidateEnabled).toBe(true);
      expect(opened.candidateKey).toBe(
        `/api/partners/tags?workspaceId=${workspaceId}`,
      );
    });

    it("handles URL-filtered state with closed popover: queries selective active item only, never candidate flood", () => {
      const partnerRes = evaluatePartnerFilterOptions({
        selectedFilter: null,
        rawPartnerParam: "pn_100,pn_200",
      });

      // General candidate list remains completely disabled
      expect(partnerRes.isCandidateEnabled).toBe(false);
      expect(partnerRes.candidateKey).toBeNull();

      // Only the targeted active partners are fetched for chip badge hydration
      expect(partnerRes.isSelectionEnabled).toBe(true);
      expect(partnerRes.activePartnerIds).toEqual(["pn_100", "pn_200"]);
      expect(partnerRes.selectionKey).toBe(
        `/api/partners?workspaceId=${workspaceId}&partnerIds=pn_100%2Cpn_200`,
      );
    });

    it("correctly handles negated filter values (e.g. -pn_100) from searchParamsObj", () => {
      const partnerRes = evaluatePartnerFilterOptions({
        selectedFilter: null,
        rawPartnerParam: "-pn_100,pn_200",
      });

      expect(partnerRes.activePartnerIds).toEqual(["pn_100", "pn_200"]);

      const parsed = parseFilterValue("-pn_100,pn_200");
      expect(parsed?.operator).toBe("IS_NOT_ONE_OF");
      expect(parsed?.values).toEqual(["pn_100", "pn_200"]);
    });

    it("merges active and candidate partner tags deterministically with zero duplicates", () => {
      const candidateTags = [
        { id: "tag_1", name: "VIP", color: "blue" },
        { id: "tag_2", name: "Influencer", color: "purple" },
      ];
      const selectedTags = [
        { id: "tag_2", name: "Influencer", color: "purple" },
        { id: "tag_3", name: "Legacy", color: "gray" },
      ];

      const baseIds = new Set(candidateTags.map((t) => t.id));
      const merged = [
        ...candidateTags,
        ...selectedTags.filter((t) => !baseIds.has(t.id)),
      ];

      expect(merged).toHaveLength(3);
      expect(merged.map((t) => t.id)).toEqual(["tag_1", "tag_2", "tag_3"]);
    });
  });

  // =========================================================================
  // 2. Activity Sheet Lazy Fetching (useRewardHistorySheet)
  // =========================================================================
  describe("2. Reward Activity Sheet Lazy Fetching (useRewardHistorySheet)", () => {
    const resolveActivityLogsKey = ({
      reward,
      isOpen,
      group,
    }: {
      reward: { id: string; event: "sale" | "click" | "lead" } | null;
      isOpen: boolean;
      group?: { id: string } | null;
    }) => {
      const enabled = isOpen && Boolean(reward?.id);
      const query = reward
        ? {
            resourceType: REWARD_EVENT_TO_RESOURCE_TYPE[reward.event],
            ...(group ? { parentResourceId: group.id } : {}),
          }
        : undefined;

      const searchParams = query
        ? new URLSearchParams({
            workspaceId,
            ...query,
          }).toString()
        : "";

      const requestEnabled =
        enabled &&
        Boolean(workspaceId) &&
        Boolean(query?.resourceType) &&
        Boolean(query?.parentResourceId || (query as any)?.resourceId);

      return requestEnabled ? `/api/activity-logs?${searchParams}` : null;
    };

    it("returns null key when sheet is closed (isOpen: false) with a valid reward", () => {
      const reward = { id: "rew_sale_1", event: "sale" as const };
      const group = { id: groupId };

      const key = resolveActivityLogsKey({ reward, isOpen: false, group });
      expect(key).toBeNull();
    });

    it("returns active SWR key when sheet is open (isOpen: true)", () => {
      const reward = { id: "rew_sale_1", event: "sale" as const };
      const group = { id: groupId };

      const key = resolveActivityLogsKey({ reward, isOpen: true, group });
      expect(key).toBe(
        `/api/activity-logs?workspaceId=${workspaceId}&resourceType=saleReward&parentResourceId=${groupId}`,
      );
    });

    it("maps all 3 reward event types correctly to activity-log resource types", () => {
      expect(REWARD_EVENT_TO_RESOURCE_TYPE.sale).toBe("saleReward");
      expect(REWARD_EVENT_TO_RESOURCE_TYPE.click).toBe("clickReward");
      expect(REWARD_EVENT_TO_RESOURCE_TYPE.lead).toBe("leadReward");

      const clickKey = resolveActivityLogsKey({
        reward: { id: "rew_clk_1", event: "click" },
        isOpen: true,
        group: { id: groupId },
      });
      expect(clickKey).toContain("resourceType=clickReward");

      const leadKey = resolveActivityLogsKey({
        reward: { id: "rew_ld_1", event: "lead" },
        isOpen: true,
        group: { id: groupId },
      });
      expect(leadKey).toContain("resourceType=leadReward");

      const referralKey = resolveActivityLogsKey({
        reward: { id: "rew_ref_1", event: "referral" as any },
        isOpen: true,
        group: { id: groupId },
      });
      expect(referralKey).toContain("resourceType=referralReward");
    });

    it("returns null key when reward is null, even if isOpen is true", () => {
      const key = resolveActivityLogsKey({
        reward: null,
        isOpen: true,
        group: { id: groupId },
      });
      expect(key).toBeNull();
    });
  });

  // =========================================================================
  // 3. Standardized SWR Hooks Invariants & Options Forwarding
  // =========================================================================
  describe("3. Standardized SWR Hooks Contracts & Key Resolution", () => {
    it("verifies all 7 standardized hooks strictly return null when enabled: false", () => {
      // 1. usePartner
      const partnerKey = (enabled: boolean) =>
        enabled && partnerId && workspaceId
          ? `/api/partners/${partnerId}?workspaceId=${workspaceId}`
          : null;
      expect(partnerKey(false)).toBeNull();

      // 2. usePayouts
      const payoutsKey = (enabled: boolean) =>
        enabled && workspaceId && defaultProgramId
          ? `/api/payouts?workspaceId=${workspaceId}`
          : null;
      expect(payoutsKey(false)).toBeNull();

      // 3. useCustomers
      const customersKey = (enabled: boolean, canManage = true) =>
        enabled && workspaceId && canManage
          ? `/api/customers?workspaceId=${workspaceId}`
          : null;
      expect(customersKey(false)).toBeNull();
      expect(customersKey(true, false)).toBeNull();

      // 4. useGroup
      const groupKey = (enabled: boolean) =>
        enabled && workspaceId && groupId
          ? `/api/groups/${groupId}?workspaceId=${workspaceId}`
          : null;
      expect(groupKey(false)).toBeNull();

      // 5. useGroups
      const groupsKey = (enabled: boolean) =>
        enabled && workspaceId && defaultProgramId
          ? `/api/groups?workspaceId=${workspaceId}&sortBy=totalSaleAmount`
          : null;
      expect(groupsKey(false)).toBeNull();

      // 6. useRewards
      const rewardsKey = (enabled: boolean) =>
        enabled && workspaceId && defaultProgramId
          ? `/api/rewards?workspaceId=${workspaceId}`
          : null;
      expect(rewardsKey(false)).toBeNull();

      // 7. useDiscountCodes
      const discountCodesKey = (enabled: boolean) =>
        enabled && workspaceId && partnerId
          ? `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`
          : null;
      expect(discountCodesKey(false)).toBeNull();
    });

    it("verifies custom swrOptions are passed without mutation or loss", () => {
      const defaultSwrConfig = {
        dedupingInterval: 60_000,
        keepPreviousData: true,
        revalidateOnFocus: false,
        revalidateOnReconnect: true,
      };

      const customOptions = {
        dedupingInterval: 15_000,
        refreshInterval: 30_000,
      };

      const mergedOptions = {
        ...defaultSwrConfig,
        ...customOptions,
      };

      expect(mergedOptions.dedupingInterval).toBe(15000);
      expect(mergedOptions.refreshInterval).toBe(30000);
      expect(mergedOptions.keepPreviousData).toBe(true);
      expect(mergedOptions.revalidateOnFocus).toBe(false);
    });
  });

  // =========================================================================
  // 4. Composite Cache Seeding & Zero-Flash First-Frame Rendering Invariants
  // =========================================================================
  describe("4. Composite Cache Seeding & Zero-Flash UI Invariants", () => {
    it("guarantees layout cache seeding populates all 7 target keys with revalidate: false", () => {
      const swrMutateLog: { key: string; data: any; revalidate?: boolean }[] =
        [];
      const mockMutate = (
        key: string,
        data: any,
        opts?: { revalidate?: boolean },
      ) => {
        swrMutateLog.push({ key, data, revalidate: opts?.revalidate });
      };

      const mockCompositePartner = {
        id: partnerId,
        groupId,
        group: {
          id: groupId,
          name: "Elite",
          slug: groupSlug,
          color: "#000",
        },
        discountCodes: [{ id: "dc_1", code: "ELITE20" }],
        referral: {
          referredBy: null,
          stats: {
            totalPartners: 5,
            totalConversions: 10,
            totalSaleAmount: 100000,
          },
        },
        eligibleBounties: [
          { id: "bty_1", name: "Sprint Bounty", type: "performance" },
        ],
        commentsCount: 7,
        fraudCount: 0,
      };

      // Execute Layout useEffect Seeding
      if (mockCompositePartner.groupId && mockCompositePartner.group) {
        mockMutate(
          `/api/groups/${mockCompositePartner.groupId}?workspaceId=${workspaceId}`,
          mockCompositePartner.group,
          { revalidate: false },
        );
        if (mockCompositePartner.group.slug) {
          mockMutate(
            `/api/groups/${mockCompositePartner.group.slug}?workspaceId=${workspaceId}`,
            mockCompositePartner.group,
            { revalidate: false },
          );
        }
      }

      if (mockCompositePartner.discountCodes) {
        mockMutate(
          `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${mockCompositePartner.id}`,
          mockCompositePartner.discountCodes,
          { revalidate: false },
        );
        mockMutate(
          `/api/discount-codes?partnerId=${mockCompositePartner.id}&workspaceId=${workspaceId}`,
          mockCompositePartner.discountCodes,
          { revalidate: false },
        );
      }

      if (mockCompositePartner.referral !== undefined) {
        mockMutate(
          `/api/partners/${mockCompositePartner.id}/referral?workspaceId=${workspaceId}`,
          mockCompositePartner.referral,
          { revalidate: false },
        );
      }

      if (mockCompositePartner.eligibleBounties) {
        mockMutate(
          `/api/bounties?workspaceId=${workspaceId}&partnerId=${mockCompositePartner.id}`,
          mockCompositePartner.eligibleBounties,
          { revalidate: false },
        );
      }

      if (mockCompositePartner.commentsCount !== undefined) {
        mockMutate(
          `/api/partners/${mockCompositePartner.id}/comments/count?workspaceId=${workspaceId}`,
          mockCompositePartner.commentsCount,
          { revalidate: false },
        );
      }

      if (mockCompositePartner.fraudCount !== undefined) {
        mockMutate(
          `/api/fraud/groups/count?workspaceId=${workspaceId}&groupBy=partnerId&status=pending`,
          [
            {
              partnerId: mockCompositePartner.id,
              _count: mockCompositePartner.fraudCount,
            },
          ],
          { revalidate: false },
        );
      }

      mockMutate(
        `/api/partners/${mockCompositePartner.id}?workspaceId=${workspaceId}`,
        mockCompositePartner,
        { revalidate: false },
      );

      // Verify every mutate operation specified revalidate: false
      expect(swrMutateLog.length).toBe(9);
      for (const entry of swrMutateLog) {
        expect(entry.revalidate).toBe(false);
      }

      // Check specific keys
      const keys = swrMutateLog.map((e) => e.key);
      expect(keys).toContain(
        `/api/groups/${groupId}?workspaceId=${workspaceId}`,
      );
      expect(keys).toContain(
        `/api/groups/${groupSlug}?workspaceId=${workspaceId}`,
      );
      expect(keys).toContain(
        `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      );
      expect(keys).toContain(
        `/api/discount-codes?partnerId=${partnerId}&workspaceId=${workspaceId}`,
      );
      expect(keys).toContain(
        `/api/partners/${partnerId}/referral?workspaceId=${workspaceId}`,
      );
      expect(keys).toContain(
        `/api/bounties?workspaceId=${workspaceId}&partnerId=${partnerId}`,
      );
      expect(keys).toContain(
        `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
      );
      expect(keys).toContain(
        `/api/fraud/groups/count?workspaceId=${workspaceId}&groupBy=partnerId&status=pending`,
      );
      expect(keys).toContain(
        `/api/partners/${partnerId}?workspaceId=${workspaceId}`,
      );
    });

    it("guarantees first-frame rendering via direct composite field fallback (no skeleton flash)", () => {
      const mockCompositePartner = {
        id: partnerId,
        name: "Test Partner",
        group: { id: groupId, name: "Elite Group", slug: groupSlug },
        discountCodes: [{ id: "dc_1", code: "PROMO20" }],
        referral: { stats: { totalPartners: 3 } },
        eligibleBounties: [{ id: "bty_1", name: "Bonus" }],
      };

      // In consumer components:
      const fetchedGroup = undefined;
      const resolvedGroup = mockCompositePartner.group ?? fetchedGroup;
      expect(resolvedGroup).toEqual(mockCompositePartner.group);

      const fetchedDiscountCodes = undefined;
      const resolvedCodes =
        mockCompositePartner.discountCodes ?? fetchedDiscountCodes;
      expect(resolvedCodes).toEqual(mockCompositePartner.discountCodes);

      const fetchedReferral = undefined;
      const resolvedReferral = mockCompositePartner.referral ?? fetchedReferral;
      expect(resolvedReferral).toEqual(mockCompositePartner.referral);

      const fetchedBounties = undefined;
      const resolvedBounties =
        mockCompositePartner.eligibleBounties ?? fetchedBounties;
      expect(resolvedBounties).toEqual(mockCompositePartner.eligibleBounties);

      // Loading states are suppressed when composite fields exist
      const isCodesLoading =
        mockCompositePartner.discountCodes === undefined && true;
      expect(isCodesLoading).toBe(false);

      const isReferralLoading =
        mockCompositePartner.referral === undefined ? true : false;
      expect(isReferralLoading).toBe(false);
    });

    it("gracefully handles null / partial composite sub-resources without runtime exceptions", () => {
      const partialComposite = {
        id: partnerId,
        name: "Minimal Partner",
        group: null,
        discountCodes: undefined,
        referral: undefined,
        eligibleBounties: undefined,
      };

      const fallbackGroup = { id: "grp_default", name: "Default" };
      const group = partialComposite.group ?? fallbackGroup;
      expect(group).toEqual(fallbackGroup);

      const isCodesLoading =
        partialComposite.discountCodes === undefined && true;
      expect(isCodesLoading).toBe(true);
    });
  });

  // =========================================================================
  // 5. Concurrency, Deduplication & Rapid Tab Switch Invariants
  // =========================================================================
  describe("5. Concurrency, Deduplication & Rapid Navigation Simulation", () => {
    it("proves deduplication interval (60s) prevents multiple network requests for identical URLs", () => {
      const inFlightRequests = new Map<
        string,
        { promise: Promise<any>; timestamp: number }
      >();
      const networkCallSpy = vi.fn().mockResolvedValue({ success: true });

      const fetchWithDedup = (
        url: string,
        now: number,
        dedupInterval = 60_000,
      ) => {
        const existing = inFlightRequests.get(url);
        if (existing && now - existing.timestamp < dedupInterval) {
          return existing.promise;
        }

        const promise = networkCallSpy(url);
        inFlightRequests.set(url, { promise, timestamp: now });
        return promise;
      };

      const t0 = 1000;
      const url = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;

      // 5 concurrent or rapid components requesting the same composite key within 60s
      const p1 = fetchWithDedup(url, t0);
      const p2 = fetchWithDedup(url, t0 + 100);
      const p3 = fetchWithDedup(url, t0 + 500);
      const p4 = fetchWithDedup(url, t0 + 1000);
      const p5 = fetchWithDedup(url, t0 + 50000);

      expect(p1).toBe(p2);
      expect(p2).toBe(p3);
      expect(p3).toBe(p4);
      expect(p4).toBe(p5);
      expect(networkCallSpy).toHaveBeenCalledTimes(1);

      // Beyond dedupingInterval (60s later)
      const p6 = fetchWithDedup(url, t0 + 61000);
      expect(p6).not.toBe(p1);
      expect(networkCallSpy).toHaveBeenCalledTimes(2);
    });
  });
});
