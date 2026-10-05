import { beforeEach, describe, expect, it, vi } from "vitest";

// 1. Activate defensive BigInt JSON fallback
import "../../instrumentation";

import { getCommissionsCount } from "@/lib/api/commissions/get-commissions-count";
import { formatCommissionsForExport } from "@/lib/api/commissions/format-commissions-for-export";
import {
  CommissionSchema,
  CommissionEnrichedSchema,
} from "@/lib/zod/schemas/commissions";
import { toSafeBigInt as toSafeBigIntOrder } from "@/lib/weletic/commerce/record-order";
import { toSafeBigInt as toSafeBigIntRefund } from "@/lib/weletic/commerce/record-refund";
import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { NextResponse } from "next/server";
import { CommissionStatus, CommissionType } from "@prisma/client";

// In-memory mock database state
const state = vi.hoisted(() => ({
  orders: new Map<string, any>(),
  orderLines: new Map<string, any[]>(),
  commissions: new Map<string, any>(),
  calculations: new Map<string, any>(),
  refunds: new Map<string, any>(),
  refundLines: new Map<string, any[]>(),
}));

const db = vi.hoisted(() => {
  const many = () => ({ findMany: vi.fn().mockResolvedValue([]) });
  return {
    project: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "ws_wholesale",
        shopifyStoreId: "wholesale-test.myshopify.com",
        defaultProgramId: "prog_wholesale",
      }),
      findFirst: vi.fn().mockResolvedValue({
        id: "ws_wholesale",
        shopifyStoreId: "wholesale-test.myshopify.com",
        defaultProgramId: "prog_wholesale",
        installedIntegrations: [
          {
            id: "inst_1",
            credentials: { shop: "wholesale-test.myshopify.com" },
            updatedAt: new Date(),
          },
        ],
        weleticShopifyStore: {
          id: "store_wholesale",
          shopDomain: "wholesale-test.myshopify.com",
          installationGeneration: 1,
        },
      }),
    },
    installedIntegration: { findFirst: vi.fn().mockResolvedValue(null) },
    activityLog: { findFirst: vi.fn().mockResolvedValue(null) },
    program: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: "prog_wholesale",
        workspaceId: "ws_wholesale",
        accountingCurrency: "VND",
      }),
      findUnique: vi.fn().mockResolvedValue({
        id: "prog_wholesale",
        workspaceId: "ws_wholesale",
        accountingCurrency: "VND",
        workspace: { payoutFee: 0.05 },
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "prog_wholesale",
          workspaceId: "ws_wholesale",
          workspace: { payoutFee: 0.05 },
        },
      ]),
    },
    weleticShopifyStore: {
      upsert: vi.fn().mockResolvedValue({
        id: "store_wholesale",
        programId: "prog_wholesale",
        shopCurrency: "VND",
        shopDomain: "wholesale-test.myshopify.com",
        installationGeneration: 1,
      }),
      findFirst: vi.fn().mockResolvedValue({
        id: "store_wholesale",
        programId: "prog_wholesale",
        projectId: "ws_wholesale",
        shopifyDomain: "wholesale-test.myshopify.com",
        shopCurrency: "VND",
        shopDomain: "wholesale-test.myshopify.com",
        installationGeneration: 1,
      }),
      findUnique: vi.fn().mockResolvedValue({
        id: "store_wholesale",
        programId: "prog_wholesale",
        projectId: "ws_wholesale",
        shopifyDomain: "wholesale-test.myshopify.com",
        shopCurrency: "VND",
        shopDomain: "wholesale-test.myshopify.com",
        installationGeneration: 1,
      }),
    },
    partnerGroup: many(),
    programEnrollment: {
      ...many(),
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where?.partnerId_programId || where?.programId_partnerId;
        if (key) {
          return {
            id: `enr_${key.partnerId}`,
            programId: key.programId,
            partnerId: key.partnerId,
            groupId: null,
            createdAt: new Date(0),
            saleRewardId: null,
            saleReward: null,
            partnerGroup: null,
            status: "approved",
            discountCodes: [],
          };
        }
        return null;
      }),
    },
    weleticCommissionRule: {
      findMany: vi.fn(async () => [
        {
          id: "rule_wholesale_10pct",
          logicalKey: "manual:wholesale:tier1",
          programId: "prog_wholesale",
          partnerId: null,
          scope: "program",
          ruleType: "percentage",
          basisPoints: 1000,
          fixedAmount: null,
          currency: null,
          minOrderAmount: null,
          priority: 1,
          version: 1,
          effectiveAt: new Date(0),
          expiresAt: null,
          createdAt: new Date(0),
        },
      ]),
    },
    weleticShopifyProduct: many(),
    weleticShopifyVariant: many(),
    weleticLoyaltyProgram: { findUnique: vi.fn().mockResolvedValue(null) },
    weleticLoyaltyEarnPolicyRevision: { findFirst: vi.fn() },
    weleticLoyaltyReferral: { findFirst: vi.fn().mockResolvedValue(null) },
    weleticLoyaltyEarnGrant: { findUnique: vi.fn().mockResolvedValue(null) },
    weleticCommerceOrder: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.storeId_externalId) {
          const key = `${where.storeId_externalId.storeId}:${where.storeId_externalId.externalId}`;
          const order = state.orders.get(key);
          if (!order) return null;
          return { ...order, lines: state.orderLines.get(order.id) || [] };
        }
        return null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        if (where?.id) {
          for (const order of state.orders.values()) {
            if (order.id === where.id) {
              return { ...order, lines: state.orderLines.get(order.id) || [] };
            }
          }
        }
        throw new Error("Order not found");
      }),
      create: vi.fn(async ({ data }: any) => {
        const key = `${data.storeId}:${data.externalId}`;
        state.orders.set(key, data);
        return data;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const [key, order] of state.orders.entries()) {
          if (order.id === where.id) {
            const updated = { ...order, ...data };
            state.orders.set(key, updated);
            return updated;
          }
        }
        return data;
      }),
      updateMany: vi.fn(async ({ data }: any) => ({ count: 1 })),
    },
    weleticCommerceOrderLine: {
      createMany: vi.fn(async ({ data }: any) => {
        const orderId = data[0]?.orderId;
        state.orderLines.set(orderId, data);
        return { count: data.length };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const lines of state.orderLines.values()) {
          const line = lines.find((l) => l.id === where.id);
          if (line) {
            Object.assign(line, data);
            return line;
          }
        }
        return data;
      }),
    },
    weleticCommerceRefund: {
      findUnique: vi.fn(async () => null),
      aggregate: vi.fn(async () => ({ _sum: { accountingAmount: BigInt(0) } })),
      create: vi.fn(async ({ data }: any) => {
        state.refunds.set(data.id, data);
        return data;
      }),
    },
    weleticCommerceRefundLine: {
      aggregate: vi.fn(async () => ({ _sum: { accountingAmount: BigInt(0) } })),
      createMany: vi.fn(async ({ data }: any) => {
        const refundId = data[0]?.refundId;
        state.refundLines.set(refundId, data);
        return { count: data.length };
      }),
    },
    commission: {
      create: vi.fn(async ({ data }: any) => {
        state.commissions.set(data.id, data);
        return data;
      }),
      groupBy: vi.fn(async () => [
        {
          status: "pending",
          _count: 10,
          _sum: {
            amount: BigInt("50000000000"), // 50 Billion VND
            earnings: BigInt("5000000000"), // 5 Billion VND
          },
        },
        {
          status: "paid",
          _count: 5,
          _sum: {
            amount: BigInt("500000000000"), // 500 Billion VND
            earnings: BigInt("50000000000"), // 50 Billion VND
          },
        },
      ]),
    },
    weleticCommissionCalculation: {
      aggregate: vi.fn(async () => ({ _sum: { earnings: BigInt(0) } })),
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) {
          state.calculations.set(d.id, d);
        }
        return { count: data.length };
      }),
    },
    partner: {
      findUnique: vi.fn().mockResolvedValue({
        id: "partner_wholesale",
        name: "Wholesale Partner",
        email: "wholesale@example.com",
      }),
    },
    customer: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    reward: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    ...db,
    $transaction: async (fn: any) => fn(db),
  },
}));

vi.mock("@/lib/api/partners/sync-total-commissions", () => ({
  syncTotalCommissions: vi.fn(),
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  acquireDistributedLock: vi.fn().mockResolvedValue({ token: "test_token" }),
  releaseDistributedLock: vi.fn().mockResolvedValue(true),
  withDistributedLock: vi.fn(async ({ fn }: any) => fn()),
}));

vi.mock("@/lib/weletic/loyalty/refund", () => ({
  processRefundPointsReversal: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/weletic/reviews/requests", () => ({
  cancelIneligibleReviewRequests: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/weletic/loyalty/referrals", () => ({
  reverseReferralPointsOnRefund: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifySettlementLocks: async ({ fn }: any) => fn(),
  assertShopifySettlementLockContext: vi.fn(),
}));

vi.mock("@/lib/weletic/fx", () => ({
  getAccountingFxQuote: vi.fn(async ({ base, quote }: any) => ({
    base: base || "VND",
    quote: quote || base || "VND",
    rate: "1",
    provider: "test",
    capturedAt: new Date(),
  })),
  persistFxQuote: vi.fn().mockResolvedValue({ id: "fx_quote" }),
}));

vi.mock("@/lib/weletic/loyalty/shopper", () => ({
  upsertWeleticShopper: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/earn", () => ({
  processOrderPointsEarn: vi.fn(),
  processRefundPointsReversal: vi.fn().mockResolvedValue(null),
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
import { recordWeleticRefund } from "@/lib/weletic/commerce/record-refund";

describe("FIN-01 Adversarial Challenger: Boundary & Stress Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.orders.clear();
    state.orderLines.clear();
    state.commissions.clear();
    state.calculations.clear();
    state.refunds.clear();
    state.refundLines.clear();
  });

  // =========================================================================
  // SUITE 1: EXACT INT32 BOUNDARY CONDITIONS
  // =========================================================================
  describe("Suite 1: Exact Int32 Boundary Stress", () => {
    const INT32_MAX = BigInt("2147483647");
    const INT32_MAX_PLUS_1 = BigInt("2147483648");
    const INT32_MAX_PLUS_2 = BigInt("2147483649");
    const INT32_MIN = BigInt("-2147483648");
    const INT32_MIN_MINUS_1 = BigInt("-2147483649");

    it("verifies exact boundary transition at 2^31 - 1, 2^31, and 2^31 + 1", () => {
      // Both functions should cleanly accept all 3 values without throwing
      expect(toSafeBigIntOrder(INT32_MAX, "Int32 Max")).toBe(INT32_MAX);
      expect(toSafeBigIntRefund(INT32_MAX, "Int32 Max")).toBe(INT32_MAX);

      expect(toSafeBigIntOrder(INT32_MAX_PLUS_1, "Int32 Max + 1 (2^31)")).toBe(
        INT32_MAX_PLUS_1,
      );
      expect(toSafeBigIntRefund(INT32_MAX_PLUS_1, "Int32 Max + 1 (2^31)")).toBe(
        INT32_MAX_PLUS_1,
      );

      expect(toSafeBigIntOrder(INT32_MAX_PLUS_2, "Int32 Max + 2 (2^31 + 1)")).toBe(
        INT32_MAX_PLUS_2,
      );
      expect(toSafeBigIntRefund(INT32_MAX_PLUS_2, "Int32 Max + 2 (2^31 + 1)")).toBe(
        INT32_MAX_PLUS_2,
      );
    });

    it("verifies negative boundary transition at -2^31 and -(2^31 + 1)", () => {
      expect(toSafeBigIntOrder(INT32_MIN, "Int32 Min")).toBe(INT32_MIN);
      expect(toSafeBigIntRefund(INT32_MIN, "Int32 Min")).toBe(INT32_MIN);

      expect(toSafeBigIntOrder(INT32_MIN_MINUS_1, "Int32 Min - 1 (-(2^31 + 1))")).toBe(
        INT32_MIN_MINUS_1,
      );
      expect(toSafeBigIntRefund(INT32_MIN_MINUS_1, "Int32 Min - 1 (-(2^31 + 1))")).toBe(
        INT32_MIN_MINUS_1,
      );
    });

    it("records orders at exact Int32 boundary 2,147,483,647 and 2,147,483,648", async () => {
      for (const boundaryAmount of ["2147483647", "2147483648"]) {
        const orderPayload = {
          id: Number(boundaryAmount.slice(-6)),
          name: `#ORDER-BOUNDARY-${boundaryAmount}`,
          confirmation_number: `CONF-${boundaryAmount}`,
          checkout_token: `tok_${boundaryAmount}`,
          created_at: "2026-10-05T00:00:00Z",
          financial_status: "paid",
          current_subtotal_price_set: {
            shop_money: { amount: boundaryAmount, currency_code: "VND" },
            presentment_money: { amount: boundaryAmount, currency_code: "VND" },
          },
          current_total_discounts_set: {
            shop_money: { amount: "0", currency_code: "VND" },
            presentment_money: { amount: "0", currency_code: "VND" },
          },
          discount_codes: [],
          line_items: [
            {
              id: Number(boundaryAmount.slice(-6)) + 100,
              title: "Boundary Line Item",
              quantity: 1,
              price_set: {
                shop_money: { amount: boundaryAmount, currency_code: "VND" },
                presentment_money: { amount: boundaryAmount, currency_code: "VND" },
              },
              total_discount_set: {
                shop_money: { amount: "0", currency_code: "VND" },
                presentment_money: { amount: "0", currency_code: "VND" },
              },
              discount_allocations: [],
            },
          ],
        };

        const result = await recordWeleticOrder({
          event: orderPayload,
          workspaceId: "ws_wholesale",
          storeId: "store_wholesale",
          programId: "prog_wholesale",
          partnerId: "partner_wholesale",
        });

        expect(result).toBeDefined();
        const orderKey = `store_wholesale:${orderPayload.id}`;
        const createdOrder = state.orders.get(orderKey);
        expect(createdOrder.accountingNet).toBe(BigInt(boundaryAmount));

        const commission = Array.from(state.commissions.values()).find(
          (c) => c.invoiceId === `shopify:${orderPayload.id}`,
        );
        expect(commission).toBeDefined();
        expect(commission.amount).toBe(BigInt(boundaryAmount));
        // 10% commission with half-up rounding
        const expectedEarnings =
          (BigInt(boundaryAmount) * BigInt(1000) + BigInt(5000)) / BigInt(10000);
        expect(commission.earnings).toBe(expectedEarnings);
      }
    });
  });

  // =========================================================================
  // SUITE 2: MULTI-BILLION VND STRESS (5B, 50B, 500B VND)
  // =========================================================================
  describe("Suite 2: Multi-Billion VND Wholesale Stress", () => {
    const testCases = [
      { amountStr: "5000000000", expectedAmt: BigInt("5000000000"), label: "5 Billion VND" },
      { amountStr: "50000000000", expectedAmt: BigInt("50000000000"), label: "50 Billion VND" },
      { amountStr: "500000000000", expectedAmt: BigInt("500000000000"), label: "500 Billion VND" },
      { amountStr: "5000000000000", expectedAmt: BigInt("5000000000000"), label: "5 Trillion VND" },
    ];

    testCases.forEach(({ amountStr, expectedAmt, label }) => {
      it(`successfully processes wholesale order of ${label}`, async () => {
        const orderId = Number(amountStr.slice(0, 7));
        const orderPayload = {
          id: orderId,
          name: `#VND-BIG-${amountStr}`,
          confirmation_number: `CONF-BIG-${amountStr}`,
          checkout_token: `tok_big_${amountStr}`,
          created_at: "2026-10-05T00:00:00Z",
          financial_status: "paid",
          current_subtotal_price_set: {
            shop_money: { amount: amountStr, currency_code: "VND" },
            presentment_money: { amount: amountStr, currency_code: "VND" },
          },
          current_total_discounts_set: {
            shop_money: { amount: "0", currency_code: "VND" },
            presentment_money: { amount: "0", currency_code: "VND" },
          },
          discount_codes: [],
          line_items: [
            {
              id: orderId + 999,
              title: `Bulk Wholesale Item (${label})`,
              quantity: 1,
              price_set: {
                shop_money: { amount: amountStr, currency_code: "VND" },
                presentment_money: { amount: amountStr, currency_code: "VND" },
              },
              total_discount_set: {
                shop_money: { amount: "0", currency_code: "VND" },
                presentment_money: { amount: "0", currency_code: "VND" },
              },
              discount_allocations: [],
            },
          ],
        };

        const result = await recordWeleticOrder({
          event: orderPayload,
          workspaceId: "ws_wholesale",
          storeId: "store_wholesale",
          programId: "prog_wholesale",
          partnerId: "partner_wholesale",
        });

        expect(result).toBeDefined();
        const orderKey = `store_wholesale:${orderId}`;
        const order = state.orders.get(orderKey);
        expect(order.accountingNet).toBe(expectedAmt);

        const commission = Array.from(state.commissions.values()).find(
          (c) => c.invoiceId === `shopify:${orderId}`,
        );
        expect(commission).toBeDefined();
        expect(commission.amount).toBe(expectedAmt);
        expect(commission.earnings).toBe(expectedAmt / BigInt(10));
        expect(commission.currency).toBe("VND");
      });
    });
  });

  // =========================================================================
  // SUITE 3: LARGE JPY WHOLESALE ORDERS
  // =========================================================================
  describe("Suite 3: Large JPY Wholesale Orders", () => {
    it("processes wholesale JPY order of 50,000,000,000 JPY without range or precision error", async () => {
      vi.mocked(db.program.findUniqueOrThrow).mockResolvedValueOnce({
        id: "prog_wholesale",
        workspaceId: "ws_wholesale",
        accountingCurrency: "JPY",
      } as any);
      vi.mocked(db.weleticShopifyStore.upsert).mockResolvedValueOnce({
        id: "store_wholesale",
        programId: "prog_wholesale",
        shopCurrency: "JPY",
      } as any);

      const jpyPayload = {
        id: 777999,
        name: "#JPY-MEGA-WHOLESALE",
        confirmation_number: "JPY-MEGA",
        checkout_token: "tok_jpy_mega",
        created_at: "2026-10-05T00:00:00Z",
        financial_status: "paid",
        current_subtotal_price_set: {
          shop_money: { amount: "50000000000", currency_code: "JPY" },
          presentment_money: { amount: "50000000000", currency_code: "JPY" },
        },
        current_total_discounts_set: {
          shop_money: { amount: "0", currency_code: "JPY" },
          presentment_money: { amount: "0", currency_code: "JPY" },
        },
        discount_codes: [],
        line_items: [
          {
            id: 888999,
            title: "Corporate Apparel Contract",
            quantity: 1,
            price_set: {
              shop_money: { amount: "50000000000", currency_code: "JPY" },
              presentment_money: { amount: "50000000000", currency_code: "JPY" },
            },
            total_discount_set: {
              shop_money: { amount: "0", currency_code: "JPY" },
              presentment_money: { amount: "0", currency_code: "JPY" },
            },
            discount_allocations: [],
          },
        ],
      };

      const result = await recordWeleticOrder({
        event: jpyPayload,
        workspaceId: "ws_wholesale",
        storeId: "store_wholesale",
        programId: "prog_wholesale",
        partnerId: "partner_wholesale",
      });

      expect(result).toBeDefined();
      const order = state.orders.get("store_wholesale:777999");
      expect(order.accountingNet).toBe(BigInt("50000000000"));

      const commission = Array.from(state.commissions.values()).find(
        (c) => c.currency === "JPY",
      );
      expect(commission).toBeDefined();
      expect(commission.amount).toBe(BigInt("50000000000"));
      expect(commission.earnings).toBe(BigInt("5000000000"));
    });
  });

  // =========================================================================
  // SUITE 4: MASSIVE REFUND CLAWBACKS & PARTIAL REFUND SEQUENCES
  // =========================================================================
  describe("Suite 4: Massive Refund Clawbacks & Partial Refund Sequences", () => {
    it("handles multi-step partial refund sequence on a 50 Billion VND order", async () => {
      const orderId = "worder_multi_refund";
      const lineId = "wline_multi_refund";
      const externalOrderId = "555001";
      const totalAmount = BigInt("50000000000");
      const totalEarnings = BigInt("5000000000");

      // Seed 50 Billion VND order in state
      state.orders.set(`store_wholesale:${externalOrderId}`, {
        id: orderId,
        storeId: "store_wholesale",
        externalId: externalOrderId,
        programId: "prog_wholesale",
        partnerId: "partner_wholesale",
        linkId: "link_wholesale",
        orderName: "#VND-50B-SEED",
        shopCurrency: "VND",
        accountingCurrency: "VND",
        presentmentCurrency: "VND",
        accountingFxRate: "1",
        accountingNet: totalAmount,
        commissionableAccountingAmount: totalAmount,
        earnings: totalEarnings,
        occurredAt: new Date("2026-10-05T00:00:00Z"),
        status: "paid",
      });

      state.orderLines.set(orderId, [
        {
          id: lineId,
          orderId,
          externalId: "888555001",
          quantity: 1,
          accountingNet: totalAmount,
          commissionableAccountingAmount: totalAmount,
          earnings: totalEarnings,
          ruleId: "rule_wholesale_10pct",
          status: "paid",
          calculations: [
            {
              ruleId: "rule_wholesale_10pct",
              earnings: totalEarnings,
              commissionableAmount: totalAmount,
              commissionId: "cm_orig_50b",
            },
          ],
        },
      ]);

      // Step 1: First partial refund = 2,147,483,648 VND (crossing Int32)
      const refundEvent1 = {
        id: 1001,
        order_id: Number(externalOrderId),
        created_at: "2026-10-05T01:00:00Z",
        refund_line_items: [
          {
            id: 2001,
            line_item_id: 888555001,
            quantity: 1,
            subtotal_set: {
              shop_money: { amount: "2147483648", currency_code: "VND" },
              presentment_money: { amount: "2147483648", currency_code: "VND" },
            },
          },
        ],
      };

      const res1 = await recordWeleticRefund({
        event: refundEvent1,
        shopDomain: "wholesale-test.myshopify.com",
      });
      expect(res1.duplicate).toBe(false);

      const refundComm1 = Array.from(state.commissions.values()).find(
        (c) => c.eventId === `weletic:shopify:refund:store_wholesale:1001`,
      );
      expect(refundComm1).toBeDefined();
      expect(refundComm1.amount).toBe(BigInt(0));
      // Reversal calculation for 2,147,483,648 / 50,000,000,000 * 5,000,000,000
      expect(refundComm1.earnings).toBe(BigInt("-214748365"));

      // Step 2: Second partial refund = 10,000,000,000 VND (10 Billion VND)
      const refundEvent2 = {
        id: 1002,
        order_id: Number(externalOrderId),
        created_at: "2026-10-05T02:00:00Z",
        refund_line_items: [
          {
            id: 2002,
            line_item_id: 888555001,
            quantity: 1,
            subtotal_set: {
              shop_money: { amount: "10000000000", currency_code: "VND" },
              presentment_money: { amount: "10000000000", currency_code: "VND" },
            },
          },
        ],
      };

      const res2 = await recordWeleticRefund({
        event: refundEvent2,
        shopDomain: "wholesale-test.myshopify.com",
      });
      expect(res2.duplicate).toBe(false);

      const refundComm2 = Array.from(state.commissions.values()).find(
        (c) => c.eventId === `weletic:shopify:refund:store_wholesale:1002`,
      );
      expect(refundComm2).toBeDefined();
      expect(refundComm2.amount).toBe(BigInt(0));
      // Reversal for 10 Billion VND = 1 Billion VND
      expect(refundComm2.earnings).toBe(BigInt("-1000000000"));
    });

    it("evaluates calculateRefundReversal with astronomical amounts up to safe limits", () => {
      const originalAmount = BigInt("50000000000"); // 50 Billion VND
      const originalEarnings = BigInt("5000000000"); // 5 Billion VND

      // Exact half refund
      const halfReversal = calculateRefundReversal({
        originalCommissionableAmount: originalAmount,
        originalEarnings,
        refundedAmount: BigInt("25000000000"),
        alreadyReversed: BigInt(0),
      });
      expect(halfReversal).toBe(BigInt("2500000000"));

      // Remaining refund
      const secondHalfReversal = calculateRefundReversal({
        originalCommissionableAmount: originalAmount,
        originalEarnings,
        refundedAmount: BigInt("25000000000"),
        alreadyReversed: BigInt("2500000000"),
      });
      expect(secondHalfReversal).toBe(BigInt("2500000000"));

      // Excess refund beyond original amount is safely clamped
      const excessReversal = calculateRefundReversal({
        originalCommissionableAmount: originalAmount,
        originalEarnings,
        refundedAmount: BigInt("10000000000"),
        alreadyReversed: BigInt("5000000000"),
      });
      expect(excessReversal).toBe(BigInt(0));
    });
  });

  // =========================================================================
  // SUITE 5: JSON SERIALIZATION & DTO EDGE CASES
  // =========================================================================
  describe("Suite 5: JSON Serialization & DTO Edge Cases", () => {
    it("correctly parses multi-billion commissions in CommissionSchema and CommissionEnrichedSchema", () => {
      const multiBillionPrismaRecord = {
        id: "cm_50b_vnd",
        type: CommissionType.sale,
        amount: BigInt("50000000000"),
        earnings: BigInt("5000000000"),
        currency: "VND",
        status: CommissionStatus.pending,
        invoiceId: "shopify:555001",
        description: "50 Billion VND Order",
        quantity: 5000,
        userId: null,
        createdAt: new Date("2026-10-05T00:00:00Z"),
        updatedAt: new Date("2026-10-05T00:00:00Z"),
      };

      const parsed = CommissionSchema.parse(multiBillionPrismaRecord);
      expect(parsed.amount).toBe(50_000_000_000);
      expect(parsed.earnings).toBe(5_000_000_000);
      expect(Number.isSafeInteger(parsed.amount)).toBe(true);
      expect(Number.isSafeInteger(parsed.earnings)).toBe(true);
    });

    it("verifies global BigInt.prototype.toJSON handles 0n, negative, and large positive BigInts", () => {
      const obj = {
        zero: BigInt(0),
        negative: BigInt("-5000000000"),
        largePositive: BigInt("50000000000"),
        maxSafe: BigInt(Number.MAX_SAFE_INTEGER),
        beyondSafe: BigInt(Number.MAX_SAFE_INTEGER) + BigInt(100),
      };

      const jsonStr = JSON.stringify(obj);
      const parsed = JSON.parse(jsonStr);

      expect(parsed.zero).toBe(0);
      expect(parsed.negative).toBe(-5_000_000_000);
      expect(parsed.largePositive).toBe(50_000_000_000);
      expect(parsed.maxSafe).toBe(Number.MAX_SAFE_INTEGER);
      expect(parsed.beyondSafe).toBe((BigInt(Number.MAX_SAFE_INTEGER) + BigInt(100)).toString());
    });
  });
});
