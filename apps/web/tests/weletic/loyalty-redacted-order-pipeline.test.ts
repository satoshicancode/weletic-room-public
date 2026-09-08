import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordWeleticOrder: vi.fn(),
  settleRedemptions: vi.fn(),
  processOrder: vi.fn(),
  attributeViaDiscountCode: vi.fn(),
  createShopifySale: vi.fn(),
  withSettlementLocks: vi.fn(),
  storeFindUnique: vi.fn(),
  customerFindUnique: vi.fn(),
  discountFindMany: vi.fn(),
}));

vi.mock("@/lib/weletic/commerce/record-order", () => ({
  recordWeleticOrder: mocks.recordWeleticOrder,
}));
vi.mock("@/lib/weletic/loyalty/redemption-settlement", () => ({
  settleRewardRedemptionsUsedByOrder: mocks.settleRedemptions,
}));
vi.mock("@/lib/integrations/shopify/process-order", () => ({
  processOrder: mocks.processOrder,
  attributeViaDiscountCode: mocks.attributeViaDiscountCode,
}));
vi.mock("@/lib/integrations/shopify/create-sale", () => ({
  createShopifySale: mocks.createShopifySale,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifySettlementLocks: mocks.withSettlementLocks,
}));
vi.mock("@/lib/cron", () => ({ qstash: { publishJSON: vi.fn() } }));
vi.mock("@/lib/upstash", () => ({
  redis: { hget: vi.fn(), hset: vi.fn(), expire: vi.fn(), del: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
    customer: { findUnique: mocks.customerFindUnique },
    discountCode: { findMany: mocks.discountFindMany },
  },
}));

import { ordersPaid } from "../../app/(ee)/api/shopify/integration/webhook/orders-paid";

describe("redacted customer order pipeline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withSettlementLocks.mockImplementation(async ({ fn }) =>
      fn({ opaque: true }),
    );
  });

  it("settles redacted-owner coupon use before skipping affiliate PII writes", async () => {
    mocks.recordWeleticOrder.mockResolvedValue({
      orderId: "order_internal_1",
      customerPrivacyTombstoned: true,
      duplicate: false,
    });
    mocks.storeFindUnique.mockResolvedValue({ id: "store_target" });
    mocks.settleRedemptions.mockResolvedValue({
      matched: 1,
      markedUsed: 1,
      lateUseCorrections: 1,
    });
    const event = {
      id: 99887760,
      name: "#1000",
      confirmation_number: "CN1000",
      checkout_token: "checkout_redacted",
      current_subtotal_price_set: {
        shop_money: { amount: "100.00", currency_code: "USD" },
      },
      discount_codes: [{ code: "PRIVATE-COUPON" }],
      customer: {
        id: 887760,
        email: "must-not-rehydrate@example.com",
        first_name: "Delayed",
        last_name: "Customer",
      },
      billing_address: { country_code: "US", province: "California" },
      line_items: [
        {
          id: 110,
          title: "Product",
          quantity: 1,
          price_set: {
            shop_money: { amount: "100.00", currency_code: "USD" },
          },
        },
      ],
    };

    const result = await ordersPaid({
      event,
      workspace: {
        id: "workspace_target",
        defaultProgramId: "program_target",
        webhookEnabled: true,
      },
    });

    expect(result).toContain("redacted customer");
    expect(mocks.withSettlementLocks).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "workspace_target",
        orderExternalId: "99887760",
        shopifyCustomerId: 887760,
      }),
    );
    expect(mocks.recordWeleticOrder).toHaveBeenCalledWith(
      expect.objectContaining({ settlementLockContext: { opaque: true } }),
    );
    expect(mocks.settleRedemptions).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_target",
        discountCodes: ["PRIVATE-COUPON"],
        shopifyCustomerId: "887760",
        orderId: "99887760",
      }),
    );
    expect(mocks.processOrder).not.toHaveBeenCalled();
    expect(mocks.attributeViaDiscountCode).not.toHaveBeenCalled();
    expect(mocks.createShopifySale).not.toHaveBeenCalled();
    expect(mocks.storeFindUnique).toHaveBeenCalledWith({
      where: { projectId: "workspace_target" },
      select: {
        id: true,
        complianceState: true,
        shopCurrency: true,
        currencyVerifiedAt: true,
        installationGeneration: true,
        storeAccessState: true,
      },
    });
    expect(mocks.customerFindUnique).not.toHaveBeenCalled();
    expect(mocks.discountFindMany).not.toHaveBeenCalled();
  });

  it.each(["frozen", "redacted"] as const)(
    "settles voucher use but performs no operational order writes for a %s store",
    async (complianceState) => {
      mocks.storeFindUnique.mockResolvedValueOnce({
        id: "store_target",
        complianceState,
      });
      mocks.settleRedemptions.mockResolvedValue({
        matched: 1,
        markedUsed: 1,
        lateUseCorrections: 0,
      });
      const event = {
        id: 99887761,
        name: "#1001",
        confirmation_number: "CN1001",
        checkout_token: "checkout_frozen",
        created_at: "2026-08-29T00:00:00.000Z",
        current_subtotal_price_set: {
          shop_money: { amount: "100.00", currency_code: "USD" },
        },
        discount_codes: [{ code: " PRIVATE-COUPON " }],
        customer: {
          id: 887761,
          email: "must-not-persist@example.com",
          first_name: "Must Not Persist",
        },
        line_items: [
          {
            id: 111,
            title: "Product",
            quantity: 1,
            price_set: {
              shop_money: { amount: "100.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result = await ordersPaid({
        event,
        workspace: {
          id: "workspace_target",
          defaultProgramId: "program_target",
          webhookEnabled: true,
        },
      });

      expect(result).toContain("privacy-minimized voucher settlement only");
      expect(mocks.settleRedemptions).toHaveBeenCalledWith({
        storeId: "store_target",
        discountCodes: ["PRIVATE-COUPON"],
        shopifyCustomerId: "887761",
        usedAt: new Date("2026-08-29T00:00:00.000Z"),
        orderId: "99887761",
        orderDiscountEvidence: null,
        expectedInstallationGeneration: undefined,
        loyaltyMaintenancePermit: undefined,
      });
      expect(JSON.stringify(mocks.settleRedemptions.mock.calls)).not.toContain(
        "must-not-persist@example.com",
      );
      expect(mocks.recordWeleticOrder).not.toHaveBeenCalled();
      expect(mocks.processOrder).not.toHaveBeenCalled();
      expect(mocks.attributeViaDiscountCode).not.toHaveBeenCalled();
      expect(mocks.createShopifySale).not.toHaveBeenCalled();
    },
  );
});
