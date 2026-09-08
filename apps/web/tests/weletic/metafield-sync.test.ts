import { prisma } from "@/lib/prisma";
import {
  buildCustomerMetafieldUpdates,
  normalizeShopifyCustomerGid,
  SHOPIFY_METAFIELDS_SET_MUTATION,
  syncCustomerMetafields,
  WELETIC_LOYALTY_NAMESPACE,
} from "@/lib/weletic/loyalty/metafield-sync";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    installedIntegration: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
  },
}));

describe("Shopify Customer Metafields Sync Engine (Milestone 4 - PII Sanitized)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.installedIntegration.findMany).mockResolvedValue([]);
  });

  describe("1. Customer GID Normalization (normalizeShopifyCustomerGid)", () => {
    it("converts raw numeric IDs to standard Shopify Global IDs", () => {
      expect(normalizeShopifyCustomerGid("987654321")).toBe(
        "gid://shopify/Customer/987654321",
      );
      expect(normalizeShopifyCustomerGid("Customer/12345")).toBe(
        "gid://shopify/Customer/12345",
      );
    });

    it("preserves already formatted Shopify Global IDs", () => {
      expect(
        normalizeShopifyCustomerGid("gid://shopify/Customer/987654321"),
      ).toBe("gid://shopify/Customer/987654321");
    });
  });

  describe("2. PII-Sanitized Metafield Payload Builder (buildCustomerMetafieldUpdates)", () => {
    it("builds complete 9-key loyalty metafields payload with correct Shopify types and namespace", () => {
      const payload = buildCustomerMetafieldUpdates({
        ownerId: "gid://shopify/Customer/123456789",
        vipTierName: "Gold",
        vipTierOrder: 3,
        pointsBalance: BigInt(1250),
        pendingPoints: BigInt(200),
        lifetimePoints: BigInt(3500),
        referralCode: "ALICE123",
        referralLink: "https://brand.store?ref=ALICE123",
        tierMultiplier: 1.5,
        memberStatus: "active",
      });

      expect(payload).toHaveLength(9);

      // Verify all 9 projection keys and their Shopify schema types
      const map = new Map(payload.map((m) => [m.key, m]));

      expect(map.get("vip_tier")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "vip_tier",
        value: "Gold",
        type: "single_line_text_field",
      });

      expect(map.get("vip_tier_order")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "vip_tier_order",
        value: "3",
        type: "number_integer",
      });

      expect(map.get("points_balance")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "points_balance",
        value: "1250",
        type: "number_integer",
      });

      expect(map.get("pending_points")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "pending_points",
        value: "200",
        type: "number_integer",
      });

      expect(map.get("lifetime_points")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "lifetime_points",
        value: "3500",
        type: "number_integer",
      });

      expect(map.get("referral_code")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "referral_code",
        value: "ALICE123",
        type: "single_line_text_field",
      });

      expect(map.get("referral_link")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "referral_link",
        value: "https://brand.store?ref=ALICE123",
        type: "single_line_text_field",
      });

      expect(map.get("tier_multiplier")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "tier_multiplier",
        value: "1.50",
        type: "number_decimal",
      });

      expect(map.get("member_status")).toEqual({
        ownerId: "gid://shopify/Customer/123456789",
        namespace: WELETIC_LOYALTY_NAMESPACE,
        key: "member_status",
        value: "active",
        type: "single_line_text_field",
      });
    });

    it("STRICT PII EXCLUSION: Never includes email, phone, address, or names in customer metafields", () => {
      const payload = buildCustomerMetafieldUpdates({
        ownerId: "gid://shopify/Customer/123456789",
        vipTierName: "Platinum",
        pointsBalance: 500,
        ...({
          email: "shopper@example.com",
          phone: "+1234567890",
          firstName: "John",
          lastName: "Doe",
          address: "123 Main St",
        } as any),
      });

      const keys = payload.map((m) => m.key);
      expect(keys).not.toContain("email");
      expect(keys).not.toContain("phone");
      expect(keys).not.toContain("first_name");
      expect(keys).not.toContain("last_name");
      expect(keys).not.toContain("address");
    });

    it("omits undefined / null fields safely without producing invalid metafield entries", () => {
      const payload = buildCustomerMetafieldUpdates({
        vipTierName: "Bronze",
        pointsBalance: 0,
      });

      expect(payload).toHaveLength(2);
      expect(payload.map((m) => m.key)).toEqual(["vip_tier", "points_balance"]);
    });
  });

  describe("3. Shopify Admin GraphQL Dispatcher (syncCustomerMetafields)", () => {
    it("fetches account details and constructs 9 PII-sanitized metafields", async () => {
      const storeId = "store_test_1";
      const accountId = "acc_user_1";
      const shopifyCustomerId = "987654321";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(750),
        cachedPendingPoints: BigInt(50),
        lifetimePointsEarned: BigInt(1500),
        referralCode: "BOB456",
        status: "active",
        tierExpiresAt: null,
        currentTier: {
          id: "tier_silver",
          name: "Silver",
          tierOrder: 2,
          pointsMultiplier: 1.25,
        },
        shopper: {
          id: "shopper_1",
          shopifyCustomerId: "987654321",
        },
        store: {
          id: storeId,
          shopDomain: "teststore.myshopify.com",
        },
      } as any);

      const result = await syncCustomerMetafields({
        storeId,
        accountId,
        shopifyCustomerId,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("offline credential");
      expect(result.shopifyCustomerId).toBe("gid://shopify/Customer/987654321");
      expect(result.metafieldsCount).toBe(9);
      expect(result.syncedKeys).toContain("vip_tier");
      expect(result.syncedKeys).toContain("points_balance");
      expect(result.syncedKeys).toContain("tier_multiplier");
      expect(result.syncedKeys).toContain("referral_link");
      expect(result.syncedKeys).not.toContain("birth_date");
    });

    it("sets member_status to 'in_grace_period' when account has active tierExpiresAt", async () => {
      const storeId = "store_test_1";
      const accountId = "acc_grace_user";
      const futureDate = new Date(Date.now() + 15 * 86400000); // 15 days in future

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(200),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(500),
        referralCode: "CHARLIE789",
        status: "active",
        tierExpiresAt: futureDate,
        currentTier: {
          id: "tier_gold",
          name: "Gold",
          tierOrder: 3,
          pointsMultiplier: 1.5,
        },
        shopper: {
          id: "shopper_2",
          shopifyCustomerId: "gid://shopify/Customer/445566",
        },
        store: {
          shopDomain: "teststore.myshopify.com",
        },
      } as any);

      const result = await syncCustomerMetafields({
        storeId,
        accountId,
        shopifyCustomerId: "gid://shopify/Customer/445566",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("offline credential");
      const statusMetafield = result.metafields.find(
        (m) => m.key === "member_status",
      );
      expect(statusMetafield?.value).toBe("in_grace_period");
    });

    it("executes GraphQL mutation with customFetch and handles userErrors properly", async () => {
      const storeId = "store_test_1";
      const accountId = "acc_user_err";
      const shopifyCustomerId = "gid://shopify/Customer/778899";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        status: "active",
        store: { shopDomain: "teststore.myshopify.com" },
      } as any);

      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            metafieldsSet: {
              metafields: [],
              userErrors: [
                {
                  field: ["metafields", "0", "ownerId"],
                  message: "Customer does not exist",
                  code: "NOT_FOUND",
                },
              ],
            },
          },
        }),
      });

      const result = await syncCustomerMetafields({
        storeId,
        accountId,
        shopifyCustomerId,
        customFetch: mockFetch as any,
        adminAccessToken: "shpat_test123",
        shopDomain: "teststore.myshopify.com",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Customer does not exist");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("verifies GraphQL query schema definition string", () => {
      expect(SHOPIFY_METAFIELDS_SET_MUTATION).toContain(
        "mutation MetafieldsSet",
      );
      expect(SHOPIFY_METAFIELDS_SET_MUTATION).toContain(
        "metafieldsSet(metafields: $metafields)",
      );
    });
  });
});
