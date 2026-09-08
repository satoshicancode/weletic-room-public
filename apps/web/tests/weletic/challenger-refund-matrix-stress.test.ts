import {
  calculateRefundPointsReversal,
  processRefundPointsReversal,
} from "@/lib/weletic/loyalty/earn";
import {
  allocateReversalAcrossRemainingLines,
  LineReversalSnapshot,
} from "@/lib/weletic/loyalty/line-reversal-allocation";
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
  programs: Map<string, any>;
  outboxJobs: Map<string, any>;
  reconciliationIssues: Map<string, any>;
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
  programs: new Map(),
  outboxJobs: new Map(),
  reconciliationIssues: new Map(),
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
  db.programs.clear();
  db.outboxJobs.clear();
  db.reconciliationIssues.clear();
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
        for (const acc of db.accounts.values()) {
          if (!where.storeId || acc.storeId === where.storeId) {
            results.push({ ...acc });
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
// EMPIRICAL CHALLENGE SUITE: REFUND CLAWBACK STRESS & ADVERSARIAL MATRIX
// =============================================================================

describe("Empirical Challenger: Refund Clawback Engine Stress Matrix", () => {
  const STORE_ID = "wstore_stress_100";
  const ACCOUNT_ID = "wlacc_stress_100";
  const ORDER_ID = "word_stress_100";
  const GRANT_ID = "wgrant_stress_100";

  beforeEach(() => {
    resetDb();

    db.stores.set(STORE_ID, {
      id: STORE_ID,
      shopDomain: "stress-test.myshopify.com",
      status: "active",
      currency: "USD",
      installedIntegration: { workspaceId: "ws_stress_100" },
    });

    db.programs.set(STORE_ID, {
      id: "wlprog_stress",
      storeId: STORE_ID,
      status: "active",
      currency: "USD",
      pointsName: "Points",
      holdingPeriodDays: 0,
      rewardExchangeRate: 100,
    });

    db.accounts.set(ACCOUNT_ID, {
      id: ACCOUNT_ID,
      storeId: STORE_ID,
      programId: "wlprog_stress",
      shopifyCustomerId: "cust_stress_1",
      cachedPointsBalance: BigInt(5000),
      pendingPointsBalance: BigInt(0),
      lifetimePointsEarned: BigInt(5000),
      currentTierId: null,
      ledgerVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  // ===========================================================================
  // VECTOR 1: Multi-Step Partial Refund Cascades with Prime Quantities & Fractions
  // ===========================================================================
  describe("Vector 1: Multi-Step Partial Refund Cascades with Prime Quantities & Fractions", () => {
    it("converges exactly without rounding drift across a 7-stage prime cascade on a single line", async () => {
      // 17 items (prime) @ $13.37 each = 22,729 cents ($227.29)
      // Awarded points = 500 points (prime-fraction ratio 500 / 22729)
      const orderLineId = "line_prime_17";
      const lineAwarded = BigInt(500);
      const lineNet = BigInt(22729); // 17 * 1337 cents
      const lineQuantity = 17;

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

      db.orderLineEarns.set("le_prime_17", {
        id: "le_prime_17",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: lineQuantity,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_prime",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      const acc = db.accounts.get(ACCOUNT_ID);
      acc.cachedPointsBalance = lineAwarded;

      // 7 cascade stages: quantities [2, 3, 1, 4, 2, 3, 2] = 17 total
      const cascadeQuantities = [2, 3, 1, 4, 2, 3, 2];
      const cascadeAmounts = [
        BigInt(2674), // 2 * 1337
        BigInt(4011), // 3 * 1337
        BigInt(1337), // 1 * 1337
        BigInt(5348), // 4 * 1337
        BigInt(2674), // 2 * 1337
        BigInt(4011), // 3 * 1337
        BigInt(2674), // 2 * 1337
      ];

      let cumulativeReversed = BigInt(0);
      let prevReversed = BigInt(0);

      for (let i = 0; i < 7; i++) {
        const stepNum = i + 1;
        const refundId = `ref_prime_step_${stepNum}`;
        db.refunds.set(refundId, {
          id: refundId,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: cascadeAmounts[i],
          occurredAt: new Date(`2026-09-01T1${i}:00:00Z`),
        });
        db.refundLines.set(`rfl_prime_${stepNum}`, {
          id: `rfl_prime_${stepNum}`,
          refundId,
          orderLineId,
          shopAmount: cascadeAmounts[i],
          quantity: cascadeQuantities[i],
        });

        const res = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId,
        });

        expect(res).not.toBeNull();
        const stepDelta = BigInt(-res!.pointsDelta);
        cumulativeReversed += stepDelta;

        const currentLineEarn = db.orderLineEarns.get("le_prime_17");
        expect(currentLineEarn.reversedPoints).toBe(cumulativeReversed);

        // Strictly monotonic progression
        expect(cumulativeReversed).toBeGreaterThan(prevReversed);
        prevReversed = cumulativeReversed;
      }

      // Verification of total convergence
      expect(cumulativeReversed).toBe(lineAwarded);
      expect(db.orderLineEarns.get("le_prime_17").reversedPoints).toBe(
        lineAwarded,
      );
      expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));
    });

    it("converges across multi-line 7-stage cascade touching 3 distinct lines with prime unit prices", async () => {
      // Line A: Qty 13 @ $11.11 = 14,443 cents, awarded 400 pts
      // Line B: Qty 7 @ $23.45 = 16,415 cents, awarded 350 pts
      // Line C: Qty 5 @ $37.99 = 18,995 cents, awarded 250 pts
      // Total: 1,000 pts, subtotal 49,853 cents
      const grossPoints = BigInt(1000);
      const subtotal = BigInt(49853);

      db.grants.set(GRANT_ID, {
        id: GRANT_ID,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        grossPoints,
        pendingPoints: BigInt(0),
        settledPoints: grossPoints,
        reversedPoints: BigInt(0),
        status: "settled",
        eligibleSubtotalAmount: subtotal,
        orderTotalAmount: subtotal,
      });

      db.orderLineEarns.set("le_A", {
        id: "le_A",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId: "line_A",
        quantity: 13,
        lineNetAmount: BigInt(14443),
        awardedPoints: BigInt(400),
        reversedPoints: BigInt(0),
        isExcluded: false,
      });
      db.orderLineEarns.set("le_B", {
        id: "le_B",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId: "line_B",
        quantity: 7,
        lineNetAmount: BigInt(16415),
        awardedPoints: BigInt(350),
        reversedPoints: BigInt(0),
        isExcluded: false,
      });
      db.orderLineEarns.set("le_C", {
        id: "le_C",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId: "line_C",
        quantity: 5,
        lineNetAmount: BigInt(18995),
        awardedPoints: BigInt(250),
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_multi_prime",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = grossPoints;

      // 7 sequential multi-line refund operations:
      // Stage 1: Line A (qty 3, $33.33 = 3333)
      // Stage 2: Line B (qty 2, $46.90 = 4690)
      // Stage 3: Line A (qty 4, $44.44 = 4444) & Line C (qty 1, $37.99 = 3799)
      // Stage 4: Line B (qty 3, $70.35 = 7035)
      // Stage 5: Line C (qty 2, $75.98 = 7598)
      // Stage 6: Line A (qty 6, $66.66 = 6666) -> Line A complete (13/13, 14443)
      // Stage 7: Line B (qty 2, $46.90 = 4690) & Line C (qty 2, $75.98 = 7598) -> B and C complete
      const stages = [
        {
          id: "m_ref_1",
          amount: BigInt(3333),
          lines: [{ orderLineId: "line_A", qty: 3, amt: BigInt(3333) }],
        },
        {
          id: "m_ref_2",
          amount: BigInt(4690),
          lines: [{ orderLineId: "line_B", qty: 2, amt: BigInt(4690) }],
        },
        {
          id: "m_ref_3",
          amount: BigInt(8243),
          lines: [
            { orderLineId: "line_A", qty: 4, amt: BigInt(4444) },
            { orderLineId: "line_C", qty: 1, amt: BigInt(3799) },
          ],
        },
        {
          id: "m_ref_4",
          amount: BigInt(7035),
          lines: [{ orderLineId: "line_B", qty: 3, amt: BigInt(7035) }],
        },
        {
          id: "m_ref_5",
          amount: BigInt(7598),
          lines: [{ orderLineId: "line_C", qty: 2, amt: BigInt(7598) }],
        },
        {
          id: "m_ref_6",
          amount: BigInt(6666),
          lines: [{ orderLineId: "line_A", qty: 6, amt: BigInt(6666) }],
        },
        {
          id: "m_ref_7",
          amount: BigInt(12288),
          lines: [
            { orderLineId: "line_B", qty: 2, amt: BigInt(4690) },
            { orderLineId: "line_C", qty: 2, amt: BigInt(7598) },
          ],
        },
      ];

      let totalClawback = BigInt(0);
      for (let i = 0; i < stages.length; i++) {
        const stage = stages[i];
        db.refunds.set(stage.id, {
          id: stage.id,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: stage.amount,
          occurredAt: new Date(`2026-09-02T1${i}:00:00Z`),
        });
        stage.lines.forEach((l, idx) => {
          db.refundLines.set(`${stage.id}_l_${idx}`, {
            id: `${stage.id}_l_${idx}`,
            refundId: stage.id,
            orderLineId: l.orderLineId,
            shopAmount: l.amt,
            quantity: l.qty,
          });
        });

        const res = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId: stage.id,
        });
        expect(res).not.toBeNull();
        totalClawback += BigInt(-res!.pointsDelta);
      }

      // Assert each line reversed exactly 100% of its awarded points
      expect(db.orderLineEarns.get("le_A").reversedPoints).toBe(BigInt(400));
      expect(db.orderLineEarns.get("le_B").reversedPoints).toBe(BigInt(350));
      expect(db.orderLineEarns.get("le_C").reversedPoints).toBe(BigInt(250));
      expect(totalClawback).toBe(grossPoints); // Exactly 1000 points
      expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));
    });

    it("converges exactly in zero-decimal currency (JPY/VND) with large integer amounts across 5 stages", async () => {
      // 10 items @ ¥3,333 each = ¥33,330 total (no fractional minor units)
      // Awarded points = 77 points
      const orderLineId = "line_jpy_zero_dec";
      const lineAwarded = BigInt(77);
      const lineNet = BigInt(33330);
      const lineQuantity = 10;

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

      db.orderLineEarns.set("le_jpy", {
        id: "le_jpy",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: lineQuantity,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_jpy",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = lineAwarded;

      // 5 stages: quantities [2, 1, 3, 2, 2] = 10 units; cash [6666, 3333, 9999, 6666, 6666] = 33,330
      const qtys = [2, 1, 3, 2, 2];
      const amounts = [
        BigInt(6666),
        BigInt(3333),
        BigInt(9999),
        BigInt(6666),
        BigInt(6666),
      ];

      let totalReversed = BigInt(0);
      for (let i = 0; i < qtys.length; i++) {
        const refundId = `ref_jpy_step_${i + 1}`;
        db.refunds.set(refundId, {
          id: refundId,
          storeId: STORE_ID,
          orderId: ORDER_ID,
          shopAmount: amounts[i],
          occurredAt: new Date(`2026-09-02T1${i}:00:00Z`),
        });
        db.refundLines.set(`rfl_jpy_${i + 1}`, {
          id: `rfl_jpy_${i + 1}`,
          refundId,
          orderLineId,
          shopAmount: amounts[i],
          quantity: qtys[i],
        });

        const res = await processRefundPointsReversal({
          storeId: STORE_ID,
          refundId,
        });
        expect(res).not.toBeNull();
        totalReversed += BigInt(-res!.pointsDelta);
      }

      expect(totalReversed).toBe(lineAwarded);
      expect(db.orderLineEarns.get("le_jpy").reversedPoints).toBe(lineAwarded);
      expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));
    });

    it("property: arbitrary randomized prime cascades monotonically converge to exact awarded points", async () => {
      const primes = [7, 11, 13, 17, 19];
      for (const primeQty of primes) {
        const lineAwarded = BigInt(100 + ((primeQty * 13) % 250));
        const unitPrice = BigInt(1234);
        const lineNet = BigInt(primeQty) * unitPrice;
        const orderLineId = `line_p_${primeQty}`;
        const grantId = `grant_p_${primeQty}`;
        const orderId = `ord_p_${primeQty}`;
        const accountId = `acc_p_${primeQty}`;

        db.accounts.set(accountId, {
          id: accountId,
          storeId: STORE_ID,
          programId: "wlprog_stress",
          shopifyCustomerId: `cust_${primeQty}`,
          cachedPointsBalance: lineAwarded,
          pendingPointsBalance: BigInt(0),
          lifetimePointsEarned: lineAwarded,
          currentTierId: null,
          ledgerVersion: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        db.grants.set(grantId, {
          id: grantId,
          storeId: STORE_ID,
          orderId,
          grossPoints: lineAwarded,
          pendingPoints: BigInt(0),
          settledPoints: lineAwarded,
          reversedPoints: BigInt(0),
          status: "settled",
          eligibleSubtotalAmount: lineNet,
          orderTotalAmount: lineNet,
        });

        db.orderLineEarns.set(`le_p_${primeQty}`, {
          id: `le_p_${primeQty}`,
          grantId,
          storeId: STORE_ID,
          orderLineId,
          quantity: primeQty,
          lineNetAmount: lineNet,
          awardedPoints: lineAwarded,
          reversedPoints: BigInt(0),
          isExcluded: false,
        });

        db.orders.set(orderId, {
          id: orderId,
          storeId: STORE_ID,
          externalId: `ext_p_${primeQty}`,
          shopper: { loyaltyAccount: { id: accountId } },
        });

        // Split primeQty into 4 partial steps
        const step1 = Math.floor(primeQty / 4) || 1;
        const step2 = Math.floor(primeQty / 4) || 1;
        const step3 = Math.floor(primeQty / 4) || 1;
        const step4 = primeQty - (step1 + step2 + step3);
        const splitQtys = [step1, step2, step3, step4];

        let accumulated = BigInt(0);
        for (let s = 0; s < splitQtys.length; s++) {
          const q = splitQtys[s];
          const amt = BigInt(q) * unitPrice;
          const refId = `ref_p_${primeQty}_${s}`;
          db.refunds.set(refId, {
            id: refId,
            storeId: STORE_ID,
            orderId,
            shopAmount: amt,
            occurredAt: new Date(`2026-09-02T1${s}:00:00Z`),
          });
          db.refundLines.set(`rfl_p_${primeQty}_${s}`, {
            id: `rfl_p_${primeQty}_${s}`,
            refundId: refId,
            orderLineId,
            shopAmount: amt,
            quantity: q,
          });

          const res = await processRefundPointsReversal({
            storeId: STORE_ID,
            refundId: refId,
          });
          expect(res).not.toBeNull();
          accumulated += BigInt(-res!.pointsDelta);
        }

        expect(accumulated).toBe(lineAwarded);
        expect(db.orderLineEarns.get(`le_p_${primeQty}`).reversedPoints).toBe(
          lineAwarded,
        );
      }
    });
  });

  // ===========================================================================
  // VECTOR 2: Arbitrage Resistance (100% Qty Returned with $0 Cash Refund)
  // ===========================================================================
  describe("Vector 2: Arbitrage Resistance (Warranty Replacement & Cumulative Quantity Floor)", () => {
    it("reverses 100% of awarded points on a full warranty replacement ($0 cash refund, 100% quantity returned)", async () => {
      // 1 item bought for $150.00, awarded 150 points
      const orderLineId = "line_warranty_1";
      const lineAwarded = BigInt(150);
      const lineNet = BigInt(15000);

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

      db.orderLineEarns.set("le_warr", {
        id: "le_warr",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: 1,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_warr",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = lineAwarded;

      // Warranty replacement refund: Quantity = 1, cash amount = $0.00
      const refundId = "ref_warranty_replacement";
      db.refunds.set(refundId, {
        id: refundId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(0),
        occurredAt: new Date("2026-09-02T12:00:00Z"),
      });
      db.refundLines.set("rfl_warr", {
        id: "rfl_warr",
        refundId,
        orderLineId,
        shopAmount: BigInt(0),
        quantity: 1,
      });

      const res = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId,
      });

      // Assert 100% of points are reversed via cumulative quantity floor
      expect(res).not.toBeNull();
      expect(res?.pointsDelta).toBe(BigInt(-150));
      expect(db.orderLineEarns.get("le_warr").reversedPoints).toBe(lineAwarded);
      expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));
    });

    it("reverses exact proportional points on partial warranty replacement ($0 cash refund for 3 out of 5 items)", async () => {
      // 5 items bought for $250.00 ($50 each), awarded 250 points
      const orderLineId = "line_partial_warranty";
      const lineAwarded = BigInt(250);
      const lineNet = BigInt(25000);
      const lineQuantity = 5;

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

      db.orderLineEarns.set("le_part_warr", {
        id: "le_part_warr",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: lineQuantity,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_pwarr",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = lineAwarded;

      // Stage 1: Return 3 items for $0 cash
      const ref1Id = "ref_warr_3_of_5";
      db.refunds.set(ref1Id, {
        id: ref1Id,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(0),
        occurredAt: new Date("2026-09-02T13:00:00Z"),
      });
      db.refundLines.set("rfl_warr_3", {
        id: "rfl_warr_3",
        refundId: ref1Id,
        orderLineId,
        shopAmount: BigInt(0),
        quantity: 3,
      });

      const res1 = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: ref1Id,
      });

      // 3/5 of 250 points = 150 points reversed
      expect(res1?.pointsDelta).toBe(BigInt(-150));
      expect(db.orderLineEarns.get("le_part_warr").reversedPoints).toBe(
        BigInt(150),
      );

      // Stage 2: Return remaining 2 items for $0 cash
      const ref2Id = "ref_warr_2_of_5";
      db.refunds.set(ref2Id, {
        id: ref2Id,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(0),
        occurredAt: new Date("2026-09-02T14:00:00Z"),
      });
      db.refundLines.set("rfl_warr_2", {
        id: "rfl_warr_2",
        refundId: ref2Id,
        orderLineId,
        shopAmount: BigInt(0),
        quantity: 2,
      });

      const res2 = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: ref2Id,
      });

      // Remaining 100 points reversed -> 250 total
      expect(res2?.pointsDelta).toBe(BigInt(-100));
      expect(db.orderLineEarns.get("le_part_warr").reversedPoints).toBe(
        BigInt(250),
      );
      expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));
    });

    it("prevents arbitrage on deeply discounted order: 100% quantity returned with $0 cash reverses 100% awarded points", async () => {
      // Order line was retail $500, with $450 coupon, net cash paid = $50.
      // But earned 500 points (pre-discount gross points promo).
      const orderLineId = "line_deep_discount";
      const lineAwarded = BigInt(500);
      const lineNet = BigInt(5000); // Only $50 paid
      const lineQuantity = 1;

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

      db.orderLineEarns.set("le_deep", {
        id: "le_deep",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: lineQuantity,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_deep",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = lineAwarded;

      // Merchant restock fee or warranty return results in $0 cash refund
      const refundId = "ref_deep_discount_zero_cash";
      db.refunds.set(refundId, {
        id: refundId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(0),
        occurredAt: new Date("2026-09-02T15:00:00Z"),
      });
      db.refundLines.set("rfl_deep", {
        id: "rfl_deep",
        refundId,
        orderLineId,
        shopAmount: BigInt(0),
        quantity: 1,
      });

      const res = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId,
      });

      // Quantity floor guarantees full 500 points are clawed back
      expect(res?.pointsDelta).toBe(BigInt(-500));
      expect(db.orderLineEarns.get("le_deep").reversedPoints).toBe(BigInt(500));
    });

    it("does NOT reverse points if both cash refund and returned quantity are 0", async () => {
      const orderLineId = "line_no_op";
      const lineAwarded = BigInt(100);
      const lineNet = BigInt(10000);

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

      db.orderLineEarns.set("le_noop", {
        id: "le_noop",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: 1,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_noop",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      // Administrative 0/0 refund
      const refundId = "ref_admin_zero";
      db.refunds.set(refundId, {
        id: refundId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(0),
        occurredAt: new Date("2026-09-02T16:00:00Z"),
      });
      db.refundLines.set("rfl_noop", {
        id: "rfl_noop",
        refundId,
        orderLineId,
        shopAmount: BigInt(0),
        quantity: 0,
      });

      const res = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId,
      });

      expect(res).toBeNull();
      expect(db.orderLineEarns.get("le_noop").reversedPoints).toBe(BigInt(0));
    });
  });

  // ===========================================================================
  // VECTOR 3: Over-Refund Clamp
  // ===========================================================================
  describe("Vector 3: Over-Refund Clamp (Refund Exceeding Line Net Amount Bounded to Awarded Points)", () => {
    it("strictly bounds clawback to awarded points when refund amount exceeds line net amount", async () => {
      // Line net = $40.00 (4,000 cents), awarded = 40 points
      const orderLineId = "line_over_refund";
      const lineAwarded = BigInt(40);
      const lineNet = BigInt(4000);

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

      db.orderLineEarns.set("le_over", {
        id: "le_over",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: 1,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_over",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = lineAwarded;

      // Merchant accidentally refunds $60.00 (6,000 cents) on $40.00 line
      const refundId = "ref_over_60";
      db.refunds.set(refundId, {
        id: refundId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(6000),
        occurredAt: new Date("2026-09-02T17:00:00Z"),
      });
      db.refundLines.set("rfl_over", {
        id: "rfl_over",
        refundId,
        orderLineId,
        shopAmount: BigInt(6000),
        quantity: 1,
      });

      const res = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId,
      });

      // Clamped to exactly 40 points, NEVER 60
      expect(res?.pointsDelta).toBe(BigInt(-40));
      expect(db.orderLineEarns.get("le_over").reversedPoints).toBe(lineAwarded);
      expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(0));
    });

    it("maintains clamp across sequential split over-refunds without exceeding awarded points", async () => {
      const orderLineId = "line_split_over";
      const lineAwarded = BigInt(50);
      const lineNet = BigInt(5000);

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

      db.orderLineEarns.set("le_split_over", {
        id: "le_split_over",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: 1,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_split_over",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = lineAwarded;

      // Stage 1: Cash-only partial refund of $35.00 (3,500 cents, qty 0 returned) -> 35 points
      const ref1Id = "ref_so_1";
      db.refunds.set(ref1Id, {
        id: ref1Id,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(3500),
        occurredAt: new Date("2026-09-02T18:00:00Z"),
      });
      db.refundLines.set("rfl_so_1", {
        id: "rfl_so_1",
        refundId: ref1Id,
        orderLineId,
        shopAmount: BigInt(3500),
        quantity: 0,
      });

      const res1 = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: ref1Id,
      });
      expect(res1?.pointsDelta).toBe(BigInt(-35));

      // Stage 2: Refund another $35.00 (cumulative $70.00 on $50.00 line)
      const ref2Id = "ref_so_2";
      db.refunds.set(ref2Id, {
        id: ref2Id,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(3500),
        occurredAt: new Date("2026-09-02T19:00:00Z"),
      });
      db.refundLines.set("rfl_so_2", {
        id: "rfl_so_2",
        refundId: ref2Id,
        orderLineId,
        shopAmount: BigInt(3500),
        quantity: 0,
      });

      const res2 = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: ref2Id,
      });
      // Should claw back remaining 15 points (50 - 35 = 15)
      expect(res2?.pointsDelta).toBe(BigInt(-15));
      expect(db.orderLineEarns.get("le_split_over").reversedPoints).toBe(
        BigInt(50),
      );

      // Stage 3: Extra goodwill refund of $20.00 (cumulative $90.00)
      const ref3Id = "ref_so_3";
      db.refunds.set(ref3Id, {
        id: ref3Id,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(2000),
        occurredAt: new Date("2026-09-02T20:00:00Z"),
      });
      db.refundLines.set("rfl_so_3", {
        id: "rfl_so_3",
        refundId: ref3Id,
        orderLineId,
        shopAmount: BigInt(2000),
        quantity: 0,
      });

      const res3 = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: ref3Id,
      });
      // Should return null / zero additional clawback since capacity is 0
      expect(res3).toBeNull();
      expect(db.orderLineEarns.get("le_split_over").reversedPoints).toBe(
        BigInt(50),
      );
    });

    it("clamps returned quantity when merchant inputs returned quantity exceeding original line quantity", async () => {
      // 2 items bought, awarded 100 points
      const orderLineId = "line_qty_over";
      const lineAwarded = BigInt(100);
      const lineNet = BigInt(10000);

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

      db.orderLineEarns.set("le_qty_over", {
        id: "le_qty_over",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: 2, // only 2 items originally
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_qty_over",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = lineAwarded;

      // Merchant inputs quantity = 5 (exceeding lineQuantity of 2)
      const refundId = "ref_qty_over_5";
      db.refunds.set(refundId, {
        id: refundId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(10000),
        occurredAt: new Date("2026-09-02T20:30:00Z"),
      });
      db.refundLines.set("rfl_qty_over", {
        id: "rfl_qty_over",
        refundId,
        orderLineId,
        shopAmount: BigInt(10000),
        quantity: 5,
      });

      const res = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId,
      });

      // Bounded strictly to lineAwarded (100 points), not (5/2)*100 = 250 points
      expect(res?.pointsDelta).toBe(BigInt(-100));
      expect(db.orderLineEarns.get("le_qty_over").reversedPoints).toBe(
        BigInt(100),
      );
    });

    it("handles extreme administrative over-refund ($1,000,000 on $10 line) without overflow", async () => {
      const orderLineId = "line_extreme_over";
      const lineAwarded = BigInt(10);
      const lineNet = BigInt(1000); // $10.00

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

      db.orderLineEarns.set("le_extreme", {
        id: "le_extreme",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId,
        quantity: 1,
        lineNetAmount: lineNet,
        awardedPoints: lineAwarded,
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_extreme",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      // $1,000,000 refund (100,000,000 cents)
      const refundId = "ref_million";
      db.refunds.set(refundId, {
        id: refundId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(100000000),
        occurredAt: new Date("2026-09-02T21:00:00Z"),
      });
      db.refundLines.set("rfl_million", {
        id: "rfl_million",
        refundId,
        orderLineId,
        shopAmount: BigInt(100000000),
        quantity: 1,
      });

      const res = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId,
      });

      expect(res?.pointsDelta).toBe(BigInt(-10));
      expect(db.orderLineEarns.get("le_extreme").reversedPoints).toBe(
        BigInt(10),
      );
    });

    it("pure calculateRefundPointsReversal clamps over-refunds cleanly", () => {
      const result = calculateRefundPointsReversal({
        originalGrant: {
          id: "grant_pure_over",
          grossPoints: BigInt(100),
          pendingPoints: BigInt(0),
          settledPoints: BigInt(100),
          reversedPoints: BigInt(0),
          eligibleSubtotalAmount: BigInt(10000),
          lineEarns: [
            {
              id: "le_pure_1",
              orderLineId: "line_pure_1",
              lineNetAmount: BigInt(10000),
              awardedPoints: BigInt(100),
              reversedPoints: BigInt(0),
              isExcluded: false,
            },
          ],
        },
        refundedLines: [
          {
            orderLineId: "line_pure_1",
            cumulativeShopAmount: BigInt(50000), // 500% refund
          },
        ],
      });

      expect(result.totalPointsToClawback).toBe(BigInt(100));
      expect(result.lineClawbacks[0].lineClawback).toBe(BigInt(100));
    });
  });

  // ===========================================================================
  // VECTOR 4: Non-Line Order-Level Adjustments & Hare-Niemeyer Conservation
  // ===========================================================================
  describe("Vector 4: Non-Line Order-Level Adjustments & Hare-Niemeyer Conservation", () => {
    it("conserves points exactly when allocating prime clawback across 5 prime capacity lines", () => {
      const lineEarns: LineReversalSnapshot[] = [
        {
          id: "l1",
          orderLineId: "line_01",
          storeId: STORE_ID,
          awardedPoints: BigInt(17),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
        {
          id: "l2",
          orderLineId: "line_02",
          storeId: STORE_ID,
          awardedPoints: BigInt(23),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
        {
          id: "l3",
          orderLineId: "line_03",
          storeId: STORE_ID,
          awardedPoints: BigInt(41),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
        {
          id: "l4",
          orderLineId: "line_04",
          storeId: STORE_ID,
          awardedPoints: BigInt(73),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
        {
          id: "l5",
          orderLineId: "line_05",
          storeId: STORE_ID,
          awardedPoints: BigInt(97),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
      ];

      const grossPoints = BigInt(251); // 17+23+41+73+97
      const pointsToAllocate = BigInt(37); // prime

      const allocations = allocateReversalAcrossRemainingLines({
        grantId: "grant_hn_test",
        storeId: STORE_ID,
        grossPoints,
        alreadyReversedPoints: BigInt(0),
        pointsToAllocate,
        lineEarns,
      });

      // 1. Strict point conservation: sum of allocated points equals pointsToAllocate
      const sumAllocated = allocations.reduce(
        (sum, a) => sum + a.pointsToReverse,
        BigInt(0),
      );
      expect(sumAllocated).toBe(pointsToAllocate);

      // 2. Capacity bounds: no line receives more than its remaining capacity
      allocations.forEach((a) => {
        expect(a.pointsToReverse).toBeLessThanOrEqual(
          a.awardedPoints - a.reversedPoints,
        );
        expect(a.pointsToReverse).toBeGreaterThan(BigInt(0));
      });

      // 3. Stable tie-break sorting: result sorted by orderLineId ascending
      for (let i = 1; i < allocations.length; i++) {
        expect(
          allocations[i].orderLineId > allocations[i - 1].orderLineId,
        ).toBe(true);
      }
    });

    it("processes non-line order-level adjustment refund through processRefundPointsReversal with exact line persistence", async () => {
      // 3 lines: 50, 100, 150 points (total 300 points, subtotal $300.00 = 30,000 cents)
      const grossPoints = BigInt(300);
      const subtotal = BigInt(30000);

      db.grants.set(GRANT_ID, {
        id: GRANT_ID,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        grossPoints,
        pendingPoints: BigInt(0),
        settledPoints: grossPoints,
        reversedPoints: BigInt(0),
        status: "settled",
        eligibleSubtotalAmount: subtotal,
        orderTotalAmount: subtotal,
      });

      db.orderLineEarns.set("le_adj_1", {
        id: "le_adj_1",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId: "line_adj_1",
        quantity: 1,
        lineNetAmount: BigInt(5000),
        awardedPoints: BigInt(50),
        reversedPoints: BigInt(0),
        isExcluded: false,
      });
      db.orderLineEarns.set("le_adj_2", {
        id: "le_adj_2",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId: "line_adj_2",
        quantity: 1,
        lineNetAmount: BigInt(10000),
        awardedPoints: BigInt(100),
        reversedPoints: BigInt(0),
        isExcluded: false,
      });
      db.orderLineEarns.set("le_adj_3", {
        id: "le_adj_3",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId: "line_adj_3",
        quantity: 1,
        lineNetAmount: BigInt(15000),
        awardedPoints: BigInt(150),
        reversedPoints: BigInt(0),
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_adj",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = grossPoints;

      // Order-level adjustment refund: $75.00 (7,500 cents), NO refund lines
      const refundId = "ref_order_level_75";
      db.refunds.set(refundId, {
        id: refundId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(7500),
        occurredAt: new Date("2026-09-02T22:00:00Z"),
      });
      // db.refundLines is left empty for this refund

      const res = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId,
      });

      expect(res).not.toBeNull();
      // Total points to clawback: ($75 / $300) * 300 = 75 points
      expect(res?.pointsDelta).toBe(BigInt(-75));

      // Check line reversals:
      // Line 1: (75 * 50) / 300 = 12.5 -> base 12, rem 150
      // Line 2: (75 * 100) / 300 = 25.0 -> base 25, rem 0
      // Line 3: (75 * 150) / 300 = 37.5 -> base 37, rem 150
      // Largest remainder goes to Line 1 (rem 150, tie broken by line_adj_1 < line_adj_3) -> 13
      // Total: 13 + 25 + 37 = 75 points!
      const l1Rev = db.orderLineEarns.get("le_adj_1").reversedPoints;
      const l2Rev = db.orderLineEarns.get("le_adj_2").reversedPoints;
      const l3Rev = db.orderLineEarns.get("le_adj_3").reversedPoints;

      expect(l1Rev + l2Rev + l3Rev).toBe(BigInt(75));
      expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(225));
    });

    it("allocates adjustment to remaining lines when one line is already fully refunded", async () => {
      // 2 lines: Line 1 (100 pts), Line 2 (100 pts).
      // Line 1 is already fully refunded (reversedPoints = 100).
      const grossPoints = BigInt(200);
      const subtotal = BigInt(20000);

      db.grants.set(GRANT_ID, {
        id: GRANT_ID,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        grossPoints,
        pendingPoints: BigInt(0),
        settledPoints: grossPoints,
        reversedPoints: BigInt(100),
        status: "settled",
        eligibleSubtotalAmount: subtotal,
        orderTotalAmount: subtotal,
      });

      db.orderLineEarns.set("le_adj_rem_1", {
        id: "le_adj_rem_1",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId: "line_adj_rem_1",
        quantity: 1,
        lineNetAmount: BigInt(10000),
        awardedPoints: BigInt(100),
        reversedPoints: BigInt(100), // fully reversed
        isExcluded: false,
      });
      db.orderLineEarns.set("le_adj_rem_2", {
        id: "le_adj_rem_2",
        grantId: GRANT_ID,
        storeId: STORE_ID,
        orderLineId: "line_adj_rem_2",
        quantity: 1,
        lineNetAmount: BigInt(10000),
        awardedPoints: BigInt(100),
        reversedPoints: BigInt(0), // 100 capacity remaining
        isExcluded: false,
      });

      db.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        externalId: "ext_ord_adj_rem",
        shopper: { loyaltyAccount: { id: ACCOUNT_ID } },
      });

      db.accounts.get(ACCOUNT_ID).cachedPointsBalance = BigInt(100);

      // Add prior refund of $100 for Line 1 in history
      const priorRefId = "ref_prior_line1";
      db.refunds.set(priorRefId, {
        id: priorRefId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(10000),
        occurredAt: new Date("2026-09-02T10:00:00Z"),
      });

      // New non-line adjustment of $50 (cumulative order refund = $150 / $200 = 150 points)
      // incremental = 150 - 100 = 50 points
      const adjRefId = "ref_adj_second";
      db.refunds.set(adjRefId, {
        id: adjRefId,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        shopAmount: BigInt(5000),
        occurredAt: new Date("2026-09-02T11:00:00Z"),
      });

      const res = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: adjRefId,
      });

      expect(res?.pointsDelta).toBe(BigInt(-50));
      // Line 1 had 0 capacity remaining, so Line 2 took all 50 points
      expect(db.orderLineEarns.get("le_adj_rem_1").reversedPoints).toBe(
        BigInt(100),
      );
      expect(db.orderLineEarns.get("le_adj_rem_2").reversedPoints).toBe(
        BigInt(50),
      );
      expect(db.accounts.get(ACCOUNT_ID).cachedPointsBalance).toBe(BigInt(50));
    });

    it("property: Hare-Niemeyer allocation strictly conserves points and obeys capacity across random configurations", () => {
      fc.assert(
        fc.property(
          fc
            .array(
              fc.record({
                capacity: fc.integer({ min: 1, max: 10000 }),
                alreadyReversed: fc.integer({ min: 0, max: 5000 }),
              }),
              { minLength: 2, maxLength: 8 },
            )
            .chain((lines) => {
              const adjustedLines = lines.map((l) => ({
                awarded: l.capacity + l.alreadyReversed,
                reversed: l.alreadyReversed,
                capacity: l.capacity,
              }));
              const totalCapacity = adjustedLines.reduce(
                (sum, l) => sum + l.capacity,
                0,
              );
              return fc.record({
                lines: fc.constant(adjustedLines),
                pointsToAllocate: fc.integer({ min: 1, max: totalCapacity }),
              });
            }),
          ({ lines, pointsToAllocate }) => {
            const lineEarns: LineReversalSnapshot[] = lines.map((l, idx) => ({
              id: `le_prop_${idx}`,
              orderLineId: `line_prop_${String(idx).padStart(2, "0")}`,
              storeId: STORE_ID,
              awardedPoints: BigInt(l.awarded),
              reversedPoints: BigInt(l.reversed),
              isExcluded: false,
            }));

            const grossPoints = lines.reduce(
              (sum, l) => sum + BigInt(l.awarded),
              BigInt(0),
            );
            const alreadyReversedPoints = lines.reduce(
              (sum, l) => sum + BigInt(l.reversed),
              BigInt(0),
            );

            const allocations = allocateReversalAcrossRemainingLines({
              grantId: "grant_prop_hn",
              storeId: STORE_ID,
              grossPoints,
              alreadyReversedPoints,
              pointsToAllocate: BigInt(pointsToAllocate),
              lineEarns,
            });

            // Invariant 1: Conservation
            const totalAllocated = allocations.reduce(
              (sum, a) => sum + a.pointsToReverse,
              BigInt(0),
            );
            expect(totalAllocated).toBe(BigInt(pointsToAllocate));

            // Invariant 2: Capacity bounded
            allocations.forEach((a) => {
              expect(a.pointsToReverse).toBeLessThanOrEqual(
                a.awardedPoints - a.reversedPoints,
              );
              expect(a.pointsToReverse).toBeGreaterThan(BigInt(0));
            });

            // Invariant 3: Ascending sort order
            for (let i = 1; i < allocations.length; i++) {
              expect(
                allocations[i].orderLineId > allocations[i - 1].orderLineId,
              ).toBe(true);
            }
          },
        ),
        { numRuns: 150 },
      );
    });

    it("throws when requested reversal exceeds total remaining capacity", () => {
      const lineEarns: LineReversalSnapshot[] = [
        {
          id: "l1",
          orderLineId: "line_01",
          storeId: STORE_ID,
          awardedPoints: BigInt(10),
          reversedPoints: BigInt(5),
          isExcluded: false,
        },
      ];

      expect(() =>
        allocateReversalAcrossRemainingLines({
          grantId: "grant_err_cap",
          storeId: STORE_ID,
          grossPoints: BigInt(10),
          alreadyReversedPoints: BigInt(5),
          pointsToAllocate: BigInt(6), // remaining capacity is 5
          lineEarns,
        }),
      ).toThrow("Line reversal capacity is insufficient");
    });
  });
});
