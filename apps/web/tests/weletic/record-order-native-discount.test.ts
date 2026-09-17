import { beforeEach, describe, expect, it, vi } from "vitest";

// Execute the production recorder with in-memory database delegates. This is a
// contract regression, not live SQL or Shopify acceptance.
const state = vi.hoisted(() => ({ order: null as any, lines: [] as any[] }));
const db = vi.hoisted(() => {
  const many = () => ({ findMany: vi.fn().mockResolvedValue([]) });
  return {
    project: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        shopifyStoreId: "test.myshopify.com",
        defaultProgramId: "program",
      }),
    },
    program: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "program",
        workspaceId: "workspace",
        accountingCurrency: "JPY",
      }),
    },
    weleticShopifyStore: {
      upsert: vi.fn().mockResolvedValue({
        id: "store",
        programId: "program",
        shopCurrency: "JPY",
      }),
    },
    partnerGroup: many(),
    programEnrollment: {
      ...many(),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    weleticCommissionRule: many(),
    weleticShopifyProduct: many(),
    weleticShopifyVariant: many(),
    weleticLoyaltyProgram: { findUnique: vi.fn().mockResolvedValue(null) },
    weleticLoyaltyEarnPolicyRevision: { findFirst: vi.fn() },
    weleticCommerceOrder: {
      findUnique: vi.fn(async () =>
        state.order ? { ...state.order, lines: state.lines } : null,
      ),
      findUniqueOrThrow: vi.fn(async () => state.order),
      create: vi.fn(async ({ data }) => (state.order = data)),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(state.order, data);
        return { count: 1 };
      }),
    },
    weleticCommerceOrderLine: {
      createMany: vi.fn(async ({ data }) => {
        state.lines = data;
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(
          state.lines.find((l) => l.id === where.id),
          data,
        ),
      ),
    },
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { ...db, $transaction: async (fn: any) => fn(db) },
}));
vi.mock("@/lib/api/partners/sync-total-commissions", () => ({
  syncTotalCommissions: vi.fn(),
}));
vi.mock("@/lib/weletic/commerce/record-refund", () => ({
  calculateRefundReversal: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifySettlementLocks: async ({ fn }: any) => fn(),
  assertShopifySettlementLockContext: vi.fn(),
}));
vi.mock("@/lib/weletic/fx", () => ({
  getAccountingFxQuote: vi.fn().mockResolvedValue({
    base: "JPY",
    quote: "JPY",
    rate: "1",
    provider: "test",
    capturedAt: new Date(),
  }),
  persistFxQuote: vi.fn().mockResolvedValue({ id: "fx" }),
}));
vi.mock("@/lib/weletic/loyalty/shopper", () => ({
  upsertWeleticShopper: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/earn", () => ({
  processOrderPointsEarn: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  resolveLoyaltyEarnPolicyRevisionAt: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/referral-friend-claim", () => ({
  evaluateReferralFriendClaimQualification: vi
    .fn()
    .mockResolvedValue({ qualified: false }),
}));
vi.mock("@/lib/weletic/shopify/customer-segments", () => ({
  getShopifyCustomerOrderHistory: vi.fn(),
  getShopifyCustomerSegmentIds: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/order-context", () => ({
  getShopifyOrderLineContext: vi.fn().mockResolvedValue(new Map()),
}));

import { recordWeleticOrder } from "@/lib/weletic/commerce/record-order";
const money = (amount: string) => ({
  shop_money: { amount, currency_code: "JPY" },
  presentment_money: { amount, currency_code: "JPY" },
});
const event = () => ({
  id: 100,
  name: "#synthetic",
  confirmation_number: "TEST",
  checkout_token: "TEST",
  created_at: "2026-09-17T00:00:00Z",
  financial_status: "paid",
  current_subtotal_price_set: money("900"),
  current_total_discounts_set: money("100"),
  discount_codes: [{ code: "TEST" }],
  line_items: [
    {
      id: 101,
      title: "Synthetic",
      quantity: 1,
      price_set: money("1000"),
      total_discount_set: money("0"),
      discount_allocations: [
        { discount_application_index: 0, amount_set: money("100") },
      ],
    },
  ],
});
const record = (input = event(), partnerId?: string) =>
  recordWeleticOrder({
    event: input,
    workspaceId: "workspace",
    storeId: "store",
    programId: "program",
    partnerId,
  });
beforeEach(() => {
  vi.clearAllMocks();
  state.order = null;
  state.lines = [];
});
describe("record native discount through production commerce recorder", () => {
  it("persists net 900 in all financial line columns despite legacy discount zero", async () => {
    await record();
    expect(state.order).toMatchObject({
      shopNet: BigInt(900),
      accountingNet: BigInt(900),
      presentmentNet: BigInt(900),
    });
    expect(state.lines).toHaveLength(1);
    expect(state.lines[0]).toMatchObject({
      shopGross: BigInt(1000),
      shopDiscount: BigInt(100),
      shopNet: BigInt(900),
      presentmentNet: BigInt(900),
      presentmentDiscount: BigInt(100),
      accountingNet: BigInt(900),
      commissionableAccountingAmount: BigInt(900),
    });
  });
  it("does not rewrite captured money on duplicate or later partner attribution", async () => {
    await record();
    const saved = structuredClone(state.lines);
    const changed = event();
    changed.line_items[0].discount_allocations[0].amount_set = money("200");
    await record(changed);
    expect(db.weleticCommerceOrder.create).toHaveBeenCalledOnce();
    expect(db.weleticCommerceOrderLine.createMany).toHaveBeenCalledOnce();
    expect(state.lines).toEqual(saved);
    await record(changed, "partner_late");
    expect(state.order.partnerId).toBe("partner_late");
    expect(state.lines).toEqual(saved);
    expect(state.order.accountingNet).toBe(BigInt(900));
    for (const [call] of db.weleticCommerceOrderLine.update.mock.calls) {
      expect(call.data).not.toHaveProperty("shopNet");
      expect(call.data).not.toHaveProperty("accountingNet");
      expect(call.data).not.toHaveProperty("presentmentNet");
    }
  });
  it("does not persist a new order when allocated discount exceeds line gross", async () => {
    const invalid = event();
    invalid.line_items[0].discount_allocations[0].amount_set = money("1001");
    await expect(record(invalid)).rejects.toThrow(/exceeds gross/);
    expect(db.weleticCommerceOrder.create).not.toHaveBeenCalled();
  });
});
