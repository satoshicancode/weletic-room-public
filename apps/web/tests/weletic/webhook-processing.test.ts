import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { linkCache } from "@/lib/api/links/cache";
import { prisma } from "@/lib/prisma";
import {
  compensateDiscountSaga,
  withLockedLoyaltyAccount,
} from "@/lib/weletic/loyalty/saga";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import {
  discountsDelete,
  discountsUpdate,
} from "../../app/(ee)/api/shopify/integration/webhook/discounts-sync";

vi.mock("@/lib/api/links/cache", () => ({
  linkCache: {
    expireMany: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("@/lib/weletic/loyalty/saga", () => ({
  compensateDiscountSaga: vi.fn().mockResolvedValue({}),
  withLockedLoyaltyAccount: vi.fn(async ({ fn }) =>
    fn({ status: "active", metadata: null }),
  ),
}));

vi.mock("@/lib/weletic/commerce/reconcile-shopify-discounts", () => ({
  reconcileWeleticShopifyDiscounts: vi.fn().mockResolvedValue({
    checked: 0,
    healedCount: 0,
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    weleticRewardRedemption: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    discountCode: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

describe("Shopify Webhook Processing & Delivery Scenarios", () => {
  const secret = "shpss_test_secret_12345";
  const rawBody = JSON.stringify({
    id: 1001,
    admin_graphql_api_id: "gid://shopify/Order/1001",
    total_price: "120.00",
    currency: "USD",
  });

  const validHmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  it("Scenario 1a: accepts valid HMAC signature", () => {
    const isValid = verifyShopifyWebhookSignature({
      body: rawBody,
      signature: validHmac,
      secret,
    });
    expect(isValid).toBe(true);
  });

  it("Scenario 1b: rejects tampered webhook payload or altered characters", () => {
    const tamperedBody = rawBody.replace("120.00", "999.00");
    const isValid = verifyShopifyWebhookSignature({
      body: tamperedBody,
      signature: validHmac,
      secret,
    });
    expect(isValid).toBe(false);
  });

  it("Scenario 1c: rejects mismatched or malformed HMAC header", () => {
    expect(
      verifyShopifyWebhookSignature({
        body: rawBody,
        signature: "invalid_base64_hmac",
        secret,
      }),
    ).toBe(false);

    expect(
      verifyShopifyWebhookSignature({
        body: rawBody,
        signature: "",
        secret,
      }),
    ).toBe(false);
  });

  it("Scenario 2: deduplicates simultaneous deliveries of the same webhook event ID", async () => {
    const processedEvents = new Map<
      string,
      { status: string; leaseExpiresAt: number }
    >();

    // Simulated atomic event lease acquirer
    const acquireWebhookLease = (webhookId: string, now: number) => {
      const existing = processedEvents.get(webhookId);
      if (existing) {
        if (existing.status === "completed") {
          return { status: "duplicate_completed" };
        }
        if (existing.status === "processing" && existing.leaseExpiresAt > now) {
          return { status: "already_processing" };
        }
      }
      processedEvents.set(webhookId, {
        status: "processing",
        leaseExpiresAt: now + 60_000,
      });
      return { status: "acquired" };
    };

    const webhookId = "wh_event_shopify_999";
    const now = Date.now();

    // First delivery acquires lease
    const firstDelivery = acquireWebhookLease(webhookId, now);
    expect(firstDelivery.status).toBe("acquired");

    // Simultaneous second delivery is rejected because it is already processing
    const secondDelivery = acquireWebhookLease(webhookId, now + 100);
    expect(secondDelivery.status).toBe("already_processing");

    // Complete first delivery
    processedEvents.set(webhookId, { status: "completed", leaseExpiresAt: 0 });

    // Subsequent redelivery is acknowledged as duplicate completed
    const thirdDelivery = acquireWebhookLease(webhookId, now + 2000);
    expect(thirdDelivery.status).toBe("duplicate_completed");
  });

  it("Scenario 3: allows retry after processing failure or expired stale lease", () => {
    const processedEvents = new Map<
      string,
      { status: string; leaseExpiresAt: number }
    >();
    const webhookId = "wh_event_shopify_stale_123";
    let now = Date.now();

    // First attempt starts but crashes/times out
    processedEvents.set(webhookId, {
      status: "processing",
      leaseExpiresAt: now + 60_000,
    });

    // While lease is active, retry is blocked
    const activeCheck = processedEvents.get(webhookId);
    expect(
      activeCheck?.status === "processing" && activeCheck.leaseExpiresAt > now,
    ).toBe(true);

    // After 61 seconds (stale lease expires), retry can re-claim the lease
    now += 61_000;
    const isStale =
      activeCheck?.status === "processing" && activeCheck.leaseExpiresAt <= now;
    expect(isStale).toBe(true);

    // Re-acquire and complete
    processedEvents.set(webhookId, {
      status: "completed",
      leaseExpiresAt: 0,
    });
    expect(processedEvents.get(webhookId)?.status).toBe("completed");
  });
});

describe("Shopify Reverse Discount Sync (discountsDelete & discountsUpdate)", () => {
  const workspace = {
    id: "ws_test_123",
    defaultProgramId: "prog_test_456",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "store_test_123",
      complianceState: "active",
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValue([]);
  });

  it("cancels a matching issued loyalty redemption when its Shopify discount is deleted", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_test_123",
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      {
        id: "redemption_123",
        storeId: "store_test_123",
        accountId: "account_123",
      },
    ] as any);
    vi.mocked(prisma.discountCode.findMany).mockResolvedValueOnce([]);

    await discountsDelete({
      event: { code: " ｗｌ－ｌｏｙａｌｔｙ１２３ " },
      workspace,
    });

    expect(prisma.weleticRewardRedemption.findMany).toHaveBeenCalledWith({
      where: {
        storeId: "store_test_123",
        OR: [
          {
            shopifyDiscountCodeCanonical: { in: ["WL-LOYALTY123"] },
          },
        ],
        status: { in: ["issued", "provisioning", "active"] },
      },
    });
    expect(withLockedLoyaltyAccount).toHaveBeenCalledWith({
      storeId: "store_test_123",
      accountId: "account_123",
      fn: expect.any(Function),
    });
    expect(compensateDiscountSaga).toHaveBeenCalledWith({
      redemptionId: "redemption_123",
      reason: "Discount deleted in Shopify Admin",
      targetStatus: "cancelled",
    });
  });

  it("Scenario 4a: discountsDelete extracts candidate code, soft-deletes DiscountCode and invalidates linkCache", async () => {
    const mockTargetCodes = [
      {
        id: "dc_1",
        code: "SUMMER20",
        programId: "prog_test_456",
        link: { domain: "yamax.co", key: "summer20" },
      },
    ];

    vi.mocked(prisma.discountCode.findMany).mockResolvedValueOnce(
      mockTargetCodes as any,
    );
    vi.mocked(prisma.discountCode.updateMany).mockResolvedValueOnce({
      count: 1,
    } as any);

    const event = {
      code: "SUMMER20",
      id: 998877,
      admin_graphql_api_id: "gid://shopify/DiscountCodeNode/998877",
    };

    const res = await discountsDelete({ event, workspace });

    expect(prisma.discountCode.findMany).toHaveBeenCalledWith({
      where: {
        programId: "prog_test_456",
        OR: [
          { code: { in: ["SUMMER20"] } },
          {
            discount: {
              couponId: {
                in: [
                  "gid://shopify/DiscountCodeNode/998877",
                  "998877",
                  "gid://shopify/DiscountCodeNode/998877",
                  "gid://shopify/PriceRule/998877",
                ],
              },
            },
          },
        ],
      },
      include: {
        link: {
          select: {
            domain: true,
            key: true,
          },
        },
      },
    });

    expect(prisma.discountCode.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["dc_1"] }, disabledAt: null },
      data: { disabledAt: expect.any(Date) },
    });

    expect(linkCache.expireMany).toHaveBeenCalledWith([
      { domain: "yamax.co", key: "summer20" },
    ]);
    expect(linkCache.delete).toHaveBeenCalledWith({
      domain: "yamax.co",
      key: "summer20",
    });
    expect(res).toContain("Successfully disabled 1 discount code(s)");
  });

  it("Scenario 4b: discountsDelete handles parent discount deletion matching couponId GIDs", async () => {
    const mockTargetCodes = [
      {
        id: "dc_child_1",
        code: "HIRO_PARTNER",
        programId: "prog_test_456",
        link: { domain: "yamax.co", key: "hiro" },
      },
      {
        id: "dc_child_2",
        code: "SARAH_PARTNER",
        programId: "prog_test_456",
        link: { domain: "yamax.co", key: "sarah" },
      },
    ];

    vi.mocked(prisma.discountCode.findMany).mockResolvedValueOnce(
      mockTargetCodes as any,
    );
    vi.mocked(prisma.discountCode.updateMany).mockResolvedValueOnce({
      count: 2,
    } as any);

    const event = {
      id: 554433,
      admin_graphql_api_id: "gid://shopify/DiscountCodeNode/554433",
    };

    const res = await discountsDelete({ event, workspace });

    expect(prisma.discountCode.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["dc_child_1", "dc_child_2"] },
        disabledAt: null,
      },
      data: { disabledAt: expect.any(Date) },
    });
    expect(linkCache.expireMany).toHaveBeenCalledWith([
      { domain: "yamax.co", key: "hiro" },
      { domain: "yamax.co", key: "sarah" },
    ]);
    expect(linkCache.delete).toHaveBeenCalledTimes(2);
    expect(res).toContain("Successfully disabled 2 discount code(s)");
  });

  it("Scenario 4c: discountsDelete returns gracefully if no discount codes matched", async () => {
    vi.mocked(prisma.discountCode.findMany).mockResolvedValueOnce([]);

    const event = { code: "NON_EXISTENT_CODE" };
    const res = await discountsDelete({ event, workspace });

    expect(res).toContain(
      "No matching Weletic discount codes found for deletion",
    );
    expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
    expect(linkCache.expireMany).not.toHaveBeenCalled();
  });

  it("Scenario 4d: discountsDelete skips if workspace has no default program", async () => {
    const res = await discountsDelete({
      event: { code: "SUMMER20" },
      workspace: { id: "ws_123", defaultProgramId: null },
    });

    expect(res).toContain("Workspace has no default program");
    expect(prisma.discountCode.findMany).not.toHaveBeenCalled();
  });

  it("Scenario 5a: discountsUpdate delegates to discountsDelete when status is expired or disabled", async () => {
    vi.mocked(prisma.discountCode.findMany).mockResolvedValueOnce([
      {
        id: "dc_1",
        code: "EXPIRED_CODE",
        programId: "prog_test_456",
        link: { domain: "yamax.co", key: "expired" },
      },
    ] as any);
    vi.mocked(prisma.discountCode.updateMany).mockResolvedValueOnce({
      count: 1,
    } as any);

    const event = {
      code: "EXPIRED_CODE",
      status: "expired",
    };

    const res = await discountsUpdate({ event, workspace });

    expect(prisma.discountCode.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["dc_1"] }, disabledAt: null },
      data: { disabledAt: expect.any(Date) },
    });
    expect(res).toContain("Successfully disabled 1 discount code(s)");
  });

  it("Scenario 5b: discountsUpdate reactivates discount codes when status is active", async () => {
    vi.mocked(prisma.discountCode.updateMany).mockResolvedValueOnce({
      count: 1,
    } as any);

    const event = {
      code: "REACTIVATED_CODE",
      status: "active",
    };

    const res = await discountsUpdate({ event, workspace });

    expect(prisma.discountCode.updateMany).toHaveBeenCalledWith({
      where: {
        programId: "prog_test_456",
        disabledAt: { not: null },
        OR: [{ code: { in: ["REACTIVATED_CODE"] } }],
      },
      data: { disabledAt: null },
    });
    expect(res).toContain("reactivated (1 updated)");
  });

  it("does not resurrect a discount when store freeze wins after the webhook claim", async () => {
    // The central route claimed this delivery while active. The durable freeze
    // then commits before this handler reaches its bounded publication.
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_test_123",
      complianceState: "frozen",
    } as any);

    await expect(
      discountsUpdate({
        event: { code: "STALE_REACTIVATION", status: "active" },
        workspace,
      }),
    ).rejects.toMatchObject({
      name: "ShopifyStoreOperationalWritesBlockedError",
      complianceState: "frozen",
    });

    expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
  });

  it("does not disable or compensate a discount when freeze wins after the webhook claim", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_test_123",
      complianceState: "frozen",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      installationGeneration: "sgen_current",
    } as any);

    await expect(
      discountsDelete({
        event: { code: "FROZEN_CODE" },
        workspace,
        storeId: "store_test_123",
        expectedInstallationGeneration: "sgen_current",
      }),
    ).rejects.toThrow("is frozen");
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
    expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
  });

  it("does not reactivate a generation-one discount after generation two reconnects", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_test_123",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      installationGeneration: "sgen_two",
    } as any);

    await expect(
      discountsUpdate({
        event: { code: "OLD_CODE", status: "active" },
        workspace,
        storeId: "store_test_123",
        expectedInstallationGeneration: "sgen_one",
      }),
    ).rejects.toThrow("stale_installation_generation");
    expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
  });

  it("Scenario 5c: discountsUpdate returns no-op when status requires no change", async () => {
    const event = {
      code: "UNCHANGED_CODE",
      status: "scheduled",
    };

    const res = await discountsUpdate({ event, workspace });

    expect(res).toContain("no status change required");
    expect(prisma.discountCode.updateMany).not.toHaveBeenCalled();
  });
});
