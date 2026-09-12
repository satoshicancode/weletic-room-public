import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import { beforeEach, describe, expect, it, vi } from "vitest";

// This suite isolates tier accounting. Notification delivery and actual
// transactional rollback require separate producer and SQL coverage.
vi.mock("@/lib/weletic/loyalty/vip-achievement-communication-producer", () => ({
  enqueueVipAchievementCommunication: vi.fn().mockResolvedValue(null),
}));

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  accountUpdate: vi.fn(),
  orderFindMany: vi.fn(),
  ledgerFindMany: vi.fn(),
  tierHistoryCreate: vi.fn(),
  appendPointsLedgerEntry: vi.fn(),
  enqueueOutboxJob: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const transactionClient = {
    weleticLoyaltyAccount: {
      findUnique: mocks.accountFindUnique,
      update: mocks.accountUpdate,
    },
    weleticLoyaltyTier: { findMany: vi.fn() },
    weleticCommerceOrder: { findMany: mocks.orderFindMany },
    weleticPointsLedgerEntry: { findMany: mocks.ledgerFindMany },
    weleticLoyaltyTierHistory: { create: mocks.tierHistoryCreate },
  };
  return {
    prisma: {
      ...transactionClient,
      $transaction: vi.fn((operation) => operation(transactionClient)),
    },
  };
});

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: mocks.appendPointsLedgerEntry,
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueueOutboxJob,
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

const tiers = [
  {
    id: "wtier_bronze",
    name: "Bronze",
    tierOrder: 1,
    minSpendThreshold: BigInt(0),
    minPointsThreshold: BigInt(0),
    entryBonusPoints: BigInt(0),
  },
  {
    id: "wtier_silver",
    name: "Silver",
    tierOrder: 2,
    minSpendThreshold: BigInt(10_000),
    minPointsThreshold: BigInt(100),
    entryBonusPoints: BigInt(100),
  },
  {
    id: "wtier_gold",
    name: "Gold",
    tierOrder: 3,
    minSpendThreshold: BigInt(20_000),
    minPointsThreshold: BigInt(200),
    entryBonusPoints: BigInt(250),
  },
];

describe("VIP Smile parity invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountUpdate.mockResolvedValue({});
    mocks.tierHistoryCreate.mockResolvedValue({});
    mocks.ledgerFindMany.mockResolvedValue([]);
    mocks.enqueueOutboxJob.mockResolvedValue({});
    mocks.appendPointsLedgerEntry.mockImplementation(async (input) => ({
      id: `ledger_${input.referenceId}`,
      balanceAfter: BigInt(1_000) + BigInt(input.pointsDelta),
      ...input,
    }));
  });

  it("awards every skipped tier entry bonus during a direct promotion", async () => {
    mocks.accountFindUnique.mockResolvedValue({
      id: "wacc_1",
      storeId: "wstore_1",
      shopperId: "wshopper_1",
      status: "active",
      metadata: null,
      currentTierId: "wtier_bronze",
      currentTier: tiers[0],
      program: {
        vipMilestoneMode: "amount_spent",
        vipTimeframe: "lifetime",
        vipAutoDowngradeEnabled: true,
        tiers,
      },
    });
    mocks.orderFindMany.mockResolvedValue([{ shopTotal: BigInt(25_000) }]);

    await expect(
      evaluateTierMaintenanceCycle({
        storeId: "wstore_1",
        accountId: "wacc_1",
        now: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "PROMOTED", newTierId: "wtier_gold" });

    expect(appendPointsLedgerEntry).toHaveBeenCalledTimes(2);
    expect(
      mocks.appendPointsLedgerEntry.mock.calls.map(
        ([call]) => call.pointsDelta,
      ),
    ).toEqual([BigInt(100), BigInt(250)]);
    for (const [call] of mocks.appendPointsLedgerEntry.mock.calls) {
      expect(call.idempotencyKey).toMatch(
        /^tier_upgrade_bonus:wacc_1:wtier_[A-Za-z0-9_-]+:wtier_/,
      );
    }
  });

  it("never downgrades the highest tier reached in lifetime mode", async () => {
    mocks.accountFindUnique.mockResolvedValue({
      id: "wacc_2",
      storeId: "wstore_1",
      shopperId: "wshopper_2",
      status: "active",
      metadata: null,
      currentTierId: "wtier_gold",
      currentTier: tiers[2],
      tierExpiresAt: null,
      program: {
        vipMilestoneMode: "amount_spent",
        vipTimeframe: "lifetime",
        vipAutoDowngradeEnabled: true,
        tiers,
      },
    });
    mocks.orderFindMany.mockResolvedValue([]);

    await expect(
      evaluateTierMaintenanceCycle({
        storeId: "wstore_1",
        accountId: "wacc_2",
      }),
    ).resolves.toMatchObject({
      status: "MAINTAINED",
      previousTierId: "wtier_gold",
      newTierId: "wtier_gold",
      tierChanged: false,
    });
    expect(mocks.accountUpdate).toHaveBeenCalledWith({
      where: { id: "wacc_2" },
      data: {
        tierExpiresAt: null,
        tierSpendRolling12Months: BigInt(0),
        tierPointsRolling12Months: BigInt(0),
      },
    });
    expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
  });

  it("subtracts partial refunds from amount-spent tier qualification", async () => {
    mocks.accountFindUnique.mockResolvedValue({
      id: "wacc_3",
      storeId: "wstore_1",
      shopperId: "wshopper_3",
      status: "active",
      metadata: null,
      currentTierId: "wtier_bronze",
      currentTier: tiers[0],
      tierExpiresAt: null,
      program: {
        vipMilestoneMode: "amount_spent",
        vipTimeframe: "lifetime",
        vipAutoDowngradeEnabled: true,
        tiers,
      },
    });
    mocks.orderFindMany.mockResolvedValue([
      {
        shopTotal: BigInt(12_000),
        refunds: [{ shopAmount: BigInt(3_000) }],
      },
    ]);

    await expect(
      evaluateTierMaintenanceCycle({
        storeId: "wstore_1",
        accountId: "wacc_3",
      }),
    ).resolves.toMatchObject({
      status: "MAINTAINED",
      newTierId: "wtier_bronze",
      qualifyingSpend: BigInt(9_000),
    });
    expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
  });
});
