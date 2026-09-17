import { beforeEach, describe, expect, it, vi } from "vitest";
import { ordersPaid } from "../../app/(ee)/api/shopify/integration/webhook/orders-paid";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  settle: vi.fn(),
  process: vi.fn(),
  publish: vi.fn(),
  link: vi.fn(),
  customer: vi.fn(),
  discounts: vi.fn(),
  cacheRead: vi.fn(),
  cacheWrite: vi.fn(),
  guard: vi.fn(),
  attribute: vi.fn(),
  sale: vi.fn(),
}));
vi.mock("@/lib/cron", () => ({ qstash: { publishJSON: mocks.publish } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    link: { findFirst: mocks.link },
    customer: { findUnique: mocks.customer },
    discountCode: { findMany: mocks.discounts },
  },
}));
vi.mock("@/lib/weletic/commerce/record-order", () => ({
  recordWeleticOrder: mocks.record,
}));
vi.mock("@/lib/weletic/loyalty/redemption-settlement", () => ({
  settleRewardRedemptionsUsedByOrder: mocks.settle,
}));
vi.mock("@/lib/integrations/shopify/create-sale", () => ({
  createShopifySale: mocks.sale,
}));
vi.mock("@/lib/integrations/shopify/process-order", () => ({
  processOrder: mocks.process,
  attributeViaDiscountCode: mocks.attribute,
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifySettlementLocks: async ({ fn }: any) => fn({}),
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.guard,
  assertShopifyStoreMatchesInstallationGeneration: vi.fn(),
  isShopifyStoreOperationalWritesBlocked: () => false,
}));
vi.mock("@/lib/weletic/shopify/privacy-cache", () => ({
  readShopifyCheckoutCacheField: mocks.cacheRead,
  writeShopifyCheckoutCache: mocks.cacheWrite,
  deleteShopifyCheckoutCache: vi.fn(),
}));

const input = {
  workspace: {
    id: "workspace_test",
    defaultProgramId: "internal_program",
    webhookEnabled: false,
  },
  storeId: "store_test",
  expectedInstallationGeneration: "generation_test",
  event: {
    id: 1,
    confirmation_number: "TEST",
    checkout_token: "TEST",
    customer: { id: 2 },
    current_subtotal_price_set: {
      shop_money: { amount: "900", currency_code: "JPY" },
    },
    discount_codes: [{ code: "TEST" }],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.guard.mockResolvedValue({ id: "store_test" });
  mocks.record.mockResolvedValue({ orderId: "order_test" });
  mocks.discounts.mockResolvedValue([]);
  mocks.customer.mockResolvedValue(null);
  mocks.link.mockResolvedValue(null);
});
describe("paid-order optional pixel wait", () => {
  it("keeps program discount attribution ahead of link-existence gating", async () => {
    mocks.discounts.mockResolvedValue([{ link: { id: "discount_link" } }]);
    mocks.attribute.mockResolvedValue({
      customer: { id: "attributed_customer" },
      leadEvent: {},
    });
    await expect(ordersPaid(input)).resolves.toContain(
      "successfully with discount codes",
    );
    expect(mocks.sale).toHaveBeenCalledOnce();
    expect(mocks.link).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("preserves shipping-only coupon evidence through parsing and settlement", async () => {
    const allocation = {
      discount_application_index: 0,
      amount_set: { shop_money: { amount: "100", currency_code: "JPY" } },
    };
    await ordersPaid({
      ...input,
      event: {
        ...input.event,
        discount_applications: [{ type: "discount_code", code: "TEST" }],
        line_items: [],
        shipping_lines: [
          { discount_allocations: [allocation], unrelated: "discard" },
        ],
      },
    });
    expect(mocks.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        orderDiscountEvidence: {
          discount_applications: [{ type: "discount_code", code: "TEST" }],
          line_items: [],
          shipping_lines: [{ discount_allocations: [allocation] }],
        },
      }),
    );
  });
  it("completes loyalty and redemption without a queue when no owned links exist", async () => {
    await expect(ordersPaid(input)).resolves.toContain("pixel wait skipped");
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.settle).toHaveBeenCalledOnce();
    expect(mocks.link).toHaveBeenCalledWith({
      where: { projectId: "workspace_test" },
      select: { id: true },
    });
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.cacheWrite).not.toHaveBeenCalled();
  });
  it("preserves queue dispatch for an owned link even without a known click yet", async () => {
    mocks.link.mockResolvedValue({ id: "link_test" });
    await expect(ordersPaid(input)).resolves.toContain("Waiting for pixel");
    expect(mocks.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          workspaceId: "workspace_test",
          storeId: "store_test",
          storeInstallationGeneration: "generation_test",
        }),
      }),
    );
  });
  it("does not swallow queue failures for a configured attribution workspace", async () => {
    mocks.link.mockResolvedValue({ id: "link_test" });
    mocks.publish.mockRejectedValue(new Error("queue unavailable"));
    await expect(ordersPaid(input)).rejects.toThrow("queue unavailable");
  });
  it("does not suppress an existing-customer or known-click attribution path", async () => {
    mocks.customer.mockResolvedValue({ id: "customer_test" });
    await ordersPaid(input);
    expect(mocks.process).toHaveBeenCalledOnce();
    expect(mocks.link).not.toHaveBeenCalled();
    mocks.customer.mockResolvedValue(null);
    mocks.cacheRead.mockResolvedValue("click_test");
    await ordersPaid(input);
    expect(mocks.process).toHaveBeenCalledTimes(2);
    expect(mocks.link).not.toHaveBeenCalled();
  });
  it("fails closed on admission/generation rejection before any settlement", async () => {
    mocks.guard.mockRejectedValue(new Error("stale generation"));
    await expect(ordersPaid(input)).rejects.toThrow("stale generation");
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
