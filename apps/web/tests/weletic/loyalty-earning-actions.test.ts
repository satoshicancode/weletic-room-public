import {
  claimCustomerIntentActivity,
  CustomerActivityClaimError,
  getCustomerIntentAction,
  serializeCustomerEarningRule,
  validateCustomerIntentConditions,
} from "@/lib/weletic/loyalty/earning-actions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  ledgerFindUnique: vi.fn(),
  ledgerCount: vi.fn(),
  awardActivityPoints: vi.fn(),
}));

const transactionClient = {
  weleticLoyaltyAccount: { findFirst: mocks.accountFindFirst },
  weleticPointsLedgerEntry: {
    findUnique: mocks.ledgerFindUnique,
    count: mocks.ledgerCount,
  },
};

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: vi.fn(({ operation }) =>
    operation(transactionClient),
  ),
}));

vi.mock("@/lib/weletic/loyalty/non-purchase-earn", () => ({
  awardActivityPoints: mocks.awardActivityPoints,
}));

function accountFixture(
  overrides: Record<string, unknown> = {},
  ruleOverrides: Record<string, unknown> = {},
) {
  return {
    id: "wacc_1",
    program: {
      status: "active",
      killSwitchActive: false,
      earningRules: [
        {
          id: "wrule_instagram",
          name: "Follow on Instagram",
          description: "Follow our brand",
          triggerCode: "instagram_follow",
          ruleType: "fixed_points",
          fixedPoints: BigInt(50),
          multiplier: 1,
          isActive: true,
          startAt: null,
          endAt: null,
          maxEventsPerCustomer: 1,
          limitInterval: "lifetime",
          conditions: {
            targetUrl: "https://www.instagram.com/weletic",
          },
          ...ruleOverrides,
        },
      ],
    },
    ...overrides,
  };
}

describe("customer-intent earning actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountFindFirst.mockResolvedValue(accountFixture());
    mocks.ledgerFindUnique.mockResolvedValue(null);
    mocks.ledgerCount.mockResolvedValue(0);
    mocks.awardActivityPoints.mockResolvedValue({
      pointsDelta: BigInt(50),
      balanceAfter: BigInt(150),
    });
  });

  it("allows only HTTPS destinations and enforces the social platform host", () => {
    expect(() =>
      validateCustomerIntentConditions({
        triggerCode: "instagram_follow",
        conditions: { targetUrl: "javascript:alert(1)" },
      }),
    ).toThrow("valid HTTPS target URL");
    expect(() =>
      validateCustomerIntentConditions({
        triggerCode: "instagram_follow",
        conditions: { targetUrl: "https://attacker.example/profile" },
      }),
    ).toThrow("not valid for the instagram follow action");
    expect(
      validateCustomerIntentConditions({
        triggerCode: "link_click",
        conditions: { targetUrl: "https://brand.example/pages/community" },
      }).targetUrl,
    ).toBe("https://brand.example/pages/community");
  });

  it("builds encoded Facebook and X share composer URLs", () => {
    expect(
      getCustomerIntentAction({
        triggerCode: "facebook_share",
        conditions: { targetUrl: "https://brand.example/new?a=1&b=2" },
      }),
    ).toMatchObject({
      label: "Share on Facebook",
      verification: "honor_system",
    });
    expect(
      getCustomerIntentAction({
        triggerCode: "x_share",
        conditions: {
          targetUrl: "https://brand.example/new",
          shareMessage: "Fresh drop",
        },
      })?.url,
    ).toBe(
      "https://x.com/intent/post?url=https%3A%2F%2Fbrand.example%2Fnew&text=Fresh%20drop",
    );
  });

  it("fails closed when serializing an invalid stored action", () => {
    expect(
      serializeCustomerEarningRule({
        ...accountFixture().program.earningRules[0],
        conditions: { targetUrl: "http://instagram.com/weletic" },
      }).action,
    ).toBeNull();
  });

  it("awards a lifetime action once with a deterministic ledger identity", async () => {
    const result = await claimCustomerIntentActivity({
      storeId: "store_1",
      shopifyCustomerId: "12345",
      ruleId: "wrule_instagram",
      claimKey: "client-claim-1",
      now: new Date("2026-09-01T00:00:00.000Z"),
    });

    expect(result).toEqual({
      awarded: true,
      alreadyCompleted: false,
      pointsAwarded: "50",
      pointsBalance: "150",
      ruleId: "wrule_instagram",
    });
    expect(mocks.awardActivityPoints).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_1",
        accountId: "wacc_1",
        activityType: "instagram_follow",
        externalId: "wrule_instagram:lifetime:once",
        points: BigInt(50),
        tx: transactionClient,
      }),
    );
  });

  it("returns the existing result for an idempotent retry", async () => {
    mocks.ledgerFindUnique.mockResolvedValue({
      pointsDelta: BigInt(50),
      balanceAfter: BigInt(150),
    });

    await expect(
      claimCustomerIntentActivity({
        storeId: "store_1",
        shopifyCustomerId: "12345",
        ruleId: "wrule_instagram",
      }),
    ).resolves.toMatchObject({
      awarded: false,
      alreadyCompleted: true,
      pointsAwarded: "50",
    });
    expect(mocks.awardActivityPoints).not.toHaveBeenCalled();
  });

  it("enforces recurring period limits and requires a retry-safe claim key", async () => {
    mocks.accountFindFirst.mockResolvedValue(
      accountFixture({}, { maxEventsPerCustomer: 2, limitInterval: "monthly" }),
    );
    await expect(
      claimCustomerIntentActivity({
        storeId: "store_1",
        shopifyCustomerId: "12345",
        ruleId: "wrule_instagram",
      }),
    ).rejects.toMatchObject({ code: "claim_key_required" });

    mocks.ledgerCount.mockResolvedValue(2);
    await expect(
      claimCustomerIntentActivity({
        storeId: "store_1",
        shopifyCustomerId: "12345",
        ruleId: "wrule_instagram",
        claimKey: "claim_002",
        now: new Date("2026-09-17T12:00:00.000Z"),
      }),
    ).rejects.toEqual(
      new CustomerActivityClaimError(
        "earning_limit_reached",
        "You have already reached the earning limit for this action.",
      ),
    );
    expect(mocks.ledgerCount).toHaveBeenCalledWith({
      where: expect.objectContaining({
        referenceId: { startsWith: "wrule_instagram:2026-09:" },
        createdAt: {
          gte: new Date("2026-09-01T00:00:00.000Z"),
          lt: new Date("2026-09-17T12:00:00.000Z"),
        },
      }),
    });
  });
});
