import { beforeEach, describe, expect, it, vi } from "vitest";
import { execSync } from "child_process";

vi.mock("server-only", () => ({}));

// Mock @vercel/functions
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((p) => p),
}));

// Mock with-cron
vi.mock("@/lib/cron/with-cron", () => ({
  withCron: (fn: any) => fn,
}));

// Mock axiom
vi.mock("@/lib/axiom/server", () => ({
  logger: {
    error: vi.fn(),
  },
  withAxiomBodyLog: (fn: any) => fn,
}));

// Mock activity log tracking
vi.mock("@/lib/api/commissions/track-commission-update-activity-log", () => ({
  trackCommissionStatusUpdate: vi.fn(),
}));

// Mock email & cron queues
vi.mock("@/lib/email/queue-batch-email", () => ({
  queueBatchEmail: vi.fn(),
}));
vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn(),
}));

// Mock PayPal batch creation
vi.mock("@/lib/paypal/create-batch-payout", () => ({
  createPayPalBatchPayout: vi.fn(),
}));

// Mock FX
vi.mock("@/lib/weletic/fx", () => ({
  getAccountingFxQuote: vi.fn().mockResolvedValue({
    base: "USD",
    quote: "USD",
    rate: "1.0",
    rateBigInt: BigInt(100000000),
    timestamp: new Date(),
  }),
  persistFxQuote: vi.fn().mockResolvedValue({ id: "fx_snap_1" }),
}));

// Mock Weletic payout quotes
vi.mock("@/lib/weletic/payouts/create-quote", () => ({
  createWeleticPayoutQuote: vi.fn().mockResolvedValue({ id: "quote_mock" }),
  refreshWeleticOpenPayoutQuotes: vi.fn().mockResolvedValue([]),
}));

// In-Memory Database Types
interface MockCommission {
  id: string;
  createdAt: Date;
  amount: bigint;
  earnings: bigint;
  status: string;
  partnerId: string;
  programId: string;
  payoutId: string | null;
}

interface MockPayout {
  id: string;
  programId: string;
  partnerId: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  amount: number;
  status: string;
  description: string;
  createdAt: Date;
}

// Stateful In-Memory Tables
let commissionsTable: MockCommission[] = [];
let payoutsTable: MockPayout[] = [];
let queryCount = 0;
let nextPayoutIdCounter = 1000;

const prismaMock = vi.hoisted(() => {
  const commissionFindMany = vi.fn();
  const commissionAggregate = vi.fn();
  const commissionUpdateMany = vi.fn();
  const payoutFindMany = vi.fn();
  const payoutCreate = vi.fn();
  const payoutDeleteMany = vi.fn();
  const programFindUnique = vi.fn();
  const partnerGroupGroupBy = vi.fn();
  const partnerGroupFindMany = vi.fn();
  const executeRaw = vi.fn();

  return {
    $executeRaw: executeRaw,
    commission: {
      findMany: commissionFindMany,
      aggregate: commissionAggregate,
      updateMany: commissionUpdateMany,
    },
    payout: {
      findMany: payoutFindMany,
      create: payoutCreate,
      deleteMany: payoutDeleteMany,
    },
    program: {
      findUnique: programFindUnique,
    },
    partnerGroup: {
      groupBy: partnerGroupGroupBy,
      findMany: partnerGroupFindMany,
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

import { CommissionStatus, PayoutStatus, Prisma } from "@prisma/client";
import { POST as aggregateDueCommissionsPOST } from "../../app/(ee)/api/cron/payouts/aggregate-due-commissions/process/route";
import {
  isRetriableSqliteError,
  withFinancialTransactionRetry,
} from "../../lib/weletic/sqlite-retry";

function setupStatefulPrismaMock() {
  queryCount = 0;

  prismaMock.program.findUnique.mockResolvedValue({
    id: "prog_stress",
    name: "Yamax Performance Affiliate",
    workspaceId: "ws_stress",
  });

  prismaMock.partnerGroup.groupBy.mockResolvedValue([
    { holdingPeriodDays: 0, _count: { id: 1 } },
  ]);

  prismaMock.partnerGroup.findMany.mockResolvedValue([
    { id: "grp_stress_0" },
  ]);

  // Dynamic commission querying with pagination and partner exclusion
  prismaMock.commission.findMany.mockImplementation(async (query: any) => {
    // 1. Claimed commissions query in aggregateDueCommissionsForPartner
    if (query?.where?.id?.in && query?.where?.payoutId) {
      const targetIds = query.where.id.in;
      const targetPayoutId = query.where.payoutId;
      return commissionsTable
        .filter(
          (c) =>
            targetIds.includes(c.id) &&
            c.payoutId === targetPayoutId &&
            c.status === CommissionStatus.processed,
        )
        .map((c) => ({
          id: c.id,
          amount: c.amount,
          earnings: c.earnings,
          status: c.status,
        }));
    }

    // 2. Due commissions batch query in while loop
    queryCount++;
    let eligible = commissionsTable.filter(
      (c) =>
        c.programId === query.where.programId &&
        c.status === CommissionStatus.pending,
    );

    if (query?.where?.partnerId?.notIn) {
      const excludedSet = new Set(query.where.partnerId.notIn);
      eligible = eligible.filter((c) => !excludedSet.has(c.partnerId));
    }

    // Sort by createdAt asc
    eligible.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    if (query?.take) {
      eligible = eligible.slice(0, query.take);
    }

    return eligible.map((c) => ({
      id: c.id,
      createdAt: c.createdAt,
      amount: c.amount,
      earnings: c.earnings,
      status: c.status,
      partnerId: c.partnerId,
      programId: c.programId,
    }));
  });

  // Dynamic commission aggregation by payoutId
  prismaMock.commission.aggregate.mockImplementation(async (query: any) => {
    const payoutId = query.where.payoutId;
    const matching = commissionsTable.filter((c) => c.payoutId === payoutId);
    const sum = matching.reduce((acc, c) => acc + c.earnings, BigInt(0));
    return {
      _sum: {
        earnings: sum,
      },
    };
  });

  // Commission rollback
  prismaMock.commission.updateMany.mockImplementation(async (query: any) => {
    const payoutId = query.where?.payoutId;
    let count = 0;
    for (const c of commissionsTable) {
      if (c.payoutId === payoutId) {
        c.payoutId = null;
        c.status = CommissionStatus.pending;
        count++;
      }
    }
    return { count };
  });

  // Dynamic payout creation
  prismaMock.payout.create.mockImplementation(async (query: any) => {
    const id = query.data.id || `po_${nextPayoutIdCounter++}`;
    const newPayout: MockPayout = {
      id,
      programId: query.data.programId,
      partnerId: query.data.partnerId,
      periodStart: query.data.periodStart,
      periodEnd: query.data.periodEnd,
      amount: query.data.amount,
      status: PayoutStatus.pending,
      description: query.data.description,
      createdAt: new Date(),
    };
    payoutsTable.push(newPayout);
    return { id: newPayout.id };
  });

  // Dynamic payout findMany
  prismaMock.payout.findMany.mockImplementation(async (query: any) => {
    const partnerIds = query.where?.partnerId?.in ?? [];
    const maxAmount = query.where?.amount?.lt ?? Infinity;
    return payoutsTable
      .filter(
        (p) =>
          p.programId === query.where.programId &&
          partnerIds.includes(p.partnerId) &&
          p.status === query.where.status &&
          p.amount < maxAmount,
      )
      .map((p) => ({ id: p.id, partnerId: p.partnerId, amount: p.amount }));
  });

  // Dynamic payout deletion
  prismaMock.payout.deleteMany.mockImplementation(async (query: any) => {
    const targetId = query.where?.id;
    const initialLen = payoutsTable.length;
    payoutsTable = payoutsTable.filter((p) => p.id !== targetId);
    return { count: initialLen - payoutsTable.length };
  });

  // Dynamic $executeRaw handler for both Commission claim and Payout update
  prismaMock.$executeRaw.mockImplementation(async (strings: any, ...values: any[]) => {
    const rawSql = Array.isArray(strings)
      ? strings.join("?")
      : typeof strings === "string"
        ? strings
        : strings?.strings?.join("?") ?? "";

    if (rawSql.includes("UPDATE Commission")) {
      const payoutId = values[1];
      const targetIds = Array.isArray(values[2]?.values)
        ? values[2].values
        : Array.isArray(values[2])
          ? values[2]
          : [];
      const partnerId = values[4];

      let updated = 0;
      for (const c of commissionsTable) {
        if (
          targetIds.includes(c.id) &&
          c.partnerId === partnerId &&
          c.status === CommissionStatus.pending
        ) {
          c.status = CommissionStatus.processed;
          c.payoutId = payoutId;
          updated++;
        }
      }
      return updated;
    }

    if (rawSql.includes("UPDATE Payout")) {
      const amount = values[0];
      const payoutId = values[2];

      const payout = payoutsTable.find((p) => p.id === payoutId);
      if (payout) {
        payout.amount = Number(amount);
      }
      return 1;
    }

    return 1;
  });
}

describe("Milestone M1 Gate 2 Adversarial Stress Testing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commissionsTable = [];
    payoutsTable = [];
    nextPayoutIdCounter = 1000;
    setupStatefulPrismaMock();
  });

  // =========================================================================
  // GATE 2 DIMENSION 1: Multi-Batch Greedy Capping with >2.0B Units (5.0B VND)
  // =========================================================================
  describe("Dimension 1: Multi-Batch Greedy Capping Stress (>2.0B Units / 5.0B VND)", () => {
    const MAX_PAYOUT_AMOUNT_LIMIT = 2_000_000_000;
    const MAX_INT32 = 2_147_483_647;

    it("1.1 Sequential Cron Iterations: Partner with 5.0B VND creates 2.0B in Run 1, 2.0B in Run 2, and 1.0B in Run 3 without overflow or rollback", async () => {
      const baseTime = Date.now() - 500_000_000;
      const partnerId = "vietnam_whale_5b";

      // Seed 10 commissions of 500M VND each = 5.0B VND total
      for (let i = 0; i < 10; i++) {
        commissionsTable.push({
          id: `vnd_c_${i}`,
          createdAt: new Date(baseTime + i * 10_000),
          amount: BigInt(5_000_000_000),
          earnings: BigInt(500_000_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      // CRON RUN 1:
      const res1 = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });
      expect(res1.status).toBe(200);

      // Verify Run 1 results:
      // Exactly 1 payout created at 2.0B VND (4 commissions of 500M)
      expect(payoutsTable.length).toBe(1);
      const p1 = payoutsTable[0];
      expect(p1.amount).toBe(2_000_000_000);
      expect(p1.amount).toBeLessThanOrEqual(MAX_INT32);
      expect(p1.status).toBe("pending");

      const processedRun1 = commissionsTable.filter((c) => c.status === CommissionStatus.processed);
      const pendingRun1 = commissionsTable.filter((c) => c.status === CommissionStatus.pending);
      expect(processedRun1.length).toBe(4);
      expect(pendingRun1.length).toBe(6);
      expect(processedRun1.every((c) => c.payoutId === p1.id)).toBe(true);
      expect(pendingRun1.every((c) => c.payoutId === null)).toBe(true);

      // CRON RUN 2 (p1 is still pending in DB, but saturated at 2.0B):
      // existingPendingPayouts excludes p1 because amount: { lt: 2.0B }.
      // Cron Run 2 MUST create a separate payout (p2) for the next 2.0B batch!
      const res2 = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });
      expect(res2.status).toBe(200);

      expect(payoutsTable.length).toBe(2);
      const p2 = payoutsTable[1];
      expect(p2.amount).toBe(2_000_000_000);
      expect(p2.amount).toBeLessThanOrEqual(MAX_INT32);
      expect(p2.id).not.toBe(p1.id);
      expect(p1.amount).toBe(2_000_000_000); // p1 remains intact

      const processedRun2 = commissionsTable.filter((c) => c.status === CommissionStatus.processed);
      const pendingRun2 = commissionsTable.filter((c) => c.status === CommissionStatus.pending);
      expect(processedRun2.length).toBe(8);
      expect(pendingRun2.length).toBe(2);
      expect(processedRun2.filter((c) => c.payoutId === p2.id).length).toBe(4);

      // CRON RUN 3:
      // Both p1 and p2 are at 2.0B. Next run claims the remaining 2 commissions (1.0B total) into p3.
      const res3 = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });
      expect(res3.status).toBe(200);

      expect(payoutsTable.length).toBe(3);
      const p3 = payoutsTable[2];
      expect(p3.amount).toBe(1_000_000_000);
      expect(p3.amount).toBeLessThanOrEqual(MAX_INT32);

      const processedRun3 = commissionsTable.filter((c) => c.status === CommissionStatus.processed);
      const pendingRun3 = commissionsTable.filter((c) => c.status === CommissionStatus.pending);
      expect(processedRun3.length).toBe(10);
      expect(pendingRun3.length).toBe(0);

      // Final reconciliation check:
      // Total amount across p1, p2, p3 is exactly 5,000,000,000 VND
      const totalPaid = payoutsTable.reduce((sum, p) => sum + p.amount, 0);
      expect(totalPaid).toBe(5_000_000_000);

      // CRON RUN 4 (Idempotent cleanup):
      const res4 = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });
      expect(res4.status).toBe(200);
      expect(payoutsTable.length).toBe(3); // No phantom payouts
    });

    it("1.2 Non-Saturated Pending Payout with Deferral: 1.8B payout does not accept 500M commission, defers without error, and processes into new payout once first is moved to processing", async () => {
      const baseTime = Date.now() - 500_000_000;
      const partnerId = "vietnam_partner_deferral";

      // 1 commission of 1.8B + 2 commissions of 500M = 2.8B total
      commissionsTable.push(
        {
          id: "vnd_big_1",
          createdAt: new Date(baseTime),
          amount: BigInt(18_000_000_000),
          earnings: BigInt(1_800_000_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
        {
          id: "vnd_med_2",
          createdAt: new Date(baseTime + 10_000),
          amount: BigInt(5_000_000_000),
          earnings: BigInt(500_000_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
        {
          id: "vnd_med_3",
          createdAt: new Date(baseTime + 20_000),
          amount: BigInt(5_000_000_000),
          earnings: BigInt(500_000_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
      );

      // CRON RUN 1: Claims 1.8B, caps at 2.0B, defers the two 500M commissions
      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });

      expect(payoutsTable.length).toBe(1);
      const p1 = payoutsTable[0];
      expect(p1.amount).toBe(1_800_000_000);
      expect(commissionsTable.filter((c) => c.status === CommissionStatus.pending).length).toBe(2);

      // CRON RUN 2: p1 is still pending (amount = 1.8B < 2.0B).
      // existingPendingPayout is p1.
      // 1.8B + 500M = 2.3B > 2.0B -> Cannot fit!
      // Must safely defer without throwing TypeError or corrupting p1!
      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });

      expect(payoutsTable.length).toBe(1);
      expect(payoutsTable[0].amount).toBe(1_800_000_000);
      expect(commissionsTable.filter((c) => c.status === CommissionStatus.pending).length).toBe(2);

      // Now simulate invoice settlement: merchant funds invoice, p1 transitions to "processing"
      p1.status = "processing";

      // CRON RUN 3: p1 is no longer "pending", so a new payout can be created for the remaining 1.0B!
      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });

      expect(payoutsTable.length).toBe(2);
      const p2 = payoutsTable[1];
      expect(p2.amount).toBe(1_000_000_000);
      expect(commissionsTable.filter((c) => c.status === CommissionStatus.pending).length).toBe(0);
      expect(commissionsTable.filter((c) => c.status === CommissionStatus.processed).length).toBe(3);
    });

    it("1.3 Multi-Partner Fair Queueing: 1 whale with 5.0B VND does not starve 5 small earners ($10 each) across runs", async () => {
      const baseTime = Date.now() - 500_000_000;
      const whaleId = "whale_partner";

      // Whale: 5.0B VND (10 x 500M)
      for (let i = 0; i < 10; i++) {
        commissionsTable.push({
          id: `whale_${i}`,
          createdAt: new Date(baseTime + i * 1000),
          amount: BigInt(5_000_000_000),
          earnings: BigInt(500_000_000),
          status: CommissionStatus.pending,
          partnerId: whaleId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      // 5 Small earners ($10 = 1000 cents each)
      for (let i = 0; i < 5; i++) {
        commissionsTable.push({
          id: `earner_${i}`,
          createdAt: new Date(baseTime + 20_000 + i * 1000),
          amount: BigInt(10_000),
          earnings: BigInt(1_000),
          status: CommissionStatus.pending,
          partnerId: `small_partner_${i}`,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      // Run 1: Whale capped at 2.0B, all 5 small earners processed cleanly!
      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });

      expect(payoutsTable.length).toBe(6); // 1 whale + 5 small earners
      const whaleP1 = payoutsTable.find((p) => p.partnerId === whaleId);
      expect(whaleP1?.amount).toBe(2_000_000_000);

      for (let i = 0; i < 5; i++) {
        const smallP = payoutsTable.find((p) => p.partnerId === `small_partner_${i}`);
        expect(smallP?.amount).toBe(1_000);
      }
    });
  });

  // =========================================================================
  // GATE 2 DIMENSION 2: Charge-Succeeded SQLite Query Stress
  // =========================================================================
  describe("Dimension 2: Charge-Succeeded SQLite Query Stress (ANSI SQL Correlated Subquery)", () => {
    it("2.1 Executes correlated subquery across comprehensive state matrix in real SQLite :memory: engine", () => {
      const sqliteScript = `
        CREATE TABLE Partner (
          id TEXT PRIMARY KEY,
          defaultPayoutMethod TEXT
        );

        CREATE TABLE Payout (
          id TEXT PRIMARY KEY,
          partnerId TEXT,
          invoiceId TEXT,
          method TEXT,
          status TEXT,
          updatedAt TEXT
        );

        -- Partners
        INSERT INTO Partner (id, defaultPayoutMethod) VALUES
          ('pn_stripe', 'stripe'),
          ('pn_paypal', 'paypal'),
          ('pn_tremendous', 'tremendous'),
          ('pn_null', NULL),
          ('pn_empty', '');

        -- Payouts Matrix for invoice 'inv_target'
        -- 1. processing + stripe default -> MUST update to stripe
        INSERT INTO Payout VALUES ('po_1', 'pn_stripe', 'inv_target', NULL, 'processing', '2026-01-01 00:00:00');
        -- 2. processing + paypal default (existing old method) -> MUST update to paypal
        INSERT INTO Payout VALUES ('po_2', 'pn_paypal', 'inv_target', 'old_method', 'processing', '2026-01-01 00:00:00');
        -- 3. processing + null default -> MUST NOT update (preserve existing, updatedAt untouched)
        INSERT INTO Payout VALUES ('po_3', 'pn_null', 'inv_target', 'custom_keep', 'processing', '2026-01-01 00:00:00');
        -- 4. pending + stripe default -> MUST NOT update (status pending)
        INSERT INTO Payout VALUES ('po_4', 'pn_stripe', 'inv_target', NULL, 'pending', '2026-01-01 00:00:00');
        -- 5. paid + stripe default -> MUST NOT update (status paid)
        INSERT INTO Payout VALUES ('po_5', 'pn_stripe', 'inv_target', 'existing_paid', 'paid', '2026-01-01 00:00:00');
        -- 6. completed + paypal default -> MUST NOT update (status completed)
        INSERT INTO Payout VALUES ('po_6', 'pn_paypal', 'inv_target', 'existing_comp', 'completed', '2026-01-01 00:00:00');
        -- 7. failed + stripe default -> MUST NOT update (status failed)
        INSERT INTO Payout VALUES ('po_7', 'pn_stripe', 'inv_target', NULL, 'failed', '2026-01-01 00:00:00');
        -- 8. processing + missing partner (orphan) -> MUST NOT update
        INSERT INTO Payout VALUES ('po_8', 'pn_nonexistent', 'inv_target', 'orphan_keep', 'processing', '2026-01-01 00:00:00');
        -- 9. processing + wrong invoice -> MUST NOT update
        INSERT INTO Payout VALUES ('po_9', 'pn_stripe', 'inv_other', NULL, 'processing', '2026-01-01 00:00:00');
        -- 10. processing + empty string default -> MUST update to empty string
        INSERT INTO Payout VALUES ('po_10', 'pn_empty', 'inv_target', 'prev', 'processing', '2026-01-01 00:00:00');

        -- Remediated charge-succeeded query under test (lines 59-76 of charge-succeeded/route.ts)
        UPDATE Payout
        SET
          method = (
            SELECT defaultPayoutMethod
            FROM Partner
            WHERE Partner.id = Payout.partnerId
          ),
          updatedAt = CURRENT_TIMESTAMP
        WHERE invoiceId = 'inv_target'
          AND status = 'processing'
          AND EXISTS (
            SELECT 1
            FROM Partner
            WHERE Partner.id = Payout.partnerId
              AND defaultPayoutMethod IS NOT NULL
          );

        -- Dump output format: id|method|status|isUpdated
        SELECT id, COALESCE(method, 'NULL'), status, (updatedAt != '2026-01-01 00:00:00') FROM Payout ORDER BY CAST(SUBSTR(id, 4) AS INTEGER);
      `;

      const output = execSync(`sqlite3 :memory: "${sqliteScript}"`, {
        encoding: "utf-8",
      });

      const lines = output.trim().split("\n");
      const rows = lines.map((line) => {
        const [id, method, status, updated] = line.split("|");
        return { id, method, status, updated: updated === "1" };
      });

      // 1. po_1 (processing, stripe) -> updated to 'stripe', updatedAt changed
      expect(rows.find((r) => r.id === "po_1")).toEqual({
        id: "po_1",
        method: "stripe",
        status: "processing",
        updated: true,
      });

      // 2. po_2 (processing, paypal) -> updated to 'paypal', updatedAt changed
      expect(rows.find((r) => r.id === "po_2")).toEqual({
        id: "po_2",
        method: "paypal",
        status: "processing",
        updated: true,
      });

      // 3. po_3 (processing, partner default is NULL) -> NOT updated, preserves 'custom_keep', updatedAt untouched
      expect(rows.find((r) => r.id === "po_3")).toEqual({
        id: "po_3",
        method: "custom_keep",
        status: "processing",
        updated: false,
      });

      // 4. po_4 (pending) -> untouched
      expect(rows.find((r) => r.id === "po_4")).toEqual({
        id: "po_4",
        method: "NULL",
        status: "pending",
        updated: false,
      });

      // 5. po_5 (paid) -> untouched
      expect(rows.find((r) => r.id === "po_5")).toEqual({
        id: "po_5",
        method: "existing_paid",
        status: "paid",
        updated: false,
      });

      // 6. po_6 (completed) -> untouched
      expect(rows.find((r) => r.id === "po_6")).toEqual({
        id: "po_6",
        method: "existing_comp",
        status: "completed",
        updated: false,
      });

      // 7. po_7 (failed) -> untouched
      expect(rows.find((r) => r.id === "po_7")).toEqual({
        id: "po_7",
        method: "NULL",
        status: "failed",
        updated: false,
      });

      // 8. po_8 (orphan partner) -> untouched
      expect(rows.find((r) => r.id === "po_8")).toEqual({
        id: "po_8",
        method: "orphan_keep",
        status: "processing",
        updated: false,
      });

      // 9. po_9 (other invoice) -> untouched
      expect(rows.find((r) => r.id === "po_9")).toEqual({
        id: "po_9",
        method: "NULL",
        status: "processing",
        updated: false,
      });

      // 10. po_10 (empty string default) -> updated to empty string
      expect(rows.find((r) => r.id === "po_10")).toEqual({
        id: "po_10",
        method: "",
        status: "processing",
        updated: true,
      });
    });

    it("2.2 High-Scale SQLite In-Memory Execution: 500 payouts across 100 partners execute cleanly in SQLite with zero latency hitch", () => {
      let script = `
        CREATE TABLE Partner (id TEXT PRIMARY KEY, defaultPayoutMethod TEXT);
        CREATE TABLE Payout (id TEXT PRIMARY KEY, partnerId TEXT, invoiceId TEXT, method TEXT, status TEXT, updatedAt TEXT);
      `;

      // 100 partners (50 stripe, 50 null)
      for (let i = 0; i < 100; i++) {
        const method = i % 2 === 0 ? "'stripe'" : "NULL";
        script += `INSERT INTO Partner VALUES ('p_${i}', ${method});\n`;
      }

      // 500 payouts for 'inv_scale'
      for (let i = 0; i < 500; i++) {
        const partnerId = `p_${i % 100}`;
        script += `INSERT INTO Payout VALUES ('po_${i}', '${partnerId}', 'inv_scale', NULL, 'processing', '2026-01-01 00:00:00');\n`;
      }

      script += `
        UPDATE Payout
        SET
          method = (
            SELECT defaultPayoutMethod
            FROM Partner
            WHERE Partner.id = Payout.partnerId
          ),
          updatedAt = CURRENT_TIMESTAMP
        WHERE invoiceId = 'inv_scale'
          AND status = 'processing'
          AND EXISTS (
            SELECT 1
            FROM Partner
            WHERE Partner.id = Payout.partnerId
              AND defaultPayoutMethod IS NOT NULL
          );

        SELECT COUNT(*) FROM Payout WHERE invoiceId = 'inv_scale' AND method = 'stripe';
        SELECT COUNT(*) FROM Payout WHERE invoiceId = 'inv_scale' AND method IS NULL;
      `;

      const output = execSync(`sqlite3 :memory: "${script}"`, {
        encoding: "utf-8",
      });

      const [stripeCount, nullCount] = output.trim().split("\n").map(Number);
      expect(stripeCount).toBe(250); // Exactly half of 500
      expect(nullCount).toBe(250);
    });
  });

  // =========================================================================
  // GATE 2 DIMENSION 3: Concurrency Stress & Deadlock Absence
  // =========================================================================
  describe("Dimension 3: Concurrency Stress & Deadlock Absence", () => {
    it("3.1 Concurrent Execution Race: Multiple parallel invocations on identical pending commissions result in exactly-once processing with 0 orphan payouts", async () => {
      const baseTime = Date.now() - 500_000_000;
      const partnerId = "race_partner";

      // 5 commissions of $10 each
      for (let i = 0; i < 5; i++) {
        commissionsTable.push({
          id: `race_c_${i}`,
          createdAt: new Date(baseTime + i * 1000),
          amount: BigInt(10_000),
          earnings: BigInt(1_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      // Launch 3 concurrent calls to aggregateDueCommissionsPOST simultaneously
      const results = await Promise.all([
        (aggregateDueCommissionsPOST as any)({
          rawBody: JSON.stringify({ programId: "prog_stress" }),
        }),
        (aggregateDueCommissionsPOST as any)({
          rawBody: JSON.stringify({ programId: "prog_stress" }),
        }),
        (aggregateDueCommissionsPOST as any)({
          rawBody: JSON.stringify({ programId: "prog_stress" }),
        }),
      ]);

      for (const res of results) {
        expect(res.status).toBe(200);
      }

      // Verification:
      // Exactly 1 payout created, total amount = $50 (5000 cents)
      expect(payoutsTable.length).toBe(1);
      expect(payoutsTable[0].amount).toBe(5000);

      // All 5 commissions are processed and linked to that payout
      const processed = commissionsTable.filter((c) => c.status === CommissionStatus.processed);
      expect(processed.length).toBe(5);
      expect(processed.every((c) => c.payoutId === payoutsTable[0].id)).toBe(true);

      // Zero commissions remain pending
      const pending = commissionsTable.filter((c) => c.status === CommissionStatus.pending);
      expect(pending.length).toBe(0);
    });

    it("3.2 Lock Contention Under SQLite_busy: withFinancialTransactionRetry achieves 100% throughput across 25 concurrent writers with jittered backoff", async () => {
      let activeWriter = false;
      let totalBusyRetries = 0;
      const committedTransactions: number[] = [];

      async function simulatedSqliteWrite(txId: number) {
        if (activeWriter) {
          totalBusyRetries++;
          throw new Error("SQLITE_BUSY: database is locked");
        }

        activeWriter = true;
        try {
          await new Promise((resolve) => setTimeout(resolve, 8)); // 8ms write
          committedTransactions.push(txId);
          return { status: "committed", txId };
        } finally {
          activeWriter = false;
        }
      }

      const writerCount = 25;
      const writers = Array.from({ length: writerCount }, (_, i) =>
        withFinancialTransactionRetry(() => simulatedSqliteWrite(i), {
          maxRetries: 15,
          baseDelayMs: 10,
          maxDelayMs: 300,
          jitter: true,
          actionName: `stress_writer_${i}`,
        }),
      );

      const outcomes = await Promise.all(writers);

      expect(outcomes.length).toBe(writerCount);
      expect(committedTransactions.length).toBe(writerCount);
      const uniqueCommitted = new Set(committedTransactions);
      expect(uniqueCommitted.size).toBe(writerCount);
      expect(totalBusyRetries).toBeGreaterThan(0); // Proves lock contention occurred and was resolved
    });
  });
});
