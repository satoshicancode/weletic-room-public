import type { Prisma } from "@prisma/client";
import { beforeEach, expect, it, vi } from "vitest";
import { loyaltyCommunicationJobPayloadSchema } from "../../lib/weletic/loyalty/points-communication-contract";
import { enqueueRewardRedeemedCommunication } from "../../lib/weletic/loyalty/reward-redeemed-communication-producer";
import { rewardCommunicationFixture } from "./reward-communication-fixture";

const enqueue = vi.hoisted(() => vi.fn());
vi.mock("../../lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: enqueue,
}));

function fixture(type = "amount_off") {
  const evidence = rewardCommunicationFixture(type);
  const program = {
    id: evidence.programId,
    storeId: evidence.storeId,
    status: "active",
    killSwitchActive: false,
    metadata: {
      loyaltyCommunications: {
        version: 1,
        sequence: 7,
        policies: [evidence.policySnapshot.policy],
      },
    },
  };
  const store = {
    installationGeneration: evidence.installationGeneration,
    storeAccessState: "active",
    complianceState: "active",
  };
  const db = {
    weleticLoyaltyProgram: { findUnique: vi.fn().mockResolvedValue(program) },
    weleticShopifyStore: { findUnique: vi.fn().mockResolvedValue(store) },
    weleticLoyaltyAccount: {
      findFirst: vi.fn().mockResolvedValue({ id: evidence.accountId }),
    },
    weleticRewardRedemption: {
      findFirst: vi.fn().mockResolvedValue(evidence.redemption),
    },
    weleticPointsLedgerEntry: {
      findFirst: vi.fn().mockResolvedValue(evidence.ledger),
    },
  };
  const input = {
    tx: db as unknown as Prisma.TransactionClient,
    storeId: evidence.storeId,
    accountId: evidence.accountId,
    expectedInstallationGeneration: evidence.installationGeneration,
    receipt: {
      transitioned: true,
      redemptionId: evidence.redemption.id,
      occurredAt: evidence.occurredAt,
    },
  };
  return { evidence, program, store, db, input };
}

beforeEach(() => {
  enqueue.mockReset().mockResolvedValue({ id: "job" });
});

it.each([
  "amount_off",
  "percentage_off",
  "free_shipping",
  "free_product",
  "gift_card",
  "store_credit",
])(
  "queues a strict %s job from persisted policy and issuance evidence",
  async (type) => {
    const { input, db, evidence } = fixture(type);
    await expect(enqueueRewardRedeemedCommunication(input)).resolves.toEqual({
      id: "job",
    });
    expect(enqueue).toHaveBeenCalledOnce();
    const args = enqueue.mock.calls[0][0];
    expect(args.tx).toBe(input.tx);
    expect(args.jobType).toBe("LOYALTY_COMMUNICATION");
    const event = loyaltyCommunicationJobPayloadSchema.parse(args.payload);
    expect(event).toMatchObject({
      journey: "reward_redeemed",
      pointsSpent: "9007199254740993",
      reward: { type },
      policy: evidence.policySnapshot.policy,
    });
    expect(JSON.stringify(event)).not.toMatch(
      /private-|customerSelectionDigest|shopifyDiscountId|shopifyGiftCardId/,
    );
    expect(db.weleticLoyaltyAccount.findFirst).toHaveBeenCalledWith({
      where: {
        id: "account",
        storeId: "store",
        programId: "program",
        status: "active",
      },
      select: { id: true },
    });
    expect(
      db.weleticPointsLedgerEntry.findFirst.mock.calls[0][0].where,
    ).toEqual({ id: "ledger", storeId: "store", accountId: "account" });
  },
);

it("does no reads or writes for a non-winning replay", async () => {
  const { input, db } = fixture();
  input.receipt.transitioned = false;
  await expect(enqueueRewardRedeemedCommunication(input)).resolves.toBeNull();
  expect(db.weleticLoyaltyProgram.findUnique).not.toHaveBeenCalled();
  expect(enqueue).not.toHaveBeenCalled();
});

it.each(["disabled", "kill_switch", "policy_disabled", "policy_missing"])(
  "does not enqueue for %s",
  async (state) => {
    const { input, program, db } = fixture();
    if (state === "disabled") program.status = "disabled";
    if (state === "kill_switch") program.killSwitchActive = true;
    if (state === "policy_disabled")
      program.metadata.loyaltyCommunications.policies[0].enabled = false;
    if (state === "policy_missing")
      program.metadata.loyaltyCommunications.policies = [];
    await expect(enqueueRewardRedeemedCommunication(input)).resolves.toBeNull();
    expect(db.weleticShopifyStore.findUnique).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  },
);

it.each([
  "foreign_program",
  "missing_program",
  "generation",
  "pending_approval",
  "privacy",
  "account",
  "redemption",
  "debit",
  "foreign_debit",
  "origin",
  "policy_corrupt",
])("fails closed for %s before enqueue", async (state) => {
  const { input, program, store, db, evidence } = fixture();
  if (state === "foreign_program") program.storeId = "foreign";
  if (state === "missing_program")
    db.weleticLoyaltyProgram.findUnique.mockResolvedValue(null);
  if (state === "generation") store.installationGeneration = "new-generation";
  if (state === "pending_approval") store.storeAccessState = "pending_approval";
  if (state === "privacy") store.complianceState = "redacted";
  if (state === "account")
    db.weleticLoyaltyAccount.findFirst.mockResolvedValue(null);
  if (state === "redemption")
    db.weleticRewardRedemption.findFirst.mockResolvedValue(null);
  if (state === "debit")
    db.weleticPointsLedgerEntry.findFirst.mockResolvedValue(null);
  if (state === "foreign_debit") evidence.ledger.accountId = "foreign";
  if (state === "origin") evidence.redemption.metadata = {};
  if (state === "policy_corrupt")
    program.metadata.loyaltyCommunications.version = 2;
  await expect(enqueueRewardRedeemedCommunication(input)).rejects.toThrow();
  expect(enqueue).not.toHaveBeenCalled();
});

it("propagates outbox failure to the owning issuance transaction", async () => {
  const failure = new Error("outbox unavailable");
  enqueue.mockRejectedValue(failure);
  await expect(
    enqueueRewardRedeemedCommunication(fixture().input),
  ).rejects.toBe(failure);
});

it("keeps one issuance key across later policy edits and occurrence times", async () => {
  const { input, program } = fixture();
  await enqueueRewardRedeemedCommunication(input);
  program.metadata.loyaltyCommunications.sequence += 1;
  input.receipt.occurredAt = new Date("2026-09-12T01:00:00Z");
  await enqueueRewardRedeemedCommunication(input);
  const [first, second] = enqueue.mock.calls.map(([args]) => args);
  expect(second.idempotencyKey).toBe(first.idempotencyKey);
  expect(second.payload.policyRevision).not.toBe(first.payload.policyRevision);
});
