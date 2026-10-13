import { execSync } from "child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

// Stateful In-Memory Database Types
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
}

let commissionsTable: MockCommission[] = [];
let payoutsTable: MockPayout[] = [];
let capturedRawQueries: { sql: string; values: any[] }[] = [];
let queryCount = 0;

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

import { CommissionStatus, PayoutStatus } from "@prisma/client";
import { POST as aggregateDueCommissionsPOST } from "../../app/(ee)/api/cron/payouts/aggregate-due-commissions/process/route";

function setupStatefulPrismaMock() {
  queryCount = 0;
  capturedRawQueries = [];

  prismaMock.program.findUnique.mockResolvedValue({
    id: "prog_test",
    name: "Yamax Performance",
    workspaceId: "ws_test",
  });

  prismaMock.partnerGroup.groupBy.mockResolvedValue([
    { holdingPeriodDays: 0, _count: { id: 1 } },
  ]);

  prismaMock.partnerGroup.findMany.mockResolvedValue([{ id: "grp_0" }]);

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

  prismaMock.payout.create.mockImplementation(async (query: any) => {
    const newPayout: MockPayout = {
      id: query.data.id,
      programId: query.data.programId,
      partnerId: query.data.partnerId,
      periodStart: query.data.periodStart,
      periodEnd: query.data.periodEnd,
      amount: query.data.amount,
      status: PayoutStatus.pending,
      description: query.data.description,
    };
    payoutsTable.push(newPayout);
    return { id: newPayout.id };
  });

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

  prismaMock.payout.deleteMany.mockImplementation(async (query: any) => {
    const targetId = query.where?.id;
    const initialLen = payoutsTable.length;
    payoutsTable = payoutsTable.filter((p) => p.id !== targetId);
    return { count: initialLen - payoutsTable.length };
  });

  prismaMock.$executeRaw.mockImplementation(
    async (strings: any, ...values: any[]) => {
      const rawSql = Array.isArray(strings)
        ? strings.join("?")
        : typeof strings === "string"
          ? strings
          : strings?.strings?.join("?") ?? "";

      capturedRawQueries.push({ sql: rawSql, values });

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
    },
  );
}

describe("FIN-AUDIT-01, 02, 03: Genuine Payout Due Commissions Cron Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commissionsTable = [];
    payoutsTable = [];
    setupStatefulPrismaMock();
  });

  describe("Pillar 1: SQLite / Cloudflare D1 ANSI SQL Statements (FIN-AUDIT-01)", () => {
    it("POST executes remediated SQLite ANSI SQL with WHERE EXISTS and CURRENT_TIMESTAMP", async () => {
      commissionsTable.push(
        {
          id: "cm_1",
          createdAt: new Date("2026-10-01T00:00:00Z"),
          amount: BigInt(10000),
          earnings: BigInt(5000),
          status: CommissionStatus.pending,
          partnerId: "part_1",
          programId: "prog_test",
          payoutId: null,
        },
        {
          id: "cm_2",
          createdAt: new Date("2026-10-02T00:00:00Z"),
          amount: BigInt(10000),
          earnings: BigInt(5000),
          status: CommissionStatus.pending,
          partnerId: "part_1",
          programId: "prog_test",
          payoutId: null,
        },
      );

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });
      expect(response.status).toBe(200);

      // Verify UPDATE Commission query
      const claimQuery = capturedRawQueries.find((q) =>
        q.sql.includes("UPDATE Commission"),
      );
      expect(claimQuery).toBeDefined();
      expect(claimQuery!.sql).not.toContain("INNER JOIN");
      expect(claimQuery!.sql).not.toContain("NOW()");
      expect(claimQuery!.sql).toContain("CURRENT_TIMESTAMP");
      expect(claimQuery!.sql).toContain("EXISTS (");
      expect(claimQuery!.sql).toContain("SELECT 1 FROM Payout");

      // Verify UPDATE Payout query
      const payoutQuery = capturedRawQueries.find((q) =>
        q.sql.includes("UPDATE Payout"),
      );
      expect(payoutQuery).toBeDefined();
      expect(payoutQuery!.sql).not.toContain("NOW()");
      expect(payoutQuery!.sql).toContain("CURRENT_TIMESTAMP");
      expect(payoutsTable[0].amount).toBe(10000);
    });

    it("executes generated correlated query in real SQLite engine and confirms legacy MySQL fails", () => {
      const sqliteScript = `
        CREATE TABLE Payout (id TEXT PRIMARY KEY, amount INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', periodEnd TEXT, updatedAt TEXT);
        CREATE TABLE Commission (id TEXT PRIMARY KEY, programId TEXT, partnerId TEXT, payoutId TEXT, status TEXT DEFAULT 'pending', updatedAt TEXT);
        INSERT INTO Payout (id, amount, status, periodEnd, updatedAt) VALUES ('po_1', 0, 'pending', '2026-10-01', datetime('now'));
        INSERT INTO Commission (id, programId, partnerId, payoutId, status, updatedAt) VALUES ('cm_1', 'prog_1', 'part_1', NULL, 'pending', datetime('now'));

        UPDATE Commission
        SET status = 'processed', payoutId = 'po_1', updatedAt = CURRENT_TIMESTAMP
        WHERE id IN ('cm_1')
          AND programId = 'prog_1'
          AND partnerId = 'part_1'
          AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM Payout
            WHERE id = 'po_1'
              AND status IN ('pending', 'processing', 'processed')
          );

        UPDATE Payout
        SET amount = 10000, periodEnd = CURRENT_TIMESTAMP, updatedAt = CURRENT_TIMESTAMP
        WHERE id = 'po_1'
          AND status IN ('pending', 'processing', 'processed');

        SELECT status, payoutId FROM Commission WHERE id = 'cm_1';
        SELECT amount FROM Payout WHERE id = 'po_1';
      `;

      const output = execSync(`sqlite3 :memory: "${sqliteScript}"`, {
        encoding: "utf-8",
      });
      expect(output).toContain("processed|po_1");
      expect(output).toContain("10000");

      // Legacy MySQL syntax validation
      const legacyScript = `
        CREATE TABLE Payout (id TEXT PRIMARY KEY, status TEXT);
        CREATE TABLE Commission (id TEXT PRIMARY KEY, payoutId TEXT, status TEXT, updatedAt TEXT);
        UPDATE Commission c INNER JOIN Payout p ON p.id = c.payoutId SET c.status = 'processed', c.updatedAt = NOW() WHERE c.id = 'cm_1';
      `;
      expect(() => {
        execSync(`sqlite3 :memory: "${legacyScript}"`, {
          encoding: "utf-8",
          stdio: "pipe",
        });
      }).toThrow(/syntax error/);
    });
  });

  describe("Pillar 2: Head-of-line (HOL) Blocking Prevention (FIN-AUDIT-02)", () => {
    it("rolls back negative debtor partner, excludes them, and processes subsequent earner partner", async () => {
      // Debtor Partner: Net -4000
      commissionsTable.push(
        {
          id: "cm_debtor_sale",
          createdAt: new Date("2026-10-01T00:00:00Z"),
          amount: BigInt(5000),
          earnings: BigInt(1000),
          status: CommissionStatus.pending,
          partnerId: "partner_debtor",
          programId: "prog_test",
          payoutId: null,
        },
        {
          id: "cm_debtor_claw",
          createdAt: new Date("2026-10-01T01:00:00Z"),
          amount: BigInt(10000),
          earnings: BigInt(-5000),
          status: CommissionStatus.pending,
          partnerId: "partner_debtor",
          programId: "prog_test",
          payoutId: null,
        },
      );

      // Earner Partner: Net +10000
      commissionsTable.push({
        id: "cm_earner_sale",
        createdAt: new Date("2026-10-01T02:00:00Z"),
        amount: BigInt(15000),
        earnings: BigInt(10000),
        status: CommissionStatus.pending,
        partnerId: "partner_earner",
        programId: "prog_test",
        payoutId: null,
      });

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });
      expect(response.status).toBe(200);

      // Debtor partner was rolled back and deleted
      expect(
        payoutsTable.find((p) => p.partnerId === "partner_debtor"),
      ).toBeUndefined();
      expect(
        commissionsTable
          .filter((c) => c.partnerId === "partner_debtor")
          .every((c) => c.status === CommissionStatus.pending),
      ).toBe(true);

      // Earner partner received payout
      const earnerPayout = payoutsTable.find(
        (p) => p.partnerId === "partner_earner",
      );
      expect(earnerPayout).toBeDefined();
      expect(earnerPayout!.amount).toBe(10000);
      expect(
        commissionsTable.find((c) => c.id === "cm_earner_sale")!.status,
      ).toBe(CommissionStatus.processed);
    });

    it("terminates cleanly via defensive guard without infinite loop when no progress is made", async () => {
      // 2 pure debtor partners
      commissionsTable.push({
        id: "cm_neg_only",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        amount: BigInt(5000),
        earnings: BigInt(-2000),
        status: CommissionStatus.pending,
        partnerId: "partner_pure_debtor",
        programId: "prog_test",
        payoutId: null,
      });

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });
      expect(response.status).toBe(200);
      expect(payoutsTable.length).toBe(0);
      expect(commissionsTable[0].status).toBe(CommissionStatus.pending);
    });
  });

  describe("Pillar 3: Greedy Capping Across Multiple Batches Without Overflow Rollback (FIN-AUDIT-03)", () => {
    const MAX_PAYOUT_AMOUNT_LIMIT = 2_000_000_000;

    it("greedily caps commissions at MAX_PAYOUT_AMOUNT_LIMIT and defers remainder within a single batch", async () => {
      commissionsTable.push(
        {
          id: "cm_cap_1",
          createdAt: new Date("2026-10-01T00:00:00Z"),
          amount: BigInt(10_000_000_000),
          earnings: BigInt(1_000_000_000), // 1.0B
          status: CommissionStatus.pending,
          partnerId: "partner_capping",
          programId: "prog_test",
          payoutId: null,
        },
        {
          id: "cm_cap_2",
          createdAt: new Date("2026-10-01T01:00:00Z"),
          amount: BigInt(8_000_000_000),
          earnings: BigInt(800_000_000), // 0.8B (sum 1.8B <= 2.0B)
          status: CommissionStatus.pending,
          partnerId: "partner_capping",
          programId: "prog_test",
          payoutId: null,
        },
        {
          id: "cm_cap_3",
          createdAt: new Date("2026-10-01T02:00:00Z"),
          amount: BigInt(7_000_000_000),
          earnings: BigInt(700_000_000), // 0.7B (sum 2.5B > 2.0B => deferred)
          status: CommissionStatus.pending,
          partnerId: "partner_capping",
          programId: "prog_test",
          payoutId: null,
        },
      );

      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });

      // Payout 1 created with capped amount 1.8B
      const payout1 = payoutsTable[0];
      expect(payout1).toBeDefined();
      expect(payout1.amount).toBe(1_800_000_000);

      // First two commissions processed in payout 1
      expect(commissionsTable.find((c) => c.id === "cm_cap_1")!.status).toBe(
        CommissionStatus.processed,
      );
      expect(commissionsTable.find((c) => c.id === "cm_cap_2")!.status).toBe(
        CommissionStatus.processed,
      );

      // Remaining commission deferred in pending without rollback
      const c3 = commissionsTable.find((c) => c.id === "cm_cap_3")!;
      expect(c3.status).toBe(CommissionStatus.pending);
      expect(c3.payoutId).toBeNull();
    });

    it("preserves prior payout and avoids Int32 overflow cascade when processing deferred commissions in iteration 2", async () => {
      // 4 commissions of 600,000,000 each = 2.4B total
      for (let i = 0; i < 4; i++) {
        commissionsTable.push({
          id: `cm_multi_${i}`,
          createdAt: new Date(Date.now() + i * 1000),
          amount: BigInt(6_000_000_000),
          earnings: BigInt(600_000_000),
          status: CommissionStatus.pending,
          partnerId: "partner_multi_batch",
          programId: "prog_test",
          payoutId: null,
        });
      }

      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });

      // Critical assertion: Prior payout must NOT be wiped out
      expect(payoutsTable.length).toBeGreaterThan(0);
      expect(payoutsTable[0].amount).toBeLessThanOrEqual(
        MAX_PAYOUT_AMOUNT_LIMIT,
      );

      // Commissions were NOT rolled back to pending
      const processedCount = commissionsTable.filter(
        (c) => c.status === CommissionStatus.processed,
      ).length;
      expect(processedCount).toBeGreaterThanOrEqual(3); // At least the first 3 commissions (1.8B) must be paid
    });

    it("incrementally tops up existing pending payout within remaining capacity", async () => {
      // Seed existing pending payout with amount 1.2B
      payoutsTable.push({
        id: "po_existing",
        programId: "prog_test",
        partnerId: "partner_topup",
        periodStart: new Date("2026-10-01T00:00:00Z"),
        periodEnd: new Date("2026-10-01T01:00:00Z"),
        amount: 1_200_000_000,
        status: PayoutStatus.pending,
        description: "Existing pending payout",
      });

      // Seed prior processed commission attached to po_existing
      commissionsTable.push({
        id: "cm_prior",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        amount: BigInt(12_000_000_000),
        earnings: BigInt(1_200_000_000),
        status: CommissionStatus.processed,
        partnerId: "partner_topup",
        programId: "prog_test",
        payoutId: "po_existing",
      });

      commissionsTable.push(
        {
          id: "cm_topup_1",
          createdAt: new Date("2026-10-02T00:00:00Z"),
          amount: BigInt(5_000_000_000),
          earnings: BigInt(500_000_000), // 500M -> 1.2B + 0.5B = 1.7B <= 2.0B
          status: CommissionStatus.pending,
          partnerId: "partner_topup",
          programId: "prog_test",
          payoutId: null,
        },
        {
          id: "cm_topup_2",
          createdAt: new Date("2026-10-02T01:00:00Z"),
          amount: BigInt(6_000_000_000),
          earnings: BigInt(600_000_000), // 600M -> 1.7B + 0.6B = 2.3B > 2.0B => deferred
          status: CommissionStatus.pending,
          partnerId: "partner_topup",
          programId: "prog_test",
          payoutId: null,
        },
      );

      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });

      const existingPayout = payoutsTable.find((p) => p.id === "po_existing");
      expect(existingPayout).toBeDefined();
      expect(existingPayout!.amount).toBe(1_700_000_000);

      expect(commissionsTable.find((c) => c.id === "cm_topup_1")!.status).toBe(
        CommissionStatus.processed,
      );
      expect(
        commissionsTable.find((c) => c.id === "cm_topup_1")!.payoutId,
      ).toBe("po_existing");

      const deferred = commissionsTable.find((c) => c.id === "cm_topup_2")!;
      expect(deferred.status).toBe(CommissionStatus.pending);
      expect(deferred.payoutId).toBeNull();
    });
  });

  describe("Pillar 4: Int32 Boundary Enforcement & Overflow Guard (FIN-AUDIT-03)", () => {
    it("single massive commission exceeding MAX_INT32 safely rolls back via hard overflow guard without crashing", async () => {
      // Whale partner: single commission of 3 Billion JPY (> MAX_INT32 2.147B)
      commissionsTable.push({
        id: "cm_whale",
        createdAt: new Date("2026-10-01T00:00:00Z"),
        amount: BigInt(30_000_000_000),
        earnings: BigInt(3_000_000_000),
        status: CommissionStatus.pending,
        partnerId: "partner_whale",
        programId: "prog_test",
        payoutId: null,
      });

      // Normal partner: 50,000 JPY
      commissionsTable.push({
        id: "cm_normal",
        createdAt: new Date("2026-10-01T01:00:00Z"),
        amount: BigInt(500_000),
        earnings: BigInt(50_000),
        status: CommissionStatus.pending,
        partnerId: "partner_normal",
        programId: "prog_test",
        payoutId: null,
      });

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });
      expect(response.status).toBe(200);

      // Whale commission rolled back to pending and payout deleted
      expect(commissionsTable.find((c) => c.id === "cm_whale")!.status).toBe(
        CommissionStatus.pending,
      );
      expect(
        commissionsTable.find((c) => c.id === "cm_whale")!.payoutId,
      ).toBeNull();
      expect(
        payoutsTable.find((p) => p.partnerId === "partner_whale"),
      ).toBeUndefined();

      // Normal partner succeeded
      const normalPayout = payoutsTable.find(
        (p) => p.partnerId === "partner_normal",
      );
      expect(normalPayout).toBeDefined();
      expect(normalPayout!.amount).toBe(50_000);
    });

    it("processes exact boundary amounts (2,000,000,000) cleanly", async () => {
      commissionsTable.push(
        {
          id: "cm_b1",
          createdAt: new Date("2026-10-01T00:00:00Z"),
          amount: BigInt(2_000_000_000),
          earnings: BigInt(1_999_999_999),
          status: CommissionStatus.pending,
          partnerId: "partner_boundary",
          programId: "prog_test",
          payoutId: null,
        },
        {
          id: "cm_b2",
          createdAt: new Date("2026-10-01T01:00:00Z"),
          amount: BigInt(10),
          earnings: BigInt(1),
          status: CommissionStatus.pending,
          partnerId: "partner_boundary",
          programId: "prog_test",
          payoutId: null,
        },
      );

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });
      expect(response.status).toBe(200);

      expect(payoutsTable.length).toBe(1);
      expect(payoutsTable[0].amount).toBe(2_000_000_000);
      expect(
        commissionsTable.every((c) => c.status === CommissionStatus.processed),
      ).toBe(true);
    });
  });
});
