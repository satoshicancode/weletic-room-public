import { processRefundPointsReversal } from "@/lib/weletic/loyalty/earn";
import { shopifyCustomerSettlementLockKeys } from "@/lib/weletic/shopify/customer-settlement-lock";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// MOCK DEPENDENCIES
// =============================================================================

vi.mock("server-only", () => ({}));

vi.mock("@vercel/functions", () => ({
  waitUntil: (fn: any) => Promise.resolve(fn),
}));

vi.mock("@dub/utils", async () => {
  const actual =
    await vi.importActual<typeof import("@dub/utils")>("@dub/utils");
  return {
    ...actual,
    log: vi.fn().mockResolvedValue(undefined),
    APP_DOMAIN_WITH_NGROK: "https://yamax.ngrok.io",
  };
});

vi.mock("@/lib/api/environment", () => ({
  isLocalDev: false,
}));

vi.mock("@/lib/upstash", () => ({
  redis: {
    set: vi.fn().mockResolvedValue("OK"),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock("@/lib/api/partners/sync-total-commissions", () => ({
  syncTotalCommissions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/loyalty/earn", () => ({
  processOrderPointsEarn: vi.fn().mockResolvedValue(null),
  processRefundPointsReversal: vi.fn().mockResolvedValue(null),
}));

const referralMocks = vi.hoisted(() => ({
  reverseReferralPointsOnRefund: vi.fn().mockResolvedValue(null),
}));
const transactionHooks = vi.hoisted(() => ({
  beforeNext: null as (() => void) | null,
}));

vi.mock("@/lib/weletic/loyalty/referrals", () => referralMocks);

vi.mock("@/lib/weletic/loyalty/shopper", () => ({
  upsertWeleticShopper: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: vi.fn().mockReturnValue(false),
}));

// In-memory Database Store
const db = {
  projects: new Map<string, any>(),
  programs: new Map<string, any>(),
  weleticShopifyStores: new Map<string, any>(),
  weleticCommerceOrders: new Map<string, any>(),
  weleticCommerceOrderLines: new Map<string, any>(),
  weleticCommerceRefunds: new Map<string, any>(),
  weleticCommerceRefundLines: new Map<string, any>(),
  commissions: new Map<string, any>(),
  weleticCommissionCalculations: new Map<string, any>(),
  weleticCommissionRules: new Map<string, any>(),
  weleticFxSnapshots: new Map<string, any>(),
  loyaltyEarnGrants: new Map<string, any>(),
  loyaltyReferrals: new Map<string, any>(),
  loyaltyAccounts: new Map<string, any>(),
  reconciliationIssues: new Map<string, any>(),
  programEnrollments: new Map<string, any>(),
  rewards: new Map<string, any>(),
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
      const beforeTransaction = transactionHooks.beforeNext;
      transactionHooks.beforeNext = null;
      beforeTransaction?.();
      const tx = {
        // This financial fixture has no native review invitations.
        weleticReviewRequest: { findMany: vi.fn().mockResolvedValue([]) },
        $queryRaw: vi.fn(async (query: { values?: unknown[] }) => {
          const storeId = String(query.values?.[0] ?? "");
          const store = db.weleticShopifyStores.get(storeId);
          return store
            ? [
                {
                  id: store.id,
                  complianceState: store.complianceState ?? "active",
                },
              ]
            : [];
        }),
        weleticCommerceRefund: {
          create: vi.fn(async ({ data }: { data: any }) => {
            db.weleticCommerceRefunds.set(data.id, data);
            return data;
          }),
          aggregate: vi.fn(
            async ({ where }: { where: { orderId: string } }) => {
              let sum = BigInt(0);
              for (const ref of db.weleticCommerceRefunds.values()) {
                if (ref.orderId === where.orderId) {
                  sum += BigInt(ref.accountingAmount);
                }
              }
              return { _sum: { accountingAmount: sum } };
            },
          ),
        },
        weleticCommerceRefundLine: {
          createMany: vi.fn(async ({ data }: { data: any[] }) => {
            for (const item of data) {
              db.weleticCommerceRefundLines.set(item.id, item);
            }
            return { count: data.length };
          }),
          aggregate: vi.fn(
            async ({ where }: { where: { orderLineId: string } }) => {
              let sum = BigInt(0);
              for (const refLine of db.weleticCommerceRefundLines.values()) {
                if (refLine.orderLineId === where.orderLineId) {
                  sum += BigInt(refLine.accountingAmount);
                }
              }
              return { _sum: { accountingAmount: sum } };
            },
          ),
        },
        commission: {
          create: vi.fn(async ({ data }: { data: any }) => {
            db.commissions.set(data.id, data);
            return data;
          }),
        },
        weleticCommissionCalculation: {
          createMany: vi.fn(async ({ data }: { data: any[] }) => {
            for (const item of data) {
              db.weleticCommissionCalculations.set(item.id, item);
            }
            return { count: data.length };
          }),
          aggregate: vi.fn(async ({ where }: any) => {
            let sumEarnings = BigInt(0);
            for (const calc of db.weleticCommissionCalculations.values()) {
              if (calc.entryType === where.entryType) {
                if (where.refundLine?.orderLineId) {
                  const refLine = db.weleticCommerceRefundLines.get(
                    calc.refundLineId,
                  );
                  if (
                    refLine &&
                    refLine.orderLineId === where.refundLine.orderLineId
                  ) {
                    sumEarnings += BigInt(calc.earnings);
                  }
                }
              }
            }
            return { _sum: { earnings: sumEarnings } };
          }),
        },
        weleticCommerceOrder: {
          update: vi.fn(
            async ({ where, data }: { where: { id: string }; data: any }) => {
              const order = db.weleticCommerceOrders.get(where.id);
              if (!order) throw new Error("Order not found");
              const updated = { ...order, ...data };
              db.weleticCommerceOrders.set(where.id, updated);
              return updated;
            },
          ),
        },
        weleticLoyaltyReferral: {
          findFirst: vi.fn(
            async ({ where }: any) =>
              Array.from(db.loyaltyReferrals.values()).find(
                (referral) =>
                  referral.storeId === where.storeId &&
                  referral.qualifyingOrderId === where.qualifyingOrderId &&
                  (!where.status?.in ||
                    where.status.in.includes(referral.status)),
              ) || null,
          ),
        },
        weleticLoyaltyEarnGrant: {
          findUnique: vi.fn(async ({ where }: any) => {
            const key = where.storeId_orderId;
            return (
              Array.from(db.loyaltyEarnGrants.values()).find(
                (grant) =>
                  grant.storeId === key.storeId &&
                  grant.orderId === key.orderId,
              ) || null
            );
          }),
        },
        weleticReconciliationIssue: {
          upsert: vi.fn(async ({ where, create, update }: any) => {
            const key = where.storeId_kind_externalKey;
            const mapKey = `${key.storeId}:${key.kind}:${key.externalKey}`;
            const current = db.reconciliationIssues.get(mapKey);
            const saved = current
              ? { ...current, ...update }
              : { ...create, detectedAt: new Date() };
            db.reconciliationIssues.set(mapKey, saved);
            return saved;
          }),
        },
      };
      return callback(tx);
    }),
    weleticShopifyStore: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.shopDomain) {
          for (const s of db.weleticShopifyStores.values()) {
            if (s.shopDomain === where.shopDomain) return s;
          }
        }
        if (where.id) return db.weleticShopifyStores.get(where.id) || null;
        return null;
      }),
    },
    weleticCommerceRefund: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.storeId_externalId) {
          for (const r of db.weleticCommerceRefunds.values()) {
            if (
              r.storeId === where.storeId_externalId.storeId &&
              r.externalId === where.storeId_externalId.externalId
            ) {
              const order = db.weleticCommerceOrders.get(r.orderId);
              const lines = Array.from(
                db.weleticCommerceRefundLines.values(),
              ).filter((line) => line.refundId === r.id);
              return { ...r, order, lines };
            }
          }
        }
        return null;
      }),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.storeId_externalId) {
          for (const o of db.weleticCommerceOrders.values()) {
            if (
              o.storeId === where.storeId_externalId.storeId &&
              o.externalId === where.storeId_externalId.externalId
            ) {
              const lines = Array.from(db.weleticCommerceOrderLines.values())
                .filter((l) => l.orderId === o.id)
                .map((line) => {
                  const calcs = Array.from(
                    db.weleticCommissionCalculations.values(),
                  ).filter(
                    (c) => c.orderLineId === line.id && c.entryType === "sale",
                  );
                  return { ...line, calculations: calcs };
                });
              return { ...o, lines };
            }
          }
        }
        return null;
      }),
    },
    weleticLoyaltyReferral: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          Array.from(db.loyaltyReferrals.values()).find(
            (referral) =>
              referral.storeId === where.storeId &&
              referral.qualifyingOrderId === where.qualifyingOrderId &&
              (!where.status?.in || where.status.in.includes(referral.status)),
          ) || null,
      ),
    },
    weleticLoyaltyAccount: {
      findMany: vi.fn(async ({ where }: any) =>
        Array.from(db.loyaltyAccounts.values()).filter(
          (account) => account.storeId === where.storeId,
        ),
      ),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return db.loyaltyAccounts.get(where.id) || null;
        if (where.shopperId) {
          return (
            Array.from(db.loyaltyAccounts.values()).find(
              (account) => account.shopperId === where.shopperId,
            ) || null
          );
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const account = db.loyaltyAccounts.get(where.id);
        return account?.storeId === where.storeId ? account : null;
      }),
    },
    weleticLoyaltyEarnGrant: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.storeId_orderId;
        return (
          Array.from(db.loyaltyEarnGrants.values()).find(
            (grant) =>
              grant.storeId === key.storeId && grant.orderId === key.orderId,
          ) || null
        );
      }),
    },
    weleticReconciliationIssue: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.storeId_kind_externalKey;
        const mapKey = `${key.storeId}:${key.kind}:${key.externalKey}`;
        const current = db.reconciliationIssues.get(mapKey);
        const saved = current
          ? { ...current, ...update }
          : { ...create, detectedAt: new Date() };
        db.reconciliationIssues.set(mapKey, saved);
        return saved;
      }),
    },
    weleticFxRateSnapshot: {
      create: vi.fn(async ({ data }: { data: any }) => {
        db.weleticFxSnapshots.set(data.id, data);
        return data;
      }),
    },
  },
}));

// Import logic under test
import {
  calculateRefundReversal,
  recordWeleticRefund,
} from "@/lib/weletic/commerce/record-refund";
import { allocateCommissionProportionally } from "@/lib/weletic/commissions/rules";

// =============================================================================
// TEST SUITE: ADR 0004 PROPORTIONAL REFUND & SETTLEMENT ENGINE
// =============================================================================

describe("Challenger 2: Financial Settlement & ADR 0004 Proportional Refund Clawback Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionHooks.beforeNext = null;
    db.projects.clear();
    db.programs.clear();
    db.weleticShopifyStores.clear();
    db.weleticCommerceOrders.clear();
    db.weleticCommerceOrderLines.clear();
    db.weleticCommerceRefunds.clear();
    db.weleticCommerceRefundLines.clear();
    db.commissions.clear();
    db.weleticCommissionCalculations.clear();
    db.weleticCommissionRules.clear();
    db.weleticFxSnapshots.clear();
    db.loyaltyEarnGrants.clear();
    db.loyaltyReferrals.clear();
    db.loyaltyAccounts.clear();
    db.reconciliationIssues.clear();
    db.programEnrollments.clear();
    db.rewards.clear();
  });

  // ===========================================================================
  // 1. ADR 0004 PROPORTIONAL REVERSAL CALCULATIONS ACROSS COMPLEX MULTI-ITEM BASKETS
  // ===========================================================================
  describe("1. ADR 0004 Proportional Reversal Across Complex Multi-Item Baskets with Fractional Pennies", () => {
    it("1.1: 7-item basket with fractional penny prices ($19.99, $33.33, $0.01, etc.) allocates exact order bonus without penny drift", () => {
      const items = [
        BigInt(1999), // $19.99
        BigInt(3333), // $33.33
        BigInt(1), // $0.01
        BigInt(9999), // $99.99
        BigInt(4550), // $45.50
        BigInt(1275), // $12.75
        BigInt(8843), // $88.43
      ];
      const totalAmount = items.reduce((a, b) => a + b, BigInt(0)); // 30,000 cents ($300.00)
      const fixedBonus = BigInt(5000); // $50.00 bonus

      const allocations = allocateCommissionProportionally({
        total: fixedBonus,
        amounts: items,
      });

      expect(allocations).toHaveLength(7);
      const sumAllocations = allocations.reduce((a, b) => a + b, BigInt(0));
      expect(sumAllocations).toBe(fixedBonus); // Exact 5000 cents

      // Verify each line's proportional reversal on partial item refund
      let totalReversedAcrossBasket = BigInt(0);
      for (let i = 0; i < items.length; i++) {
        const itemPrice = items[i];
        const itemBonus = allocations[i];

        // Refund 50% of the item price
        const refundItemPrice = itemPrice / BigInt(2);
        const itemReversal = calculateRefundReversal({
          originalEarnings: itemBonus,
          originalCommissionableAmount: itemPrice,
          refundedAmount: refundItemPrice,
          alreadyReversed: BigInt(0),
        });

        totalReversedAcrossBasket += itemReversal;
        expect(itemReversal).toBeLessThanOrEqual(itemBonus);
        expect(itemBonus - itemReversal).toBeGreaterThanOrEqual(BigInt(0));
      }

      expect(totalReversedAcrossBasket).toBeLessThanOrEqual(fixedBonus);
    });

    it("1.2: Uneven 3-way split ($33.33, $33.33, $33.34) preserves exact half-up integer rounding", () => {
      const line1 = BigInt(3333);
      const line2 = BigInt(3333);
      const line3 = BigInt(3334);
      const total = line1 + line2 + line3; // 10000 cents ($100.00)
      const commission = BigInt(1500); // 15% = 1500 cents

      const allocations = allocateCommissionProportionally({
        total: commission,
        amounts: [line1, line2, line3],
      });

      expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(commission);

      // Refund line 1 ($33.33) in full
      const rev1 = calculateRefundReversal({
        originalEarnings: allocations[0],
        originalCommissionableAmount: line1,
        refundedAmount: line1,
        alreadyReversed: BigInt(0),
      });

      expect(rev1).toBe(allocations[0]);
    });
  });

  // ===========================================================================
  // 2. MULTI-STAGE PARTIAL REFUND CASCADES
  // ===========================================================================
  describe("2. Multi-Stage Partial Refund Cascades (10%, 25%, 33.33%, Remaining)", () => {
    it("2.1: 4-stage cascade (10% -> 25% -> 33.33% -> Remaining 31.67%) on a $240.00 line ($36.00 commission)", () => {
      const originalAmount = BigInt(24000); // $240.00 (24,000 cents)
      const originalEarnings = BigInt(3600); // 15% commission = $36.00 (3,600 cents)

      // Stage 1: 10% refund ($24.00)
      const refund1 = BigInt(2400);
      const rev1 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: refund1,
        alreadyReversed: BigInt(0),
      });
      expect(rev1).toBe(BigInt(360)); // Exactly $3.60

      // Stage 2: 25% refund ($60.00)
      const refund2 = BigInt(6000);
      const rev2 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: refund2,
        alreadyReversed: rev1,
      });
      expect(rev2).toBe(BigInt(900)); // Exactly $9.00

      // Stage 3: 33.33% refund ($79.99)
      const refund3 = BigInt(7999);
      const rev3 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: refund3,
        alreadyReversed: rev1 + rev2,
      });
      // 3600 * 7999 / 24000 = 1199.85 -> rounds to 1200 cents ($12.00)
      expect(rev3).toBe(BigInt(1200));

      // Stage 4: Remaining 31.67% refund ($76.01) [24000 - 2400 - 6000 - 7999 = 7601]
      const refund4 = originalAmount - refund1 - refund2 - refund3;
      expect(refund4).toBe(BigInt(7601));
      const rev4 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: refund4,
        alreadyReversed: rev1 + rev2 + rev3,
      });

      const totalReversed = rev1 + rev2 + rev3 + rev4;
      expect(totalReversed).toBe(originalEarnings); // Exact conservation (3,600 cents)
      expect(rev4).toBe(originalEarnings - (rev1 + rev2 + rev3)); // Remaining headroom 1140 cents
    });

    it("2.2: 7-stage prime partition refund in zero-decimal JPY (¥50,000 line @ 12% commission = ¥6,000)", () => {
      const originalAmount = BigInt(50000);
      const originalEarnings = BigInt(6000);

      // Partitions: 7,123 + 5,879 + 11,411 + 6,999 + 8,456 + 4,132 + 6,000 = 50,000
      const chunks = [
        BigInt(7123),
        BigInt(5879),
        BigInt(11411),
        BigInt(6999),
        BigInt(8456),
        BigInt(4132),
        BigInt(6000),
      ];
      expect(chunks.reduce((a, b) => a + b, BigInt(0))).toBe(originalAmount);

      let runningReversed = BigInt(0);
      const reversals: bigint[] = [];

      for (const chunk of chunks) {
        const rev = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: chunk,
          alreadyReversed: runningReversed,
        });
        runningReversed += rev;
        reversals.push(rev);
      }

      expect(runningReversed).toBeLessThanOrEqual(originalEarnings);
      expect(runningReversed).toBeGreaterThanOrEqual(
        originalEarnings - BigInt(1),
      );
      expect(reversals.reduce((a, b) => a + b, BigInt(0))).toBe(
        runningReversed,
      );
    });

    it("2.3: Over-100% cascade attempt (50% + 40% + 30% = 120%) clamps Stage 3 to remaining 10%", () => {
      const originalAmount = BigInt(10000);
      const originalEarnings = BigInt(2000);

      const rev1 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(5000),
        alreadyReversed: BigInt(0),
      });
      expect(rev1).toBe(BigInt(1000));

      const rev2 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(4000),
        alreadyReversed: rev1,
      });
      expect(rev2).toBe(BigInt(800));

      // Attempting 30% refund ($30.00) with only $2.00 (200 cents) remaining headroom
      const rev3 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(3000),
        alreadyReversed: rev1 + rev2,
      });
      expect(rev3).toBe(BigInt(200)); // Strictly clamped to 200 cents

      expect(rev1 + rev2 + rev3).toBe(originalEarnings);

      // Subsequent 4th attempt returns 0
      const rev4 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(1000),
        alreadyReversed: rev1 + rev2 + rev3,
      });
      expect(rev4).toBe(BigInt(0));
    });
  });

  // ===========================================================================
  // 3. INVARIANT BOUNDS ENFORCEMENT
  // ===========================================================================
  describe("3. Invariant Bounds Enforcement (`reversal <= originalEarnings`, `netEarnings >= 0`, `sum(reversals) === totalReversed`)", () => {
    it("3.1: Property-Based Fuzzing 3,000 random cascades: verifies all 4 invariants concurrently", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: BigInt(100), max: BigInt(1_000_000) }),
          fc.integer({ min: 100, max: 5000 }), // 1% to 50% commission
          fc.array(fc.bigInt({ min: BigInt(1), max: BigInt(200_000) }), {
            minLength: 1,
            maxLength: 8,
          }),
          (amount, rateBps, refundSteps) => {
            const originalEarnings = (amount * BigInt(rateBps)) / BigInt(10000);
            if (originalEarnings === BigInt(0)) return;

            let alreadyReversed = BigInt(0);
            const reversals: bigint[] = [];

            for (const step of refundSteps) {
              const reversal = calculateRefundReversal({
                originalEarnings,
                originalCommissionableAmount: amount,
                refundedAmount: step,
                alreadyReversed,
              });

              // INVARIANT 1: Reversal is non-negative
              expect(reversal).toBeGreaterThanOrEqual(BigInt(0));

              alreadyReversed += reversal;

              // INVARIANT 2: Reversal <= originalEarnings at every step
              expect(alreadyReversed).toBeLessThanOrEqual(originalEarnings);

              // INVARIANT 3: Net earnings >= 0
              const netEarnings = originalEarnings - alreadyReversed;
              expect(netEarnings).toBeGreaterThanOrEqual(BigInt(0));

              reversals.push(reversal);
            }

            // INVARIANT 4: Sum of step reversals === total alreadyReversed
            const sumOfReversals = reversals.reduce((a, b) => a + b, BigInt(0));
            expect(sumOfReversals).toBe(alreadyReversed);
          },
        ),
        { numRuns: 3000 },
      );
    });

    it("3.2: Handles negative and invalid inputs cleanly without corruption", () => {
      // Negative refundedAmount
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(1000),
          originalCommissionableAmount: BigInt(5000),
          refundedAmount: BigInt(-2000),
          alreadyReversed: BigInt(0),
        }),
      ).toBe(BigInt(0));

      // Negative alreadyReversed
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(1000),
          originalCommissionableAmount: BigInt(5000),
          refundedAmount: BigInt(2500),
          alreadyReversed: BigInt(-500),
        }),
      ).toBe(BigInt(500)); // 50% of 1000 = 500

      // Zero original amount
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(1000),
          originalCommissionableAmount: BigInt(0),
          refundedAmount: BigInt(2500),
          alreadyReversed: BigInt(0),
        }),
      ).toBe(BigInt(0));
    });
  });

  // ===========================================================================
  // 4. SIMULATED WEBHOOK PAYLOADS DISPATCHING TO `recordRefund`
  // ===========================================================================
  describe("4. Simulated Webhook Payloads from simulate-shopify-webhook.ts Dispatching to recordWeleticRefund", () => {
    it("4.1: simulates orders/paid payload ingestion followed by 2-stage partial refund webhook dispatch", async () => {
      const shopDomain = "yamaxdev.myshopify.com";
      const storeId = "wstore_yamax_sim";
      const orderExternalId = "589283748234";
      const orderId = "worder_sim_101";
      const orderLineId1 = "wline_sim_1";
      const orderLineId2 = "wline_sim_2";

      // Seed Store
      db.weleticShopifyStores.set(storeId, {
        id: storeId,
        shopDomain,
        shopCurrency: "USD",
        programId: "prog_yamax",
      });

      // Seed Order (2 lines: Line 1 = $80.00 with $16.00 comm, Line 2 = $40.00 with $4.00 comm)
      db.weleticCommerceOrders.set(orderId, {
        id: orderId,
        storeId,
        externalId: orderExternalId,
        orderName: "#1042",
        status: "paid",
        shopCurrency: "USD",
        accountingCurrency: "USD",
        accountingNet: BigInt(12000),
        accountingFxRate: "1.0",
        partnerId: "partner_hiro",
        programId: "prog_yamax",
        linkId: "link_hiro",
        occurredAt: new Date("2026-08-20T12:00:00Z"),
      });

      db.weleticCommerceOrderLines.set(orderLineId1, {
        id: orderLineId1,
        orderId,
        externalId: "987654321",
        quantity: 1,
        shopGross: BigInt(8000),
        accountingNet: BigInt(8000),
        commissionableAccountingAmount: BigInt(8000),
      });

      db.weleticCommerceOrderLines.set(orderLineId2, {
        id: orderLineId2,
        orderId,
        externalId: "987654322",
        quantity: 1,
        shopGross: BigInt(4000),
        accountingNet: BigInt(4000),
        commissionableAccountingAmount: BigInt(4000),
      });

      // Seed Sale Calculations
      db.weleticCommissionCalculations.set("wcalc_sale_1", {
        id: "wcalc_sale_1",
        entryType: "sale",
        orderLineId: orderLineId1,
        ruleId: "wrule_leggings_20",
        commissionId: "cm_order_sale",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(8000),
        earnings: BigInt(1600), // $16.00
      });

      db.weleticCommissionCalculations.set("wcalc_sale_2", {
        id: "wcalc_sale_2",
        entryType: "sale",
        orderLineId: orderLineId2,
        ruleId: "wrule_tank_10",
        commissionId: "cm_order_sale",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(4000),
        earnings: BigInt(400), // $4.00
      });

      // DISPATCH SIMULATED REFUND 1: 50% refund on Line 1 ($40.00)
      const refundEvent1 = {
        id: 883746281,
        order_id: Number(orderExternalId),
        created_at: "2026-08-20T14:00:00Z",
        refund_line_items: [
          {
            id: 77263541,
            line_item_id: 987654321,
            quantity: 1,
            subtotal_set: {
              shop_money: { amount: "40.00", currency_code: "USD" },
              presentment_money: { amount: "40.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result1 = await recordWeleticRefund({
        event: refundEvent1,
        shopDomain,
      });

      expect(result1.duplicate).toBe(false);
      expect(result1.ignored).toBe(false);
      expect(result1.refundId).toBeDefined();

      // Verify Reversal Commission Record
      const refundCommissions = Array.from(db.commissions.values());
      expect(refundCommissions).toHaveLength(1);
      const refundComm1 = refundCommissions[0];
      expect(refundComm1.earnings).toBe(-800); // -$8.00 (50% of $16.00)
      expect(refundComm1.partnerId).toBe("partner_hiro");
      expect(refundComm1.status).toBe("pending");

      // Verify Order Status updated to "partially_refunded"
      expect(db.weleticCommerceOrders.get(orderId).status).toBe(
        "partially_refunded",
      );
      expect(
        referralMocks.reverseReferralPointsOnRefund,
      ).not.toHaveBeenCalled();

      // DISPATCH SIMULATED REFUND 2: Remaining 50% on Line 1 ($40.00) + 100% on Line 2 ($40.00)
      const refundEvent2 = {
        id: 883746282,
        order_id: Number(orderExternalId),
        created_at: "2026-08-20T15:00:00Z",
        refund_line_items: [
          {
            id: 77263542,
            line_item_id: 987654321,
            quantity: 1,
            subtotal_set: {
              shop_money: { amount: "40.00", currency_code: "USD" },
              presentment_money: { amount: "40.00", currency_code: "USD" },
            },
          },
          {
            id: 77263543,
            line_item_id: 987654322,
            quantity: 1,
            subtotal_set: {
              shop_money: { amount: "40.00", currency_code: "USD" },
              presentment_money: { amount: "40.00", currency_code: "USD" },
            },
          },
        ],
      };

      const result2 = await recordWeleticRefund({
        event: refundEvent2,
        shopDomain,
      });

      expect(result2.duplicate).toBe(false);
      expect(result2.ignored).toBe(false);

      const allCommissions = Array.from(db.commissions.values());
      expect(allCommissions).toHaveLength(2);
      const refundComm2 = allCommissions[1];
      // Remaining $8.00 from Line 1 + full $4.00 from Line 2 = -$12.00 (-1200 cents)
      expect(refundComm2.earnings).toBe(-1200);

      // Verify total net commission across entire order: $20.00 original - $8.00 - $12.00 = $0.00
      const totalCommissionNet =
        BigInt(1600 + 400) +
        BigInt(refundComm1.earnings) +
        BigInt(refundComm2.earnings);
      expect(totalCommissionNet).toBe(BigInt(0));

      // Verify Order Status updated to "refunded" (100% refunded)
      expect(db.weleticCommerceOrders.get(orderId).status).toBe("refunded");
      expect(
        referralMocks.reverseReferralPointsOnRefund,
      ).toHaveBeenCalledOnce();
      expect(referralMocks.reverseReferralPointsOnRefund).toHaveBeenCalledWith({
        storeId,
        orderId,
        refundId: result2.refundId,
        privacyMinimized: false,
      });
    });

    it("4.2: idempotent deduplication when duplicate simulated refund webhook is dispatched", async () => {
      const shopDomain = "yamaxdev.myshopify.com";
      const storeId = "wstore_yamax_sim";
      const orderId = "worder_sim_101";

      db.weleticShopifyStores.set(storeId, {
        id: storeId,
        shopDomain,
        shopCurrency: "USD",
      });

      db.weleticCommerceRefunds.set("wrefund_existing_1", {
        id: "wrefund_existing_1",
        storeId,
        externalId: "883746281",
        orderId,
        accountingAmount: BigInt(4000),
      });

      db.weleticCommerceOrders.set(orderId, {
        id: orderId,
        partnerId: "partner_hiro",
        programId: "prog_yamax",
      });

      const refundEvent = {
        id: 883746281,
        order_id: 589283748234,
        created_at: "2026-08-20T14:00:00Z",
        refund_line_items: [],
      };

      const result = await recordWeleticRefund({
        event: refundEvent,
        shopDomain,
      });

      expect(result.duplicate).toBe(true);
      expect(result.ignored).toBe(false);
      expect(result.refundId).toBe("wrefund_existing_1");
      expect(
        referralMocks.reverseReferralPointsOnRefund,
      ).not.toHaveBeenCalled();
      expect(processRefundPointsReversal).not.toHaveBeenCalled();
    });

    it("4.3: opens a critical reconciliation issue instead of guessing loyalty clawback for a refund without merchandise lines", async () => {
      const shopDomain = "yamaxdev.myshopify.com";
      const storeId = "wstore_yamax_no_lines";
      const orderId = "worder_no_lines";
      const orderExternalId = "589283748299";

      db.weleticShopifyStores.set(storeId, {
        id: storeId,
        shopDomain,
        shopCurrency: "USD",
        programId: "prog_yamax",
      });
      db.weleticCommerceOrders.set(orderId, {
        id: orderId,
        storeId,
        externalId: orderExternalId,
        orderName: "#1099",
        status: "paid",
        presentmentCurrency: "USD",
        shopCurrency: "USD",
        accountingCurrency: "USD",
        accountingNet: BigInt(10_000),
        accountingFxRate: "1.0",
        partnerId: null,
        programId: "prog_yamax",
        linkId: null,
        shopperId: null,
        occurredAt: new Date("2026-08-20T12:00:00Z"),
      });
      db.loyaltyEarnGrants.set("grant_no_lines", {
        id: "grant_no_lines",
        storeId,
        orderId,
        grossPoints: BigInt(100),
        reversedPoints: BigInt(25),
      });
      db.loyaltyReferrals.set("referral_no_lines", {
        id: "referral_no_lines",
        storeId,
        qualifyingOrderId: orderId,
        status: "rewarded",
      });

      const result = await recordWeleticRefund({
        event: {
          id: 883746299,
          order_id: Number(orderExternalId),
          created_at: "2026-08-20T16:00:00Z",
          refund_line_items: [],
          transactions: [
            { amount: "125.00", currency: "USD", status: "success" },
          ],
        },
        shopDomain,
      });

      expect(result.duplicate).toBe(false);
      expect(result.loyaltyLedgerEntryId).toBeNull();
      expect(db.reconciliationIssues.size).toBe(1);
      const issue = Array.from(db.reconciliationIssues.values())[0];
      expect(issue).toMatchObject({
        storeId,
        externalKey: "883746299",
        kind: "loyalty_refund_merchandise_amount_unresolved",
        severity: "critical",
        status: "open",
        details: expect.objectContaining({
          orderId,
          earnGrantId: "grant_no_lines",
          remainingEarnedPoints: "75",
          referralId: "referral_no_lines",
          referralStatus: "rewarded",
        }),
      });
      expect(
        referralMocks.reverseReferralPointsOnRefund,
      ).not.toHaveBeenCalled();
      expect(processRefundPointsReversal).not.toHaveBeenCalled();
      expect(db.weleticCommerceRefunds.size).toBe(1);
      expect(Array.from(db.weleticCommerceRefunds.values())[0].shopAmount).toBe(
        BigInt(0),
      );
    });

    it("4.4: keeps an enriched retry in reconciliation when its merchandise lines were never persisted", async () => {
      const shopDomain = "yamaxdev.myshopify.com";
      const storeId = "wstore_yamax_enriched_retry";
      const orderId = "worder_enriched_retry";
      const orderExternalId = "589283748399";
      const refundExternalId = "883746399";

      db.weleticShopifyStores.set(storeId, {
        id: storeId,
        shopDomain,
        shopCurrency: "USD",
      });
      db.weleticCommerceOrders.set(orderId, {
        id: orderId,
        storeId,
        externalId: orderExternalId,
        partnerId: null,
        programId: "prog_yamax",
        shopperId: null,
      });
      db.weleticCommerceRefunds.set("wrefund_enriched_retry", {
        id: "wrefund_enriched_retry",
        storeId,
        externalId: refundExternalId,
        orderId,
        accountingAmount: BigInt(0),
      });
      db.loyaltyReferrals.set("referral_enriched_retry", {
        id: "referral_enriched_retry",
        storeId,
        qualifyingOrderId: orderId,
        status: "rewarded",
      });

      const result = await recordWeleticRefund({
        event: {
          id: Number(refundExternalId),
          order_id: Number(orderExternalId),
          created_at: "2026-08-20T17:00:00Z",
          refund_line_items: [
            {
              id: 77263999,
              line_item_id: 98765999,
              quantity: 1,
              subtotal_set: {
                shop_money: { amount: "50.00", currency_code: "USD" },
                presentment_money: {
                  amount: "50.00",
                  currency_code: "USD",
                },
              },
            },
          ],
        },
        shopDomain,
      });

      expect(result.duplicate).toBe(true);
      expect(
        referralMocks.reverseReferralPointsOnRefund,
      ).not.toHaveBeenCalled();
      expect(processRefundPointsReversal).not.toHaveBeenCalled();
      expect(db.weleticCommerceRefundLines.size).toBe(0);
      expect(Array.from(db.reconciliationIssues.values())[0]).toMatchObject({
        kind: "loyalty_refund_merchandise_amount_unresolved",
        externalKey: refundExternalId,
        details: expect.objectContaining({
          referralId: "referral_enriched_retry",
          referralStatus: "rewarded",
        }),
      });
    });

    it("4.5: serializes shopper and referral corrections with deterministic customer locks", async () => {
      const shopDomain = "lock-order.myshopify.com";
      const storeId = "wstore_lock_order";
      const orderId = "worder_lock_order";
      const orderExternalId = "589283748499";

      db.weleticShopifyStores.set(storeId, {
        id: storeId,
        projectId: storeId,
        shopDomain,
        shopCurrency: "USD",
      });
      db.weleticCommerceOrders.set(orderId, {
        id: orderId,
        storeId,
        externalId: orderExternalId,
        orderName: "#LOCK",
        status: "paid",
        presentmentCurrency: "USD",
        shopCurrency: "USD",
        accountingCurrency: "USD",
        accountingNet: BigInt(1000),
        accountingFxRate: "1.0",
        partnerId: null,
        programId: "prog_lock",
        linkId: null,
        shopperId: "shopper_lock_owner",
        occurredAt: new Date("2026-08-29T00:00:00Z"),
      });
      db.weleticCommerceOrderLines.set("line_lock", {
        id: "line_lock",
        orderId,
        externalId: "98765998",
        quantity: 1,
        shopGross: BigInt(1000),
        accountingNet: BigInt(1000),
        commissionableAccountingAmount: BigInt(1000),
      });
      db.loyaltyReferrals.set("referral_lock", {
        id: "referral_lock",
        storeId,
        qualifyingOrderId: orderId,
        status: "rewarded",
        advocateAccountId: "account_advocate_lock",
        refereeAccountId: "account_referee_lock",
      });

      for (const account of [
        {
          id: "account_owner_lock",
          shopperId: "shopper_lock_owner",
          shopifyCustomerId: "300",
        },
        {
          id: "account_advocate_lock",
          shopperId: "shopper_advocate_lock",
          shopifyCustomerId: "100",
        },
        {
          id: "account_referee_lock",
          shopperId: "shopper_referee_lock",
          shopifyCustomerId: "200",
        },
      ]) {
        db.loyaltyAccounts.set(account.id, {
          id: account.id,
          storeId,
          shopperId: account.shopperId,
          status: "closed",
          metadata: null,
          shopper: { shopifyCustomerId: account.shopifyCustomerId },
          store: { projectId: storeId },
        });
      }

      await recordWeleticRefund({
        event: {
          id: 883746499,
          order_id: Number(orderExternalId),
          created_at: "2026-08-29T01:00:00Z",
          refund_line_items: [
            {
              id: 77264999,
              line_item_id: 98765998,
              quantity: 1,
              subtotal_set: {
                shop_money: { amount: "10.00", currency_code: "USD" },
                presentment_money: {
                  amount: "10.00",
                  currency_code: "USD",
                },
              },
            },
          ],
        },
        shopDomain,
      });

      const acquiredKeys = vi
        .mocked((await import("@/lib/upstash")).redis.set)
        .mock.calls.map(([key]) => key);
      const expectedCustomerKeys = ["100", "200", "300"]
        .flatMap((shopifyCustomerId) =>
          shopifyCustomerSettlementLockKeys({
            storeId,
            workspaceId: storeId,
            shopifyCustomerId,
          }),
        )
        .sort();
      expect(acquiredKeys).toEqual([
        `weletic:shopify:order:${storeId}:${orderExternalId}`,
        ...expectedCustomerKeys,
      ]);
      expect(referralMocks.reverseReferralPointsOnRefund).toHaveBeenCalledWith({
        storeId,
        orderId,
        refundId: expect.any(String),
        privacyMinimized: false,
      });
    });

    it("4.6: rejects a refund when the store freezes after the precheck but before the financial transaction", async () => {
      const shopDomain = "freeze-race.myshopify.com";
      const storeId = "wstore_freeze_race";
      const orderId = "worder_freeze_race";
      const orderExternalId = "589283748599";

      db.weleticShopifyStores.set(storeId, {
        id: storeId,
        projectId: storeId,
        shopDomain,
        shopCurrency: "USD",
        complianceState: "active",
      });
      db.weleticCommerceOrders.set(orderId, {
        id: orderId,
        storeId,
        externalId: orderExternalId,
        orderName: "#FREEZE",
        status: "paid",
        presentmentCurrency: "USD",
        shopCurrency: "USD",
        accountingCurrency: "USD",
        accountingNet: BigInt(1000),
        accountingFxRate: "1.0",
        partnerId: null,
        programId: "prog_freeze_race",
        linkId: null,
        shopperId: null,
        occurredAt: new Date("2026-08-29T00:00:00Z"),
      });
      db.weleticCommerceOrderLines.set("line_freeze_race", {
        id: "line_freeze_race",
        orderId,
        externalId: "98765997",
        quantity: 1,
        shopGross: BigInt(1000),
        accountingNet: BigInt(1000),
        commissionableAccountingAmount: BigInt(1000),
      });

      transactionHooks.beforeNext = () => {
        db.weleticShopifyStores.set(storeId, {
          ...db.weleticShopifyStores.get(storeId),
          complianceState: "frozen",
        });
      };

      await expect(
        recordWeleticRefund({
          event: {
            id: 883746599,
            order_id: Number(orderExternalId),
            created_at: "2026-08-29T01:00:00Z",
            refund_line_items: [
              {
                id: 77265997,
                line_item_id: 98765997,
                quantity: 1,
                subtotal_set: {
                  shop_money: { amount: "10.00", currency_code: "USD" },
                  presentment_money: {
                    amount: "10.00",
                    currency_code: "USD",
                  },
                },
              },
            ],
          },
          shopDomain,
        }),
      ).rejects.toMatchObject({
        name: "ShopifyStoreOperationalWritesBlockedError",
        storeId,
        complianceState: "frozen",
      });

      expect(db.weleticCommerceRefunds.size).toBe(0);
      expect(db.weleticCommerceRefundLines.size).toBe(0);
      expect(db.commissions.size).toBe(0);
      expect(db.weleticCommerceOrders.get(orderId)?.status).toBe("paid");
    });
  });
});
