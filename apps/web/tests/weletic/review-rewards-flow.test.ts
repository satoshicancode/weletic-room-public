import {
  awardVerifiedReviewPoints,
  reverseReviewPoints,
  type ReviewProvider,
} from "@/lib/weletic/loyalty/review-rewards";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  append: vi.fn(),
  enqueue: vi.fn(),
  schedule: vi.fn(),
  account: vi.fn(),
  ledger: vi.fn(),
  count: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: mocks.append,
}));
vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: mocks.enqueue,
}));
vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: mocks.schedule,
}));

const tx = {
  weleticLoyaltyAccount: { findFirst: mocks.account },
  weleticPointsLedgerEntry: { findUnique: mocks.ledger, count: mocks.count },
} as unknown as Prisma.TransactionClient;

function award(provider: ReviewProvider) {
  return awardVerifiedReviewPoints({
    tx,
    storeId: "store-1",
    provider,
    accountIdentity:
      provider === "native"
        ? { shopperId: "shopper-1" }
        : { email: "buyer@example.test" },
    review: {
      id: "review-1",
      body: "An honest review with enough content to qualify.",
      rating: 1,
      productId: "gid://shopify/Product/1234",
      hasPhoto: false,
      hasVideo: false,
      verifiedStatus: "verified-purchase",
    },
  });
}

describe("provider-neutral review rewards and durable Flow boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.ledger.mockResolvedValue(null);
    mocks.count.mockResolvedValue(0);
    mocks.account.mockResolvedValue({
      id: "account-1",
      currentTierId: null,
      program: {
        status: "active",
        killSwitchActive: false,
        earningRules: ["native", "judgeme"].map((provider) => ({
          id: `rule-${provider}`,
          name: "Honest review",
          fixedPoints: BigInt(100),
          conditions: { provider },
          eligibleTierIds: [],
          limitInterval: "lifetime",
          maxEventsPerCustomer: 2,
          maxPointsPerEvent: null,
        })),
      },
    });
    mocks.append.mockResolvedValue({
      id: "award-ledger-1",
      pointsDelta: BigInt(100),
      balanceAfter: BigInt(-25),
    });
  });

  it.each(["native", "judgeme"] as const)(
    "enqueues %s points from the persisted ledger identity in the caller transaction",
    async (provider) => {
      await expect(award(provider)).resolves.toEqual({
        status: "awarded",
        pointsAwarded: "100",
        accountId: "account-1",
      });
      expect(mocks.append).toHaveBeenCalledWith(
        expect.objectContaining({
          tx,
          idempotencyKey: `review:${provider}:store-1:review-1`,
          referenceType:
            provider === "native" ? "REVIEW_NATIVE" : "REVIEW_JUDGEME",
        }),
      );
      expect(mocks.enqueue).toHaveBeenCalledTimes(1);
      expect(mocks.enqueue).toHaveBeenCalledWith({
        tx,
        storeId: "store-1",
        eventId: "award-ledger-1",
        payload: {
          accountId: "account-1",
          handle: "weletic-points-earned",
          pointsDelta: "100",
          pointsBalance: "-25",
          reason: "verified_review",
          orderId: null,
        },
      });
    },
  );

  it.each(["native", "judgeme"] as const)(
    "does not emit for an already awarded %s review",
    async (provider) => {
      mocks.ledger.mockResolvedValue({ id: "existing-award" });
      await expect(award(provider)).resolves.toMatchObject({
        status: "duplicate",
      });
      expect(mocks.append).not.toHaveBeenCalled();
      expect(mocks.enqueue).not.toHaveBeenCalled();
    },
  );

  it("does not emit for an unavailable account or a review velocity limit", async () => {
    mocks.account.mockResolvedValueOnce(null);
    await expect(award("native")).resolves.toMatchObject({ status: "ignored" });
    mocks.count.mockResolvedValueOnce(2);
    await expect(award("judgeme")).resolves.toMatchObject({
      status: "limit_reached",
    });
    expect(mocks.append).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("propagates enqueue failure to the owning transaction instead of reporting awarded", async () => {
    mocks.enqueue.mockRejectedValue(new Error("Outbox unavailable"));
    await expect(award("native")).rejects.toThrow("Outbox unavailable");
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it.each(["native", "judgeme"] as const)(
    "never labels an append-only %s clawback as points earned",
    async (provider) => {
      mocks.ledger.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: "award-ledger-1",
        accountId: "account-1",
        pointsDelta: BigInt(100),
      });
      mocks.append.mockResolvedValue({
        id: "clawback-ledger-1",
        pointsDelta: BigInt(-100),
        balanceAfter: BigInt(-125),
      });
      await expect(
        reverseReviewPoints({
          tx,
          storeId: "store-1",
          provider,
          reviewId: "review-1",
        }),
      ).resolves.toMatchObject({ status: "clawed_back", balanceAfter: "-125" });
      expect(mocks.enqueue).not.toHaveBeenCalled();
    },
  );
});
