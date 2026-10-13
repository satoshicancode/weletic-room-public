import { beforeEach, describe, expect, it, vi } from "vitest";
import { ordersPaid } from "../../app/(ee)/api/shopify/integration/webhook/orders-paid";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  settle: vi.fn(),
  process: vi.fn(),
  publish: vi.fn(),
  linkFindFirst: vi.fn(),
  customerFindUnique: vi.fn(),
  discountFindMany: vi.fn(),
  cacheRead: vi.fn(),
  cacheWrite: vi.fn(),
  cacheDelete: vi.fn(),
  guard: vi.fn(),
  attribute: vi.fn(),
  sale: vi.fn(),
}));

vi.mock("@/lib/cron", () => ({ qstash: { publishJSON: mocks.publish } }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    link: { findFirst: mocks.linkFindFirst },
    customer: { findUnique: mocks.customerFindUnique },
    discountCode: { findMany: mocks.discountFindMany },
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
  deleteShopifyCheckoutCache: mocks.cacheDelete,
}));

const baseWorkspace = {
  id: "ws_test_sync02",
  defaultProgramId: "prog_sync02",
  webhookEnabled: false,
};

const createOrderEvent = (overrides: Record<string, any> = {}) => ({
  id: 99112233,
  confirmation_number: "CN-SYNC02",
  checkout_token: "chk_sync02_token",
  created_at: "2026-08-20T12:00:00Z",
  customer: {
    id: 100200,
    email: "customer@example.com",
    first_name: "Test",
    last_name: "Customer",
  },
  current_subtotal_price_set: {
    shop_money: { amount: "100.00", currency_code: "USD" },
  },
  discount_codes: [{ code: "DISCOUNT10" }],
  ...overrides,
});

describe("SYNC-02: Temporal validity enforcement on disabled discount codes in ordersPaid", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.guard.mockResolvedValue({ id: "store_sync02" });
    mocks.record.mockResolvedValue({
      orderId: "worder_sync02",
      customerPrivacyTombstoned: false,
    });
    mocks.customerFindUnique.mockResolvedValue(null);
    mocks.cacheRead.mockResolvedValue("");
    mocks.attribute.mockResolvedValue({
      customer: { id: "cus_sync02_1" },
      leadEvent: { event_id: "lead_sync02_1" },
    });
    mocks.sale.mockResolvedValue({});
  });

  // -------------------------------------------------------------------------
  // Case 1: Order created AFTER discount code disabledAt
  // MUST NOT attribute or create commission via this code!
  // -------------------------------------------------------------------------
  it("Case 1: Order created AFTER code.disabledAt must NOT be attributed or generate commissions", async () => {
    const disabledDate = new Date("2026-08-15T00:00:00Z");
    const orderCreatedAt = "2026-08-20T12:00:00Z"; // 5 days after code disabled

    mocks.discountFindMany.mockResolvedValue([
      {
        id: "dcode_disabled_post",
        code: "DISCOUNT10",
        programId: "prog_sync02",
        partnerId: "partner_alice",
        disabledAt: disabledDate,
        link: {
          id: "link_alice",
          programId: "prog_sync02",
          partnerId: "partner_alice",
          disabledAt: null,
        },
      },
    ]);

    const event = createOrderEvent({
      created_at: orderCreatedAt,
      discount_codes: [{ code: "DISCOUNT10" }],
    });

    const result = await ordersPaid({
      event,
      workspace: baseWorkspace,
      storeId: "store_sync02",
    });

    // Verification:
    // 1. Must NOT attribute via discount code
    expect(mocks.attribute).not.toHaveBeenCalled();
    expect(mocks.sale).not.toHaveBeenCalled();
    // 2. Result string must NOT claim success with discount codes
    expect(result).not.toContain("processed successfully with discount codes");
    // 3. Must fall through to factual order recording
    expect(result).toContain("Factual order recorded");
  });

  // -------------------------------------------------------------------------
  // Case 2: Order created BEFORE code.disabledAt (historical order / delayed webhook)
  // MUST attribute and create commission normally!
  // -------------------------------------------------------------------------
  it("Case 2: Order created BEFORE code.disabledAt (historical checkout) MUST be attributed normally", async () => {
    const disabledDate = new Date("2026-08-15T00:00:00Z");
    const orderCreatedAt = "2026-08-10T12:00:00Z"; // 5 days before code disabled

    mocks.discountFindMany.mockResolvedValue([
      {
        id: "dcode_disabled_pre",
        code: "DISCOUNT10",
        programId: "prog_sync02",
        partnerId: "partner_alice",
        disabledAt: disabledDate,
        link: {
          id: "link_alice",
          programId: "prog_sync02",
          partnerId: "partner_alice",
          disabledAt: null,
        },
      },
    ]);

    const event = createOrderEvent({
      created_at: orderCreatedAt,
      discount_codes: [{ code: "DISCOUNT10" }],
    });

    const result = await ordersPaid({
      event,
      workspace: baseWorkspace,
      storeId: "store_sync02",
    });

    // Verification:
    expect(mocks.attribute).toHaveBeenCalledOnce();
    expect(mocks.sale).toHaveBeenCalledOnce();
    expect(result).toContain(
      "Order event processed successfully with discount codes",
    );
  });

  // -------------------------------------------------------------------------
  // Case 3: Code is active (disabledAt === null) or reactivated
  // MUST attribute and create commission normally!
  // -------------------------------------------------------------------------
  it("Case 3: Active or reactivated discount code (disabledAt === null) MUST be attributed normally", async () => {
    mocks.discountFindMany.mockResolvedValue([
      {
        id: "dcode_active",
        code: "DISCOUNT10",
        programId: "prog_sync02",
        partnerId: "partner_alice",
        disabledAt: null, // Active / reactivated
        link: {
          id: "link_alice",
          programId: "prog_sync02",
          partnerId: "partner_alice",
          disabledAt: null,
        },
      },
    ]);

    const event = createOrderEvent({
      created_at: "2026-08-20T12:00:00Z",
      discount_codes: [{ code: "DISCOUNT10" }],
    });

    const result = await ordersPaid({
      event,
      workspace: baseWorkspace,
      storeId: "store_sync02",
    });

    // Verification:
    expect(mocks.attribute).toHaveBeenCalledOnce();
    expect(mocks.sale).toHaveBeenCalledOnce();
    expect(result).toContain(
      "Order event processed successfully with discount codes",
    );
  });

  // -------------------------------------------------------------------------
  // Case 4: Temporal check using event.processed_at when created_at is omitted
  // -------------------------------------------------------------------------
  it("Case 4a: Order with processed_at AFTER disabledAt (created_at missing) must NOT be attributed", async () => {
    const disabledDate = new Date("2026-08-15T00:00:00Z");

    mocks.discountFindMany.mockResolvedValue([
      {
        id: "dcode_disabled_proc",
        code: "DISCOUNT10",
        programId: "prog_sync02",
        partnerId: "partner_alice",
        disabledAt: disabledDate,
        link: {
          id: "link_alice",
          programId: "prog_sync02",
          partnerId: "partner_alice",
          disabledAt: null,
        },
      },
    ]);

    const event = createOrderEvent({
      created_at: undefined,
      processed_at: "2026-08-20T12:00:00Z", // After disabledAt
      discount_codes: [{ code: "DISCOUNT10" }],
    });

    const result = await ordersPaid({
      event,
      workspace: baseWorkspace,
      storeId: "store_sync02",
    });

    expect(mocks.attribute).not.toHaveBeenCalled();
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(result).toContain("Factual order recorded");
  });

  it("Case 4b: Order with processed_at BEFORE disabledAt (created_at missing) MUST be attributed", async () => {
    const disabledDate = new Date("2026-08-15T00:00:00Z");

    mocks.discountFindMany.mockResolvedValue([
      {
        id: "dcode_disabled_proc",
        code: "DISCOUNT10",
        programId: "prog_sync02",
        partnerId: "partner_alice",
        disabledAt: disabledDate,
        link: {
          id: "link_alice",
          programId: "prog_sync02",
          partnerId: "partner_alice",
          disabledAt: null,
        },
      },
    ]);

    const event = createOrderEvent({
      created_at: undefined,
      processed_at: "2026-08-10T12:00:00Z", // Before disabledAt
      discount_codes: [{ code: "DISCOUNT10" }],
    });

    const result = await ordersPaid({
      event,
      workspace: baseWorkspace,
      storeId: "store_sync02",
    });

    expect(mocks.attribute).toHaveBeenCalledOnce();
    expect(mocks.sale).toHaveBeenCalledOnce();
    expect(result).toContain(
      "Order event processed successfully with discount codes",
    );
  });

  // -------------------------------------------------------------------------
  // Case 5: Multiple discount codes: filters out expired code and matches active code
  // -------------------------------------------------------------------------
  it("Case 5: Multiple codes in order: ignores expired code and attributes via remaining active code", async () => {
    const disabledDate = new Date("2026-08-10T00:00:00Z");
    const orderCreatedAt = "2026-08-20T12:00:00Z";

    mocks.discountFindMany.mockResolvedValue([
      // First in desc order: expired code
      {
        id: "dcode_expired",
        code: "EXPIRED_CODE",
        programId: "prog_sync02",
        partnerId: "partner_alice",
        disabledAt: disabledDate,
        link: {
          id: "link_alice",
          programId: "prog_sync02",
          partnerId: "partner_alice",
          disabledAt: null,
        },
      },
      // Second: active code
      {
        id: "dcode_active",
        code: "ACTIVE_CODE",
        programId: "prog_sync02",
        partnerId: "partner_bob",
        disabledAt: null,
        link: {
          id: "link_bob",
          programId: "prog_sync02",
          partnerId: "partner_bob",
          disabledAt: null,
        },
      },
    ]);

    const event = createOrderEvent({
      created_at: orderCreatedAt,
      discount_codes: [{ code: "EXPIRED_CODE" }, { code: "ACTIVE_CODE" }],
    });

    const result = await ordersPaid({
      event,
      workspace: baseWorkspace,
      storeId: "store_sync02",
    });

    // Verification:
    // Expired code should be skipped, active code should be attributed to partner_bob
    expect(mocks.attribute).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({ id: "link_bob" }),
      }),
    );
    expect(mocks.sale).toHaveBeenCalledOnce();
    expect(result).toContain(
      "Order event processed successfully with discount codes",
    );
  });

  // -------------------------------------------------------------------------
  // Case 6: Fallback link query respects temporal validity
  // -------------------------------------------------------------------------
  it("Case 6a: Fallback link disabled BEFORE order creation is rejected", async () => {
    const codeDisabledDate = new Date("2026-08-30T00:00:00Z"); // Code was disabled after order
    const linkDisabledDate = new Date("2026-08-10T00:00:00Z"); // But link was disabled before order
    const orderCreatedAt = "2026-08-15T12:00:00Z";

    mocks.discountFindMany.mockResolvedValue([
      {
        id: "dcode_valid_time",
        code: "CODE10",
        programId: "prog_sync02",
        partnerId: "partner_alice",
        disabledAt: codeDisabledDate,
        link: null, // Requires fallback link query
      },
    ]);

    // Fallback link was disabled before order creation
    mocks.linkFindFirst.mockResolvedValue({
      id: "link_fallback_disabled",
      programId: "prog_sync02",
      partnerId: "partner_alice",
      disabledAt: linkDisabledDate,
    });

    const event = createOrderEvent({
      created_at: orderCreatedAt,
      discount_codes: [{ code: "CODE10" }],
    });

    const result = await ordersPaid({
      event,
      workspace: baseWorkspace,
      storeId: "store_sync02",
    });

    expect(mocks.attribute).not.toHaveBeenCalled();
    expect(mocks.sale).not.toHaveBeenCalled();
    expect(result).toContain("Factual order recorded");
  });

  it("Case 6b: Fallback link active (disabledAt === null) is accepted", async () => {
    const orderCreatedAt = "2026-08-15T12:00:00Z";

    mocks.discountFindMany.mockResolvedValue([
      {
        id: "dcode_active",
        code: "CODE10",
        programId: "prog_sync02",
        partnerId: "partner_alice",
        disabledAt: null,
        link: null, // Requires fallback link query
      },
    ]);

    mocks.linkFindFirst.mockResolvedValue({
      id: "link_fallback_active",
      programId: "prog_sync02",
      partnerId: "partner_alice",
      disabledAt: null,
    });

    const event = createOrderEvent({
      created_at: orderCreatedAt,
      discount_codes: [{ code: "CODE10" }],
    });

    const result = await ordersPaid({
      event,
      workspace: baseWorkspace,
      storeId: "store_sync02",
    });

    expect(mocks.attribute).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({ id: "link_fallback_active" }),
      }),
    );
    expect(mocks.sale).toHaveBeenCalledOnce();
    expect(result).toContain(
      "Order event processed successfully with discount codes",
    );
  });
});
