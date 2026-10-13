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
}

// Stateful In-Memory Tables
let commissionsTable: MockCommission[] = [];
let payoutsTable: MockPayout[] = [];
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

import { CommissionStatus, PayoutStatus, Prisma } from "@prisma/client";
import { POST as aggregateDueCommissionsPOST } from "../../app/(ee)/api/cron/payouts/aggregate-due-commissions/process/route";
import { withFinancialTransactionRetry } from "../../lib/weletic/sqlite-retry";

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

  prismaMock.partnerGroup.findMany.mockResolvedValue([{ id: "grp_stress_0" }]);

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
  prismaMock.$executeRaw.mockImplementation(
    async (strings: any, ...values: any[]) => {
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
    },
  );
}

describe("Adversarial M1 Stress Harness: Empirical Bug Hunting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    commissionsTable = [];
    payoutsTable = [];
    setupStatefulPrismaMock();
  });

  // =========================================================================
  // SUITE 1: Payout Cron Head-of-Line (HOL) Blocking Stress Harness
  // =========================================================================
  describe("Adversarial Suite 1: FIN-AUDIT-02 Head-of-Line Blocking Stress", () => {
    it("Stress 1A: 150 consecutive negative debtor commissions preceding 50 positive commissions across multiple batch cycles (BATCH_SIZE=100)", async () => {
      const baseTime = Date.now() - 100_000_000;

      // Seed 75 Debtor Partners: each partner has 2 commissions (+1000 sale, -5000 clawback => Net -4000)
      // Total 150 negative-balance commissions
      for (let i = 0; i < 75; i++) {
        const partnerId = `debtor_${String(i).padStart(3, "0")}`;
        const t1 = new Date(baseTime + i * 2000);
        const t2 = new Date(baseTime + i * 2000 + 1000);

        commissionsTable.push({
          id: `comm_pos_${partnerId}`,
          createdAt: t1,
          amount: BigInt(10000),
          earnings: BigInt(1000), // +$10
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        });

        commissionsTable.push({
          id: `comm_claw_${partnerId}`,
          createdAt: t2,
          amount: BigInt(20000),
          earnings: BigInt(-5000), // -$50
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      // Seed 25 Earner Partners: each partner has 2 positive commissions (+3000, +2000 => Net +5000)
      // Total 50 positive commissions created AFTER the 150 debtor commissions
      for (let i = 0; i < 25; i++) {
        const partnerId = `earner_${String(i).padStart(3, "0")}`;
        const t1 = new Date(baseTime + 200_000 + i * 2000);
        const t2 = new Date(baseTime + 200_000 + i * 2000 + 1000);

        commissionsTable.push({
          id: `comm_earn1_${partnerId}`,
          createdAt: t1,
          amount: BigInt(15000),
          earnings: BigInt(3000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        });

        commissionsTable.push({
          id: `comm_earn2_${partnerId}`,
          createdAt: t2,
          amount: BigInt(10000),
          earnings: BigInt(2000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      expect(commissionsTable.length).toBe(200);

      // Execute Cron Route Handler
      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });

      expect(response.status).toBe(200);

      // VERIFICATIONS:
      // 1. All 25 positive partners must have received valid payouts!
      expect(payoutsTable.length).toBe(25);
      for (const payout of payoutsTable) {
        expect(payout.amount).toBe(5000); // 3000 + 2000
        expect(payout.partnerId.startsWith("earner_")).toBe(true);
      }

      // 2. Zero negative debtor payouts exist (all rolled back and deleted)
      const debtorPayouts = payoutsTable.filter((p) =>
        p.partnerId.startsWith("debtor_"),
      );
      expect(debtorPayouts.length).toBe(0);

      // 3. Debtor commissions were safely preserved in pending status for future rollover recovery
      const pendingDebtorCommissions = commissionsTable.filter(
        (c) =>
          c.partnerId.startsWith("debtor_") &&
          c.status === CommissionStatus.pending &&
          c.payoutId === null,
      );
      expect(pendingDebtorCommissions.length).toBe(150);

      // 4. Positive commissions were marked processed and linked to payouts
      const processedEarnerCommissions = commissionsTable.filter(
        (c) =>
          c.partnerId.startsWith("earner_") &&
          c.status === CommissionStatus.processed &&
          c.payoutId !== null,
      );
      expect(processedEarnerCommissions.length).toBe(50);

      // 5. Cron required exactly 3 batch queries (batch 1: 100 debtors, batch 2: 50 debtors + 50 earners, batch 3: 0 remaining)
      expect(queryCount).toBe(3);
    });

    it("Stress 1B: Interleaved distribution: alternating bursts of negative debtor partners and positive earner partners", async () => {
      const baseTime = Date.now() - 100_000_000;

      // Interleave: for each cycle, create 3 debtor partners and 1 earner partner (25 cycles = 75 debtors, 25 earners)
      let commIdx = 0;
      for (let cycle = 0; cycle < 25; cycle++) {
        // 3 Debtors
        for (let d = 0; d < 3; d++) {
          const partnerId = `inter_debtor_${cycle}_${d}`;
          commissionsTable.push({
            id: `comm_c1_${commIdx++}`,
            createdAt: new Date(baseTime + commIdx * 1000),
            amount: BigInt(5000),
            earnings: BigInt(1000),
            status: CommissionStatus.pending,
            partnerId,
            programId: "prog_stress",
            payoutId: null,
          });
          commissionsTable.push({
            id: `comm_c2_${commIdx++}`,
            createdAt: new Date(baseTime + commIdx * 1000),
            amount: BigInt(10000),
            earnings: BigInt(-8000), // Net: -7000
            status: CommissionStatus.pending,
            partnerId,
            programId: "prog_stress",
            payoutId: null,
          });
        }

        // 1 Earner
        const earnerId = `inter_earner_${cycle}`;
        commissionsTable.push({
          id: `comm_e1_${commIdx++}`,
          createdAt: new Date(baseTime + commIdx * 1000),
          amount: BigInt(20000),
          earnings: BigInt(6000),
          status: CommissionStatus.pending,
          partnerId: earnerId,
          programId: "prog_stress",
          payoutId: null,
        });
        commissionsTable.push({
          id: `comm_e2_${commIdx++}`,
          createdAt: new Date(baseTime + commIdx * 1000),
          amount: BigInt(15000),
          earnings: BigInt(4000), // Net: +10000
          status: CommissionStatus.pending,
          partnerId: earnerId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      // Total 200 commissions
      expect(commissionsTable.length).toBe(200);

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });
      expect(response.status).toBe(200);

      // All 25 earners must receive payouts of 10000
      expect(payoutsTable.length).toBe(25);
      for (const p of payoutsTable) {
        expect(p.amount).toBe(10000);
        expect(p.partnerId.startsWith("inter_earner_")).toBe(true);
      }
    });

    it("Stress 1C: Monolithic single debtor partner with 150 consecutive pending commissions alone, unblocking downstream earners", async () => {
      const baseTime = Date.now() - 100_000_000;
      const megaDebtorId = "partner_lone_megadebtor";

      // 150 negative refund clawbacks for this single partner
      for (let i = 0; i < 150; i++) {
        commissionsTable.push({
          id: `mega_claw_${i}`,
          createdAt: new Date(baseTime + i * 1000),
          amount: BigInt(1000),
          earnings: BigInt(-500),
          status: CommissionStatus.pending,
          partnerId: megaDebtorId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      // 10 subsequent positive partners (1 commission of +5000 each)
      for (let i = 0; i < 10; i++) {
        const partnerId = `subsequent_earner_${i}`;
        commissionsTable.push({
          id: `comm_sub_${i}`,
          createdAt: new Date(baseTime + 200_000 + i * 1000),
          amount: BigInt(10000),
          earnings: BigInt(5000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });
      expect(response.status).toBe(200);

      // The single debtor must not block the 10 earners
      expect(payoutsTable.length).toBe(10);
      for (const p of payoutsTable) {
        expect(p.amount).toBe(5000);
        expect(p.partnerId.startsWith("subsequent_earner_")).toBe(true);
      }
    });
  });

  // =========================================================================
  // SUITE 2: JPY / VND Boundary & Integer Overflow Guard Stress Harness
  // =========================================================================
  describe("Adversarial Suite 2: FIN-AUDIT-03 JPY / VND Boundary & Overflow Stress", () => {
    const MAX_INT32 = 2_147_483_647;
    const MAX_PAYOUT_AMOUNT_LIMIT = 2_000_000_000;

    it("Stress 2A (Remediated): Multi-commission accumulation exceeding 2.0B units (5 Billion VND) is greedily capped without rollback cascade", async () => {
      const baseTime = Date.now() - 100_000_000;
      const partnerId = "vietnam_top_affiliate";

      // 10 commissions of 500,000,000 VND each = 5,000,000,000 VND total
      for (let i = 0; i < 10; i++) {
        commissionsTable.push({
          id: `vnd_comm_${i}`,
          createdAt: new Date(baseTime + i * 1000),
          amount: BigInt(5_000_000_000),
          earnings: BigInt(500_000_000), // 500M VND
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        });
      }

      // Execute Cron Route Handler
      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });
      expect(response.status).toBe(200);

      // VERIFIED REMEDIATION:
      // In iteration 1: commissions 0..3 (2.0B) are claimed into po_1.
      // Capping excludes partner from re-attachment in iteration 2.
      // po_1 remains intact at 2,000,000,000 VND.
      // Remaining 6 commissions stay safely in pending without rollback.
      expect(payoutsTable.length).toBe(1);
      expect(payoutsTable[0].amount).toBe(2_000_000_000);
      expect(payoutsTable[0].amount).toBeLessThanOrEqual(
        MAX_PAYOUT_AMOUNT_LIMIT,
      );

      const processed = commissionsTable.filter(
        (c) => c.status === CommissionStatus.processed,
      );
      expect(processed.length).toBe(4);
      const pending = commissionsTable.filter(
        (c) => c.status === CommissionStatus.pending,
      );
      expect(pending.length).toBe(6);
      expect(pending.every((c) => c.payoutId === null)).toBe(true);
    });

    it("Stress 2B (Remediated): Boundary deferral preserved: deferred 1 unit is not re-attached to capped pending payout", async () => {
      const baseTime = Date.now() - 100_000_000;
      const partnerId = "boundary_jpy_partner";

      commissionsTable.push(
        {
          id: "jpy_1",
          createdAt: new Date(baseTime),
          amount: BigInt(2_000_000_000),
          earnings: BigInt(1_999_999_999),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
        {
          id: "jpy_2",
          createdAt: new Date(baseTime + 1000),
          amount: BigInt(10),
          earnings: BigInt(1), // sum reaches exactly 2,000,000,000
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
        {
          id: "jpy_3",
          createdAt: new Date(baseTime + 2000),
          amount: BigInt(10),
          earnings: BigInt(1), // deferred in iteration 1
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
      );

      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });

      // VERIFIED REMEDIATION:
      // Greedy capping deferred jpy_3 in iteration 1 and excluded partner.
      // Existing pending payout is preserved at exactly 2.0B.
      // jpy_3 safely remains pending.
      expect(payoutsTable.length).toBe(1);
      expect(payoutsTable[0].amount).toBe(2_000_000_000);
      expect(payoutsTable[0].amount).toBeLessThanOrEqual(
        MAX_PAYOUT_AMOUNT_LIMIT,
      );
      expect(commissionsTable.find((c) => c.id === "jpy_3")?.status).toBe(
        CommissionStatus.pending,
      );
      expect(
        commissionsTable.find((c) => c.id === "jpy_3")?.payoutId,
      ).toBeNull();
    });

    it("Stress 2C: Single massive commission exceeding 2.14B units (3 Billion JPY) safely rolls back via hard overflow guard without crashing", async () => {
      const baseTime = Date.now() - 100_000_000;
      const massivePartnerId = "massive_single_jpy_whale";
      const normalPartnerId = "normal_earner_1";

      // 1. Single massive commission exceeding MAX_INT32 (2.14B)
      commissionsTable.push({
        id: "single_huge_comm",
        createdAt: new Date(baseTime),
        amount: BigInt(30_000_000_000),
        earnings: BigInt(3_000_000_000), // 3 Billion JPY > 2.147B MAX_INT32
        status: CommissionStatus.pending,
        partnerId: massivePartnerId,
        programId: "prog_stress",
        payoutId: null,
      });

      // 2. Normal partner with 50,000 JPY
      commissionsTable.push({
        id: "normal_comm",
        createdAt: new Date(baseTime + 1000),
        amount: BigInt(500_000),
        earnings: BigInt(50_000),
        status: CommissionStatus.pending,
        partnerId: normalPartnerId,
        programId: "prog_stress",
        payoutId: null,
      });

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });
      expect(response.status).toBe(200);

      // The massive whale commission was rolled back and deleted
      expect(
        commissionsTable.find((c) => c.id === "single_huge_comm")?.status,
      ).toBe(CommissionStatus.pending);
      expect(
        commissionsTable.find((c) => c.id === "single_huge_comm")?.payoutId,
      ).toBe(null);

      // Normal partner payout succeeded!
      expect(payoutsTable.length).toBe(1);
      expect(payoutsTable[0].partnerId).toBe(normalPartnerId);
      expect(payoutsTable[0].amount).toBe(50_000);
    });

    it("Stress 2D (Remediated): High-denomination commission with clawback preserves capped payout without rollback cascade", async () => {
      const baseTime = Date.now() - 100_000_000;
      const partnerId = "jpy_mixed_partner";

      // Sale 1: +1.8B
      // Clawback: -0.6B (net: 1.2B)
      // Sale 2: +0.7B (net: 1.9B <= 2.0B)
      // Sale 3: +0.4B (net: 2.3B > 2.0B => deferred in iter 1)
      commissionsTable.push(
        {
          id: "m_1",
          createdAt: new Date(baseTime),
          amount: BigInt(18_000_000_000),
          earnings: BigInt(1_800_000_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
        {
          id: "m_2",
          createdAt: new Date(baseTime + 1000),
          amount: BigInt(6_000_000_000),
          earnings: BigInt(-600_000_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
        {
          id: "m_3",
          createdAt: new Date(baseTime + 2000),
          amount: BigInt(7_000_000_000),
          earnings: BigInt(700_000_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
        {
          id: "m_4",
          createdAt: new Date(baseTime + 3000),
          amount: BigInt(4_000_000_000),
          earnings: BigInt(400_000_000),
          status: CommissionStatus.pending,
          partnerId,
          programId: "prog_stress",
          payoutId: null,
        },
      );

      await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_stress" }),
      });

      // VERIFIED REMEDIATION:
      // Iteration 1 claims m_1, m_2, m_3 (net 1.9B).
      // m_4 is deferred due to capping at 2.0B. Partner is excluded for the run.
      // Payout remains intact at 1.9B, and m_4 remains pending.
      expect(payoutsTable.length).toBe(1);
      expect(payoutsTable[0].amount).toBe(1_900_000_000);
      expect(commissionsTable.find((c) => c.id === "m_4")?.status).toBe(
        CommissionStatus.pending,
      );
      expect(commissionsTable.find((c) => c.id === "m_4")?.payoutId).toBeNull();
    });
  });

  // =========================================================================
  // SUITE 3: Concurrency / SQLite_busy Lock Contention Stress Harness
  // =========================================================================
  describe("Adversarial Suite 3: FIN-AUDIT-10 Concurrency & SQLite_busy Lock Stress", () => {
    it("Stress 3A: 30 concurrent parallel transaction writes competing for a single SQLite write lock achieve 100% throughput with 0 drops", async () => {
      let isLockHeld = false;
      let totalRetriesEncountered = 0;
      const committedTransactions: number[] = [];

      // Simulated SQLite single-writer lock
      async function simulatedSqliteTransaction(txId: number) {
        if (isLockHeld) {
          totalRetriesEncountered++;
          throw new Error("SQLITE_BUSY: database is locked");
        }

        // Acquire exclusive lock
        isLockHeld = true;
        try {
          // Simulate realistic atomic disk write duration (10ms)
          await new Promise((resolve) => setTimeout(resolve, 10));
          committedTransactions.push(txId);
          return { status: "committed", txId };
        } finally {
          // Release lock
          isLockHeld = false;
        }
      }

      // Launch 30 concurrent workers competing simultaneously
      const workerCount = 30;
      const workerPromises = Array.from({ length: workerCount }, (_, i) =>
        withFinancialTransactionRetry(() => simulatedSqliteTransaction(i), {
          maxRetries: 15,
          baseDelayMs: 10,
          maxDelayMs: 250,
          jitter: true,
          actionName: `worker_${i}`,
        }),
      );

      const results = await Promise.all(workerPromises);

      // Assertions
      expect(results.length).toBe(workerCount);
      expect(committedTransactions.length).toBe(workerCount);
      // Verify all workers from 0 to 29 were committed
      const uniqueCommitted = new Set(committedTransactions);
      expect(uniqueCommitted.size).toBe(workerCount);
      // Verify lock contention was actually triggered and handled
      expect(totalRetriesEncountered).toBeGreaterThan(0);
    });

    it("Stress 3B: Pathological multi-failure contention: transaction succeeds on 5th attempt with exponential backoff", async () => {
      let attempts = 0;
      const op = vi.fn(async () => {
        attempts++;
        if (attempts < 5) {
          throw new Error("D1_ERROR: stepping, database is locked (5)");
        }
        return "eventually_succeeded";
      });

      const result = await withFinancialTransactionRetry(op, {
        maxRetries: 5,
        baseDelayMs: 5,
        maxDelayMs: 50,
      });

      expect(result).toBe("eventually_succeeded");
      expect(attempts).toBe(5);
    });

    it("Stress 3C: Fatal non-retriable error (e.g. Prisma P2002 Unique Constraint violation) fails fast on attempt 1", async () => {
      let attempts = 0;
      const fatalErr = new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed",
        {
          code: "P2002",
          clientVersion: "6.19.1",
        },
      );

      const op = vi.fn(async () => {
        attempts++;
        throw fatalErr;
      });

      await expect(
        withFinancialTransactionRetry(op, { maxRetries: 4, baseDelayMs: 5 }),
      ).rejects.toThrow("Unique constraint failed");

      expect(attempts).toBe(1); // Fast abort, zero wasted retries
    });

    it("Stress 3D: Permanent lock contention exhausts retry budget and cleanly surfaces original error", async () => {
      let attempts = 0;
      const deadlockedErr = new Error("SQLITE_BUSY: database is locked");

      const op = vi.fn(async () => {
        attempts++;
        throw deadlockedErr;
      });

      await expect(
        withFinancialTransactionRetry(op, { maxRetries: 3, baseDelayMs: 5 }),
      ).rejects.toThrow("SQLITE_BUSY: database is locked");

      expect(attempts).toBe(4); // 1 initial + 3 retries = 4 total attempts
    });
  });

  // =========================================================================
  // SUITE 4: ANSI SQL SQLite Engine Compatibility Verification
  // =========================================================================
  describe("Adversarial Suite 4: FIN-AUDIT-01 ANSI SQL SQLite In-Memory Execution", () => {
    it("Stress 4A: SQLite engine executes remediated correlated subquery and CURRENT_TIMESTAMP with zero syntax errors", () => {
      const sqliteScript = `
        CREATE TABLE Payout (
          id TEXT PRIMARY KEY,
          amount INTEGER DEFAULT 0,
          status TEXT DEFAULT 'pending',
          periodEnd TEXT,
          updatedAt TEXT
        );

        CREATE TABLE Commission (
          id TEXT PRIMARY KEY,
          programId TEXT,
          partnerId TEXT,
          payoutId TEXT,
          status TEXT DEFAULT 'pending',
          updatedAt TEXT
        );

        INSERT INTO Payout (id, amount, status, periodEnd, updatedAt) 
        VALUES ('po_test_ansi', 0, 'pending', '2026-10-01', datetime('now'));

        INSERT INTO Commission (id, programId, partnerId, payoutId, status, updatedAt) 
        VALUES ('cm_test_ansi', 'prog_ansi', 'part_ansi', NULL, 'pending', datetime('now'));

        -- Remediated query under test:
        UPDATE Commission
        SET status = 'processed', payoutId = 'po_test_ansi', updatedAt = CURRENT_TIMESTAMP
        WHERE id IN ('cm_test_ansi')
          AND programId = 'prog_ansi'
          AND partnerId = 'part_ansi'
          AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM Payout 
            WHERE id = 'po_test_ansi' 
              AND status IN ('pending', 'processing', 'processed')
          );

        -- Remediated payout update:
        UPDATE Payout
        SET amount = 50000, periodEnd = COALESCE(NULL, periodEnd), updatedAt = CURRENT_TIMESTAMP
        WHERE id = 'po_test_ansi' 
          AND status IN ('pending', 'processing', 'processed');

        SELECT status, payoutId FROM Commission WHERE id = 'cm_test_ansi';
        SELECT amount FROM Payout WHERE id = 'po_test_ansi';
      `;

      const output = execSync(`sqlite3 :memory: "${sqliteScript}"`, {
        encoding: "utf-8",
      });

      expect(output).toContain("processed|po_test_ansi");
      expect(output).toContain("50000");
    });

    it("Stress 4B: SQLite engine confirms legacy MySQL INNER JOIN syntax is completely invalid", () => {
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

    it("Stress 4C (Remediated): charge-succeeded correlated subquery updates payout method cleanly in SQLite", () => {
      // Line 59-71 of apps/web/app/(ee)/api/cron/payouts/charge-succeeded/route.ts:
      const chargeSucceededQuery = `
        CREATE TABLE Payout (id TEXT PRIMARY KEY, partnerId TEXT, invoiceId TEXT, method TEXT, status TEXT, updatedAt TEXT);
        CREATE TABLE Partner (id TEXT PRIMARY KEY, defaultPayoutMethod TEXT);

        INSERT INTO Partner (id, defaultPayoutMethod) VALUES ('pn_1', 'stripe'), ('pn_2', NULL);
        INSERT INTO Payout (id, partnerId, invoiceId, method, status, updatedAt)
        VALUES ('po_1', 'pn_1', 'inv_1', NULL, 'processing', datetime('now')),
               ('po_2', 'pn_2', 'inv_1', 'existing', 'processing', datetime('now'));

        UPDATE Payout
        SET method = (
          SELECT defaultPayoutMethod FROM Partner WHERE Partner.id = Payout.partnerId
        ),
        updatedAt = CURRENT_TIMESTAMP
        WHERE invoiceId = 'inv_1'
          AND status = 'processing'
          AND EXISTS (
            SELECT 1 FROM Partner
            WHERE Partner.id = Payout.partnerId
              AND defaultPayoutMethod IS NOT NULL
          );

        SELECT id, method FROM Payout WHERE invoiceId = 'inv_1' ORDER BY id;
      `;

      const output = execSync(`sqlite3 :memory: "${chargeSucceededQuery}"`, {
        encoding: "utf-8",
      });

      expect(output).toContain("po_1|stripe");
      expect(output).toContain("po_2|existing");

      // Verify that the legacy MySQL syntax indeed fails in SQLite
      const legacyQuery = `
        CREATE TABLE Payout (id TEXT PRIMARY KEY, partnerId TEXT, invoiceId TEXT, method TEXT, status TEXT);
        CREATE TABLE Partner (id TEXT PRIMARY KEY, defaultPayoutMethod TEXT);
        UPDATE Payout p INNER JOIN Partner pn ON p.partnerId = pn.id SET p.method = pn.defaultPayoutMethod WHERE p.invoiceId = 'inv_1' AND pn.defaultPayoutMethod IS NOT NULL AND p.status = 'processing';
      `;
      expect(() => {
        execSync(`sqlite3 :memory: "${legacyQuery}"`, {
          encoding: "utf-8",
          stdio: "pipe",
        });
      }).toThrow(/syntax error/);
    });
  });
});
