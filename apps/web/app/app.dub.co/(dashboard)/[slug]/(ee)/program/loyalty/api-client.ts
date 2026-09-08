/**
 * Unified API Client for Weletic Loyalty Merchant Admin
 * Handles standard { data: ... } envelope unwrapping and error handling
 */

import type {
  LoyaltyBranding,
  LoyaltyBrandingResponse,
  LoyaltyBrandingUpdateResponse,
} from "@/lib/weletic/loyalty/branding";

export type {
  LoyaltyBranding,
  LoyaltyBrandingResponse,
  LoyaltyBrandingUpdateResponse,
} from "@/lib/weletic/loyalty/branding";

export interface LoyaltyApiResponse<T = any> {
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export interface LoyaltyActivityEntry {
  id: string;
  sequenceNumber: number;
  entryType: string;
  pointsDelta: string;
  pendingDelta: string;
  balanceAfter: string;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  createdAt: string;
  customer: {
    name: string;
    email: string | null;
  } | null;
  tierName: string;
}

export interface LoyaltyCohortAnalytics {
  currency: string;
  dataQuality: {
    status: "available" | "temporarily_unavailable" | "data_quality_error";
    reason: string | null;
  };
  members: {
    aovDecimal: string | null;
    ltvDecimal: string | null;
  };
  nonMembers: {
    aovDecimal: string | null;
    ltvDecimal: string | null;
  };
  lift: {
    aovLiftPercentage: number | null;
    ltvLiftPercentage: number | null;
  };
}

export function toLoyaltyActivityTableRow(entry: LoyaltyActivityEntry) {
  return {
    pointsDelta: entry.pointsDelta,
    pendingDelta: entry.pendingDelta,
    balanceAfter: entry.balanceAfter,
    customerName: entry.customer?.name || entry.customer?.email || "—",
    customerEmail:
      entry.customer?.name && entry.customer.email
        ? entry.customer.email
        : null,
    notes: entry.reason || entry.referenceId || "—",
  };
}

export type ParsedLoyaltyPointInteger =
  | { state: "valid"; value: bigint }
  | { state: "invalid"; display: "Invalid" };

const MIN_SIGNED_64_BIT_INTEGER = BigInt("-9223372036854775808");
const MAX_SIGNED_64_BIT_INTEGER = BigInt("9223372036854775807");

export function parseLoyaltyPointInteger(
  value: unknown,
): ParsedLoyaltyPointInteger {
  if (
    typeof value !== "string" ||
    value.length > 20 ||
    !/^(?:0|[1-9]\d*|-[1-9]\d*)$/.test(value)
  ) {
    return { state: "invalid", display: "Invalid" };
  }

  const parsed = BigInt(value);
  if (
    parsed < MIN_SIGNED_64_BIT_INTEGER ||
    parsed > MAX_SIGNED_64_BIT_INTEGER
  ) {
    return { state: "invalid", display: "Invalid" };
  }
  return { state: "valid", value: parsed };
}

export function addLoyaltyWorkspaceContext(
  endpoint: string,
  pathname = typeof window === "undefined" ? "" : window.location.pathname,
): string {
  if (!endpoint.startsWith("/api/") || !pathname) return endpoint;

  const url = new URL(endpoint, "http://weletic.local");
  if (
    url.searchParams.has("workspaceId") ||
    url.searchParams.has("projectSlug")
  ) {
    return endpoint;
  }

  const [workspaceSlug] = pathname.split("/").filter(Boolean);
  if (!workspaceSlug) return endpoint;

  url.searchParams.set("projectSlug", workspaceSlug);
  return `${url.pathname}${url.search}${url.hash}`;
}

export async function fetchLoyaltyAdmin<T>(
  endpoint: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(addLoyaltyWorkspaceContext(endpoint), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  const json: LoyaltyApiResponse<T> = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errorMsg =
      json?.error?.message || `Request failed with status ${res.status}`;
    throw new Error(errorMsg);
  }

  return json.data !== undefined ? json.data : (json as unknown as T);
}

export const LoyaltyAdminApi = {
  // Settings
  getSettings: () =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/settings"),
  updateSettings: (data: any) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/settings", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Earn Rules
  getEarnRules: () =>
    fetchLoyaltyAdmin<{ rules: any[]; programId: string }>(
      "/api/shopify/loyalty/admin/earn-rules",
    ),
  createEarnRule: (data: any) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/earn-rules", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteEarnRule: (ruleId: string) =>
    fetchLoyaltyAdmin<any>(
      `/api/shopify/loyalty/admin/earn-rules?ruleId=${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    ),
  getReviewIntegration: () =>
    fetchLoyaltyAdmin<{
      provider: "judgeme";
      connected: boolean;
      lastVerifiedAt: string | null;
    }>("/api/shopify/loyalty/admin/review-integrations"),
  configureReviewIntegration: (privateApiToken: string) =>
    fetchLoyaltyAdmin<{
      provider: "judgeme";
      connected: boolean;
      lastVerifiedAt: string | null;
    }>("/api/shopify/loyalty/admin/review-integrations", {
      method: "POST",
      body: JSON.stringify({ privateApiToken }),
    }),

  // Rewards
  getRewards: (status?: string) =>
    fetchLoyaltyAdmin<any[]>(
      `/api/shopify/loyalty/admin/rewards${status ? `?status=${status}` : ""}`,
    ),
  createReward: (data: any) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/rewards", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateReward: (data: any) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/rewards", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteReward: (id: string) =>
    fetchLoyaltyAdmin<any>(
      `/api/shopify/loyalty/admin/rewards?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),

  // Customers & Accounts
  getCustomers: (params?: {
    page?: number;
    limit?: number;
    search?: string;
    tierId?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set("page", String(params.page));
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.search) q.set("search", params.search);
    if (params?.tierId) q.set("tierId", params.tierId);
    return fetchLoyaltyAdmin<{
      accounts: any[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }>(`/api/shopify/loyalty/admin/accounts?${q.toString()}`);
  },
  getCustomer: (accountId: string) =>
    fetchLoyaltyAdmin<any>(
      `/api/shopify/loyalty/admin/accounts?accountId=${encodeURIComponent(accountId)}`,
    ),
  adjustCustomerPoints: (data: {
    shopperId?: string;
    accountId?: string;
    pointsDelta: number;
    reason: string;
    adjustmentType?: string;
    referenceId?: string;
  }) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/accounts", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  // Activity Ledger
  getActivity: (params?: {
    page?: number;
    limit?: number;
    type?: string;
    search?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.page) q.set("page", String(params.page));
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.type && params.type !== "all") q.set("type", params.type);
    if (params?.search) q.set("search", params.search);
    return fetchLoyaltyAdmin<{
      entries: LoyaltyActivityEntry[];
      pagination: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
    }>(`/api/shopify/loyalty/admin/activity?${q.toString()}`);
  },
  exportActivityCsv: async () => {
    const res = await fetch(
      addLoyaltyWorkspaceContext(
        "/api/shopify/loyalty/admin/activity?format=csv",
      ),
    );
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      throw new Error(
        json?.error?.message || "Failed to export activity ledger CSV",
      );
    }
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `loyalty-activity-ledger-${new Date().toISOString().split("T")[0]}.csv`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  },

  // Referrals
  getReferrals: () =>
    fetchLoyaltyAdmin<{ rule: any; metrics: any }>(
      "/api/shopify/loyalty/admin/referrals",
    ),
  updateReferrals: (data: any) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/referrals", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  reviewReferral: (data: {
    referralId: string;
    action: "cancel" | "unblock";
    reason?: string;
    note?: string;
  }) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/referrals", {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  // VIP Tiers
  getTiers: () => fetchLoyaltyAdmin<any[]>("/api/shopify/loyalty/admin/tiers"),
  createTier: (data: any) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/tiers", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateTier: (data: any) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/tiers", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteTier: (tierId: string) =>
    fetchLoyaltyAdmin<any>(
      `/api/shopify/loyalty/admin/tiers?tierId=${encodeURIComponent(tierId)}`,
      { method: "DELETE" },
    ),

  // Bonus Campaigns
  getCampaigns: () =>
    fetchLoyaltyAdmin<{ campaigns: any[] }>(
      "/api/shopify/loyalty/admin/campaigns",
    ),
  createCampaign: (data: any) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/campaigns", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  deleteCampaign: (campaignId: string) =>
    fetchLoyaltyAdmin<any>(
      `/api/shopify/loyalty/admin/campaigns?campaignId=${encodeURIComponent(campaignId)}`,
      { method: "DELETE" },
    ),

  // Analytics
  getAnalytics: (params?: {
    currency?: string;
    startDate?: string;
    endDate?: string;
  }) => {
    const q = new URLSearchParams();
    if (params?.currency) q.set("currency", params.currency);
    if (params?.startDate) q.set("startDate", params.startDate);
    if (params?.endDate) q.set("endDate", params.endDate);
    return fetchLoyaltyAdmin<any>(
      `/api/shopify/loyalty/admin/analytics?${q.toString()}`,
    );
  },
  getAnalyticsCohorts: (params?: { startDate?: string; endDate?: string }) => {
    const q = new URLSearchParams();
    if (params?.startDate) q.set("startDate", params.startDate);
    if (params?.endDate) q.set("endDate", params.endDate);
    return fetchLoyaltyAdmin<LoyaltyCohortAnalytics>(
      `/api/shopify/loyalty/admin/analytics/cohorts?${q.toString()}`,
    );
  },
  getAnalyticsExport: async (
    format: "json" | "csv",
    params?: { startDate?: string; endDate?: string },
  ) => {
    const q = new URLSearchParams({ format });
    if (params?.startDate) q.set("startDate", params.startDate);
    if (params?.endDate) q.set("endDate", params.endDate);
    const endpoint = addLoyaltyWorkspaceContext(
      `/api/shopify/loyalty/admin/analytics/export?${q.toString()}`,
    );
    const response = await fetch(endpoint);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(
        body?.error?.message || `Export failed with status ${response.status}`,
      );
    }
    return response.blob();
  },

  // On-site Branding
  getBranding: () =>
    fetchLoyaltyAdmin<LoyaltyBrandingResponse>(
      "/api/shopify/loyalty/admin/branding",
    ),
  updateBranding: (branding: LoyaltyBranding) =>
    fetchLoyaltyAdmin<LoyaltyBrandingUpdateResponse>(
      "/api/shopify/loyalty/admin/branding",
      {
        method: "POST",
        body: JSON.stringify({ branding }),
      },
    ),

  // Historical Backfill
  getBackfillJobs: () =>
    fetchLoyaltyAdmin<any[]>("/api/shopify/loyalty/admin/backfill"),
  getBackfillJob: (jobId: string) =>
    fetchLoyaltyAdmin<any>(
      `/api/shopify/loyalty/admin/backfill?jobId=${encodeURIComponent(jobId)}`,
    ),
  createBackfillPreview: (data: {
    lookbackDays?: number;
    pointsPerCurrencyUnit?: number;
    minOrderAmount?: number;
  }) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/backfill", {
      method: "POST",
      body: JSON.stringify({ action: "preview", ...data }),
    }),
  commitBackfill: (jobId: string) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/backfill", {
      method: "POST",
      body: JSON.stringify({ action: "commit", jobId }),
    }),
  cancelBackfill: (jobId: string) =>
    fetchLoyaltyAdmin<any>("/api/shopify/loyalty/admin/backfill", {
      method: "POST",
      body: JSON.stringify({ action: "cancel", jobId }),
    }),
};
