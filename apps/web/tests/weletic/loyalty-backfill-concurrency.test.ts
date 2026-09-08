import {
  BackfillPreviewStaleError,
  buildHistoricalOrderSnapshotHash,
  commitBackfillJob,
  reconcileCompensatoryHistoricalOrder,
  type HistoricalBackfillOrder,
} from "@/lib/weletic/loyalty/backfill";
import {
  WeleticLoyaltyBackfillCreditStatus,
  WeleticLoyaltyBackfillJobStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendLedgerEntry: vi.fn(),
  assertActiveAccount: vi.fn(),
  withFence: vi.fn(),
  withLock: vi.fn(),
}));

const state = vi.hoisted(() => ({
  jobs: new Map<string, Record<string, any>>(),
  snapshots: new Map<string, Record<string, any>>(),
  credits: new Map<string, Record<string, any>>(),
  grants: new Map<string, Record<string, any>>(),
  order: null as Record<string, any> | null,
}));

function matches(value: Record<string, any>, where: Record<string, any>) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "status" && typeof expected === "object" && expected?.in) {
      return expected.in.includes(value.status);
    }
    return expected === undefined || value[key] === expected;
  });
}

const tx = {
  $queryRaw: vi.fn(async () => [{ id: state.order?.id }]),
  weleticCommerceOrder: {
    findUnique: vi.fn(async () =>
      state.order ? structuredClone(state.order) : null,
    ),
  },
  weleticLoyaltyAccount: {
    findUnique: vi.fn(),
    updateMany: vi.fn(),
  },
  weleticLoyaltyBackfillJob: {
    findUniqueOrThrow: vi.fn(async ({ where }: any) => {
      const job = state.jobs.get(where.id);
      if (!job) throw new Error("job missing");
      return { ...job };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const job = state.jobs.get(where.id);
      if (!job || !matches(job, where)) return { count: 0 };
      Object.assign(job, data);
      job.updatedAt = new Date(job.updatedAt.getTime() + 1);
      return { count: 1 };
    }),
  },
  weleticLoyaltyBackfillOrderCredit: {
    findUnique: vi.fn(async ({ where }: any) =>
      [...state.credits.values()].find(
        (credit) =>
          credit.storeId === where.storeId_orderId.storeId &&
          credit.orderId === where.storeId_orderId.orderId,
      ),
    ),
    findMany: vi.fn(async ({ where }: any) =>
      [...state.credits.values()].filter((credit) => matches(credit, where)),
    ),
    count: vi.fn(
      async ({ where }: any) =>
        [...state.credits.values()].filter((credit) => matches(credit, where))
          .length,
    ),
    createMany: vi.fn(async ({ data }: any) => {
      const credit = data[0];
      const duplicate = [...state.credits.values()].some(
        (candidate) =>
          candidate.storeId === credit.storeId &&
          candidate.orderId === credit.orderId,
      );
      if (duplicate) return { count: 0 };
      state.credits.set(credit.id, { ...credit });
      return { count: 1 };
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const credit = state.credits.get(where.id);
      if (!credit || !matches(credit, where)) return { count: 0 };
      Object.assign(credit, data);
      return { count: 1 };
    }),
  },
  weleticLoyaltyEarnGrant: {
    findUnique: vi.fn(async ({ where }: any) =>
      [...state.grants.values()].find(
        (grant) =>
          grant.storeId === where.storeId_orderId.storeId &&
          grant.orderId === where.storeId_orderId.orderId,
      ),
    ),
    create: vi.fn(async ({ data }: any) => {
      state.grants.set(data.id, { ...data });
      return { ...data };
    }),
  },
  weleticPointsLedgerEntry: {
    findUnique: vi.fn(),
    create: vi.fn(),
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (operation: any) => operation(tx)),
    weleticLoyaltyBackfillJob: {
      findUnique: vi.fn(async ({ where }: any) => {
        const job = state.jobs.get(where.id);
        return job ? { ...job } : null;
      }),
      updateMany: vi.fn((args: any) =>
        tx.weleticLoyaltyBackfillJob.updateMany(args),
      ),
    },
    weleticLoyaltyBackfillOrderSnapshot: {
      findMany: vi.fn(async ({ where }: any) =>
        [...state.snapshots.values()].filter(
          (snapshot) => snapshot.jobId === where.jobId,
        ),
      ),
    },
    weleticLoyaltyBackfillOrderCredit: {
      findMany: vi.fn((args: any) =>
        tx.weleticLoyaltyBackfillOrderCredit.findMany(args),
      ),
    },
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: mocks.withLock,
}));

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  assertActiveLoyaltyAccountForMutation: mocks.assertActiveAccount,
  withActiveStoreLoyaltyMutation: mocks.withFence,
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: mocks.appendLedgerEntry,
}));

const order: HistoricalBackfillOrder & { storeId: string } = {
  id: "worder_backfill",
  storeId: "wstore_backfill",
  shopperId: "wshopper_backfill",
  status: "partially_refunded",
  shopCurrency: "USD",
  shopNet: BigInt(10_000),
  shopSubtotal: BigInt(10_000),
  shopTotal: BigInt(10_000),
  presentmentCurrency: "USD",
  presentmentNet: BigInt(10_000),
  presentmentTotal: BigInt(10_000),
  occurredAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-02T00:00:00.000Z"),
  refunds: [
    {
      id: "wrefund_backfill",
      shopAmount: BigInt(2_500),
      presentmentAmount: BigInt(2_500),
      updatedAt: new Date("2026-08-02T00:00:00.000Z"),
      lines: [
        {
          id: "wrline_backfill",
          orderLineId: "wline_backfill_a",
          shopAmount: BigInt(2_500),
          quantity: 0,
        },
      ],
    },
  ],
  lines: [
    {
      id: "wline_backfill_a",
      externalId: "line-a",
      title: "A",
      quantity: 1,
      shopNet: BigInt(5_000),
      shopGross: BigInt(5_000),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    {
      id: "wline_backfill_b",
      externalId: "line-b",
      title: "B",
      quantity: 1,
      shopNet: BigInt(5_000),
      shopGross: BigInt(5_000),
      updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
  ],
};

function seed(jobId = "wbackfill_durable") {
  const job = {
    id: jobId,
    storeId: order.storeId,
    programId: "wprogram_backfill",
    status: WeleticLoyaltyBackfillJobStatus.preview_ready,
    metadata: { installationGeneration: "sgen_backfill" },
    lookbackDays: 60,
    lookbackStartDate: null,
    pointsPerCurrencyUnit: 1,
    minOrderAmount: null,
    totalShoppersCount: 1,
    totalOrdersCount: 1,
    totalProjectedPoints: BigInt(75),
    processedAccountsCount: 0,
    totalCommittedPoints: BigInt(0),
    commitLeaseId: null,
    errorLog: null,
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
    updatedAt: new Date("2026-08-03T00:00:00.000Z"),
    completedAt: null,
  };
  state.jobs.set(jobId, job);
  state.snapshots.set(`${jobId}:snapshot`, {
    id: `${jobId}:snapshot`,
    jobId,
    storeId: order.storeId,
    programId: job.programId,
    shopperId: order.shopperId,
    accountId: "waccount_backfill",
    orderId: order.id,
    orderVersion: order.updatedAt,
    orderStatus: order.status,
    orderHash: buildHistoricalOrderSnapshotHash(order),
    policyRevisionId: "wpolicy_backfill",
    currency: "USD",
    eligibleSpend: BigInt(7_500),
    refundedSpend: BigInt(2_500),
    orderTotalAmount: BigInt(10_000),
    projectedPoints: BigInt(75),
    pointsPerCurrencyUnit: 1,
    effectiveMultiplier: 1,
    lineAllocations: [
      {
        orderLineId: "wline_backfill_a",
        productId: null,
        variantId: null,
        lineExternalId: "line-a",
        title: "A",
        quantity: 1,
        lineNetAmount: "2500",
        awardedPoints: "25",
      },
      {
        orderLineId: "wline_backfill_b",
        productId: null,
        variantId: null,
        lineExternalId: "line-b",
        title: "B",
        quantity: 1,
        lineNetAmount: "5000",
        awardedPoints: "50",
      },
    ],
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
  });
  return job;
}

describe("loyalty backfill durable per-order commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.jobs.clear();
    state.snapshots.clear();
    state.credits.clear();
    state.grants.clear();
    state.order = structuredClone(order);
    mocks.withLock.mockImplementation(async ({ fn }: any) => fn());
    mocks.withFence.mockImplementation(async ({ operation }: any) =>
      operation(tx, "sgen_backfill"),
    );
    mocks.assertActiveAccount.mockResolvedValue({ id: "waccount_backfill" });
    mocks.appendLedgerEntry.mockImplementation(async (input: any) => ({
      id: `wledger_${input.referenceId}`,
      ...input,
    }));
  });

  it("commits one complete grant, ledger row, and durable marker per order", async () => {
    const job = seed();

    await expect(commitBackfillJob(job.id)).resolves.toMatchObject({
      status: WeleticLoyaltyBackfillJobStatus.completed,
      processedAccountsCount: 1,
      totalCommittedPoints: BigInt(75),
    });

    expect(mocks.appendLedgerEntry).toHaveBeenCalledOnce();
    expect(mocks.appendLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: `backfill:order:${order.id}`,
        pointsDelta: BigInt(75),
        referenceType: "historical_order",
        referenceId: order.id,
      }),
    );
    expect(tx.weleticLoyaltyEarnGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: order.id,
          eligibleSubtotalAmount: BigInt(7_500),
          grossPoints: BigInt(75),
          lineEarns: { create: expect.arrayContaining([expect.any(Object)]) },
        }),
      }),
    );
    expect([...state.credits.values()][0]).toMatchObject({
      orderId: order.id,
      status: WeleticLoyaltyBackfillCreditStatus.credited,
      points: BigInt(75),
    });

    await commitBackfillJob(job.id);
    expect(mocks.appendLedgerEntry).toHaveBeenCalledOnce();
  });

  it("returns the job to preview-ready when the order version changes", async () => {
    const job = seed();
    state.order = {
      ...state.order,
      status: "refunded",
      updatedAt: new Date("2026-08-04T00:00:00.000Z"),
    };

    await expect(commitBackfillJob(job.id)).rejects.toBeInstanceOf(
      BackfillPreviewStaleError,
    );
    expect(job.status).toBe(WeleticLoyaltyBackfillJobStatus.preview_ready);
    expect(job.errorLog).toContain("BACKFILL_PREVIEW_STALE");
    expect(mocks.appendLedgerEntry).not.toHaveBeenCalled();
    expect(state.credits.size).toBe(0);
  });

  it("rejects a snapshot whose line allocations do not conserve points", async () => {
    const job = seed();
    const snapshot = state.snapshots.get(`${job.id}:snapshot`)!;
    snapshot.lineAllocations[0].awardedPoints = "24";

    await expect(commitBackfillJob(job.id)).rejects.toThrow(
      "do not conserve the immutable order snapshot",
    );
    expect(job.status).toBe(WeleticLoyaltyBackfillJobStatus.failed);
    expect(mocks.appendLedgerEntry).not.toHaveBeenCalled();
    expect(state.credits.size).toBe(0);
  });

  it("allows only one active committer for an order", async () => {
    const job = seed();
    let held = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const appendStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.withLock.mockImplementation(async ({ fn, onLocked }: any) => {
      if (held) return onLocked();
      held = true;
      try {
        return await fn();
      } finally {
        held = false;
      }
    });
    mocks.appendLedgerEntry.mockImplementationOnce(async (input: any) => {
      started();
      await blocked;
      return { id: `wledger_${input.referenceId}`, ...input };
    });

    const first = commitBackfillJob(job.id);
    await appendStarted;
    await expect(commitBackfillJob(job.id)).rejects.toThrow(
      "already being committed",
    );
    release();
    await expect(first).resolves.toMatchObject({
      status: WeleticLoyaltyBackfillJobStatus.completed,
    });
    expect(mocks.appendLedgerEntry).toHaveBeenCalledOnce();
  });
});

describe("historical order snapshot valuation", () => {
  it("keeps a partial refund and conserves spend and points across lines", () => {
    const result = reconcileCompensatoryHistoricalOrder({
      order,
      pointsPerCurrencyUnit: 1,
    });

    expect(result.isPartiallyRefunded).toBe(true);
    expect(result.eligibleNetSpend).toBe(BigInt(7_500));
    expect(result.projectedPoints).toBe(BigInt(75));
    expect(
      result.lineAllocations.reduce(
        (total, line) => total + line.lineNetAmount,
        BigInt(0),
      ),
    ).toBe(BigInt(7_500));
    expect(
      result.lineAllocations.reduce(
        (total, line) => total + line.awardedPoints,
        BigInt(0),
      ),
    ).toBe(BigInt(75));
  });

  it.each([
    {
      currency: "JPY",
      amount: BigInt(10_000),
      rate: 0.01,
      points: BigInt(100),
    },
    {
      currency: "VND",
      amount: BigInt(500_000),
      rate: 0.001,
      points: BigInt(500),
    },
    { currency: "BHD", amount: BigInt(10_500), rate: 2, points: BigInt(21) },
  ])(
    "converts $currency major units through the ISO minor-unit scale",
    ({ currency, amount, rate, points }) => {
      const result = reconcileCompensatoryHistoricalOrder({
        order: {
          id: `order_${currency}`,
          status: "paid",
          shopCurrency: currency,
          shopNet: amount,
          shopTotal: amount,
          lines: [
            {
              id: `line_${currency}`,
              externalId: `external_${currency}`,
              quantity: 1,
              shopNet: amount,
            },
          ],
        },
        pointsPerCurrencyUnit: rate,
      });

      expect(result.projectedPoints).toBe(points);
      expect(result.lineAllocations[0].awardedPoints).toBe(points);
    },
  );

  it("excludes fully refunded and voided orders", () => {
    const fullyRefunded = reconcileCompensatoryHistoricalOrder({
      order: {
        ...order,
        status: "refunded",
        refunds: [
          {
            id: "refund_full",
            shopAmount: BigInt(10_000),
            presentmentAmount: BigInt(10_000),
            lines: [],
          },
        ],
      },
      pointsPerCurrencyUnit: 1,
    });
    const voided = reconcileCompensatoryHistoricalOrder({
      order: { ...order, status: "voided" },
      pointsPerCurrencyUnit: 1,
    });

    expect(fullyRefunded).toMatchObject({
      isFullyRefunded: true,
      eligibleNetSpend: BigInt(0),
      projectedPoints: BigInt(0),
      lineAllocations: [],
    });
    expect(voided).toMatchObject({
      isCancelled: true,
      eligibleNetSpend: BigInt(0),
      projectedPoints: BigInt(0),
      lineAllocations: [],
    });
  });

  it("fails closed when a partial refund lacks merchandise-line evidence", () => {
    const result = reconcileCompensatoryHistoricalOrder({
      order: {
        ...order,
        refunds: [
          {
            id: "refund_without_lines",
            shopAmount: BigInt(2_500),
            presentmentAmount: BigInt(2_500),
            lines: [],
          },
        ],
      },
      pointsPerCurrencyUnit: 1,
    });

    expect(result.missingLinesFallback).toBe(true);
  });

  it("uses returned quantity as a conservative floor for zero-cash refunds", () => {
    const result = reconcileCompensatoryHistoricalOrder({
      order: {
        id: "order_quantity_refund",
        status: "partially_refunded",
        shopCurrency: "USD",
        shopNet: BigInt(10_000),
        shopTotal: BigInt(10_000),
        refunds: [
          {
            id: "refund_quantity_only",
            shopAmount: BigInt(0),
            lines: [
              {
                id: "refund_line_quantity_only",
                orderLineId: "line_quantity_refund",
                shopAmount: BigInt(0),
                quantity: 1,
              },
            ],
          },
        ],
        lines: [
          {
            id: "line_quantity_refund",
            externalId: "external_quantity_refund",
            quantity: 4,
            shopNet: BigInt(10_000),
          },
        ],
      },
      pointsPerCurrencyUnit: 1,
    });

    expect(result.refundedSpend).toBe(BigInt(2_500));
    expect(result.eligibleNetSpend).toBe(BigInt(7_500));
    expect(result.projectedPoints).toBe(BigInt(75));
    expect(result.lineAllocations[0]).toMatchObject({
      lineNetAmount: BigInt(7_500),
      awardedPoints: BigInt(75),
    });
  });

  it("fails closed when partially-refunded status has no refund snapshot", () => {
    const result = reconcileCompensatoryHistoricalOrder({
      order: { ...order, refunds: [] },
      pointsPerCurrencyUnit: 1,
    });

    expect(result.missingLinesFallback).toBe(true);
  });

  it("uses deterministic Hare-Niemeyer allocation for a multi-line remainder", () => {
    const result = reconcileCompensatoryHistoricalOrder({
      order: {
        id: "order_remainder",
        status: "paid",
        shopCurrency: "USD",
        shopNet: BigInt(100),
        shopTotal: BigInt(100),
        lines: ["a", "b", "c"].map((id) => ({
          id: `line_${id}`,
          externalId: id,
          quantity: 1,
          shopNet: id === "c" ? BigInt(34) : BigInt(33),
        })),
      },
      pointsPerCurrencyUnit: 1,
    });

    expect(result.projectedPoints).toBe(BigInt(1));
    expect(
      result.lineAllocations.map(({ awardedPoints }) => awardedPoints),
    ).toEqual([BigInt(0), BigInt(0), BigInt(1)]);
  });

  it("changes the immutable hash when order or refund state changes", () => {
    const first = buildHistoricalOrderSnapshotHash(order);
    const changed = buildHistoricalOrderSnapshotHash({
      ...order,
      refunds: [
        {
          ...order.refunds![0],
          lines: [{ ...order.refunds![0].lines![0], quantity: 1 }],
        },
      ],
    });

    expect(changed).not.toBe(first);
  });
});
