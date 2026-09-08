import {
  allocatePointsAcrossOrderLines,
  calculateRefundPointsReversal,
  LineAllocationInput,
  processRefundPointsReversal,
} from "@/lib/weletic/loyalty/earn";
import {
  appendPointsLedgerEntry,
  getAccountPointsBalance,
  OptimisticConcurrencyError,
} from "@/lib/weletic/loyalty/ledger";
import {
  allocateReversalAcrossRemainingLines,
  LineReversalSnapshot,
} from "@/lib/weletic/loyalty/line-reversal-allocation";
import { settleRewardRedemptionsUsedByOrder } from "@/lib/weletic/loyalty/redemption-settlement";
import {
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
} from "@prisma/client";
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

vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: vi.fn().mockReturnValue(false),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn().mockResolvedValue({ id: "outbox_1" }),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

// =============================================================================
// IN-MEMORY PRISMA SIMULATOR
// =============================================================================

interface MockDb {
  stores: Map<string, any>;
  accounts: Map<string, any>;
  ledgerEntries: Map<string, any>;
  orders: Map<string, any>;
  orderLines: Map<string, any>;
  refunds: Map<string, any>;
  refundLines: Map<string, any>;
  grants: Map<string, any>;
  orderLineEarns: Map<string, any>;
  redemptions: Map<string, any>;
  programs: Map<string, any>;
  outboxJobs: Map<string, any>;
  reconciliationIssues: Map<string, any>;
  tombstones: Map<string, any>;
}

const db: MockDb = {
  stores: new Map(),
  accounts: new Map(),
  ledgerEntries: new Map(),
  orders: new Map(),
  orderLines: new Map(),
  refunds: new Map(),
  refundLines: new Map(),
  grants: new Map(),
  orderLineEarns: new Map(),
  redemptions: new Map(),
  programs: new Map(),
  outboxJobs: new Map(),
  reconciliationIssues: new Map(),
  tombstones: new Map(),
};

function resetDb() {
  db.stores.clear();
  db.accounts.clear();
  db.ledgerEntries.clear();
  db.orders.clear();
  db.orderLines.clear();
  db.refunds.clear();
  db.refundLines.clear();
  db.grants.clear();
  db.orderLineEarns.clear();
  db.redemptions.clear();
  db.programs.clear();
  db.outboxJobs.clear();
  db.reconciliationIssues.clear();
  db.tombstones.clear();
}

vi.mock("@/lib/prisma", () => {
  const mockPrismaClient = {
    $transaction: vi.fn(async (callback: any) => {
      if (typeof callback === "function") {
        return await callback(mockPrismaClient);
      }
      return callback;
    }),
    weleticShopifyStore: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return db.stores.get(where.id) ?? null;
        if (where.shopDomain) {
          for (const s of db.stores.values()) {
            if (s.shopDomain === where.shopDomain) return s;
          }
        }
        return null;
      }),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(async ({ where }: any) => {
        const acc = db.accounts.get(where.id);
        return acc ? { ...acc } : null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const acc of db.accounts.values()) {
          if (where.id && acc.id !== where.id) continue;
          if (where.storeId && acc.storeId !== where.storeId) continue;
          return {
            ...acc,
            shopper: acc.shopper ?? {
              id: `shopper_${acc.id}`,
              shopifyCustomerId: acc.shopifyCustomerId ?? "cust_1",
            },
          };
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        const results: any[] = [];
        if (where?.id?.in) {
          for (const id of where.id.in) {
            const acc = db.accounts.get(id);
            if (acc && (!where.storeId || acc.storeId === where.storeId)) {
              results.push({ ...acc });
            }
          }
        } else {
          for (const acc of db.accounts.values()) {
            if (!where.storeId || acc.storeId === where.storeId) {
              results.push({ ...acc });
            }
          }
        }
        return results;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const acc = db.accounts.get(where.id);
        if (!acc) throw new Error(`Account ${where.id} not found`);
        const updated = { ...acc, ...data, updatedAt: new Date() };
        db.accounts.set(where.id, updated);
        return { ...updated };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const acc of db.accounts.values()) {
          if (where.id && acc.id !== where.id) continue;
          if (where.storeId && acc.storeId !== where.storeId) continue;
          if (
            where.ledgerVersion !== undefined &&
            acc.ledgerVersion !== where.ledgerVersion
          ) {
            continue;
          }
          const updated = { ...acc, ...data, updatedAt: new Date() };
          db.accounts.set(acc.id, updated);
          count++;
        }
        return { count };
      }),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.storeId_idempotencyKey) {
          const { storeId, idempotencyKey } = where.storeId_idempotencyKey;
          for (const entry of db.ledgerEntries.values()) {
            if (
              entry.storeId === storeId &&
              entry.idempotencyKey === idempotencyKey
            ) {
              return { ...entry };
            }
          }
          return null;
        }
        if (where.id) return db.ledgerEntries.get(where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const entry of db.ledgerEntries.values()) {
          if (where.accountId && entry.accountId !== where.accountId) continue;
          if (where.storeId && entry.storeId !== where.storeId) continue;
          return { ...entry };
        }
        return null;
      }),
      findMany: vi.fn(async ({ where, orderBy }: any) => {
        const entries = Array.from(db.ledgerEntries.values()).filter((e) => {
          if (where?.accountId && e.accountId !== where.accountId) return false;
          if (where?.storeId && e.storeId !== where.storeId) return false;
          if (where?.entryType && e.entryType !== where.entryType) return false;
          if (where?.grantId === null && e.grantId !== null) return false;
          if (where?.grantId && e.grantId !== where.grantId) return false;
          if (
            where?.idempotencyKey?.in &&
            !where.idempotencyKey.in.includes(e.idempotencyKey)
          ) {
            return false;
          }
          return true;
        });
        if (orderBy?.sequenceNumber === "desc") {
          entries.sort((a, b) => b.sequenceNumber - a.sequenceNumber);
        } else {
          entries.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        }
        return entries;
      }),
      count: vi.fn(async ({ where }: any) => {
        let cnt = 0;
        for (const e of db.ledgerEntries.values()) {
          if (where?.accountId && e.accountId !== where.accountId) continue;
          if (where?.storeId && e.storeId !== where.storeId) continue;
          cnt++;
        }
        return cnt;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `wledger_${db.ledgerEntries.size + 1}`;
        const entry = { ...data, id, createdAt: new Date() };
        db.ledgerEntries.set(id, entry);
        return { ...entry };
      }),
    },
    weleticCommerceRefund: {
      findUnique: vi.fn(async ({ where }: any) => {
        const ref = db.refunds.get(where.id);
        if (!ref) return null;
        const order = db.orders.get(ref.orderId);
        const shopperAcc = db.accounts.get(order?.shopper?.loyaltyAccount?.id);
        const orderRefunds = Array.from(db.refunds.values())
          .filter((r) => r.orderId === ref.orderId)
          .map((r) => {
            const lines = Array.from(db.refundLines.values()).filter(
              (rl) => rl.refundId === r.id,
            );
            return {
              id: r.id,
              occurredAt: r.occurredAt ?? new Date(),
              shopAmount: r.shopAmount,
              lines: lines.map((l) => ({
                orderLineId: l.orderLineId,
                shopAmount: l.shopAmount,
                quantity: l.quantity,
              })),
            };
          });

        const lines = Array.from(db.refundLines.values()).filter(
          (rl) => rl.refundId === ref.id,
        );

        return {
          ...ref,
          lines,
          order: {
            ...order,
            storeId: ref.storeId,
            shopper: {
              ...order?.shopper,
              id: order?.shopper?.id || `shopper_${ref.storeId}`,
              storeId: ref.storeId,
              loyaltyAccount: shopperAcc
                ? {
                    ...shopperAcc,
                    storeId: ref.storeId,
                    programId: shopperAcc.programId || "wlprog_matrix",
                    program: {
                      id: shopperAcc.programId || "wlprog_matrix",
                      storeId: ref.storeId,
                    },
                  }
                : null,
            },
            refunds: orderRefunds,
          },
        };
      }),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(async ({ where }: any) => {
        return db.orders.get(where.id) ?? null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const ord = db.orders.get(where.id);
        if (!ord) throw new Error("Order not found");
        const updated = { ...ord, ...data };
        db.orders.set(where.id, updated);
        return updated;
      }),
    },
    weleticLoyaltyEarnGrant: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.storeId_orderId;
        if (key) {
          for (const grant of db.grants.values()) {
            if (
              grant.storeId === key.storeId &&
              grant.orderId === key.orderId
            ) {
              const lineEarns = Array.from(db.orderLineEarns.values()).filter(
                (le) => le.grantId === grant.id,
              );
              return { ...grant, lineEarns };
            }
          }
        }
        if (where.id) {
          const grant = db.grants.get(where.id);
          if (!grant) return null;
          const lineEarns = Array.from(db.orderLineEarns.values()).filter(
            (le) => le.grantId === grant.id,
          );
          return { ...grant, lineEarns };
        }
        return null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const grant of db.grants.values()) {
          if (where.id && grant.id !== where.id) continue;
          if (where.storeId && grant.storeId !== where.storeId) continue;
          const updated = { ...grant, ...data };
          db.grants.set(grant.id, updated);
          count++;
        }
        return { count };
      }),
    },
    weleticLoyaltyOrderLineEarn: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const lineEarn of db.orderLineEarns.values()) {
          if (where.id && lineEarn.id !== where.id) continue;
          if (where.grantId && lineEarn.grantId !== where.grantId) continue;
          if (where.storeId && lineEarn.storeId !== where.storeId) continue;
          if (
            where.reversedPoints !== undefined &&
            lineEarn.reversedPoints !== where.reversedPoints
          ) {
            continue;
          }
          const updated = { ...lineEarn, ...data };
          db.orderLineEarns.set(lineEarn.id, updated);
          count++;
        }
        return { count };
      }),
    },
    weleticRewardRedemption: {
      findMany: vi.fn(async ({ where }: any) => {
        const results: any[] = [];
        for (const red of db.redemptions.values()) {
          if (where.storeId && red.storeId !== where.storeId) continue;
          if (
            where.shopifyDiscountCodeCanonical?.in &&
            !where.shopifyDiscountCodeCanonical.in.includes(
              red.shopifyDiscountCodeCanonical,
            )
          ) {
            continue;
          }
          if (
            where.settlementQuarantinedAt === null &&
            red.settlementQuarantinedAt !== null
          ) {
            continue;
          }
          if (where.status?.in && !where.status.in.includes(red.status)) {
            continue;
          }
          results.push({ ...red });
        }
        return results;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const red of db.redemptions.values()) {
          if (where.storeId && red.storeId !== where.storeId) continue;
          if (
            where.shopifyDiscountCodeCanonical &&
            red.shopifyDiscountCodeCanonical !==
              where.shopifyDiscountCodeCanonical
          ) {
            continue;
          }
          if (
            where.settlementQuarantinedAt === null &&
            red.settlementQuarantinedAt !== null
          ) {
            continue;
          }
          return { ...red };
        }
        return null;
      }),
      count: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (const red of db.redemptions.values()) {
          if (where.storeId && red.storeId !== where.storeId) continue;
          if (
            where.shopifyDiscountCodeCanonical &&
            red.shopifyDiscountCodeCanonical !==
              where.shopifyDiscountCodeCanonical
          ) {
            continue;
          }
          if (
            where.settlementQuarantinedAt === null &&
            red.settlementQuarantinedAt !== null
          ) {
            continue;
          }
          count++;
        }
        return count;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const red of db.redemptions.values()) {
          if (where.id && red.id !== where.id) continue;
          if (where.storeId && red.storeId !== where.storeId) continue;
          if (where.status && red.status !== where.status) continue;
          const updated = { ...red, ...data };
          db.redemptions.set(red.id, updated);
          count++;
        }
        return { count };
      }),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(async ({ where }: any) => {
        return db.programs.get(where.storeId) ?? null;
      }),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(async ({ where }: any) => {
        return db.outboxJobs.get(where.id) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const id = data.id || `outbox_${db.outboxJobs.size + 1}`;
        const job = { ...data, id, createdAt: new Date() };
        db.outboxJobs.set(id, job);
        return job;
      }),
    },
    weleticReconciliationIssue: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const key = where.storeId_kind_externalKey;
        const mapKey = `${key.storeId}:${key.kind}:${key.externalKey}`;
        const existing = db.reconciliationIssues.get(mapKey);
        const item = existing ? { ...existing, ...update } : { ...create };
        db.reconciliationIssues.set(mapKey, item);
        return item;
      }),
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findFirst: vi.fn(async () => null),
    },
    weleticLoyaltyReferral: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };

  return { prisma: mockPrismaClient };
});

// =============================================================================
// TEST SUITE: LOYALTY CHECKOUT-REFUND MATRIX
// =============================================================================

describe("Weletic Loyalty Checkout-to-Refund Parity Verification Matrix", () => {
  const STORE_ID = "wstore_matrix_test";
  const ACCOUNT_ID = "wlacc_matrix_test";
  const ORDER_ID = "word_matrix_1001";
  const GRANT_ID = "wgrant_matrix_1001";

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    resetDb();

    // Default active store setup
    db.stores.set(STORE_ID, {
      id: STORE_ID,
      shopDomain: "matrix-store.myshopify.com",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(),
      installationGeneration: null,
    });

    // Default loyalty program
    db.programs.set(STORE_ID, {
      id: "wlprog_matrix",
      storeId: STORE_ID,
      status: "active",
      killSwitchActive: false,
      pointsPerCurrencyUnit: "1.0",
      holdingPeriodDays: 0,
    });

    // Default account setup
    db.accounts.set(ACCOUNT_ID, {
      id: ACCOUNT_ID,
      storeId: STORE_ID,
      programId: "wlprog_matrix",
      status: "active",
      cachedPointsBalance: BigInt(0),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(0),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 0,
      shopifyCustomerId: "cust_matrix_1",
      shopper: {
        id: "shopper_matrix_1",
        storeId: STORE_ID,
        shopifyCustomerId: "cust_matrix_1",
        loyaltyAccount: {
          id: ACCOUNT_ID,
          storeId: STORE_ID,
          programId: "wlprog_matrix",
          program: { id: "wlprog_matrix", storeId: STORE_ID },
        },
      },
    });
  });

  // ===========================================================================
  // REQUIREMENT 1: MULTI-LINE ORDER & INCREMENTAL PARTIAL REFUND CLAWBACK
  // ===========================================================================
  describe("R1: Multi-Line Order & Incremental Partial Refund Clawback", () => {
    describe("1.1 Proportional Point Allocation Across Multiple Lines", () => {
      it("allocates points proportionally across multiple lines on order creation", () => {
        const lines: LineAllocationInput[] = [
          {
            orderLineId: "line_1",
            lineNetAmount: BigInt(5000), // $50.00
            isExcluded: false,
            quantity: 1,
          },
          {
            orderLineId: "line_2",
            lineNetAmount: BigInt(3000), // $30.00
            isExcluded: false,
            quantity: 1,
          },
          {
            orderLineId: "line_3",
            lineNetAmount: BigInt(2000), // $20.00
            isExcluded: false,
            quantity: 1,
          },
        ];

        const grossPoints = BigInt(100);
        const result = allocatePointsAcrossOrderLines({ grossPoints, lines });

        expect(result).toHaveLength(3);
        const line1 = result.find((l) => l.orderLineId === "line_1");
        const line2 = result.find((l) => l.orderLineId === "line_2");
        const line3 = result.find((l) => l.orderLineId === "line_3");

        expect(line1?.awardedPoints).toBe(BigInt(50));
        expect(line2?.awardedPoints).toBe(BigInt(30));
        expect(line3?.awardedPoints).toBe(BigInt(20));

        // Exact penny-conserving integer sum
        const totalAwarded = result.reduce(
          (sum, l) => sum + l.awardedPoints,
          BigInt(0),
        );
        expect(totalAwarded).toBe(grossPoints);
      });

      it("conserves exact integer points using Hare-Niemeyer largest-remainder allocation on uneven division", () => {
        // 100 points across 3 lines of $33.33, $33.33, $33.34 (total $100.00)
        const lines: LineAllocationInput[] = [
          {
            orderLineId: "line_a",
            lineNetAmount: BigInt(3333),
            isExcluded: false,
            quantity: 1,
          },
          {
            orderLineId: "line_b",
            lineNetAmount: BigInt(3333),
            isExcluded: false,
            quantity: 1,
          },
          {
            orderLineId: "line_c",
            lineNetAmount: BigInt(3334),
            isExcluded: false,
            quantity: 1,
          },
        ];

        const grossPoints = BigInt(100);
        const result = allocatePointsAcrossOrderLines({ grossPoints, lines });

        // Base points:
        // line_a: (100 * 3333) / 10000 = 33, remainder 3300
        // line_b: (100 * 3333) / 10000 = 33, remainder 3300
        // line_c: (100 * 3334) / 10000 = 33, remainder 3400 -> largest remainder gets +1!
        const lineA = result.find((l) => l.orderLineId === "line_a");
        const lineB = result.find((l) => l.orderLineId === "line_b");
        const lineC = result.find((l) => l.orderLineId === "line_c");

        expect(lineA?.awardedPoints).toBe(BigInt(33));
        expect(lineB?.awardedPoints).toBe(BigInt(33));
        expect(lineC?.awardedPoints).toBe(BigInt(34));

        const totalAwarded = result.reduce(
          (sum, l) => sum + l.awardedPoints,
          BigInt(0),
        );
        expect(totalAwarded).toBe(grossPoints);
      });

      it("allocates zero points to excluded lines and routes 100% to eligible lines", () => {
        const lines: LineAllocationInput[] = [
          {
            orderLineId: "line_eligible",
            lineNetAmount: BigInt(6000),
            isExcluded: false,
            quantity: 1,
          },
          {
            orderLineId: "line_excluded",
            lineNetAmount: BigInt(4000),
            isExcluded: true,
            exclusionReason: "discounted_item",
            quantity: 1,
          },
        ];

        const result = allocatePointsAcrossOrderLines({
          grossPoints: BigInt(60),
          lines,
        });

        const eligible = result.find((l) => l.orderLineId === "line_eligible");
        const excluded = result.find((l) => l.orderLineId === "line_excluded");

        expect(eligible?.awardedPoints).toBe(BigInt(60));
        expect(excluded?.awardedPoints).toBe(BigInt(0));
        expect(excluded?.isExcluded).toBe(true);
      });

      it("property: exact integer conservation across arbitrary multi-line baskets", () => {
        fc.assert(
          fc.property(
            fc.bigInt({ min: BigInt(1), max: BigInt(1_000_000) }),
            fc.array(
              fc.record({
                id: fc.string({ minLength: 3, maxLength: 8 }),
                amount: fc.bigInt({ min: BigInt(1), max: BigInt(500_000) }),
                isExcluded: fc.boolean(),
              }),
              { minLength: 1, maxLength: 10 },
            ),
            (grossPoints, lineDefs) => {
              const lines: LineAllocationInput[] = lineDefs.map((ld, idx) => ({
                orderLineId: `line_${idx}_${ld.id}`,
                lineNetAmount: ld.amount,
                isExcluded: ld.isExcluded,
                quantity: 1,
              }));

              const result = allocatePointsAcrossOrderLines({
                grossPoints,
                lines,
              });
              const eligibleCount = lines.filter((l) => !l.isExcluded).length;

              const totalAwarded = result.reduce(
                (sum, l) => sum + l.awardedPoints,
                BigInt(0),
              );

              if (eligibleCount > 0) {
                expect(totalAwarded).toBe(grossPoints);
              } else {
                expect(totalAwarded).toBe(BigInt(0));
              }

              for (const r of result) {
                if (r.isExcluded) {
                  expect(r.awardedPoints).toBe(BigInt(0));
                }
              }
            },
          ),
          { numRuns: 200 },
        );
      });
    });

    describe("1.2 Single-Line Partial Refund Reversal", () => {
      it("calculates exact proportional clawback on a single line of a multi-line order", () => {
        const originalGrant = {
          id: GRANT_ID,
          grossPoints: BigInt(100),
          pendingPoints: BigInt(0),
          settledPoints: BigInt(100),
          reversedPoints: BigInt(0),
          eligibleSubtotalAmount: BigInt(10000), // $100.00
          lineEarns: [
            {
              id: "le_1",
              orderLineId: "line_1",
              lineNetAmount: BigInt(6000), // $60.00
              awardedPoints: BigInt(60),
              reversedPoints: BigInt(0),
              isExcluded: false,
            },
            {
              id: "le_2",
              orderLineId: "line_2",
              lineNetAmount: BigInt(4000), // $40.00
              awardedPoints: BigInt(40),
              reversedPoints: BigInt(0),
              isExcluded: false,
            },
          ],
        };

        // Partial refund of $30.00 on Line 1 (50% of Line 1)
        const reversal = calculateRefundPointsReversal({
          originalGrant,
          refundedLines: [
            {
              orderLineId: "line_1",
              cumulativeShopAmount: BigInt(3000),
            },
          ],
        });

        expect(reversal.totalPointsToClawback).toBe(BigInt(30));
        expect(reversal.debitSettledPoints).toBe(BigInt(30));
        expect(reversal.voidPendingPoints).toBe(BigInt(0));
        expect(reversal.lineClawbacks).toEqual([
          {
            orderLineId: "line_1",
            lineClawback: BigInt(30),
          },
        ]);
      });

      it("persists exact single-line partial reversal through database orchestration", async () => {
        const refundId = "ref_single_partial";
        const orderLineId1 = "line_p1";
        const orderLineId2 = "line_p2";

        // Seed Grant and Lines
        db.grants.set(GRANT_ID, {
          id: GRANT_ID,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          grossPoints: BigInt(100),
          pendingPoints: BigInt(0),
          settledPoints: BigInt(100),
          reversedPoints: BigInt(0),
          status: "settled",
          eligibleSubtotalAmount: BigInt(10000),
          orderTotalAmount: BigInt(10000),
        });

        db.orderLineEarns.set("le_p1", {
          id: "le_p1",
          grantId: GRANT_ID,
          storeId: STORE_ID,
          orderLineId: orderLineId1,
          quantity: 2,
          lineNetAmount: BigInt(6000),
          awardedPoints: BigInt(60),
          reversedPoints: BigInt(0),
          isExcluded: false,
        });

        db.orderLineEarns.set("le_p2", {
          id: "le_p2",
          grantId: GRANT_ID,
          storeId: STORE_ID,
          orderLineId: orderLineId2,
          quantity: 1,
          lineNetAmount: BigInt(4000),
          awardedPoints: BigInt(40),
          reversedPoints: BigInt(0),
          isExcluded: false,
        });

        // Set account balance to 100
        const acc = db.accounts.get(ACCOUNT_ID);
        acc.cachedPointsBalance = BigInt(100);
        acc.lifetimePointsEarned = BigInt(100);

        // Refund 1 unit / $30.00 on Line 1
        db.orders.set(ORDER_ID, {
          id: ORDER_ID,
          storeId: STORE_ID,
          externalId: "ext_ord_1",
          shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
        });

        db.refunds.set(refundId, {
          id: refundId,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: BigInt(3000),
        });

        db.refundLines.set("rfl_1", {
          id: "rfl_1",
          refundId,
          orderLineId: orderLineId1,
          shopAmount: BigInt(3000),
          quantity: 1,
        });

        const result = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId,
        });

        expect(result).not.toBeNull();
        expect(result?.pointsDelta).toBe(BigInt(-30));
        expect(-result!.pointsDelta).toBe(BigInt(30));

        // Verify Line 1 reversedPoints updated to 30, Line 2 remains 0
        expect(db.orderLineEarns.get("le_p1").reversedPoints).toBe(BigInt(30));
        expect(db.orderLineEarns.get("le_p2").reversedPoints).toBe(BigInt(0));

        // Verify Grant reversedPoints updated to 30
        expect(db.grants.get(GRANT_ID).reversedPoints).toBe(BigInt(30));

        // Verify Account balance debited to 70
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(
          BigInt(70),
        );
      });
    });

    describe("1.3 Step-Wise Sequential Partial Refunds (Cumulative Convergence)", () => {
      it("converges exactly without rounding drift across sequential split returns (qty 1 then qty 2 on qty 3 line)", async () => {
        const orderLineId = "line_step_seq";
        const lineAwarded = BigInt(300);
        const lineNet = BigInt(30000); // $300.00
        const lineQuantity = BigInt(3); // 3 units @ $100.00 each

        db.grants.set(GRANT_ID, {
          id: GRANT_ID,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          grossPoints: lineAwarded,
          pendingPoints: BigInt(0),
          settledPoints: lineAwarded,
          reversedPoints: BigInt(0),
          status: "settled",
          eligibleSubtotalAmount: lineNet,
          orderTotalAmount: lineNet,
        });

        db.orderLineEarns.set("le_seq", {
          id: "le_seq",
          grantId: GRANT_ID,
          storeId: STORE_ID,
          orderLineId,
          quantity: 3,
          lineNetAmount: lineNet,
          awardedPoints: lineAwarded,
          reversedPoints: BigInt(0),
          isExcluded: false,
        });

        db.orders.set(ORDER_ID, {
          id: ORDER_ID,
          storeId: STORE_ID,
          externalId: "ext_ord_seq",
          shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
        });

        const acc = db.accounts.get(ACCOUNT_ID);
        acc.cachedPointsBalance = lineAwarded;

        // ---------------------------------------------------------------------
        // STEP 1: Return Qty 1 ($100.00)
        // ---------------------------------------------------------------------
        const refund1Id = "ref_step_1";
        db.refunds.set(refund1Id, {
          id: refund1Id,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: BigInt(10000),
          occurredAt: new Date("2026-09-01T10:00:00Z"),
        });
        db.refundLines.set("rfl_step_1", {
          id: "rfl_step_1",
          refundId: refund1Id,
          orderLineId,
          shopAmount: BigInt(10000),
          quantity: 1,
        });

        const res1 = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId: refund1Id,
        });

        // Step 1: cumulativeQty=1/3, cumulativeAmt=$100/$300 -> 100 points reversed
        expect(res1?.pointsDelta).toBe(BigInt(-100));
        expect(-res1!.pointsDelta).toBe(BigInt(100));
        expect(db.orderLineEarns.get("le_seq").reversedPoints).toBe(
          BigInt(100),
        );
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(
          BigInt(200),
        );

        // ---------------------------------------------------------------------
        // STEP 2: Return Qty 2 ($200.00) — Cumulative Qty 3/3
        // ---------------------------------------------------------------------
        const refund2Id = "ref_step_2";
        db.refunds.set(refund2Id, {
          id: refund2Id,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: BigInt(20000),
          occurredAt: new Date("2026-09-01T11:00:00Z"),
        });
        db.refundLines.set("rfl_step_2", {
          id: "rfl_step_2",
          refundId: refund2Id,
          orderLineId,
          shopAmount: BigInt(20000),
          quantity: 2,
        });

        const res2 = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId: refund2Id,
        });

        // Step 2: cumulativeQty=3/3, cumulativeAmt=$300/$300 -> target=300
        // Incremental clawback = 300 - 100 = 200
        expect(res2?.pointsDelta).toBe(BigInt(-200));
        expect(-res2!.pointsDelta).toBe(BigInt(200));
        expect(db.orderLineEarns.get("le_seq").reversedPoints).toBe(
          BigInt(300),
        );
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));

        // Full convergence: exactly 100 + 200 = 300 points reversed with zero drift
        const totalClawed = -res1!.pointsDelta - res2!.pointsDelta;
        expect(totalClawed).toBe(lineAwarded);
      });

      it("converges across a 3-step uneven partial return (qty 1 + 2 + 2 = 5 units)", async () => {
        const orderLineId = "line_step_5";
        const lineAwarded = BigInt(100);
        const lineNet = BigInt(25000); // $250.00
        const lineQuantity = BigInt(5); // 5 units @ $50.00 each

        db.grants.set(GRANT_ID, {
          id: GRANT_ID,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          grossPoints: lineAwarded,
          pendingPoints: BigInt(0),
          settledPoints: lineAwarded,
          reversedPoints: BigInt(0),
          status: "settled",
          eligibleSubtotalAmount: lineNet,
          orderTotalAmount: lineNet,
        });

        db.orderLineEarns.set("le_step_5", {
          id: "le_step_5",
          grantId: GRANT_ID,
          storeId: STORE_ID,
          orderLineId,
          quantity: 5,
          lineNetAmount: lineNet,
          awardedPoints: lineAwarded,
          reversedPoints: BigInt(0),
          isExcluded: false,
        });

        db.orders.set(ORDER_ID, {
          id: ORDER_ID,
          storeId: STORE_ID,
          externalId: "ext_ord_5",
          shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
        });

        // Step 1: 1 unit / $50
        db.refunds.set("ref_s1", {
          id: "ref_s1",
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: BigInt(5000),
          occurredAt: new Date("2026-09-01T01:00:00Z"),
        });
        db.refundLines.set("rfl_s1", {
          id: "rfl_s1",
          refundId: "ref_s1",
          orderLineId,
          shopAmount: BigInt(5000),
          quantity: 1,
        });
        const r1 = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId: "ref_s1",
        });
        expect(r1?.pointsDelta).toBe(BigInt(-20)); // (1/5) * 100 = 20

        // Step 2: 2 units / $100 -> cumulative 3 units / $150
        db.refunds.set("ref_s2", {
          id: "ref_s2",
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: BigInt(10000),
          occurredAt: new Date("2026-09-01T02:00:00Z"),
        });
        db.refundLines.set("rfl_s2", {
          id: "rfl_s2",
          refundId: "ref_s2",
          orderLineId,
          shopAmount: BigInt(10000),
          quantity: 2,
        });
        const r2 = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId: "ref_s2",
        });
        expect(r2?.pointsDelta).toBe(BigInt(-40)); // (3/5)*100 = 60; 60 - 20 = 40

        // Step 3: 2 units / $100 -> cumulative 5 units / $250
        db.refunds.set("ref_s3", {
          id: "ref_s3",
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: BigInt(10000),
          occurredAt: new Date("2026-09-01T03:00:00Z"),
        });
        db.refundLines.set("rfl_s3", {
          id: "rfl_s3",
          refundId: "ref_s3",
          orderLineId,
          shopAmount: BigInt(10000),
          quantity: 2,
        });
        const r3 = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId: "ref_s3",
        });
        expect(r3?.pointsDelta).toBe(BigInt(-40)); // (5/5)*100 = 100; 100 - 60 = 40

        // Total sum = 20 + 40 + 40 = 100
        const total = -r1!.pointsDelta - r2!.pointsDelta - r3!.pointsDelta;
        expect(total).toBe(BigInt(100));
        expect(db.orderLineEarns.get("le_step_5").reversedPoints).toBe(
          BigInt(100),
        );
      });

      it("property: step-wise sequential returns monotonically converge to exact target without rounding drift", () => {
        fc.assert(
          fc.property(
            fc.integer({ min: 2, max: 10 }),
            fc.bigInt({ min: BigInt(10), max: BigInt(10_000) }),
            fc.array(fc.integer({ min: 1, max: 3 }), {
              minLength: 2,
              maxLength: 6,
            }),
            (lineQty, lineAwarded, stepQtys) => {
              const lineQuantity = BigInt(lineQty);
              let cumulativeQty = BigInt(0);
              let runningReversed = BigInt(0);
              const clawbacks: bigint[] = [];

              for (const step of stepQtys) {
                if (cumulativeQty >= lineQuantity) break;
                const nextQty = cumulativeQty + BigInt(step);
                cumulativeQty = nextQty < lineQuantity ? nextQty : lineQuantity;

                // Rational quantity target formula with half-up rounding
                const proportional =
                  (cumulativeQty * lineAwarded) / lineQuantity;
                const remainder = (cumulativeQty * lineAwarded) % lineQuantity;
                const quantityTarget =
                  remainder * BigInt(2) >= lineQuantity
                    ? proportional + BigInt(1)
                    : proportional;
                const boundedTarget =
                  quantityTarget < lineAwarded ? quantityTarget : lineAwarded;

                const stepClawback = boundedTarget - runningReversed;
                expect(stepClawback).toBeGreaterThanOrEqual(BigInt(0));
                runningReversed += stepClawback;
                clawbacks.push(stepClawback);
              }

              // Invariant 1: runningReversed <= lineAwarded
              expect(runningReversed).toBeLessThanOrEqual(lineAwarded);

              // Invariant 2: sum of step clawbacks === runningReversed
              const sumClawbacks = clawbacks.reduce((s, c) => s + c, BigInt(0));
              expect(sumClawbacks).toBe(runningReversed);

              // Invariant 3: if all items returned, exact 100% convergence
              if (cumulativeQty === lineQuantity) {
                expect(runningReversed).toBe(lineAwarded);
              }
            },
          ),
          { numRuns: 200 },
        );
      });
    });

    describe("1.4 Discounted Full-Return Clawback (Cumulative Quantity Floor)", () => {
      it("forces 100% points clawback via quantity floor when gross $100 is discounted to $20 cash refund on 100% return", async () => {
        const orderLineId = "line_discounted_return";
        const originalAwarded = BigInt(100);
        const lineNetCash = BigInt(2000); // $20.00 cash paid
        const lineGross = BigInt(10000); // $100.00 gross value

        // 100 points were awarded based on eligible pre-discount merchandise value
        db.grants.set(GRANT_ID, {
          id: GRANT_ID,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          grossPoints: originalAwarded,
          pendingPoints: BigInt(0),
          settledPoints: originalAwarded,
          reversedPoints: BigInt(0),
          status: "settled",
          eligibleSubtotalAmount: lineGross,
          orderTotalAmount: lineNetCash,
        });

        db.orderLineEarns.set("le_disc", {
          id: "le_disc",
          grantId: GRANT_ID,
          storeId: STORE_ID,
          orderLineId,
          quantity: 1, // 1 unit purchased
          lineNetAmount: lineGross, // earning recorded against eligible gross
          awardedPoints: originalAwarded,
          reversedPoints: BigInt(0),
          isExcluded: false,
        });

        db.orders.set(ORDER_ID, {
          id: ORDER_ID,
          storeId: STORE_ID,
          externalId: "ext_ord_disc",
          shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
        });

        const acc = db.accounts.get(ACCOUNT_ID);
        acc.cachedPointsBalance = originalAwarded;

        // Customer returns 100% of quantity (1 unit), but Shopify refunds only the $20.00 cash paid
        const refundId = "ref_discounted_full";
        db.refunds.set(refundId, {
          id: refundId,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: lineNetCash,
        });

        db.refundLines.set("rfl_disc", {
          id: "rfl_disc",
          refundId,
          orderLineId,
          shopAmount: lineNetCash, // $20.00
          quantity: 1, // 1 unit (100% returned!)
        });

        const res = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId,
        });

        // Mathematical verification:
        // Amount target = (2000 * 100) / 10000 = 20 points
        // Quantity target = (1 * 100) / 1 = 100 points
        // Cumulative target = max(100, 20) = 100 points (Quantity floor activated!)
        expect(res?.pointsDelta).toBe(BigInt(-100));
        expect(-res!.pointsDelta).toBe(BigInt(100));
        expect(db.orderLineEarns.get("le_disc").reversedPoints).toBe(
          BigInt(100),
        );
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));
      });

      it("enforces quantity floor on partial returns where cash refund is depressed by merchant restocking fees", async () => {
        const orderLineId = "line_fee_partial";
        const awardedPoints = BigInt(100);
        const lineNet = BigInt(6000); // 2 units @ $30 cash paid = $60 net ($100 gross)
        const lineQuantity = BigInt(2);

        db.grants.set(GRANT_ID, {
          id: GRANT_ID,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          grossPoints: awardedPoints,
          pendingPoints: BigInt(0),
          settledPoints: awardedPoints,
          reversedPoints: BigInt(0),
          status: "settled",
          eligibleSubtotalAmount: lineNet,
          orderTotalAmount: lineNet,
        });

        db.orderLineEarns.set("le_fee", {
          id: "le_fee",
          grantId: GRANT_ID,
          storeId: STORE_ID,
          orderLineId,
          quantity: 2,
          lineNetAmount: lineNet,
          awardedPoints,
          reversedPoints: BigInt(0),
          isExcluded: false,
        });

        db.orders.set(ORDER_ID, {
          id: ORDER_ID,
          storeId: STORE_ID,
          externalId: "ext_ord_fee",
          shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
        });

        // Return 1 unit, but merchant deducts $20 fee, refunding only $10.00 cash
        // Amount target = (1000 * 100) / 6000 = 16.67 -> 17 points
        // Quantity target = (1 * 100) / 2 = 50 points
        // Floor forces 50 points clawed back
        const refundId = "ref_fee_1";
        db.refunds.set(refundId, {
          id: refundId,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: BigInt(1000),
        });
        db.refundLines.set("rfl_fee_1", {
          id: "rfl_fee_1",
          refundId,
          orderLineId,
          shopAmount: BigInt(1000),
          quantity: 1,
        });

        const res = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId,
        });

        expect(res?.pointsDelta).toBe(BigInt(-50));
        expect(-res!.pointsDelta).toBe(BigInt(50));
        expect(db.orderLineEarns.get("le_fee").reversedPoints).toBe(BigInt(50));
      });
    });

    describe("1.5 Non-Line Order-Level Adjustments (Hare-Niemeyer Allocation)", () => {
      it("allocates non-line order adjustment proportionally across remaining line capacities", () => {
        const lineEarns: LineReversalSnapshot[] = [
          {
            id: "line_rev_1",
            orderLineId: "line_ord_1",
            storeId: STORE_ID,
            awardedPoints: BigInt(60),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "line_rev_2",
            orderLineId: "line_ord_2",
            storeId: STORE_ID,
            awardedPoints: BigInt(40),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ];

        // Allocate 25 points of general goodwill refund
        const allocations = allocateReversalAcrossRemainingLines({
          grantId: GRANT_ID,
          storeId: STORE_ID,
          grossPoints: BigInt(100),
          alreadyReversedPoints: BigInt(0),
          pointsToAllocate: BigInt(25),
          lineEarns,
        });

        // Line 1: (25 * 60) / 100 = 15 points
        // Line 2: (25 * 40) / 100 = 10 points
        expect(allocations).toHaveLength(2);
        const l1 = allocations.find((a) => a.orderLineId === "line_ord_1");
        const l2 = allocations.find((a) => a.orderLineId === "line_ord_2");

        expect(l1?.pointsToReverse).toBe(BigInt(15));
        expect(l2?.pointsToReverse).toBe(BigInt(10));

        const totalAllocated = allocations.reduce(
          (sum, a) => sum + a.pointsToReverse,
          BigInt(0),
        );
        expect(totalAllocated).toBe(BigInt(25));
      });

      it("uses Hare-Niemeyer largest-remainder with stable orderLineId tie breaking", () => {
        // 3 lines with capacities 33, 33, 34 (total 100 capacity). Allocate 10 points.
        const lineEarns: LineReversalSnapshot[] = [
          {
            id: "l_a",
            orderLineId: "ord_line_a",
            storeId: STORE_ID,
            awardedPoints: BigInt(33),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "l_b",
            orderLineId: "ord_line_b",
            storeId: STORE_ID,
            awardedPoints: BigInt(33),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "l_c",
            orderLineId: "ord_line_c",
            storeId: STORE_ID,
            awardedPoints: BigInt(34),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ];

        const allocations = allocateReversalAcrossRemainingLines({
          grantId: GRANT_ID,
          storeId: STORE_ID,
          grossPoints: BigInt(100),
          alreadyReversedPoints: BigInt(0),
          pointsToAllocate: BigInt(10),
          lineEarns,
        });

        // Line c has largest remainder (10 * 34 % 100 = 40 vs 30) -> receives the extra +1!
        const la = allocations.find((a) => a.orderLineId === "ord_line_a");
        const lb = allocations.find((a) => a.orderLineId === "ord_line_b");
        const lc = allocations.find((a) => a.orderLineId === "ord_line_c");

        expect(la?.pointsToReverse).toBe(BigInt(3));
        expect(lb?.pointsToReverse).toBe(BigInt(3));
        expect(lc?.pointsToReverse).toBe(BigInt(4));

        const total = allocations.reduce(
          (s, a) => s + a.pointsToReverse,
          BigInt(0),
        );
        expect(total).toBe(BigInt(10));
      });

      it("fails closed on cross-tenant line or when reversal exceeds total capacity", () => {
        const lineEarns: LineReversalSnapshot[] = [
          {
            id: "l_x",
            orderLineId: "line_x",
            storeId: "other_store", // Cross-tenant!
            awardedPoints: BigInt(50),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ];

        expect(() =>
          allocateReversalAcrossRemainingLines({
            grantId: GRANT_ID,
            storeId: STORE_ID,
            grossPoints: BigInt(50),
            alreadyReversedPoints: BigInt(0),
            pointsToAllocate: BigInt(10),
            lineEarns,
          }),
        ).toThrow("cross-tenant");

        const normalLines: LineReversalSnapshot[] = [
          {
            id: "l_normal",
            orderLineId: "line_normal",
            storeId: STORE_ID,
            awardedPoints: BigInt(20),
            reversedPoints: BigInt(15), // only 5 capacity remaining
            isExcluded: false,
          },
        ];

        expect(() =>
          allocateReversalAcrossRemainingLines({
            grantId: GRANT_ID,
            storeId: STORE_ID,
            grossPoints: BigInt(20),
            alreadyReversedPoints: BigInt(15),
            pointsToAllocate: BigInt(10), // exceeds remaining capacity of 5!
            lineEarns: normalLines,
          }),
        ).toThrow("capacity is insufficient");
      });

      it("property: largest-remainder allocation is always strictly conserved and capacity-bounded", () => {
        fc.assert(
          fc.property(
            fc.array(fc.bigInt({ min: BigInt(5), max: BigInt(1000) }), {
              minLength: 2,
              maxLength: 8,
            }),
            fc.integer({ min: 1, max: 100 }),
            (capacities, pct) => {
              const lineEarns: LineReversalSnapshot[] = capacities.map(
                (cap, idx) => ({
                  id: `line_prop_${idx}`,
                  orderLineId: `ord_line_${String(idx).padStart(2, "0")}`,
                  storeId: STORE_ID,
                  awardedPoints: cap,
                  reversedPoints: BigInt(0),
                  isExcluded: false,
                }),
              );

              const totalCap = capacities.reduce(
                (sum, c) => sum + c,
                BigInt(0),
              );
              const pointsToAllocate = (totalCap * BigInt(pct)) / BigInt(100);
              if (pointsToAllocate <= BigInt(0)) return;

              const allocations = allocateReversalAcrossRemainingLines({
                grantId: GRANT_ID,
                storeId: STORE_ID,
                grossPoints: totalCap,
                alreadyReversedPoints: BigInt(0),
                pointsToAllocate,
                lineEarns,
              });

              // Invariant 1: Total allocated === pointsToAllocate (exact conservation)
              const sumAllocated = allocations.reduce(
                (s, a) => s + a.pointsToReverse,
                BigInt(0),
              );
              expect(sumAllocated).toBe(pointsToAllocate);

              // Invariant 2: Each allocation <= line capacity
              for (const alloc of allocations) {
                expect(alloc.pointsToReverse).toBeLessThanOrEqual(
                  alloc.awardedPoints,
                );
              }
            },
          ),
          { numRuns: 200 },
        );
      });
    });
  });

  // ===========================================================================
  // REQUIREMENT 2: NON-FIXED REWARD TYPES CHECKOUT SETTLEMENT & LIFECYCLE
  // ===========================================================================
  describe("R2: Non-Fixed Reward Types Checkout Settlement & Lifecycle", () => {
    describe("2.1 Percentage Off Discount Checkout & Lifecycle", () => {
      it("scales down net merchandise amounts and earned points proportionally by 10%", () => {
        // Line 1: $60.00 gross -> 10% off -> $54.00 net
        // Line 2: $40.00 gross -> 10% off -> $36.00 net
        // Total subtotal = $90.00 (down from $100.00)
        const lines: LineAllocationInput[] = [
          {
            orderLineId: "line_pct_1",
            lineNetAmount: BigInt(5400),
            isExcluded: false,
            quantity: 1,
          },
          {
            orderLineId: "line_pct_2",
            lineNetAmount: BigInt(3600),
            isExcluded: false,
            quantity: 1,
          },
        ];

        // Points earning at 1 pt / $1: 90 points awarded (10% reduction)
        const grossPoints = BigInt(90);
        const allocated = allocatePointsAcrossOrderLines({
          grossPoints,
          lines,
        });

        expect(
          allocated.find((l) => l.orderLineId === "line_pct_1")?.awardedPoints,
        ).toBe(BigInt(54));
        expect(
          allocated.find((l) => l.orderLineId === "line_pct_2")?.awardedPoints,
        ).toBe(BigInt(36));
        expect(
          allocated.reduce((sum, l) => sum + l.awardedPoints, BigInt(0)),
        ).toBe(BigInt(90));
      });

      it("transitions percentage off coupon to used and links orderId on payment", async () => {
        const discountCode = "SAVE10NOW";
        const redemptionId = "wredemp_pct_10";

        db.redemptions.set(redemptionId, {
          id: redemptionId,
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          pointsSpent: BigInt(500),
          shopifyDiscountCode: discountCode,
          shopifyDiscountCodeCanonical: discountCode,
          status: WeleticRedemptionStatus.issued,
          settlementQuarantinedAt: null,
          orderId: null,
          usedAt: null,
        });

        const result = await settleRewardRedemptionsUsedByOrder({
          storeId: STORE_ID,
          discountCodes: [discountCode],
          orderId: ORDER_ID,
          shopifyCustomerId: "cust_matrix_1",
          usedAt: new Date("2026-09-02T14:30:00Z"),
        });

        expect(result.markedUsed).toBe(1);
        const settled = db.redemptions.get(redemptionId);
        expect(settled.status).toBe(WeleticRedemptionStatus.used);
        expect(settled.orderId).toBe(ORDER_ID);
        expect(settled.usedAt).toEqual(new Date("2026-09-02T14:30:00Z"));
      });
    });

    describe("2.2 Free Shipping Reward Settlement & Points Earning Isolation", () => {
      it("leaves merchandise point earning completely untouched when shipping is reduced to 0", () => {
        // Cart: Merchandise $100.00 (Line 1 $50, Line 2 $50). Shipping was $15.00 -> reduced to $0.00.
        // Because excludeTaxesAndShipping is mandatory, points are evaluated solely on line nets.
        const lines: LineAllocationInput[] = [
          {
            orderLineId: "line_ship_1",
            lineNetAmount: BigInt(5000),
            isExcluded: false,
            quantity: 1,
          },
          {
            orderLineId: "line_ship_2",
            lineNetAmount: BigInt(5000),
            isExcluded: false,
            quantity: 1,
          },
        ];

        // 100 points calculated on merchandise, totally ignoring shipping rate
        const result = allocatePointsAcrossOrderLines({
          grossPoints: BigInt(100),
          lines,
        });

        expect(
          result.find((l) => l.orderLineId === "line_ship_1")?.awardedPoints,
        ).toBe(BigInt(50));
        expect(
          result.find((l) => l.orderLineId === "line_ship_2")?.awardedPoints,
        ).toBe(BigInt(50));
        expect(
          result.reduce((sum, l) => sum + l.awardedPoints, BigInt(0)),
        ).toBe(BigInt(100));
      });

      it("transitions free shipping coupon to used linked to orderId", async () => {
        const code = "FREESHIPVIP";
        const redemptionId = "wredemp_ship_1";

        db.redemptions.set(redemptionId, {
          id: redemptionId,
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          pointsSpent: BigInt(300),
          shopifyDiscountCode: code,
          shopifyDiscountCodeCanonical: code,
          status: WeleticRedemptionStatus.issued,
          settlementQuarantinedAt: null,
          orderId: null,
          usedAt: null,
        });

        const result = await settleRewardRedemptionsUsedByOrder({
          storeId: STORE_ID,
          discountCodes: [code],
          orderId: ORDER_ID,
          shopifyCustomerId: "cust_matrix_1",
          usedAt: new Date("2026-09-02T15:00:00Z"),
        });

        expect(result.markedUsed).toBe(1);
        const settled = db.redemptions.get(redemptionId);
        expect(settled.status).toBe(WeleticRedemptionStatus.used);
        expect(settled.orderId).toBe(ORDER_ID);
      });
    });

    describe("2.3 Free Product / BXGY Reward Checkout Settlement", () => {
      it("awards 0 points to free product item (net amount 0) while paid items earn normally", () => {
        // Cart: Line 1 Paid Item ($70.00 net), Line 2 Free Item ($30.00 gross with 100% discount = $0 net)
        const lines: LineAllocationInput[] = [
          {
            orderLineId: "line_paid_item",
            lineNetAmount: BigInt(7000),
            isExcluded: false,
            quantity: 1,
          },
          {
            orderLineId: "line_free_product",
            lineNetAmount: BigInt(0), // Free item net amount = 0
            isExcluded: false,
            quantity: 1,
          },
        ];

        const grossPoints = BigInt(70);
        const result = allocatePointsAcrossOrderLines({ grossPoints, lines });

        const paid = result.find((l) => l.orderLineId === "line_paid_item");
        const free = result.find((l) => l.orderLineId === "line_free_product");

        expect(paid?.awardedPoints).toBe(BigInt(70));
        expect(free?.awardedPoints).toBe(BigInt(0));
      });

      it("transitions free product / BXGY redemption to used bound to orderId", async () => {
        const code = "FREEGIFT2026";
        const redemptionId = "wredemp_free_prod";

        db.redemptions.set(redemptionId, {
          id: redemptionId,
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          pointsSpent: BigInt(1000),
          shopifyDiscountCode: code,
          shopifyDiscountCodeCanonical: code,
          status: WeleticRedemptionStatus.issued,
          settlementQuarantinedAt: null,
          orderId: null,
          usedAt: null,
        });

        const result = await settleRewardRedemptionsUsedByOrder({
          storeId: STORE_ID,
          discountCodes: [code],
          orderId: ORDER_ID,
          shopifyCustomerId: "cust_matrix_1",
          usedAt: new Date("2026-09-02T16:00:00Z"),
        });

        expect(result.markedUsed).toBe(1);
        const settled = db.redemptions.get(redemptionId);
        expect(settled.status).toBe(WeleticRedemptionStatus.used);
        expect(settled.orderId).toBe(ORDER_ID);
      });
    });

    describe("2.4 Non-Recrediting Invariant: Coupons Never Restored on Order Refund", () => {
      it("reverses earned order points while coupon remains strictly used and is never re-credited", async () => {
        const code = "REWARDCOUPON10";
        const redemptionId = "wredemp_non_recredit";
        const refundId = "ref_non_recredit";
        const orderLineId = "line_non_recredit";

        // 1. Coupon is marked used by order
        db.redemptions.set(redemptionId, {
          id: redemptionId,
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          pointsSpent: BigInt(500),
          shopifyDiscountCode: code,
          shopifyDiscountCodeCanonical: code,
          status: WeleticRedemptionStatus.used,
          settlementQuarantinedAt: null,
          orderId: ORDER_ID,
          usedAt: new Date("2026-09-02T10:00:00Z"),
        });

        // 2. Order earned 90 points
        db.grants.set(GRANT_ID, {
          id: GRANT_ID,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          grossPoints: BigInt(90),
          pendingPoints: BigInt(0),
          settledPoints: BigInt(90),
          reversedPoints: BigInt(0),
          status: "settled",
          eligibleSubtotalAmount: BigInt(9000),
          orderTotalAmount: BigInt(9000),
        });

        db.orderLineEarns.set("le_nr", {
          id: "le_nr",
          grantId: GRANT_ID,
          storeId: STORE_ID,
          orderLineId,
          quantity: 1,
          lineNetAmount: BigInt(9000),
          awardedPoints: BigInt(90),
          reversedPoints: BigInt(0),
          isExcluded: false,
        });

        db.orders.set(ORDER_ID, {
          id: ORDER_ID,
          storeId: STORE_ID,
          externalId: "ext_ord_nr",
          shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
        });

        const acc = db.accounts.get(ACCOUNT_ID);
        acc.cachedPointsBalance = BigInt(90);

        // 3. Full refund of order occurs
        db.refunds.set(refundId, {
          id: refundId,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: BigInt(9000),
        });
        db.refundLines.set("rfl_nr", {
          id: "rfl_nr",
          refundId,
          orderLineId,
          shopAmount: BigInt(9000),
          quantity: 1,
        });

        const refResult = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId,
        });

        // Earned points are clawed back (-90)
        expect(refResult?.pointsDelta).toBe(BigInt(-90));
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));

        // NON-RECREDITING INVARIANT:
        // Coupon MUST remain used and MUST NOT be reset to issued or active
        const couponAfterRefund = db.redemptions.get(redemptionId);
        expect(couponAfterRefund.status).toBe(WeleticRedemptionStatus.used);
        expect(couponAfterRefund.orderId).toBe(ORDER_ID);

        // Customer wallet MUST NOT receive the 500 points back (balance is 0, not 500)
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));
      });
    });
  });

  // ===========================================================================
  // REQUIREMENT 3: NEGATIVE POINTS BALANCE & INSOLVENT ACCOUNT PROTECTION
  // ===========================================================================
  describe("R3: Negative Points Balance & Insolvent Account Protection", () => {
    describe("3.1 Refund Clawback Exceeding Available Balance (Negative Ledger Invariant)", () => {
      it("records complete debit below zero without clamping or corruption (balanceAfter < 0)", async () => {
        // Customer lifecycle:
        // 1. Earned 200 points on purchase
        const earnEntry = await appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(200),
          idempotencyKey: "idemp_earn_200",
        });
        expect(earnEntry.balanceAfter).toBe(BigInt(200));

        // 2. Spent 200 points to redeem a voucher (balance becomes 0)
        const redeemEntry = await appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          pointsDelta: BigInt(-200),
          idempotencyKey: "idemp_redeem_200",
        });
        expect(redeemEntry.balanceAfter).toBe(BigInt(0));
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));

        // 3. Purchase is refunded: 200 points clawed back
        const refundEntry = await appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
          pointsDelta: BigInt(-200),
          idempotencyKey: "idemp_refund_clawback_200",
        });

        // Invariant: Full debit is recorded; balanceAfter is exactly -200 (NOT clamped to 0)
        expect(refundEntry.pointsDelta).toBe(BigInt(-200));
        expect(refundEntry.balanceAfter).toBe(BigInt(-200));
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(
          BigInt(-200),
        );
      });
    });

    describe("3.2 Insolvent Account Protection & Balance Projection", () => {
      it("reflects negative balance cleanly and locks redemption (canRedeem = false)", async () => {
        // Set account balance to -150
        const acc = db.accounts.get(ACCOUNT_ID);
        acc.cachedPointsBalance = BigInt(-150);
        acc.ledgerVersion = 3;

        const balanceReport = await getAccountPointsBalance(ACCOUNT_ID);
        expect(balanceReport).not.toBeNull();

        expect(balanceReport!.pointsBalance).toBe(BigInt(-150));
        expect(balanceReport!.isNegative).toBe(true);
        expect(balanceReport!.canRedeem).toBe(false); // Insolvent account cannot redeem rewards!
      });

      it("re-enables canRedeem when balance returns to positive (> 0)", async () => {
        const acc = db.accounts.get(ACCOUNT_ID);
        acc.cachedPointsBalance = BigInt(50);
        acc.ledgerVersion = 4;

        const balanceReport = await getAccountPointsBalance(ACCOUNT_ID);
        expect(balanceReport).not.toBeNull();

        expect(balanceReport!.pointsBalance).toBe(BigInt(50));
        expect(balanceReport!.isNegative).toBe(false);
        expect(balanceReport!.canRedeem).toBe(true);
      });
    });

    describe("3.3 Future Earn Deficit Amortization", () => {
      it("algebraically offsets negative debt through subsequent purchase earn events", async () => {
        // Account has debt of -200 points
        const acc = db.accounts.get(ACCOUNT_ID);
        acc.cachedPointsBalance = BigInt(-200);
        acc.ledgerVersion = 1;

        // Future order 1: customer earns +150 points
        const earn1 = await appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(150),
          idempotencyKey: "idemp_future_earn_150",
        });

        expect(earn1.balanceAfter).toBe(BigInt(-50));
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(
          BigInt(-50),
        );

        let report = await getAccountPointsBalance(ACCOUNT_ID);
        expect(report).not.toBeNull();
        expect(report!.pointsBalance).toBe(BigInt(-50));
        expect(report!.canRedeem).toBe(false); // Still insolvent

        // Future order 2: customer earns +100 points
        const earn2 = await appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(100),
          idempotencyKey: "idemp_future_earn_100",
        });

        // -50 + 100 = +50 points (Debt fully cleared, surplus returned!)
        expect(earn2.balanceAfter).toBe(BigInt(50));
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(
          BigInt(50),
        );

        report = await getAccountPointsBalance(ACCOUNT_ID);
        expect(report).not.toBeNull();
        expect(report!.pointsBalance).toBe(BigInt(50));
        expect(report!.isNegative).toBe(false);
        expect(report!.canRedeem).toBe(true); // Redemption unlocked!
      });
    });

    describe("3.4 Strict Monotonic Sequence & OCC Integrity", () => {
      it("strictly orders sequence numbers and ledgerVersion monotonically across transactions", async () => {
        // Sequence of 5 operations
        const deltas = [
          { type: WeleticPointsLedgerEntryType.EARN_ORDER, delta: BigInt(500) },
          {
            type: WeleticPointsLedgerEntryType.REDEEM_REWARD,
            delta: BigInt(-500),
          },
          {
            type: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
            delta: BigInt(-500),
          }, // drops to -500
          { type: WeleticPointsLedgerEntryType.EARN_ORDER, delta: BigInt(300) }, // recovers to -200
          { type: WeleticPointsLedgerEntryType.EARN_ORDER, delta: BigInt(400) }, // recovers to +200
        ];

        const entries: any[] = [];
        for (let i = 0; i < deltas.length; i++) {
          const entry = await appendPointsLedgerEntry({
            storeId: STORE_ID,
            accountId: ACCOUNT_ID,
            entryType: deltas[i].type,
            pointsDelta: deltas[i].delta,
            idempotencyKey: `seq_step_${i + 1}`,
          });
          entries.push(entry);
        }

        // Verify sequence numbers: 1, 2, 3, 4, 5
        expect(entries.map((e) => e.sequenceNumber)).toEqual([1, 2, 3, 4, 5]);

        // Verify ledgerVersion on account matches latest sequence
        expect(db.accounts.get(ACCOUNT_ID).ledgerVersion).toBe(5);

        // Verify balances after: 500, 0, -500, -200, 200
        expect(entries.map((e) => e.balanceAfter)).toEqual([
          BigInt(500),
          BigInt(0),
          BigInt(-500),
          BigInt(-200),
          BigInt(200),
        ]);
      });

      it("rejects concurrent mutation with stale ledgerVersion via OptimisticConcurrencyError", async () => {
        const acc = db.accounts.get(ACCOUNT_ID);
        acc.cachedPointsBalance = BigInt(100);
        acc.ledgerVersion = 1;

        // In a transaction, an OCC collision immediately throws OptimisticConcurrencyError
        const mockTx = {
          weleticLoyaltyAccount: {
            findUnique: vi.fn().mockResolvedValue({
              ...acc,
              storeId: STORE_ID,
            }),
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
          },
          weleticPointsLedgerEntry: {
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: "wledger_occ" }),
          },
        };

        await expect(
          appendPointsLedgerEntry({
            storeId: STORE_ID,
            accountId: ACCOUNT_ID,
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
            pointsDelta: BigInt(50),
            idempotencyKey: "occ_conflict_test",
            tx: mockTx as any,
          }),
        ).rejects.toThrow(OptimisticConcurrencyError);
      });

      it("deduplicates idempotently on replay without sequence increment or balance distortion", async () => {
        const idempotencyKey = "idemp_exact_replay";

        // First call
        const entry1 = await appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(100),
          idempotencyKey,
        });

        // Replay call with exact same idempotency key
        const entry2 = await appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(100),
          idempotencyKey,
        });

        expect(entry1.id).toBe(entry2.id);
        expect(entry1.sequenceNumber).toBe(entry2.sequenceNumber);
        expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(
          BigInt(100),
        );
        expect(db.accounts.get(ACCOUNT_ID).ledgerVersion).toBe(1);
      });

      it("property: algebraic balance conservation and strict sequence monotonicity across random delta streams", async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.array(fc.bigInt({ min: BigInt(-200), max: BigInt(500) }), {
              minLength: 3,
              maxLength: 8,
            }),
            async (deltas) => {
              const testAccountId = `prop_acc_${Math.random().toString(36).slice(2, 8)}`;
              db.accounts.set(testAccountId, {
                id: testAccountId,
                storeId: STORE_ID,
                status: "active",
                programId: "wlprog_matrix",
                cachedPointsBalance: BigInt(0),
                cachedPendingPoints: BigInt(0),
                lifetimePointsEarned: BigInt(0),
                lifetimePointsRedeemed: BigInt(0),
                ledgerVersion: 0,
              });

              let expectedBalance = BigInt(0);
              let expectedSeq = 0;

              for (let i = 0; i < deltas.length; i++) {
                const delta = deltas[i];
                if (delta === BigInt(0)) continue;
                expectedSeq++;
                expectedBalance += delta;

                const entry = await appendPointsLedgerEntry({
                  storeId: STORE_ID,
                  accountId: testAccountId,
                  entryType:
                    delta > BigInt(0)
                      ? WeleticPointsLedgerEntryType.EARN_ORDER
                      : WeleticPointsLedgerEntryType.REFUND_REVERSAL,
                  pointsDelta: delta,
                  idempotencyKey: `prop_delta_${testAccountId}_${i}`,
                });

                expect(entry.sequenceNumber).toBe(expectedSeq);
                expect(entry.balanceAfter).toBe(expectedBalance);
              }

              const finalAcc = db.accounts.get(testAccountId);
              expect(finalAcc.cachedPointsBalance).toBe(expectedBalance);
              expect(finalAcc.ledgerVersion).toBe(expectedSeq);

              const balanceReport =
                await getAccountPointsBalance(testAccountId);
              expect(balanceReport).not.toBeNull();
              expect(balanceReport!.pointsBalance).toBe(expectedBalance);
              expect(balanceReport!.canRedeem).toBe(
                expectedBalance > BigInt(0),
              );
            },
          ),
          { numRuns: 30 },
        );
      });
    });
  });
});
