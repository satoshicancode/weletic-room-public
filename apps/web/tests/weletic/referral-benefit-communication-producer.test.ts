import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { loyaltyCommunicationJobPayloadSchema } from "../../lib/weletic/loyalty/points-communication-contract";
import { enqueueReferralBenefitCommunication } from "../../lib/weletic/loyalty/referral-benefit-communication-producer";
import { referralBenefitFixture } from "./referral-benefit-communication-fixture";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), guard: vi.fn() }));
vi.mock("../../lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: mocks.enqueue,
}));
vi.mock("../../lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: mocks.guard,
}));
function fixture(
  kind: "points" | "coupon" = "points",
  side: "advocate" | "referee" = "advocate",
) {
  const evidence = referralBenefitFixture(kind, side);
  const program = {
    id: "program",
    storeId: "store",
    status: "active",
    killSwitchActive: false,
    metadata: {
      loyaltyCommunications: {
        version: 1,
        sequence: 1,
        policies: [evidence.policySnapshot.policy],
      },
    },
  };
  const db = {
    weleticLoyaltyReferral: {
      findFirst: vi.fn().mockResolvedValue(evidence.referral),
    },
    weleticLoyaltyProgram: { findUnique: vi.fn().mockResolvedValue(program) },
    weleticLoyaltyAccount: {
      findFirst: vi.fn().mockResolvedValue({ id: "account", metadata: null }),
    },
    weleticPointsLedgerEntry: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          evidence.receipt.kind === "points" ? evidence.receipt.ledger : null,
        ),
    },
    weleticRewardRedemption: {
      findFirst: vi
        .fn()
        .mockResolvedValue(
          evidence.receipt.kind === "coupon"
            ? evidence.receipt.redemption
            : null,
        ),
    },
  };
  const input = {
    tx: db as unknown as Prisma.TransactionClient,
    identity: evidence.identity,
    expectedInstallationGeneration: "generation",
    receipt: {
      created: true,
      kind,
      id: kind === "points" ? "ledger" : "redemption",
    },
  };
  return { evidence, program, db, input };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.enqueue.mockResolvedValue({ id: "job" });
  mocks.guard.mockResolvedValue({ installationGeneration: "generation" });
});
it.each(["points", "coupon"] as const)(
  "queues %s for both account sides using the original transaction",
  async (kind) => {
    for (const side of ["advocate", "referee"] as const) {
      const x = fixture(kind, side);
      await expect(
        enqueueReferralBenefitCommunication(x.input),
      ).resolves.toEqual({ id: "job" });
      const args = mocks.enqueue.mock.lastCall![0];
      expect(args.tx).toBe(x.input.tx);
      const event = loyaltyCommunicationJobPayloadSchema.parse(args.payload);
      expect(event).toMatchObject({
        source: "referral_benefit_confirmed",
        benefitKind: kind,
        journey: side === "advocate" ? "referral_advocate" : "referral_friend",
      });
      expect(JSON.stringify(event)).not.toContain("private-");
      expect(mocks.guard).toHaveBeenLastCalledWith({
        tx: x.input.tx,
        storeId: "store",
        expectedInstallationGeneration: "generation",
        action: "loyalty_referral_communication_origin",
        loyaltyMaintenancePermit: undefined,
      });
    }
  },
);
it("does nothing for a replay instead of reconstructing a notification", async () => {
  const x = fixture();
  x.input.receipt.created = false;
  await expect(
    enqueueReferralBenefitCommunication(x.input),
  ).resolves.toBeNull();
  expect(x.db.weleticLoyaltyReferral.findFirst).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("does not retrofit a legacy benefit", async () => {
  const x = fixture();
  x.evidence.referral.metadata = {};
  await expect(
    enqueueReferralBenefitCommunication(x.input),
  ).resolves.toBeNull();
  expect(mocks.guard).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it.each(["program_paused", "kill_switch", "missing_policy", "disabled_policy"])(
  "suppresses %s",
  async (state) => {
    const x = fixture();
    if (state === "program_paused") x.program.status = "paused";
    if (state === "kill_switch") x.program.killSwitchActive = true;
    if (state === "missing_policy")
      x.program.metadata.loyaltyCommunications.policies = [];
    if (state === "disabled_policy")
      Object.assign(
        x.program.metadata.loyaltyCommunications.policies[0] as object,
        { enabled: false },
      );
    await expect(
      enqueueReferralBenefitCommunication(x.input),
    ).resolves.toBeNull();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  },
);
it.each([
  "generation",
  "wrong_kind",
  "guard",
  "missing_referral",
  "missing_program",
  "foreign_program",
  "missing_account",
  "missing_receipt",
  "tampered_receipt",
])("fails closed for %s", async (state) => {
  const x = fixture();
  if (state === "generation") x.input.expectedInstallationGeneration = "fresh";
  if (state === "wrong_kind") x.input.receipt.kind = "coupon";
  if (state === "guard") mocks.guard.mockRejectedValue(new Error("suspended"));
  if (state === "missing_referral")
    x.db.weleticLoyaltyReferral.findFirst.mockResolvedValue(null);
  if (state === "missing_program")
    x.db.weleticLoyaltyProgram.findUnique.mockResolvedValue(null);
  if (state === "foreign_program") x.program.id = "foreign";
  if (state === "missing_account")
    x.db.weleticLoyaltyAccount.findFirst.mockResolvedValue(null);
  if (state === "missing_receipt")
    x.db.weleticPointsLedgerEntry.findFirst.mockResolvedValue(null);
  if (state === "tampered_receipt" && x.evidence.receipt.kind === "points")
    x.evidence.receipt.ledger.pointsDelta = BigInt(1);
  await expect(enqueueReferralBenefitCommunication(x.input)).rejects.toThrow();
  expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("propagates queue failure so the caller transaction cannot commit silently", async () => {
  mocks.enqueue.mockRejectedValue(new Error("queue unavailable"));
  await expect(
    enqueueReferralBenefitCommunication(fixture().input),
  ).rejects.toThrow("queue unavailable");
});
