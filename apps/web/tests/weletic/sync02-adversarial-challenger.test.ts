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
  id: "ws_adv_test",
  defaultProgramId: "prog_adv_test",
  webhookEnabled: false,
};

const createOrderEvent = (overrides: Record<string, any> = {}) => ({
  id: 99445566,
  confirmation_number: "CN-ADV-02",
  checkout_token: "chk_adv_token",
  created_at: "2026-08-20T12:00:00Z",
  customer: {
    id: 300400,
    email: "adv_shopper@example.com",
    first_name: "Adversary",
    last_name: "Tester",
  },
  current_subtotal_price_set: {
    shop_money: { amount: "120.00", currency_code: "USD" },
  },
  discount_codes: [{ code: "PROMO10" }],
  ...overrides,
});

describe("SYNC-02: Adversarial Stress Test Suite (Challenger 2)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.guard.mockResolvedValue({ id: "store_adv" });
    mocks.record.mockResolvedValue({
      orderId: "worder_adv",
      customerPrivacyTombstoned: false,
    });
    mocks.customerFindUnique.mockResolvedValue(null);
    mocks.cacheRead.mockResolvedValue("");
    mocks.attribute.mockResolvedValue({
      customer: { id: "cus_adv_1" },
      leadEvent: { event_id: "lead_adv_1" },
    });
    mocks.sale.mockResolvedValue({});
  });

  // =========================================================================
  // DIMENSION 1: Fallback link attribution when direct code is unlinked
  // Link disabled AFTER vs BEFORE order creation
  // =========================================================================
  describe("Dimension 1: Fallback Link Attribution Temporal Invariants", () => {
    it("1.1: Unlinked code + Fallback link disabled AFTER order creation MUST attribute", async () => {
      // Order created Aug 15. Link disabled Aug 20 (after order).
      const orderCreatedAt = "2026-08-15T12:00:00Z";
      const linkDisabledDate = new Date("2026-08-20T00:00:00Z");

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_unlinked_valid",
          code: "PROMO10",
          programId: "prog_adv_test",
          partnerId: "partner_bob",
          disabledAt: null, // Code is active
          link: null, // Direct link is unlinked
        },
      ]);

      mocks.linkFindFirst.mockResolvedValue({
        id: "link_fallback_bob",
        programId: "prog_adv_test",
        partnerId: "partner_bob",
        disabledAt: linkDisabledDate, // Disabled AFTER order
      });

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "PROMO10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.attribute).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ id: "link_fallback_bob" }),
        }),
      );
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("1.2: Unlinked code + Fallback link disabled BEFORE order creation MUST NOT attribute", async () => {
      // Order created Aug 25. Link disabled Aug 20 (before order).
      const orderCreatedAt = "2026-08-25T12:00:00Z";
      const linkDisabledDate = new Date("2026-08-20T00:00:00Z");

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_unlinked_invalid",
          code: "PROMO10",
          programId: "prog_adv_test",
          partnerId: "partner_bob",
          disabledAt: null,
          link: null,
        },
      ]);

      mocks.linkFindFirst.mockResolvedValue({
        id: "link_fallback_bob",
        programId: "prog_adv_test",
        partnerId: "partner_bob",
        disabledAt: linkDisabledDate, // Disabled BEFORE order
      });

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "PROMO10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(mocks.sale).not.toHaveBeenCalled();
      expect(result).toContain("Factual order recorded");
    });

    it("1.3: Boundary exact millisecond: orderCreatedAt === link.disabledAt is accepted", async () => {
      const boundaryTimestamp = "2026-08-20T12:00:00.000Z";
      const boundaryDate = new Date(boundaryTimestamp);

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_boundary",
          code: "PROMO10",
          programId: "prog_adv_test",
          partnerId: "partner_bob",
          disabledAt: null,
          link: null,
        },
      ]);

      mocks.linkFindFirst.mockResolvedValue({
        id: "link_boundary",
        programId: "prog_adv_test",
        partnerId: "partner_bob",
        disabledAt: boundaryDate, // Exactly same millisecond
      });

      const event = createOrderEvent({
        created_at: boundaryTimestamp,
        discount_codes: [{ code: "PROMO10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("1.4: Direct link disabled BEFORE order, but fallback link active: falls through and attributes via fallback", async () => {
      const orderCreatedAt = "2026-08-20T12:00:00Z";
      const directLinkDisabledDate = new Date("2026-08-10T00:00:00Z"); // Disabled before order

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_direct_link_expired",
          code: "PROMO10",
          programId: "prog_adv_test",
          partnerId: "partner_alice",
          disabledAt: null,
          link: {
            id: "link_direct_expired",
            programId: "prog_adv_test",
            partnerId: "partner_alice",
            disabledAt: directLinkDisabledDate,
          },
        },
      ]);

      // Fallback link is active
      mocks.linkFindFirst.mockResolvedValue({
        id: "link_fallback_active",
        programId: "prog_adv_test",
        partnerId: "partner_alice",
        disabledAt: null,
      });

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "PROMO10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      // Direct link was rejected, but fallback link was active and attributed!
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

  // =========================================================================
  // DIMENSION 2: Code disabled then reactivated (disabledAt set back to null)
  // =========================================================================
  describe("Dimension 2: Code Reactivation Lifecycle", () => {
    it("2.1: Reactivated discount code (disabledAt: null) with order created now MUST attribute", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_reactivated",
          code: "REACTIVATED10",
          programId: "prog_adv_test",
          partnerId: "partner_charlie",
          disabledAt: null, // Reactivated by admin
          link: {
            id: "link_charlie",
            programId: "prog_adv_test",
            partnerId: "partner_charlie",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: "2026-09-01T10:00:00Z",
        discount_codes: [{ code: "REACTIVATED10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("2.2: Reactivated code with unlinked link and active fallback link MUST attribute", async () => {
      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_reactivated_unlinked",
          code: "REACTIVATED10",
          programId: "prog_adv_test",
          partnerId: "partner_charlie",
          disabledAt: null,
          link: null,
        },
      ]);

      mocks.linkFindFirst.mockResolvedValue({
        id: "link_fallback_charlie",
        programId: "prog_adv_test",
        partnerId: "partner_charlie",
        disabledAt: null,
      });

      const event = createOrderEvent({
        created_at: "2026-09-01T10:00:00Z",
        discount_codes: [{ code: "REACTIVATED10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });
  });

  // =========================================================================
  // DIMENSION 3: Non-standard ISO formats, Microseconds & Timezone Offsets
  // =========================================================================
  describe("Dimension 3: Date Formats, Microseconds and Timezones", () => {
    it("3.1: Microsecond precision in created_at: Order AFTER disabledAt (by microsecond fraction) is rejected", async () => {
      // disabledAt is at .500Z, order is at .654321Z (154ms after)
      const disabledDate = new Date("2026-08-20T12:00:00.500Z");
      const orderCreatedAt = "2026-08-20T12:00:00.654321Z";

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_micro_after",
          code: "MICRO10",
          programId: "prog_adv_test",
          partnerId: "partner_micro",
          disabledAt: disabledDate,
          link: {
            id: "link_micro",
            programId: "prog_adv_test",
            partnerId: "partner_micro",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "MICRO10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(mocks.sale).not.toHaveBeenCalled();
      expect(result).toContain("Factual order recorded");
    });

    it("3.2: Microsecond precision in created_at: Order BEFORE disabledAt (by microsecond fraction) is accepted", async () => {
      // disabledAt is at .500Z, order is at .123456Z (377ms before)
      const disabledDate = new Date("2026-08-20T12:00:00.500Z");
      const orderCreatedAt = "2026-08-20T12:00:00.123456Z";

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_micro_before",
          code: "MICRO10",
          programId: "prog_adv_test",
          partnerId: "partner_micro",
          disabledAt: disabledDate,
          link: {
            id: "link_micro",
            programId: "prog_adv_test",
            partnerId: "partner_micro",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "MICRO10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("3.3: Positive timezone offset (+09:00 JST): Order occurred BEFORE disabledAt in UTC", async () => {
      // Order created: 2026-08-20T08:00:00+09:00 => UTC is 2026-08-19T23:00:00.000Z
      // Code disabled: 2026-08-20T00:00:00.000Z UTC (1 hour after order!)
      const disabledDate = new Date("2026-08-20T00:00:00.000Z");
      const orderCreatedAt = "2026-08-20T08:00:00+09:00";

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_jst",
          code: "JAPAN10",
          programId: "prog_adv_test",
          partnerId: "partner_japan",
          disabledAt: disabledDate,
          link: {
            id: "link_japan",
            programId: "prog_adv_test",
            partnerId: "partner_japan",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "JAPAN10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("3.4: Negative timezone offset (-07:00 PDT): Order occurred AFTER disabledAt in UTC", async () => {
      // Order created: 2026-08-20T18:00:00-07:00 => UTC is 2026-08-21T01:00:00.000Z
      // Code disabled: 2026-08-20T23:00:00.000Z UTC (2 hours before order!)
      const disabledDate = new Date("2026-08-20T23:00:00.000Z");
      const orderCreatedAt = "2026-08-20T18:00:00-07:00";

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_pdt",
          code: "CALIFORNIA10",
          programId: "prog_adv_test",
          partnerId: "partner_cali",
          disabledAt: disabledDate,
          link: {
            id: "link_cali",
            programId: "prog_adv_test",
            partnerId: "partner_cali",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "CALIFORNIA10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(mocks.sale).not.toHaveBeenCalled();
      expect(result).toContain("Factual order recorded");
    });

    it("3.5: Non-standard ISO format with space separator ('YYYY-MM-DD HH:mm:ssZ')", async () => {
      const disabledDate = new Date("2026-08-20T00:00:00Z");
      const orderCreatedAt = "2026-08-20 12:00:00Z"; // After disabledAt

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_space",
          code: "SPACE10",
          programId: "prog_adv_test",
          partnerId: "partner_space",
          disabledAt: disabledDate,
          link: {
            id: "link_space",
            programId: "prog_adv_test",
            partnerId: "partner_space",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "SPACE10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).not.toHaveBeenCalled();
      expect(mocks.sale).not.toHaveBeenCalled();
      expect(result).toContain("Factual order recorded");
    });

    it("3.6: created_at omitted, processed_at provided with timezone offset", async () => {
      // processed_at in JST: 2026-08-10T12:00:00+09:00 => 2026-08-10T03:00:00Z
      // disabledAt: 2026-08-15T00:00:00Z (5 days after order)
      const disabledDate = new Date("2026-08-15T00:00:00Z");

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_proc_offset",
          code: "OFFSET10",
          programId: "prog_adv_test",
          partnerId: "partner_offset",
          disabledAt: disabledDate,
          link: {
            id: "link_offset",
            programId: "prog_adv_test",
            partnerId: "partner_offset",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: undefined,
        processed_at: "2026-08-10T12:00:00+09:00",
        discount_codes: [{ code: "OFFSET10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      expect(mocks.attribute).toHaveBeenCalledOnce();
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });

    it("3.7: Completely malformed date string in created_at falls back gracefully to permissive behavior", async () => {
      // Malformed date: new Date('corrupt-date') is NaN.
      // System falls back gracefully (as designed for synthetic test payloads without dates).
      const disabledDate = new Date("2026-08-15T00:00:00Z");

      mocks.discountFindMany.mockResolvedValue([
        {
          id: "dcode_malformed",
          code: "CORRUPT10",
          programId: "prog_adv_test",
          partnerId: "partner_corrupt",
          disabledAt: disabledDate,
          link: {
            id: "link_corrupt",
            programId: "prog_adv_test",
            partnerId: "partner_corrupt",
            disabledAt: null,
          },
        },
      ]);

      const event = createOrderEvent({
        created_at: "corrupted-date-value",
        processed_at: undefined,
        discount_codes: [{ code: "CORRUPT10" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      // Does not throw unhandled exception
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });
  });

  // =========================================================================
  // DIMENSION 4: Multiple codes & complex fallback scenarios
  // =========================================================================
  describe("Dimension 4: Multi-Code Fallback Chains", () => {
    it("4.1: Code 1 fallback link disabled before order, Code 2 fallback link active: skips Code 1 and attributes to Code 2", async () => {
      const orderCreatedAt = "2026-08-20T12:00:00Z";
      const code1LinkDisabledDate = new Date("2026-08-10T00:00:00Z"); // Disabled before order

      mocks.discountFindMany.mockResolvedValue([
        // Code 1: unlinked, partner_1
        {
          id: "dcode_1",
          code: "CODE1",
          programId: "prog_adv_test",
          partnerId: "partner_1",
          disabledAt: null,
          link: null,
        },
        // Code 2: unlinked, partner_2
        {
          id: "dcode_2",
          code: "CODE2",
          programId: "prog_adv_test",
          partnerId: "partner_2",
          disabledAt: null,
          link: null,
        },
      ]);

      // When querying partner_1 link, returns disabled link
      // When querying partner_2 link, returns active link
      mocks.linkFindFirst.mockImplementation(async ({ where }: any) => {
        if (where.partnerId === "partner_1") {
          return {
            id: "link_partner_1",
            programId: "prog_adv_test",
            partnerId: "partner_1",
            disabledAt: code1LinkDisabledDate,
          };
        }
        if (where.partnerId === "partner_2") {
          return {
            id: "link_partner_2",
            programId: "prog_adv_test",
            partnerId: "partner_2",
            disabledAt: null,
          };
        }
        return null;
      });

      const event = createOrderEvent({
        created_at: orderCreatedAt,
        discount_codes: [{ code: "CODE1" }, { code: "CODE2" }],
      });

      const result = await ordersPaid({
        event,
        workspace: baseWorkspace,
        storeId: "store_adv",
      });

      // Code 1 fallback link was rejected, Code 2 fallback link was accepted!
      expect(mocks.attribute).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ id: "link_partner_2" }),
        }),
      );
      expect(mocks.sale).toHaveBeenCalledOnce();
      expect(result).toContain(
        "Order event processed successfully with discount codes",
      );
    });
  });
});
