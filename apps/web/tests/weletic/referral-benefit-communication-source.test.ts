import type { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";
import { createReferralBenefitCommunication } from "../../lib/weletic/loyalty/referral-benefit-communication-contract";
import { isCurrentReferralBenefit } from "../../lib/weletic/loyalty/referral-benefit-communication-source";
import { referralBenefitFixture } from "./referral-benefit-communication-fixture";

function fixture(kind: "points" | "coupon" = "points") {
  const input = referralBenefitFixture(kind);
  const event = createReferralBenefitCommunication(input);
  const mocks = {
    weleticLoyaltyReferral: {
      findFirst: vi.fn().mockResolvedValue(input.referral),
    },
    weleticCommerceOrder: {
      findFirst: vi.fn().mockResolvedValue({ status: "paid" }),
    },
    weleticPointsLedgerEntry: { findFirst: vi.fn().mockResolvedValue(null) },
    weleticRewardRedemption: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          input.receipt.kind === "coupon" ? input.receipt.redemption : null,
        ),
    },
  };
  if (input.receipt.kind === "points")
    mocks.weleticPointsLedgerEntry.findFirst.mockResolvedValueOnce(
      input.receipt.ledger,
    );
  const db = mocks as unknown as Prisma.TransactionClient;
  const now = new Date("2026-09-13T01:00:00Z");
  return { input, event, mocks, db, now };
}
it.each(["points", "coupon"] as const)(
  "checks tenant-bound current %s evidence",
  async (kind) => {
    const x = fixture(kind);
    await expect(isCurrentReferralBenefit(x)).resolves.toBe(true);
    expect(x.mocks.weleticLoyaltyReferral.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "referral", storeId: "store" } }),
    );
    expect(x.mocks.weleticCommerceOrder.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "order", storeId: "store" } }),
    );
    const receiptQuery =
      kind === "points"
        ? x.mocks.weleticPointsLedgerEntry.findFirst
        : x.mocks.weleticRewardRedemption.findFirst;
    expect(receiptQuery).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          id: kind === "points" ? "ledger" : "redemption",
          storeId: "store",
          accountId: "account",
        },
      }),
    );
  },
);
it.each(["points", "coupon"] as const)(
  "suppresses absent %s referral evidence",
  async (kind) => {
    const x = fixture(kind);
    x.mocks.weleticLoyaltyReferral.findFirst.mockResolvedValue(null);
    await expect(isCurrentReferralBenefit(x)).resolves.toBe(false);
    expect(x.mocks.weleticCommerceOrder.findFirst).not.toHaveBeenCalled();
  },
);
it.each([null, "pending", "refunded", "cancelled"])(
  "suppresses an unavailable qualifying order (%s)",
  async (status) => {
    const x = fixture();
    x.mocks.weleticCommerceOrder.findFirst.mockResolvedValue(
      status ? { status } : null,
    );
    await expect(isCurrentReferralBenefit(x)).resolves.toBe(false);
    expect(x.mocks.weleticPointsLedgerEntry.findFirst).not.toHaveBeenCalled();
  },
);
it("allows a partially refunded order only while the benefit evidence remains intact", async () => {
  const x = fixture();
  x.mocks.weleticCommerceOrder.findFirst.mockResolvedValue({
    status: "partially_refunded",
  });
  await expect(isCurrentReferralBenefit(x)).resolves.toBe(true);
  const y = fixture();
  y.mocks.weleticCommerceOrder.findFirst.mockResolvedValue({
    status: "partially_refunded",
  });
  y.input.referral.advocatePointsAwarded = BigInt(0);
  await expect(isCurrentReferralBenefit(y)).resolves.toBe(false);
});
it.each(["points", "coupon"] as const)(
  "suppresses missing %s receipts",
  async (kind) => {
    const x = fixture(kind);
    x.mocks.weleticPointsLedgerEntry.findFirst
      .mockReset()
      .mockResolvedValue(null);
    x.mocks.weleticRewardRedemption.findFirst.mockResolvedValue(null);
    await expect(isCurrentReferralBenefit(x)).resolves.toBe(false);
  },
);
it("suppresses current-award clawback and scopes the reversal query after the receipt", async () => {
  const x = fixture();
  x.mocks.weleticPointsLedgerEntry.findFirst.mockResolvedValue({
    id: "reversal",
  });
  await expect(isCurrentReferralBenefit(x)).resolves.toBe(false);
  expect(x.mocks.weleticPointsLedgerEntry.findFirst).toHaveBeenNthCalledWith(
    2,
    {
      where: {
        storeId: "store",
        accountId: "account",
        entryType: "REFUND_REVERSAL",
        referenceType: "REFERRAL_REFUND_CLAWBACK",
        referenceId: "referral",
        pointsDelta: { lt: BigInt(0) },
        createdAt: { gte: new Date(x.event.receiptCreatedAt) },
      },
      select: { id: true },
    },
  );
});
it("suppresses a coupon at the exact expiry boundary", async () => {
  const x = fixture("coupon");
  if (x.input.receipt.kind !== "coupon") throw new Error("fixture");
  x.now = x.input.receipt.redemption.expiresAt!;
  await expect(isCurrentReferralBenefit(x)).resolves.toBe(false);
});
it.each(["cancelled", "expired", "failed", "provisioning"])(
  "suppresses %s coupon receipts",
  async (status) => {
    const x = fixture("coupon");
    if (x.input.receipt.kind !== "coupon") throw new Error("fixture");
    x.input.receipt.redemption.status = status;
    await expect(isCurrentReferralBenefit(x)).resolves.toBe(false);
  },
);
it.each(["points", "coupon"] as const)(
  "does not adopt a later order for an old %s event",
  async (kind) => {
    const x = fixture(kind);
    x.input.referral.qualifyingOrderId = "later-order";
    await expect(isCurrentReferralBenefit(x)).resolves.toBe(false);
  },
);
it.each([new Date(NaN), new Date("2026-09-12T00:00:00Z")])(
  "rejects an invalid/current-before-event clock without reads",
  async (now) => {
    const x = fixture();
    await expect(isCurrentReferralBenefit({ ...x, now })).resolves.toBe(false);
    expect(x.mocks.weleticLoyaltyReferral.findFirst).not.toHaveBeenCalled();
  },
);
