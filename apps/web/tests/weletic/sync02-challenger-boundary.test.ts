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
  id: "ws_challenger_sync02",
  defaultProgramId: "prog_challenger",
  webhookEnabled: false,
};

const createOrderEvent = (overrides: Record<string, any> = {}) => ({
  id: 77889900,
  confirmation_number: "CN-CHALLENGER-01",
  checkout_token: "chk_challenger_token",
  created_at: "2026-08-20T12:00:00.000Z",
  customer: {
    id: 998877,
    email: "challenger@example.com",
    first_name: "Challenger",
    last_name: "Tester",
  },
  current_subtotal_price_set: {
    shop_money: { amount: "150.00", currency_code: "USD" },
  },
  discount_codes: [{ code: "PROMO_TEST" }],
  ...overrides,
});

describe("Challenger 1 Empirical Boundary Testing for SYNC-02", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.guard.mockResolvedValue({ id: "store_challenger" });
    mocks.record.mockResolvedValue({
      orderId: "worder_challenger",
      customerPrivacyTombstoned: false,
    });
    mocks.customerFindUnique.mockResolvedValue(null);
    mocks.cacheRead.mockResolvedValue("");
    mocks.attribute.mockResolvedValue({
      customer: { id: "cus_challenger_1" },
      leadEvent: { event_id: "lead_challenger_1" },
    });
    mocks.sale.mockResolvedValue({});
  });

  // =========================================================================
  // SECTION 1: Exact Millisecond Boundary Tests (===, -1ms, +1ms)
  // =========================================================================
  describe("Section 1: Millisecond Boundary Precision", () => {
    const disabledInstant = new Date("2026-08-20T12:00:00.500Z");

    it("1.1 [Exact Match]: orderCreatedAt === disabledAt (exact to ms) MUST be attributed (valid at disable moment)", async () => {
      // Order created exactly at 12:00:00.500Z
      const orderCreatedAt = "2026-08-20T12:00:00.500Z";

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_exact_match",
          code: "EXACT_MS",
          programId: "prog_challenger",
          partnerId: "partner_exact",
          disabledAt: disabledInstant,
          link: {
            id: "link_exact",
            programId: "prog_challenger",
            partnerId: "partner_exact",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "EXACT_MS" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("1.2 [Strictly Before -1ms]: orderCreatedAt = disabledAt - 1ms MUST be attributed", async () => {
      // Order created at 12:00:00.499Z (1ms before disabled)
      const orderCreatedAt = "2026-08-20T12:00:00.499Z";

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_minus_1ms",
          code: "MINUS_1MS",
          programId: "prog_challenger",
          partnerId: "partner_minus1",
          disabledAt: disabledInstant,
          link: {
            id: "link_minus1",
            programId: "prog_challenger",
            partnerId: "partner_minus1",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "MINUS_1MS" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("1.3 [Strictly After +1ms]: orderCreatedAt = disabledAt + 1ms MUST NOT be attributed (rejected)", async () => {
      // Order created at 12:00:00.501Z (1ms after disabled)
      const orderCreatedAt = "2026-08-20T12:00:00.501Z";

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_plus_1ms",
          code: "PLUS_1MS",
          programId: "prog_challenger",
          partnerId: "partner_plus1",
          disabledAt: disabledInstant,
          link: {
            id: "link_plus1",
            programId: "prog_challenger",
            partnerId: "partner_plus1",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "PLUS_1MS" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(mocks.sale).not.toHaveBeenCalled();
      expect(result).toContain("Factual order recorded");
    });
  });

  // =========================================================================
  // SECTION 2: Millisecond Boundary Precision with processed_at
  // =========================================================================
  describe("Section 2: processed_at fallback boundary precision", () => {
    const disabledInstant = new Date("2026-08-20T12:00:00.500Z");

    it("2.1 [Exact Match via processed_at]: processed_at === disabledAt MUST be attributed", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_proc_exact",
          code: "PROC_EXACT",
          programId: "prog_challenger",
          partnerId: "partner_p1",
          disabledAt: disabledInstant,
          link: {
            id: "link_p1",
            programId: "prog_challenger",
            partnerId: "partner_p1",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: undefined,
        processed_at: "2026-08-20T12:00:00.500Z",
        discount_codes: [{ code: "PROC_EXACT" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("2.2 [-1ms via processed_at]: processed_at = disabledAt - 1ms MUST be attributed", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_proc_minus",
          code: "PROC_MINUS",
          programId: "prog_challenger",
          partnerId: "partner_p2",
          disabledAt: disabledInstant,
          link: {
            id: "link_p2",
            programId: "prog_challenger",
            partnerId: "partner_p2",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: undefined,
        processed_at: "2026-08-20T12:00:00.499Z",
        discount_codes: [{ code: "PROC_MINUS" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("2.3 [+1ms via processed_at]: processed_at = disabledAt + 1ms MUST NOT be attributed", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_proc_plus",
          code: "PROC_PLUS",
          programId: "prog_challenger",
          partnerId: "partner_p3",
          disabledAt: disabledInstant,
          link: {
            id: "link_p3",
            programId: "prog_challenger",
            partnerId: "partner_p3",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: undefined,
        processed_at: "2026-08-20T12:00:00.501Z",
        discount_codes: [{ code: "PROC_PLUS" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(result).toContain("Factual order recorded");
    });
  });

  // =========================================================================
  // SECTION 3: Multi-Code Orders with Interleaved Valid and Expired Codes
  // =========================================================================
  describe("Section 3: Interleaved Multi-Discount Codes", () => {
    const disabledInstant = new Date("2026-08-20T12:00:00.000Z");

    it("3.1 [Order: Expired (+1ms) followed by Valid Active (null)]: attributes via Active code", async () => {
      const orderCreatedAt = "2026-08-20T12:00:00.001Z"; // 1ms after disabledInstant

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_exp_1",
          code: "EXPIRED_FIRST",
          programId: "prog_challenger",
          partnerId: "partner_expired",
          disabledAt: disabledInstant,
          link: {
            id: "link_expired",
            programId: "prog_challenger",
            partnerId: "partner_expired",
            disabledAt: null,
          },
        },
        {
          id: "dcode_active_2",
          code: "ACTIVE_SECOND",
          programId: "prog_challenger",
          partnerId: "partner_active",
          disabledAt: null,
          link: {
            id: "link_active",
            programId: "prog_challenger",
            partnerId: "partner_active",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "EXPIRED_FIRST" }, { code: "ACTIVE_SECOND" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ id: "link_active" }),
        }),
      );
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("3.2 [Order: Expired (+10s), Expired (+1ms), Valid (-1ms)]: attributes via the Valid (-1ms) code", async () => {
      // Order created at 12:00:00.000Z
      const orderCreatedAt = "2026-08-20T12:00:00.000Z";

      mocks.discountFindMany.mockResolvedValue([
        // Code 1: disabled 10 seconds before order
        {
          id: "dcode_old_exp",
          code: "CODE_OLD_EXP",
          programId: "prog_challenger",
          partnerId: "partner_old",
          disabledAt: new Date("2026-08-20T11:59:50.000Z"),
          link: {
            id: "link_old",
            programId: "prog_challenger",
            partnerId: "partner_old",
            disabledAt: null,
          },
        },
        // Code 2: disabled 1ms before order (11:59:59.999Z)
        {
          id: "dcode_just_exp",
          code: "CODE_JUST_EXP",
          programId: "prog_challenger",
          partnerId: "partner_just",
          disabledAt: new Date("2026-08-20T11:59:59.999Z"),
          link: {
            id: "link_just",
            programId: "prog_challenger",
            partnerId: "partner_just",
            disabledAt: null,
          },
        },
        // Code 3: disabled 1ms AFTER order (12:00:00.001Z) -> VALID!
        {
          id: "dcode_valid_edge",
          code: "CODE_VALID_EDGE",
          programId: "prog_challenger",
          partnerId: "partner_valid",
          disabledAt: new Date("2026-08-20T12:00:00.001Z"),
          link: {
            id: "link_valid",
            programId: "prog_challenger",
            partnerId: "partner_valid",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [
          { code: "CODE_OLD_EXP" },
          { code: "CODE_JUST_EXP" },
          { code: "CODE_VALID_EDGE" },
        ],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ id: "link_valid" }),
        }),
      );
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("3.3 [Order: All codes expired at +1ms and +5ms]: no attribution, falls through to factual", async () => {
      const orderCreatedAt = "2026-08-20T12:00:00.000Z";

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_exp_a",
          code: "EXP_A",
          programId: "prog_challenger",
          partnerId: "partner_a",
          disabledAt: new Date("2026-08-20T11:59:59.999Z"), // 1ms before order
          link: { id: "link_a", programId: "prog_challenger", partnerId: "partner_a", disabledAt: null },
        },
        {
          id: "dcode_exp_b",
          code: "EXP_B",
          programId: "prog_challenger",
          partnerId: "partner_b",
          disabledAt: new Date("2026-08-20T11:59:55.000Z"), // 5s before order
          link: { id: "link_b", programId: "prog_challenger", partnerId: "partner_b", disabledAt: null },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "EXP_A" }, { code: "EXP_B" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(mocks.sale).not.toHaveBeenCalled();
      expect(result).toContain("Factual order recorded");
    });
  });

  // =========================================================================
  // SECTION 4: Fallback Link and Direct Link Millisecond Precision
  // =========================================================================
  describe("Section 4: Direct vs Fallback Link Boundary Precision", () => {
    const orderCreatedAt = "2026-08-20T12:00:00.000Z";

    it("4.1 [Link exact ms]: direct link disabledAt === orderCreatedAt MUST be accepted", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_valid",
          code: "CODE_LINK_EXACT",
          programId: "prog_challenger",
          partnerId: "partner_link",
          disabledAt: null,
          link: {
            id: "link_exact_ms",
            programId: "prog_challenger",
            partnerId: "partner_link",
            disabledAt: new Date(orderCreatedAt), // exact same ms
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "CODE_LINK_EXACT" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ id: "link_exact_ms" }),
        }),
      );
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("4.2 [Link +1ms vs Fallback -1ms]: direct link disabled 1ms before order, fallback link disabled 1ms after order", async () => {
      // Direct link disabled at 11:59:59.999Z (1ms before order) -> should be discarded
      // Fallback link disabled at 12:00:00.001Z (1ms after order) -> should be picked up!
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_valid",
          code: "CODE_CASCADE",
          programId: "prog_challenger",
          partnerId: "partner_cascade",
          disabledAt: null,
          link: {
            id: "link_direct_expired_1ms",
            programId: "prog_challenger",
            partnerId: "partner_cascade",
            disabledAt: new Date("2026-08-20T11:59:59.999Z"),
          },
        },
      ]);

      mocks.linkFindFirst.mockResolvedValue({
        id: "link_fallback_valid_1ms",
        programId: "prog_challenger",
        partnerId: "partner_cascade",
        disabledAt: new Date("2026-08-20T12:00:00.001Z"),
      });

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "CODE_CASCADE" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.linkFindFirst).toHaveBeenCalledOnce();
      expect(mocks.attribute).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ id: "link_fallback_valid_1ms" }),
        }),
      );
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("4.3 [Fallback link exact ms]: fallback link disabledAt === orderCreatedAt MUST be accepted", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_valid",
          code: "CODE_FALLBACK_EXACT",
          programId: "prog_challenger",
          partnerId: "partner_fb",
          disabledAt: null,
          link: null, // triggers fallback findFirst
        },
      ]);

      mocks.linkFindFirst.mockResolvedValue({
        id: "link_fb_exact_ms",
        programId: "prog_challenger",
        partnerId: "partner_fb",
        disabledAt: new Date(orderCreatedAt),
      });

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "CODE_FALLBACK_EXACT" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ id: "link_fb_exact_ms" }),
        }),
      );
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });
  });

  // =========================================================================
  // SECTION 5: Timezone Offsets and ISO String Handling
  // =========================================================================
  describe("Section 5: Timezone Formats and ISO Strings", () => {
    it("5.1: Non-UTC ISO string (+09:00 JST) matching exact same UTC millisecond as disabledAt (UTC)", async () => {
      // 2026-08-20T21:00:00.500+09:00 == 2026-08-20T12:00:00.500Z
      const orderCreatedAtJst = "2026-08-20T21:00:00.500+09:00";
      const disabledInstantUtc = new Date("2026-08-20T12:00:00.500Z");

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_tz",
          code: "CODE_TZ",
          programId: "prog_challenger",
          partnerId: "partner_tz",
          disabledAt: disabledInstantUtc,
          link: {
            id: "link_tz",
            programId: "prog_challenger",
            partnerId: "partner_tz",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAtJst,
        discount_codes: [{ code: "CODE_TZ" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      // Exactly same millisecond -> must be valid
      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("5.2: Non-UTC ISO string (+09:00 JST) 1ms AFTER disabledAt (UTC) MUST be rejected", async () => {
      // 2026-08-20T21:00:00.501+09:00 == 2026-08-20T12:00:00.501Z (+1ms)
      const orderCreatedAtJst = "2026-08-20T21:00:00.501+09:00";
      const disabledInstantUtc = new Date("2026-08-20T12:00:00.500Z");

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_tz_after",
          code: "CODE_TZ_AFTER",
          programId: "prog_challenger",
          partnerId: "partner_tz",
          disabledAt: disabledInstantUtc,
          link: {
            id: "link_tz",
            programId: "prog_challenger",
            partnerId: "partner_tz",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAtJst,
        discount_codes: [{ code: "CODE_TZ_AFTER" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(result).toContain("Factual order recorded");
    });
  });

  // =========================================================================
  // SECTION 6: Resilience on Malformed Dates and Edge Case Formats
  // =========================================================================
  describe("Section 6: Malformed / Edge Case Timestamp Resilience", () => {
    it("6.1: When order created_at is an invalid date string, does not crash and defaults to permissive attribution", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_invalid_date",
          code: "CODE_INVALID",
          programId: "prog_challenger",
          partnerId: "partner_inv",
          disabledAt: new Date("2026-08-20T12:00:00.000Z"),
          link: {
            id: "link_inv",
            programId: "prog_challenger",
            partnerId: "partner_inv",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: "invalid-timestamp-format",
        discount_codes: [{ code: "CODE_INVALID" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      // Does not throw unhandled exception; attribution proceeds safely
      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("6.2: When code.disabledAt is an invalid date string, does not crash and treats code as valid", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_invalid_disabled",
          code: "CODE_INV_DIS",
          programId: "prog_challenger",
          partnerId: "partner_inv2",
          disabledAt: "invalid-disabled-date" as any,
          link: {
            id: "link_inv2",
            programId: "prog_challenger",
            partnerId: "partner_inv2",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: "2026-08-20T12:00:00.000Z",
        discount_codes: [{ code: "CODE_INV_DIS" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_challenger",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });
  });
});
