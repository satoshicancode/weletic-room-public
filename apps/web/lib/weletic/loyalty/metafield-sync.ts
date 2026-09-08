import { prisma } from "@/lib/prisma";
import {
  isLoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { shopifyAdminGraphqlRequest } from "@/lib/weletic/loyalty/shopify-discounts";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";

export const WELETIC_LOYALTY_NAMESPACE = "weletic_loyalty";

export interface LoyaltyAccountMetafieldPayload {
  ownerId?: string; // e.g. "gid://shopify/Customer/123456789"
  vipTierName?: string | null;
  vipTierOrder?: number | null;
  pointsBalance?: bigint | number | string | null;
  pendingPoints?: bigint | number | string | null;
  lifetimePoints?: bigint | number | string | null;
  referralCode?: string | null;
  referralLink?: string | null;
  tierMultiplier?: number | string | null;
  memberStatus?: string | null;
  birthDate?: Date | string | null;
}

export interface ShopifyMetafieldInput {
  ownerId?: string;
  namespace: string;
  key: string;
  value: string;
  type: string;
}

export interface SyncCustomerMetafieldsParams {
  storeId: string;
  shopifyCustomerId: string;
  accountId: string;
  customFetch?: typeof fetch;
  adminAccessToken?: string;
  shopDomain?: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}

export interface MetafieldSyncResult {
  success: boolean;
  shopifyCustomerId: string;
  syncedKeys: string[];
  metafieldsCount: number;
  metafields: ShopifyMetafieldInput[];
  userErrors?: Array<{ field: string[]; message: string; code?: string }>;
  error?: string;
}

/**
 * Normalizes customer GID to full Shopify Global ID format.
 */
export function normalizeShopifyCustomerGid(customerId: string): string {
  if (!customerId) return "";
  if (customerId.startsWith("gid://shopify/Customer/")) {
    return customerId;
  }
  const cleanId = customerId.replace(/^Customer\//, "").replace(/\D+/g, "");
  return `gid://shopify/Customer/${cleanId || customerId}`;
}

/**
 * Builds customer metafield inputs for Shopify Admin GraphQL API under the `weletic_loyalty` namespace.
 * Standard key order:
 * 1. vip_tier (single_line_text_field)
 * 2. vip_tier_order (number_integer)
 * 3. points_balance (number_integer)
 * 4. pending_points (number_integer)
 * 5. lifetime_points (number_integer)
 * 6. referral_code (single_line_text_field)
 * 7. referral_link (single_line_text_field)
 * 8. tier_multiplier (number_decimal)
 * 9. member_status (single_line_text_field)
 * 10. birth_date (date - optional)
 */
export function buildCustomerMetafieldUpdates(
  payload: LoyaltyAccountMetafieldPayload,
): ShopifyMetafieldInput[] {
  const metafields: ShopifyMetafieldInput[] = [];
  const ownerId = payload.ownerId;

  // 1. vip_tier (single_line_text_field)
  if (payload.vipTierName !== undefined && payload.vipTierName !== null) {
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "vip_tier",
      value: String(payload.vipTierName),
      type: "single_line_text_field",
    });
  }

  // 2. vip_tier_order (number_integer)
  if (payload.vipTierOrder !== undefined && payload.vipTierOrder !== null) {
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "vip_tier_order",
      value: String(payload.vipTierOrder),
      type: "number_integer",
    });
  }

  // 3. points_balance (number_integer)
  if (payload.pointsBalance !== undefined && payload.pointsBalance !== null) {
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "points_balance",
      value: String(payload.pointsBalance),
      type: "number_integer",
    });
  }

  // 4. pending_points (number_integer)
  if (payload.pendingPoints !== undefined && payload.pendingPoints !== null) {
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "pending_points",
      value: String(payload.pendingPoints),
      type: "number_integer",
    });
  }

  // 5. lifetime_points (number_integer)
  if (payload.lifetimePoints !== undefined && payload.lifetimePoints !== null) {
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "lifetime_points",
      value: String(payload.lifetimePoints),
      type: "number_integer",
    });
  }

  // 6. referral_code (single_line_text_field)
  if (payload.referralCode !== undefined && payload.referralCode !== null) {
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "referral_code",
      value: String(payload.referralCode),
      type: "single_line_text_field",
    });
  }

  // 7. referral_link (single_line_text_field)
  if (payload.referralLink !== undefined && payload.referralLink !== null) {
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "referral_link",
      value: String(payload.referralLink),
      type: "single_line_text_field",
    });
  }

  // 8. tier_multiplier (number_decimal)
  if (payload.tierMultiplier !== undefined && payload.tierMultiplier !== null) {
    const multNum = Number(payload.tierMultiplier);
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "tier_multiplier",
      value: isNaN(multNum) ? "1.00" : multNum.toFixed(2),
      type: "number_decimal",
    });
  }

  // 9. member_status (single_line_text_field)
  if (payload.memberStatus !== undefined && payload.memberStatus !== null) {
    metafields.push({
      ...(ownerId ? { ownerId } : {}),
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "member_status",
      value: String(payload.memberStatus).toLowerCase(),
      type: "single_line_text_field",
    });
  }

  // 10. birth_date (date - optional)
  if (payload.birthDate !== undefined && payload.birthDate !== null) {
    let dateStr = "";
    if (payload.birthDate instanceof Date) {
      dateStr = payload.birthDate.toISOString().split("T")[0];
    } else if (typeof payload.birthDate === "string") {
      dateStr = payload.birthDate.split("T")[0];
    }
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      metafields.push({
        ...(ownerId ? { ownerId } : {}),
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "birth_date",
        value: dateStr,
        type: "date",
      });
    }
  }

  return metafields;
}

export const SHOPIFY_METAFIELDS_SET_MUTATION = `
mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields {
      id
      namespace
      key
      value
      type
      ownerType
    }
    userErrors {
      field
      message
      code
    }
  }
}
`;

/**
 * Syncs a customer's complete loyalty state to Shopify Customer Metafields via Admin GraphQL API.
 * In production sync, sensitive PII like email, phone, and name are never synced.
 */
export async function syncCustomerMetafields(
  params: SyncCustomerMetafieldsParams,
): Promise<MetafieldSyncResult> {
  const {
    storeId,
    shopifyCustomerId,
    accountId,
    customFetch,
    adminAccessToken,
    shopDomain,
  } = params;

  // 1. Fetch account, shopper, currentTier, and store records
  const account = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    include: {
      shopper: true,
      currentTier: true,
      store: true,
    },
  });

  if (!account || account.storeId !== storeId) {
    throw new Error(
      `Loyalty account ${accountId} not found in store ${storeId}.`,
    );
  }

  const rawCustomerId = shopifyCustomerId || account.shopper?.shopifyCustomerId;
  if (!rawCustomerId) {
    return {
      success: false,
      shopifyCustomerId: "",
      syncedKeys: [],
      metafieldsCount: 0,
      metafields: [],
      error: "No Shopify Customer ID associated with account.",
    };
  }

  const normalizedGid = normalizeShopifyCustomerGid(rawCustomerId);
  const domain = shopDomain || account.store.shopDomain;
  if (!domain) {
    return {
      success: false,
      shopifyCustomerId: normalizedGid,
      syncedKeys: [],
      metafieldsCount: 0,
      metafields: [],
      error: "No Shopify store domain associated with loyalty account.",
    };
  }
  const referralLink = account.referralCode
    ? `https://${domain}?ref=${account.referralCode}`
    : "";

  // Determine status (including active grace period state)
  let status: string = account.status;
  if (account.tierExpiresAt && new Date(account.tierExpiresAt) > new Date()) {
    status = "in_grace_period";
  }

  const tierOrder = account.currentTier?.tierOrder ?? 1;

  // 2. Build 9-key PII-sanitized metafields payload
  const metafields = buildCustomerMetafieldUpdates({
    ownerId: normalizedGid,
    vipTierName: account.currentTier?.name ?? "Bronze",
    vipTierOrder: tierOrder,
    pointsBalance: account.cachedPointsBalance,
    pendingPoints: account.cachedPendingPoints,
    lifetimePoints: account.lifetimePointsEarned,
    referralCode: account.referralCode,
    referralLink,
    tierMultiplier: account.currentTier
      ? Number(account.currentTier.pointsMultiplier)
      : 1.0,
    memberStatus: status,
  });

  const syncedKeys = metafields.map((m) => m.key);

  // 3. Resolve offline token if not passed directly
  let token = adminAccessToken;
  let targetDomain = domain;
  let resolutionError: string | undefined;

  if (!token && !customFetch) {
    try {
      const resolvedStore = await resolveShopifyStoreByDomain(domain);
      if (resolvedStore?.accessToken) {
        token = resolvedStore.accessToken;
        targetDomain = resolvedStore.myshopifyDomain || domain;
      } else {
        resolutionError = `No Shopify offline credential found for ${domain}`;
      }
    } catch (error) {
      resolutionError =
        error instanceof Error
          ? error.message
          : `Unable to resolve Shopify offline credential for ${domain}`;
    }
  }

  const fetchFn = customFetch || (typeof fetch !== "undefined" ? fetch : null);

  if (fetchFn && (token || customFetch)) {
    try {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId,
        action: "loyalty_metafield_sync",
        expectedInstallationGeneration: params.expectedInstallationGeneration,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      });
      const response = await shopifyAdminGraphqlRequest<{
        metafieldsSet: {
          metafields?: Array<any>;
          userErrors?: Array<{
            field: string[];
            message: string;
            code?: string;
          }>;
        };
      }>({
        shopDomain: targetDomain,
        accessToken: token || "injected-transport-token",
        query: SHOPIFY_METAFIELDS_SET_MUTATION,
        variables: { metafields },
        customFetch: fetchFn,
      });

      const userErrors = response?.metafieldsSet?.userErrors;
      if (userErrors && userErrors.length > 0) {
        return {
          success: false,
          shopifyCustomerId: normalizedGid,
          syncedKeys,
          metafieldsCount: metafields.length,
          metafields,
          userErrors,
          error: userErrors.map((e: any) => e.message).join(", "),
        };
      }

      return {
        success: true,
        shopifyCustomerId: normalizedGid,
        syncedKeys,
        metafieldsCount: metafields.length,
        metafields,
      };
    } catch (err: any) {
      if (isLoyaltyMaintenanceBlockedError(err)) throw err;
      return {
        success: false,
        shopifyCustomerId: normalizedGid,
        syncedKeys,
        metafieldsCount: metafields.length,
        metafields,
        error: err?.message || "Failed to execute Shopify GraphQL mutation",
      };
    }
  }

  return {
    success: false,
    shopifyCustomerId: normalizedGid,
    syncedKeys,
    metafieldsCount: metafields.length,
    metafields,
    error:
      resolutionError ||
      "Shopify metafield sync could not run because no authenticated transport is available.",
  };
}

/**
 * Legacy compatibility wrapper for buildLoyaltyMetafieldsPayload.
 */
export function buildLoyaltyMetafieldsPayload(data: {
  vipTierName?: string | null;
  vipTierMultiplier?: number | null;
  pointsBalance?: bigint | number | null;
  referralCode?: string | null;
}): Array<{ namespace: string; key: string; value: string; type: string }> {
  const result: Array<{
    namespace: string;
    key: string;
    value: string;
    type: string;
  }> = [];

  if (data.vipTierName !== undefined && data.vipTierName !== null) {
    result.push({
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "vip_tier",
      value: String(data.vipTierName),
      type: "single_line_text_field",
    });
  }

  if (data.vipTierMultiplier !== undefined && data.vipTierMultiplier !== null) {
    result.push({
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "tier_multiplier",
      value: Number(data.vipTierMultiplier).toFixed(2),
      type: "number_decimal",
    });
  }

  if (data.pointsBalance !== undefined && data.pointsBalance !== null) {
    result.push({
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "points_balance",
      value: String(data.pointsBalance),
      type: "number_integer",
    });
  }

  if (data.referralCode !== undefined && data.referralCode !== null) {
    result.push({
      namespace: WELETIC_LOYALTY_NAMESPACE,
      key: "referral_code",
      value: String(data.referralCode),
      type: "single_line_text_field",
    });
  }

  return result;
}

/**
 * Legacy compatibility wrapper for syncCustomerLoyaltyMetafields.
 */
export async function syncCustomerLoyaltyMetafields(params: {
  storeId: string;
  accountId: string;
  shopifyCustomerId?: string | null;
  vipTierName?: string | null;
  vipTierMultiplier?: number | null;
  pointsBalance?: bigint | number | null;
  referralCode?: string | null;
}): Promise<{
  success: boolean;
  metafieldsCount: number;
  shopifyCustomerId?: string;
}> {
  const result = await syncCustomerMetafields({
    storeId: params.storeId,
    accountId: params.accountId,
    shopifyCustomerId: params.shopifyCustomerId || "",
  });

  return {
    success: result.success,
    metafieldsCount: result.metafieldsCount,
    shopifyCustomerId: result.shopifyCustomerId,
  };
}
