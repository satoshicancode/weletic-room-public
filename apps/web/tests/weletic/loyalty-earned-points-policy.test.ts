import { prisma } from "@/lib/prisma";
import {
  appendPointsLedgerEntry,
  reconcileAccountPoints,
} from "@/lib/weletic/loyalty/ledger";
import {
  GENUINE_EARN_ENTRY_TYPES,
  getLifetimeEarnedPointsDelta,
} from "@/lib/weletic/loyalty/ledger-entry-policy";
import { WeleticPointsLedgerEntryType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (callback) => callback(prisma)),
  },
}));

describe("loyalty genuine-earned-points policy", () => {
  const storeId = "wstore_earned_policy";
  const accountId = "wlacc_earned_policy";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
      id: accountId,
      storeId,
      cachedPointsBalance: BigInt(100),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(500),
      lifetimePointsRedeemed: BigInt(100),
      ledgerVersion: 4,
      status: "active",
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValue({
      count: 1,
    });
    (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
      ({ data }: any) => ({ id: "wledger_policy", ...data }),
    );
  });

  it.each([
    ["failed-redemption compensation", "REDEMPTION_REFUND"],
    ["redemption cancellation", "REWARD_REDEMPTION_CANCEL"],
  ])(
    "restores the spendable balance for %s without manufacturing lifetime earnings",
    async (_scenario, referenceType) => {
      await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        pointsDelta: BigInt(100),
        referenceType,
        referenceId: "redemption_1",
        idempotencyKey: `restore:${referenceType}`,
      });

      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(200),
            lifetimePointsEarned: BigInt(500),
          }),
        }),
      );
    },
  );

  it.each(GENUINE_EARN_ENTRY_TYPES)(
    "counts a positive %s entry as genuine lifetime earnings",
    async (entryType) => {
      await appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType,
        pointsDelta: BigInt(25),
        idempotencyKey: `earn:${entryType}`,
      });

      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(125),
            lifetimePointsEarned: BigInt(525),
          }),
        }),
      );
    },
  );

  it("reverses invalid backfill lifetime earnings before replay", async () => {
    await appendPointsLedgerEntry({
      storeId,
      accountId,
      entryType: WeleticPointsLedgerEntryType.BACKFILL_CORRECTION,
      pointsDelta: BigInt(-200),
      idempotencyKey: "backfill:correction:legacy_1",
    });

    expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cachedPointsBalance: BigInt(-100),
          lifetimePointsEarned: BigInt(300),
        }),
      }),
    );
  });

  it("does not change lifetime earnings for refunds or positive corrections", () => {
    expect(
      getLifetimeEarnedPointsDelta(
        WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        BigInt(-50),
      ),
    ).toBe(BigInt(0));
    expect(
      getLifetimeEarnedPointsDelta(
        WeleticPointsLedgerEntryType.BACKFILL_CORRECTION,
        BigInt(50),
      ),
    ).toBe(BigInt(0));
  });

  it("removes only explicit invalid-review reversals from lifetime earnings", () => {
    expect(
      getLifetimeEarnedPointsDelta(
        WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        BigInt(-100),
        "REVIEW_INCENTIVE_REVERSAL",
      ),
    ).toBe(BigInt(-100));
    expect(
      getLifetimeEarnedPointsDelta(
        WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        BigInt(-100),
        "REVIEW_NATIVE_CLAWBACK",
      ),
    ).toBe(BigInt(0));
    expect(
      getLifetimeEarnedPointsDelta(
        WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        BigInt(-100),
        "REVIEW_INCENTIVE_REVERSAL",
      ),
    ).toBe(BigInt(0));
    expect(
      getLifetimeEarnedPointsDelta(
        WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        BigInt(100),
        "REVIEW_INCENTIVE_REVERSAL",
      ),
    ).toBe(BigInt(0));
  });

  it("rejects a correction that would make lifetime earnings negative", async () => {
    await expect(
      appendPointsLedgerEntry({
        storeId,
        accountId,
        entryType: WeleticPointsLedgerEntryType.BACKFILL_CORRECTION,
        pointsDelta: BigInt(-501),
        idempotencyKey: "backfill:correction:invalid",
      }),
    ).rejects.toThrow("correction would make the total negative");

    expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
  });

  it("repairs legacy lifetime totals without counting a redemption restoration as earned", async () => {
    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
      id: accountId,
      storeId,
      cachedPointsBalance: BigInt(100),
      lifetimePointsEarned: BigInt(200),
      lifetimePointsRedeemed: BigInt(100),
      ledgerVersion: 3,
    } as any);
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce([
      {
        id: "earn_1",
        sequenceNumber: 1,
        pointsDelta: BigInt(100),
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      },
      {
        id: "redeem_1",
        sequenceNumber: 2,
        pointsDelta: BigInt(-100),
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
      },
      {
        id: "restore_1",
        sequenceNumber: 3,
        pointsDelta: BigInt(100),
        entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      },
    ] as any);

    const result = await reconcileAccountPoints(accountId);

    expect(result.repaired).toBe(true);
    expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        cachedPointsBalance: BigInt(100),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(100),
        ledgerVersion: 3,
      },
    });
  });

  it("reconciles a corrected and replayed backfill to the net lifetime total", async () => {
    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
      id: accountId,
      storeId,
      cachedPointsBalance: BigInt(200),
      lifetimePointsEarned: BigInt(400),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 4,
    } as any);
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce([
      {
        id: "legacy_backfill",
        sequenceNumber: 1,
        pointsDelta: BigInt(200),
        entryType: WeleticPointsLedgerEntryType.BACKFILL,
      },
      {
        id: "correction",
        sequenceNumber: 2,
        pointsDelta: BigInt(-200),
        entryType: WeleticPointsLedgerEntryType.BACKFILL_CORRECTION,
      },
      {
        id: "replay_1",
        sequenceNumber: 3,
        pointsDelta: BigInt(100),
        entryType: WeleticPointsLedgerEntryType.BACKFILL,
      },
      {
        id: "replay_2",
        sequenceNumber: 4,
        pointsDelta: BigInt(100),
        entryType: WeleticPointsLedgerEntryType.BACKFILL,
      },
    ] as any);

    const result = await reconcileAccountPoints(accountId);

    expect(result.repaired).toBe(true);
    expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        cachedPointsBalance: BigInt(200),
        lifetimePointsEarned: BigInt(200),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 4,
      },
    });
  });
});
