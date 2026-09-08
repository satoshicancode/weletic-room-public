import { generateReferralCode } from "@/lib/weletic/loyalty/referrals";
import { describe, expect, it } from "vitest";

describe("Weletic Customer Loyalty Customer Referrals Engine", () => {
  interface SimulatedReferralRule {
    advocatePointsReward: bigint;
    refereePointsReward: bigint;
    minQualifyingOrderSubtotal?: number | null;
    maxReferralsPerAdvocate?: number | null;
    isActive: boolean;
  }

  interface SimulatedAccount {
    id: string;
    storeId: string;
    shopperId: string;
    referralCode?: string | null;
    referredById?: string | null;
    referralCount: number;
    referralPointsEarned: bigint;
    balance: bigint;
  }

  interface SimulatedReferral {
    id: string;
    advocateAccountId: string;
    refereeAccountId: string;
    status: "pending" | "qualified" | "rewarded" | "fraud_blocked";
    qualifyingOrderId?: string | null;
    advocatePointsAwarded: bigint;
    refereePointsAwarded: bigint;
  }

  const createReferralTestHarness = () => {
    const accounts = new Map<string, SimulatedAccount>();
    const referrals = new Map<string, SimulatedReferral>();
    let rule: SimulatedReferralRule = {
      advocatePointsReward: BigInt(100),
      refereePointsReward: BigInt(50),
      minQualifyingOrderSubtotal: null,
      maxReferralsPerAdvocate: null,
      isActive: true,
    };

    const bindReferral = (params: {
      refereeAccountId: string;
      referralCode: string;
    }) => {
      if (!rule.isActive) {
        throw new Error("Referral program is inactive");
      }

      const normalizedCode = params.referralCode.trim().toUpperCase();
      const advocate = Array.from(accounts.values()).find(
        (a) => a.referralCode === normalizedCode,
      );

      if (!advocate) {
        throw new Error(`Invalid referral code: ${normalizedCode}`);
      }

      if (advocate.id === params.refereeAccountId) {
        throw new Error("Self-referral is strictly prohibited.");
      }

      const referee = accounts.get(params.refereeAccountId);
      if (!referee) {
        throw new Error("Referee account not found");
      }

      if (referee.referredById) {
        throw new Error("Account has already been referred by another member.");
      }

      if (
        rule.maxReferralsPerAdvocate &&
        advocate.referralCount >= rule.maxReferralsPerAdvocate
      ) {
        throw new Error("Advocate has reached max referrals");
      }

      const referralId = `ref_${referrals.size + 1}`;
      const referral: SimulatedReferral = {
        id: referralId,
        advocateAccountId: advocate.id,
        refereeAccountId: referee.id,
        status: "pending",
        advocatePointsAwarded: BigInt(0),
        refereePointsAwarded: BigInt(0),
      };

      referee.referredById = advocate.id;
      referrals.set(referralId, referral);
      return referral;
    };

    const evaluateQualification = (params: {
      refereeAccountId: string;
      orderId: string;
      orderSubtotalMinor: bigint;
      currency: string;
    }) => {
      const referral = Array.from(referrals.values()).find(
        (r) =>
          r.refereeAccountId === params.refereeAccountId &&
          r.status === "pending",
      );

      if (!referral) {
        return { qualified: false, reason: "No pending referral found" };
      }

      if (rule.minQualifyingOrderSubtotal) {
        const isZeroDecimal = ["JPY", "VND"].includes(
          params.currency.toUpperCase(),
        );
        const majorSubtotal = isZeroDecimal
          ? Number(params.orderSubtotalMinor)
          : Number(params.orderSubtotalMinor) / 100;

        if (majorSubtotal < rule.minQualifyingOrderSubtotal) {
          return {
            qualified: false,
            reason: "Order subtotal below minimum qualifying threshold",
          };
        }
      }

      const advocate = accounts.get(referral.advocateAccountId);
      const referee = accounts.get(referral.refereeAccountId);

      if (advocate) {
        advocate.balance += rule.advocatePointsReward;
        advocate.referralCount += 1;
        advocate.referralPointsEarned += rule.advocatePointsReward;
      }

      if (referee && rule.refereePointsReward > BigInt(0)) {
        referee.balance += rule.refereePointsReward;
      }

      referral.status = "rewarded";
      referral.qualifyingOrderId = params.orderId;
      referral.advocatePointsAwarded = rule.advocatePointsReward;
      referral.refereePointsAwarded = rule.refereePointsReward;

      return {
        qualified: true,
        advocatePointsAwarded: rule.advocatePointsReward,
        refereePointsAwarded: rule.refereePointsReward,
      };
    };

    return {
      accounts,
      referrals,
      setRule: (r: Partial<SimulatedReferralRule>) => {
        rule = { ...rule, ...r };
      },
      bindReferral,
      evaluateQualification,
    };
  };

  it("generates uppercase formatted referral codes", () => {
    const code1 = generateReferralCode("Alice");
    expect(code1.startsWith("ALICE-")).toBe(true);

    const code2 = generateReferralCode();
    expect(code2.startsWith("REF-")).toBe(true);
  });

  it("binds referee to advocate and blocks self-referral and duplicates", () => {
    const harness = createReferralTestHarness();

    // Advocate
    harness.accounts.set("acc_adv", {
      id: "acc_adv",
      storeId: "store_1",
      shopperId: "shopper_adv",
      referralCode: "ALICE-8888",
      referralCount: 0,
      referralPointsEarned: BigInt(0),
      balance: BigInt(0),
    });

    // Referee
    harness.accounts.set("acc_ref", {
      id: "acc_ref",
      storeId: "store_1",
      shopperId: "shopper_ref",
      referralCode: "BOB-1111",
      referralCount: 0,
      referralPointsEarned: BigInt(0),
      balance: BigInt(0),
    });

    // 1. Self-referral rejection
    expect(() =>
      harness.bindReferral({
        refereeAccountId: "acc_adv",
        referralCode: "ALICE-8888",
      }),
    ).toThrow("Self-referral is strictly prohibited.");

    // 2. Valid referral binding
    const referral = harness.bindReferral({
      refereeAccountId: "acc_ref",
      referralCode: "ALICE-8888",
    });

    expect(referral.id).toBeDefined();
    expect(referral.advocateAccountId).toBe("acc_adv");
    expect(referral.refereeAccountId).toBe("acc_ref");
    expect(referral.status).toBe("pending");
    expect(harness.accounts.get("acc_ref")?.referredById).toBe("acc_adv");

    // 3. Duplicate binding rejection
    expect(() =>
      harness.bindReferral({
        refereeAccountId: "acc_ref",
        referralCode: "ALICE-8888",
      }),
    ).toThrow("Account has already been referred by another member.");
  });

  it("awards double-sided referral points upon referee's first qualifying order", () => {
    const harness = createReferralTestHarness();
    harness.setRule({
      advocatePointsReward: BigInt(150),
      refereePointsReward: BigInt(75),
      minQualifyingOrderSubtotal: 30.0,
    });

    harness.accounts.set("acc_adv", {
      id: "acc_adv",
      storeId: "store_1",
      shopperId: "shopper_adv",
      referralCode: "SARAH-777",
      referralCount: 0,
      referralPointsEarned: BigInt(0),
      balance: BigInt(0),
    });

    harness.accounts.set("acc_ref", {
      id: "acc_ref",
      storeId: "store_1",
      shopperId: "shopper_ref",
      referralCount: 0,
      referralPointsEarned: BigInt(0),
      balance: BigInt(0),
    });

    harness.bindReferral({
      refereeAccountId: "acc_ref",
      referralCode: "SARAH-777",
    });

    // 1. Order below min qualifying threshold ($20 < $30) -> Not qualified
    const lowOrderResult = harness.evaluateQualification({
      refereeAccountId: "acc_ref",
      orderId: "ord_low",
      orderSubtotalMinor: BigInt(2000), // $20
      currency: "USD",
    });
    expect(lowOrderResult.qualified).toBe(false);
    expect(harness.accounts.get("acc_adv")?.balance).toBe(BigInt(0));

    // 2. Qualifying order ($50 >= $30) -> Qualified & awarded
    const qualifyingResult = harness.evaluateQualification({
      refereeAccountId: "acc_ref",
      orderId: "ord_qual",
      orderSubtotalMinor: BigInt(5000), // $50
      currency: "USD",
    });

    expect(qualifyingResult.qualified).toBe(true);
    expect(qualifyingResult.advocatePointsAwarded).toBe(BigInt(150));
    expect(qualifyingResult.refereePointsAwarded).toBe(BigInt(75));

    // Advocate balances & stats updated
    const advocate = harness.accounts.get("acc_adv")!;
    expect(advocate.balance).toBe(BigInt(150));
    expect(advocate.referralCount).toBe(1);
    expect(advocate.referralPointsEarned).toBe(BigInt(150));

    // Referee balance updated
    const referee = harness.accounts.get("acc_ref")!;
    expect(referee.balance).toBe(BigInt(75));
  });
});
