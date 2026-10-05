import { beforeEach, describe, expect, it, vi } from "vitest";

// 1. Activate defensive BigInt JSON fallback
import "../../instrumentation";

import { getCommissionsCount } from "@/lib/api/commissions/get-commissions-count";
import { formatCommissionsForExport } from "@/lib/api/commissions/format-commissions-for-export";
import {
  CommissionSchema,
  CommissionEnrichedSchema,
  CommissionDetailSchema,
} from "@/lib/zod/schemas/commissions";
import { toSafeBigInt as toSafeBigIntOrder } from "@/lib/weletic/commerce/record-order";
import { toSafeBigInt as toSafeBigIntRefund } from "@/lib/weletic/commerce/record-refund";
import { NextResponse } from "next/server";
import { CommissionStatus, CommissionType } from "@prisma/client";

// Set up in-memory mock database delegates for commerce recorder tests
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
          _count: 5,
          _sum: {
            amount: BigInt(2500000000), // BigInt exceeding Int32
            earnings: BigInt(250000000),
          },
        },
        {
          status: "paid",
          _count: 2,
          _sum: {
            amount: BigInt(5000000000), // 5 Billion VND
            earnings: BigInt(500000000),
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

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: vi.fn().mockResolvedValue({
    workspaceId: "ws_wholesale",
    storeId: "store_wholesale",
    shopId: "shop_ws_wholesale",
    primaryDomain: "wholesale-test.myshopify.com",
    myshopifyDomain: "wholesale-test.myshopify.com",
    allDomains: ["wholesale-test.myshopify.com"],
    programId: "prog_wholesale",
    accessToken: "shpat_mock",
  }),
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

describe("FIN-01: Zero-Decimal Currency (VND, JPY) Int32 Overflow Prevention Suite", () => {
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
  // 1. MATHEMATICAL BOUNDARIES & TO_SAFE_BIGINT GUARDRAIL
  // =========================================================================
  describe("1. Mathematical Boundaries & toSafeBigInt Guardrail", () => {
    it("handles values exceeding Int32 max (2,147,483,647) up to 64-bit limits without throwing", () => {
      // 2.5 Billion VND (Wholesale order)
      const wholesaleVnd = BigInt(2_500_000_000);
      expect(toSafeBigIntOrder(wholesaleVnd, "Order amount")).toBe(BigInt(2500000000));
      expect(toSafeBigIntRefund(wholesaleVnd, "Order amount")).toBe(BigInt(2500000000));

      // 25 Million JPY and 2.5 Billion JPY
      const wholesaleJpy = BigInt(25_000_000);
      const megaWholesaleJpy = BigInt(2_500_000_000);
      expect(toSafeBigIntOrder(wholesaleJpy, "Order amount")).toBe(BigInt(25000000));
      expect(toSafeBigIntOrder(megaWholesaleJpy, "Order amount")).toBe(BigInt(2500000000));

      // 10 Billion VND
      const tenBillion = BigInt(10_000_000_000);
      expect(toSafeBigIntOrder(tenBillion, "Order amount")).toBe(BigInt("10000000000"));

      // Accepts number input and returns bigint
      expect(toSafeBigIntOrder(2500000000, "Order amount")).toBe(BigInt(2500000000));
    });

    it("handles negative values beyond 32-bit negative limit (-2,147,483,648) for large refund clawbacks", () => {
      // -2.5 Billion VND clawback
      const negativeVnd = BigInt(-2_500_000_000);
      expect(toSafeBigIntOrder(negativeVnd, "Refund reversal")).toBe(BigInt(-2500000000));
      expect(toSafeBigIntRefund(negativeVnd, "Refund reversal")).toBe(BigInt(-2500000000));
    });

    it("strictly rejects values exceeding signed 64-bit integer limits", () => {
      const MAX_64 = BigInt("9223372036854775807");
      const MIN_64 = BigInt("-9223372036854775808");

      expect(toSafeBigIntOrder(MAX_64, "Safe Max")).toBe(MAX_64);
      expect(toSafeBigIntOrder(MIN_64, "Safe Min")).toBe(MIN_64);

      // Beyond 64-bit limits
      const overflow64 = MAX_64 + BigInt(1);
      const underflow64 = MIN_64 - BigInt(1);

      expect(() => toSafeBigIntOrder(overflow64, "Overflow")).toThrow(
        /exceeds the 64-bit integer money range/,
      );
      expect(() => toSafeBigIntRefund(underflow64, "Underflow")).toThrow(
        /exceeds the 64-bit integer money range/,
      );
    });
  });

  // =========================================================================
  // 2. WHOLESALE COMMERCE RECORDING (recordWeleticOrder)
  // =========================================================================
  describe("2. Wholesale Commerce Recording (> 2,147,483,647 VND & JPY)", () => {
    it("successfully records wholesale order of 2,500,000,000 VND and creates BigInt commission", async () => {
      const wholesaleOrderPayload = {
        id: 999001,
        name: "#VND-WHOLESALE-01",
        confirmation_number: "VND-WS-01",
        checkout_token: "tok_vnd_wholesale",
        created_at: "2026-10-05T00:00:00Z",
        financial_status: "paid",
        current_subtotal_price_set: {
          shop_money: { amount: "2500000000", currency_code: "VND" },
          presentment_money: { amount: "2500000000", currency_code: "VND" },
        },
        current_total_discounts_set: {
          shop_money: { amount: "0", currency_code: "VND" },
          presentment_money: { amount: "0", currency_code: "VND" },
        },
        discount_codes: [],
        line_items: [
          {
            id: 888001,
            title: "Bulk Activewear Bundle 2500 units",
            quantity: 2500,
            price_set: {
              shop_money: { amount: "1000000", currency_code: "VND" },
              presentment_money: { amount: "1000000", currency_code: "VND" },
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
        event: wholesaleOrderPayload,
        workspaceId: "ws_wholesale",
        storeId: "store_wholesale",
        programId: "prog_wholesale",
        partnerId: "partner_wholesale",
      });

      expect(result).toBeDefined();

      // Verify created order
      const key = "store_wholesale:999001";
      const createdOrder = state.orders.get(key);
      expect(createdOrder).toBeDefined();
      expect(createdOrder.accountingNet).toBe(BigInt(2500000000));

      // Verify created Commission in Dub table
      const commissions = Array.from(state.commissions.values());
      expect(commissions.length).toBeGreaterThanOrEqual(1);

      const comm = commissions.find((c) => c.partnerId === "partner_wholesale");
      expect(comm).toBeDefined();
      expect(comm.type).toBe("sale");
      // 2.5 Billion VND amount (> Int32 max 2,147,483,647)
      expect(comm.amount).toBe(BigInt(2500000000));
      // 10% commission on 2.5 Billion = 250,000,000 VND
      expect(comm.earnings).toBe(BigInt(250000000));
      expect(comm.currency).toBe("VND");
      expect(comm.status).toBe("pending");
    });

    it("successfully records wholesale order of 25,000,000 JPY and mega order of 2,500,000,000 JPY", async () => {
      // Configure program for JPY
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

      const jpyOrderPayload = {
        id: 999002,
        name: "#JPY-WHOLESALE-01",
        confirmation_number: "JPY-WS-01",
        checkout_token: "tok_jpy_wholesale",
        created_at: "2026-10-05T00:00:00Z",
        financial_status: "paid",
        current_subtotal_price_set: {
          shop_money: { amount: "2500000000", currency_code: "JPY" },
          presentment_money: { amount: "2500000000", currency_code: "JPY" },
        },
        current_total_discounts_set: {
          shop_money: { amount: "0", currency_code: "JPY" },
          presentment_money: { amount: "0", currency_code: "JPY" },
        },
        discount_codes: [],
        line_items: [
          {
            id: 888002,
            title: "Tokyo Department Store B2B Order",
            quantity: 500,
            price_set: {
              shop_money: { amount: "5000000", currency_code: "JPY" },
              presentment_money: { amount: "5000000", currency_code: "JPY" },
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
        event: jpyOrderPayload,
        workspaceId: "ws_wholesale",
        storeId: "store_wholesale",
        programId: "prog_wholesale",
        partnerId: "partner_wholesale",
      });

      expect(result).toBeDefined();
      const createdOrder = state.orders.get("store_wholesale:999002");
      expect(createdOrder.accountingNet).toBe(BigInt(2500000000));

      const commissions = Array.from(state.commissions.values());
      const jpyComm = commissions.find((c) => c.currency === "JPY");
      expect(jpyComm).toBeDefined();
      expect(jpyComm.amount).toBe(BigInt(2500000000));
      expect(jpyComm.earnings).toBe(BigInt(250000000));
    });
  });

  // =========================================================================
  // 3. ZERO-DECIMAL REFUND CLAWBACK (recordWeleticRefund)
  // =========================================================================
  describe("3. Zero-Decimal Refund Clawback Handling", () => {
    it("successfully creates a negative clawback commission for a 2.5 Billion VND order refund", async () => {
      // First seed an existing order in state
      const orderId = "worder_vnd_seed";
      const lineId = "wline_vnd_seed";
      const externalId = "999003";

      const orderData = {
        id: orderId,
        storeId: "store_wholesale",
        externalId,
        programId: "prog_wholesale",
        partnerId: "partner_wholesale",
        linkId: "link_wholesale",
        orderName: "#VND-WHOLESALE-01",
        shopCurrency: "VND",
        accountingCurrency: "VND",
        presentmentCurrency: "VND",
        accountingFxRate: "1",
        accountingNet: BigInt(2500000000),
        commissionableAccountingAmount: BigInt(2500000000),
        earnings: BigInt(250000000),
        occurredAt: new Date("2026-10-05T00:00:00Z"),
        status: "paid",
      };
      state.orders.set(`store_wholesale:${externalId}`, orderData);

      const orderLineData = [
        {
          id: lineId,
          orderId,
          externalId: "888003",
          quantity: 1000,
          accountingNet: BigInt(2500000000),
          commissionableAccountingAmount: BigInt(2500000000),
          earnings: BigInt(250000000),
          ruleId: "rule_wholesale_10pct",
          status: "paid",
          calculations: [
            {
              ruleId: "rule_wholesale_10pct",
              earnings: BigInt(250000000),
              commissionableAmount: BigInt(2500000000),
              commissionId: "cm_orig_1",
            },
          ],
        },
      ];
      state.orderLines.set(orderId, orderLineData);

      // Dispatch full refund event
      const refundEvent = {
        id: 777001,
        order_id: 999003,
        created_at: "2026-10-05T01:00:00Z",
        refund_line_items: [
          {
            id: 666001,
            line_item_id: 888003,
            quantity: 1000,
            subtotal_set: {
              shop_money: { amount: "2500000000", currency_code: "VND" },
              presentment_money: { amount: "2500000000", currency_code: "VND" },
            },
          },
        ],
      };

      const result = await recordWeleticRefund({
        event: refundEvent,
        shopDomain: "wholesale-test.myshopify.com",
      });

      expect(result.duplicate).toBe(false);
      expect(result.ignored).toBe(false);

      // Verify refund commission created with negative BigInt earnings
      const commissions = Array.from(state.commissions.values());
      const reversal = commissions.find(
        (c) => c.type === "custom" && c.currency === "VND",
      );
      expect(reversal).toBeDefined();
      expect(reversal.earnings).toBe(BigInt(-250000000));
      expect(reversal.amount).toBe(BigInt(0));
    });
  });

  // =========================================================================
  // 4. ZOD SCHEMA COERCION & DTO COMPATIBILITY
  // =========================================================================
  describe("4. Zod Schema Coercion & DTO Serialization", () => {
    it("coerces BigInt amount and earnings to standard JavaScript numbers in CommissionSchema", () => {
      const rawPrismaCommission = {
        id: "cm_vnd_wholesale",
        type: CommissionType.sale,
        amount: BigInt(2500000000), // BigInt from Prisma
        earnings: BigInt(250000000), // BigInt from Prisma
        currency: "VND",
        status: CommissionStatus.pending,
        invoiceId: "shopify:999001",
        description: "Shopify order #VND-WHOLESALE-01",
        quantity: 2500,
        userId: null,
        createdAt: new Date("2026-10-05T00:00:00Z"),
        updatedAt: new Date("2026-10-05T00:00:00Z"),
      };

      const parsed = CommissionSchema.parse(rawPrismaCommission);

      // Expected to be clean numbers
      expect(parsed.amount).toBe(2500000000);
      expect(typeof parsed.amount).toBe("number");
      expect(parsed.earnings).toBe(250000000);
      expect(typeof parsed.earnings).toBe("number");
    });

    it("coerces negative BigInt refund earnings to negative number", () => {
      const rawRefundCommission = {
        id: "cm_vnd_refund",
        type: CommissionType.custom,
        amount: BigInt(0),
        earnings: BigInt(-250000000), // Negative BigInt
        currency: "VND",
        status: CommissionStatus.pending,
        invoiceId: null,
        description: "Refund clawback",
        quantity: 1,
        userId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const parsed = CommissionSchema.parse(rawRefundCommission);
      expect(parsed.amount).toBe(0);
      expect(typeof parsed.amount).toBe("number");
      expect(parsed.earnings).toBe(-250000000);
      expect(typeof parsed.earnings).toBe("number");
    });

    it("serializes parsed CommissionEnrichedSchema via NextResponse.json without errors", async () => {
      const enrichedRecord = {
        id: "cm_enriched_test",
        type: CommissionType.sale,
        amount: BigInt(2500000000),
        earnings: BigInt(250000000),
        currency: "VND",
        status: CommissionStatus.pending,
        invoiceId: "shopify:999001",
        description: "Test description",
        quantity: 1,
        userId: null,
        createdAt: new Date("2026-10-05T00:00:00Z"),
        updatedAt: new Date("2026-10-05T00:00:00Z"),
        paidAt: null,
        partner: {
          id: "partner_1",
          name: "Hiro Partner",
          email: "hiro@example.com",
          image: null,
          payoutsEnabledAt: new Date("2026-01-01"),
          country: "VN",
          groupId: "group_1",
        },
        customer: null,
      };

      const parsed = CommissionEnrichedSchema.parse(enrichedRecord);
      const response = NextResponse.json(parsed);
      const json = await response.json();

      expect(json.amount).toBe(2500000000);
      expect(json.earnings).toBe(250000000);
      expect(typeof json.amount).toBe("number");
      expect(typeof json.earnings).toBe("number");
    });
  });

  // =========================================================================
  // 5. DEFENSIVE BIGINT PROTOTYPE FALLBACK (JSON.stringify Safety)
  // =========================================================================
  describe("5. Defensive BigInt.prototype.toJSON Fallback", () => {
    it("guarantees JSON.stringify serializes uncoerced BigInt without throwing", () => {
      const rawObjectWithBigInt = {
        amount: BigInt(2500000000),
        earnings: BigInt(250000000),
        label: "Wholesale test",
      };

      // Native JSON.stringify would throw TypeError: Do not know how to serialize a BigInt
      // With our instrumentation.ts fallback, it serializes safely
      const serialized = JSON.stringify(rawObjectWithBigInt);
      expect(serialized).toBe(
        '{"amount":2500000000,"earnings":250000000,"label":"Wholesale test"}',
      );

      const parsed = JSON.parse(serialized);
      expect(parsed.amount).toBe(2500000000);
      expect(parsed.earnings).toBe(250000000);
    });

    it("serializes numbers beyond safe integer as string to prevent precision loss", () => {
      const hugeBigInt = BigInt("9007199254740992"); // Number.MAX_SAFE_INTEGER + 1
      const obj = { value: hugeBigInt };
      const serialized = JSON.stringify(obj);
      expect(serialized).toBe('{"value":"9007199254740992"}');
    });
  });

  // =========================================================================
  // 6. RAW AGGREGATIONS SAFETY
  // =========================================================================
  describe("6. Raw Aggregations & Analytics Route Safety", () => {
    it("getCommissionsCount aggregates BigInt sums into numbers without TypeError", async () => {
      const counts = await getCommissionsCount({
        programId: "prog_wholesale",
        interval: "all",
      });

      expect(counts).toBeDefined();
      expect(counts.pending).toBeDefined();
      expect(counts.pending.amount).toBe(2500000000);
      expect(typeof counts.pending.amount).toBe("number");
      expect(counts.pending.earnings).toBe(250000000);
      expect(typeof counts.pending.earnings).toBe("number");

      expect(counts.paid.amount).toBe(5000000000);
      expect(counts.all.amount).toBe(7500000000);
      expect(typeof counts.all.amount).toBe("number");
      expect(counts.all.earnings).toBe(750000000);
      expect(typeof counts.all.earnings).toBe("number");
    });

    it("formatCommissionsForExport formats BigInt amount and earnings cleanly", () => {
      const rawCommissionExportItem = [
        {
          id: "cm_export_1",
          amount: BigInt(2500000000),
          earnings: BigInt(250000000),
          currency: "vnd",
          status: "pending",
          type: "sale",
          createdAt: new Date("2026-10-05T00:00:00Z"),
          updatedAt: new Date("2026-10-05T00:00:00Z"),
          customer: null,
          partner: { name: "Partner Hiro", email: "hiro@example.com" },
          programEnrollment: { tenantId: "tenant_1" },
        },
      ] as any;

      const formatted = formatCommissionsForExport(rawCommissionExportItem, [
        "amount",
        "earnings",
      ]);
      expect(formatted).toHaveLength(1);
      const row = formatted[0];
      // Column 'amount' and 'earnings' were processed without crash and converted from BigInt
      expect(row).toBeDefined();
      expect(typeof row.amount).toBe("string");
      expect(typeof row.earnings).toBe("string");
    });
  });
});
