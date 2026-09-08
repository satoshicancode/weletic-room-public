import { prisma } from "@/lib/prisma";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/internal/shopify/loyalty/customer/activity/route";

const STORE_ID = "store_test_activity_1";
const SHOP_DOMAIN = "test-activity-store.myshopify.com";
const CUSTOMER_ID = "99887766";
const ACCOUNT_ID = "wacc_test_activity_1";
const SHOPPER_ID = "wshop_test_activity_1";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopper: {
      findUnique: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    weleticLoyaltyReferral: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  readWeleticShopifyRequestBody: vi.fn(async () => ""),
  verifyWeleticShopifyRequest: vi.fn(() => true),
  WELETIC_SHOPIFY_REQUEST_ID_HEADER: "x-weletic-request-id",
}));

describe("Customer Loyalty Activity Pagination & Filtering (Smile Parity)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveShopifyStoreByDomain).mockResolvedValue({
      storeId: STORE_ID,
      workspaceId: "ws_1",
      myshopifyDomain: SHOP_DOMAIN,
      primaryDomain: SHOP_DOMAIN,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Security & Query Validation", () => {
    it("returns 400 when shop parameter is missing", async () => {
      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?customerId=${CUSTOMER_ID}`,
      );
      const response = await GET(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error?.code).toBe("bad_request");
      expect(body.error?.message).toContain("shop");
    });

    it("returns 400 when customerId parameter is missing", async () => {
      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}`,
      );
      const response = await GET(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error?.code).toBe("bad_request");
      expect(body.error?.message).toContain("customerId");
    });

    it("returns 404 when shop domain cannot be resolved", async () => {
      vi.mocked(resolveShopifyStoreByDomain).mockResolvedValueOnce(null);
      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=unknown.myshopify.com&customerId=${CUSTOMER_ID}`,
      );
      const response = await GET(request);
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body.error?.code).toBe("store_not_found");
    });

    it("rejects a malformed opaque cursor", async () => {
      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=points&cursor=not-a-cursor`,
      );
      const response = await GET(request);
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error?.code).toBe("bad_request");
      expect(body.error?.message).toContain("cursor");
    });
  });

  describe("2. Empty State Handling", () => {
    it("returns empty paginated result when shopper is not found", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(null);

      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=points`,
      );
      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data).toEqual({
        type: "points",
        activities: [],
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasMore: false,
        },
      });
    });
  });

  describe("3. Points Ledger Activity Pagination", () => {
    it("uses the stable cursor in preference to page/limit offsets", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValue({
        id: SHOPPER_ID,
        storeId: STORE_ID,
        shopifyCustomerId: CUSTOMER_ID,
        loyaltyAccount: { id: ACCOUNT_ID, status: "active" },
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany)
        .mockResolvedValueOnce([
          {
            id: "entry_30",
            sequenceNumber: 30,
            entryType: "EARN_ORDER",
            pointsDelta: BigInt(30),
            balanceAfter: BigInt(30),
            reason: "Order 30",
            referenceType: "ORDER",
            referenceId: "30",
            createdAt: new Date("2026-09-03T00:00:00.000Z"),
          },
          {
            id: "entry_29",
            sequenceNumber: 29,
            entryType: "EARN_ORDER",
            pointsDelta: BigInt(29),
            balanceAfter: BigInt(59),
            reason: "Order 29",
            referenceType: "ORDER",
            referenceId: "29",
            createdAt: new Date("2026-09-02T00:00:00.000Z"),
          },
          {
            id: "entry_28",
            sequenceNumber: 28,
            entryType: "EARN_ORDER",
            pointsDelta: BigInt(28),
            balanceAfter: BigInt(87),
            reason: "Order 28",
            referenceType: "ORDER",
            referenceId: "28",
            createdAt: new Date("2026-09-01T00:00:00.000Z"),
          },
        ] as any)
        .mockResolvedValueOnce([]);

      const first = await GET(
        new Request(
          `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=points&cursor=&page=999999999&limit=2`,
        ),
      );
      const firstBody = await first.json();
      expect(first.status).toBe(200);
      expect(
        firstBody.data.activities.map((entry: { id: string }) => entry.id),
      ).toEqual(["entry_30", "entry_29"]);
      expect(firstBody.data.pagination).toMatchObject({
        mode: "cursor",
        hasMore: true,
        total: 0,
        totalPages: 0,
      });
      expect(firstBody.data.pagination.nextCursor).toEqual(expect.any(String));
      expect(prisma.weleticPointsLedgerEntry.count).not.toHaveBeenCalled();

      const second = await GET(
        new Request(
          `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=points&cursor=${encodeURIComponent(firstBody.data.pagination.nextCursor)}&page=1&limit=2`,
        ),
      );
      expect(second.status).toBe(200);
      expect(
        vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mock.calls[1][0],
      ).toMatchObject({
        where: {
          OR: [
            { sequenceNumber: { lt: 29 } },
            { sequenceNumber: 29, id: { lt: "entry_29" } },
          ],
        },
        orderBy: [{ sequenceNumber: "desc" }, { id: "desc" }],
        take: 3,
      });
    });

    it("returns paginated points activity with default limit", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: SHOPPER_ID,
        storeId: STORE_ID,
        shopifyCustomerId: CUSTOMER_ID,
        loyaltyAccount: { id: ACCOUNT_ID, status: "active" },
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.count).mockResolvedValueOnce(
        25,
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            id: "entry_1",
            entryType: "EARN_ORDER",
            pointsDelta: BigInt(100),
            balanceAfter: BigInt(500),
            reason: "Order #1001",
            referenceType: "CommerceOrder",
            referenceId: "order_1",
            createdAt: new Date("2026-06-01T10:00:00.000Z"),
          },
          {
            id: "entry_2",
            entryType: "REDEEM_REWARD",
            pointsDelta: BigInt(-200),
            balanceAfter: BigInt(400),
            reason: "¥500 off coupon",
            referenceType: "WeleticRewardRedemption",
            referenceId: "red_1",
            createdAt: new Date("2026-05-30T10:00:00.000Z"),
          },
        ] as any,
      );

      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=points&page=1&limit=20`,
      );
      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.data.type).toBe("points");
      expect(body.data.activities).toHaveLength(2);
      expect(body.data.activities[0]).toEqual({
        id: "entry_1",
        entryType: "EARN_ORDER",
        pointsDelta: "100",
        balanceAfter: "500",
        reason: "Order #1001",
        referenceType: "CommerceOrder",
        referenceId: "order_1",
        createdAt: "2026-06-01T10:00:00.000Z",
      });
      expect(body.data.pagination).toEqual({
        page: 1,
        limit: 20,
        total: 25,
        totalPages: 2,
        hasMore: true,
      });
    });

    it("clamps limit to 50 when client requests excessive limit", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: SHOPPER_ID,
        storeId: STORE_ID,
        shopifyCustomerId: CUSTOMER_ID,
        loyaltyAccount: { id: ACCOUNT_ID, status: "active" },
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.count).mockResolvedValueOnce(
        10,
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=points&limit=500`,
      );
      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.data.pagination.limit).toBe(50);
      expect(prisma.weleticPointsLedgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50 }),
      );
    });
  });

  describe("4. Referrals Activity Pagination", () => {
    it("uses createdAt plus ID as the stable referrals cursor", async () => {
      const createdAt = new Date("2026-06-01T12:00:00.000Z");
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValue({
        id: SHOPPER_ID,
        storeId: STORE_ID,
        shopifyCustomerId: CUSTOMER_ID,
        loyaltyAccount: { id: ACCOUNT_ID, status: "active" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findMany)
        .mockResolvedValueOnce([
          {
            id: "ref_b",
            status: "pending",
            advocatePointsAwarded: BigInt(0),
            refereePointsAwarded: BigInt(0),
            rewardedAt: null,
            createdAt,
            refereeAccount: null,
          },
          {
            id: "ref_a",
            status: "pending",
            advocatePointsAwarded: BigInt(0),
            refereePointsAwarded: BigInt(0),
            rewardedAt: null,
            createdAt,
            refereeAccount: null,
          },
        ] as any)
        .mockResolvedValueOnce([]);

      const first = await GET(
        new Request(
          `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=referrals&cursor=&limit=1`,
        ),
      );
      const firstBody = await first.json();
      const second = await GET(
        new Request(
          `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=referrals&cursor=${encodeURIComponent(firstBody.data.pagination.nextCursor)}&limit=1`,
        ),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(
        vi.mocked(prisma.weleticLoyaltyReferral.findMany).mock.calls[1][0],
      ).toMatchObject({
        where: {
          OR: [
            { createdAt: { lt: createdAt } },
            { createdAt, id: { lt: "ref_b" } },
          ],
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 2,
      });
      expect(prisma.weleticLoyaltyReferral.count).not.toHaveBeenCalled();
    });

    it("returns paginated referrals activity with referee details", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: SHOPPER_ID,
        storeId: STORE_ID,
        shopifyCustomerId: CUSTOMER_ID,
        loyaltyAccount: { id: ACCOUNT_ID, status: "active" },
      } as any);

      vi.mocked(prisma.weleticLoyaltyReferral.count).mockResolvedValueOnce(3);
      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce([
        {
          id: "ref_1",
          status: "rewarded",
          advocatePointsAwarded: BigInt(500),
          refereePointsAwarded: BigInt(0),
          rewardedAt: new Date("2026-06-02T12:00:00.000Z"),
          createdAt: new Date("2026-06-01T12:00:00.000Z"),
          refereeAccount: {
            shopper: {
              firstName: "Alice",
            },
          },
        },
      ] as any);

      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=referrals&page=1&limit=10`,
      );
      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.data.type).toBe("referrals");
      expect(body.data.activities).toHaveLength(1);
      expect(body.data.activities[0]).toEqual({
        id: "ref_1",
        status: "rewarded",
        refereeName: "Alice",
        advocatePointsAwarded: "500",
        refereePointsAwarded: "0",
        rewardedAt: "2026-06-02T12:00:00.000Z",
        createdAt: "2026-06-01T12:00:00.000Z",
      });
      expect(body.data.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 3,
        totalPages: 1,
        hasMore: false,
      });
    });
  });

  describe("5. VIP Tier History Pagination", () => {
    it("uses effectiveAt plus ID as the stable VIP cursor", async () => {
      const effectiveAt = new Date("2026-06-03T15:00:00.000Z");
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValue({
        id: SHOPPER_ID,
        storeId: STORE_ID,
        shopifyCustomerId: CUSTOMER_ID,
        loyaltyAccount: { id: ACCOUNT_ID, status: "active" },
      } as any);
      vi.mocked(prisma.weleticLoyaltyTierHistory.findMany)
        .mockResolvedValueOnce([
          {
            id: "hist_b",
            fromTier: null,
            toTier: { id: "tier_gold", name: "Gold" },
            changeReason: "threshold_reached",
            qualifyingSpendSnapshot: null,
            qualifyingPointsSnapshot: null,
            effectiveAt,
          },
          {
            id: "hist_a",
            fromTier: null,
            toTier: { id: "tier_gold", name: "Gold" },
            changeReason: "threshold_reached",
            qualifyingSpendSnapshot: null,
            qualifyingPointsSnapshot: null,
            effectiveAt,
          },
        ] as any)
        .mockResolvedValueOnce([]);

      const first = await GET(
        new Request(
          `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=vip&cursor=&limit=1`,
        ),
      );
      const firstBody = await first.json();
      const second = await GET(
        new Request(
          `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=vip&cursor=${encodeURIComponent(firstBody.data.pagination.nextCursor)}&limit=1`,
        ),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(
        vi.mocked(prisma.weleticLoyaltyTierHistory.findMany).mock.calls[1][0],
      ).toMatchObject({
        where: {
          OR: [
            { effectiveAt: { lt: effectiveAt } },
            { effectiveAt, id: { lt: "hist_b" } },
          ],
        },
        orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
        take: 2,
      });
      expect(prisma.weleticLoyaltyTierHistory.count).not.toHaveBeenCalled();
    });

    it("returns paginated VIP tier transitions with fromTier and toTier", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: SHOPPER_ID,
        storeId: STORE_ID,
        shopifyCustomerId: CUSTOMER_ID,
        loyaltyAccount: { id: ACCOUNT_ID, status: "active" },
      } as any);

      vi.mocked(prisma.weleticLoyaltyTierHistory.count).mockResolvedValueOnce(
        2,
      );
      vi.mocked(
        prisma.weleticLoyaltyTierHistory.findMany,
      ).mockResolvedValueOnce([
        {
          id: "hist_1",
          fromTier: { id: "tier_bronze", name: "Bronze" },
          toTier: { id: "tier_silver", name: "Silver" },
          changeReason: "threshold_reached",
          qualifyingSpendSnapshot: { toString: () => "50000" },
          qualifyingPointsSnapshot: { toString: () => "1000" },
          effectiveAt: new Date("2026-06-03T15:00:00.000Z"),
        },
      ] as any);

      const request = new Request(
        `https://app.example.test/api/internal/shopify/loyalty/customer/activity?shop=${SHOP_DOMAIN}&customerId=${CUSTOMER_ID}&type=vip&page=1&limit=5`,
      );
      const response = await GET(request);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.data.type).toBe("vip");
      expect(body.data.activities).toHaveLength(1);
      expect(body.data.activities[0]).toEqual({
        id: "hist_1",
        fromTier: { id: "tier_bronze", name: "Bronze" },
        toTier: { id: "tier_silver", name: "Silver" },
        changeReason: "threshold_reached",
        qualifyingSpendSnapshot: "50000",
        qualifyingPointsSnapshot: "1000",
        effectiveAt: "2026-06-03T15:00:00.000Z",
      });
      expect(body.data.pagination).toEqual({
        page: 1,
        limit: 5,
        total: 2,
        totalPages: 1,
        hasMore: false,
      });
    });
  });
});
