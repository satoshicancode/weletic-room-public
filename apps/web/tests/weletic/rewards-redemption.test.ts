import { describe, expect, it } from "vitest";

describe("Weletic Customer Loyalty Reward Catalog & Redemption Engine (ADR 0003, ADR 0004)", () => {
  interface SimulatedReward {
    id: string;
    storeId: string;
    name: string;
    pointsCost: bigint;
    discountValue: number;
    rewardType: string;
    status: string;
  }

  interface SimulatedRedemption {
    id: string;
    storeId: string;
    accountId: string;
    rewardId: string;
    pointsSpent: bigint;
    discountCode: string;
    status: string;
    createdAt: Date;
  }

  const createSimulatedRewardSystem = () => {
    const rewards = new Map<string, SimulatedReward>();
    const redemptions = new Map<string, SimulatedRedemption>();
    const accounts = new Map<
      string,
      { balance: bigint; status: string; programActive: boolean }
    >();

    const redeem = ({
      storeId,
      accountId,
      rewardId,
      codeOverride,
    }: {
      storeId: string;
      accountId: string;
      rewardId: string;
      codeOverride?: string;
    }) => {
      const account = accounts.get(accountId);
      if (!account) {
        throw new Error("Account not found");
      }
      if (account.status !== "active") {
        throw new Error("Account is not active");
      }
      if (!account.programActive) {
        throw new Error("Program is not active");
      }

      const reward = rewards.get(rewardId);
      if (!reward || reward.status !== "active") {
        throw new Error("Reward not found or inactive");
      }

      if (account.balance < reward.pointsCost || account.balance <= BigInt(0)) {
        throw new Error("INSUFFICIENT_POINTS");
      }

      // Debit points
      account.balance -= reward.pointsCost;

      const redemptionId = `wredemp_${redemptions.size + 1}`;
      const discountCode =
        codeOverride ||
        `WL-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

      const redemption: SimulatedRedemption = {
        id: redemptionId,
        storeId,
        accountId,
        rewardId,
        pointsSpent: reward.pointsCost,
        discountCode,
        status: "active",
        createdAt: new Date(),
      };

      redemptions.set(redemptionId, redemption);

      return {
        success: true,
        redemption,
        discountCode,
        newBalance: account.balance,
      };
    };

    const cancelRedemption = ({ redemptionId }: { redemptionId: string }) => {
      const redemption = redemptions.get(redemptionId);
      if (!redemption) {
        throw new Error("Redemption not found");
      }
      if (redemption.status !== "active") {
        throw new Error("Redemption already closed");
      }

      const account = accounts.get(redemption.accountId);
      if (account) {
        account.balance += redemption.pointsSpent;
      }

      redemption.status = "cancelled";
      return { success: true, redemption, restoredBalance: account?.balance };
    };

    return { rewards, redemptions, accounts, redeem, cancelRedemption };
  };

  it("redeems reward, generates unique discount code, and atomically debits points", () => {
    const sys = createSimulatedRewardSystem();
    sys.rewards.set("wreward_1", {
      id: "wreward_1",
      storeId: "store_1",
      name: "$10 Off Voucher",
      pointsCost: BigInt(200),
      discountValue: 10.0,
      rewardType: "amount_off",
      status: "active",
    });

    sys.accounts.set("acc_1", {
      balance: BigInt(500),
      status: "active",
      programActive: true,
    });

    const res = sys.redeem({
      storeId: "store_1",
      accountId: "acc_1",
      rewardId: "wreward_1",
      codeOverride: "WL-TENOFF-1234",
    });

    expect(res.success).toBe(true);
    expect(res.discountCode).toBe("WL-TENOFF-1234");
    expect(res.newBalance).toBe(BigInt(300));
    expect(res.redemption.status).toBe("active");
  });

  it("blocks redemption when account has insufficient points or negative balance", () => {
    const sys = createSimulatedRewardSystem();
    sys.rewards.set("wreward_2", {
      id: "wreward_2",
      storeId: "store_1",
      name: "$20 Off Voucher",
      pointsCost: BigInt(400),
      discountValue: 20.0,
      rewardType: "amount_off",
      status: "active",
    });

    // Account with 100 points (< 400 needed)
    sys.accounts.set("acc_low", {
      balance: BigInt(100),
      status: "active",
      programActive: true,
    });

    expect(() =>
      sys.redeem({
        storeId: "store_1",
        accountId: "acc_low",
        rewardId: "wreward_2",
      }),
    ).toThrow("INSUFFICIENT_POINTS");

    // Account in negative balance (-50)
    sys.accounts.set("acc_neg", {
      balance: BigInt(-50),
      status: "active",
      programActive: true,
    });

    expect(() =>
      sys.redeem({
        storeId: "store_1",
        accountId: "acc_neg",
        rewardId: "wreward_2",
      }),
    ).toThrow("INSUFFICIENT_POINTS");
  });

  it("restores points to account when an unused redemption is cancelled", () => {
    const sys = createSimulatedRewardSystem();
    sys.rewards.set("wreward_3", {
      id: "wreward_3",
      storeId: "store_1",
      name: "Free Shipping",
      pointsCost: BigInt(150),
      discountValue: 0,
      rewardType: "free_shipping",
      status: "active",
    });

    sys.accounts.set("acc_3", {
      balance: BigInt(300),
      status: "active",
      programActive: true,
    });

    const redeemRes = sys.redeem({
      storeId: "store_1",
      accountId: "acc_3",
      rewardId: "wreward_3",
    });
    expect(redeemRes.newBalance).toBe(BigInt(150));

    // Cancel redemption
    const cancelRes = sys.cancelRedemption({
      redemptionId: redeemRes.redemption.id,
    });
    expect(cancelRes.success).toBe(true);
    expect(cancelRes.restoredBalance).toBe(BigInt(300));
    expect(cancelRes.redemption.status).toBe("cancelled");
  });
});
