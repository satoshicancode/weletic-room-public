import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  seedStoreLoyaltyPolicy,
  type SeededLoyaltyPolicyDefinition,
} from "../../scripts/seed-weletic-workspaces";

const policyRevisionMocks = vi.hoisted(() => ({
  publish: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: policyRevisionMocks.publish,
  verifyLoyaltyEarnPolicyRevisionSnapshot: policyRevisionMocks.verify,
}));

const definition = {
  program: {
    id: "loyalty_seed",
    name: "Seed Rewards",
    pointNameSingular: "Point",
    pointNamePlural: "Points",
    pointsPerCurrencyUnit: 1,
    holdingPeriodDays: 14,
    pointsExpiryMonths: 12,
  },
  tiers: [
    {
      id: "tier_seed_bronze",
      name: "Bronze",
      slug: "bronze",
      tierOrder: 1,
      pointsMultiplier: 1,
      minSpendThreshold: BigInt(0),
      minPointsThreshold: BigInt(0),
      entryBonusPoints: BigInt(0),
    },
    {
      id: "tier_seed_silver",
      name: "Silver",
      slug: "silver",
      tierOrder: 2,
      pointsMultiplier: 1.25,
      minSpendThreshold: BigInt(20000),
      minPointsThreshold: BigInt(0),
      entryBonusPoints: BigInt(100),
    },
  ],
} satisfies SeededLoyaltyPolicyDefinition;

const revision = {
  id: "wpolicy_seed",
  storeId: "store_seed",
  programId: "loyalty_seed",
  version: 1,
  effectiveAt: new Date("2026-09-02T00:00:00.000Z"),
  schemaVersion: 1,
  snapshot: { schemaVersion: 1 },
  fingerprint: "a".repeat(64),
  reason: "local_seed_policy_synchronized",
  createdAt: new Date("2026-09-02T00:00:00.000Z"),
};

function transactionMock({
  program,
  tiers,
}: {
  program: { id: string; storeId: string } | null;
  tiers: Array<{
    id: string;
    programId: string;
    deletedAt: Date | null;
  } | null>;
}) {
  return {
    weleticLoyaltyProgram: {
      findUnique: vi.fn().mockResolvedValue(program),
      create: vi.fn().mockResolvedValue({
        id: definition.program.id,
        storeId: "store_seed",
      }),
    },
    weleticLoyaltyTier: {
      findUnique: vi.fn().mockImplementation(async () => tiers.shift()),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("local loyalty policy seed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    policyRevisionMocks.publish.mockResolvedValue(revision);
  });

  it("creates a missing program and all tiers before publishing and verifying one policy head", async () => {
    const tx = transactionMock({ program: null, tiers: [null, null] });

    await seedStoreLoyaltyPolicy({
      tx,
      storeId: "store_seed",
      definition,
    });

    expect(tx.weleticLoyaltyProgram.create).toHaveBeenCalledOnce();
    expect(tx.weleticLoyaltyTier.create).toHaveBeenCalledTimes(2);
    expect(policyRevisionMocks.publish).toHaveBeenCalledOnce();
    expect(policyRevisionMocks.publish).toHaveBeenCalledWith({
      tx,
      storeId: "store_seed",
      programId: "loyalty_seed",
      reason: "local_seed_policy_synchronized",
    });
    expect(policyRevisionMocks.verify).toHaveBeenCalledOnce();
    expect(policyRevisionMocks.verify).toHaveBeenCalledWith({
      revisionId: revision.id,
      storeId: revision.storeId,
      programId: revision.programId,
      schemaVersion: revision.schemaVersion,
      snapshot: revision.snapshot,
      fingerprint: revision.fingerprint,
      expectedStoreId: "store_seed",
      expectedProgramId: "loyalty_seed",
    });
  });

  it("repairs missing or retired tiers on an existing seed before verifying its idempotent policy head", async () => {
    const tx = transactionMock({
      program: { id: "loyalty_seed", storeId: "store_seed" },
      tiers: [
        {
          id: "tier_seed_bronze",
          programId: "loyalty_seed",
          deletedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
        null,
      ],
    });

    await seedStoreLoyaltyPolicy({
      tx,
      storeId: "store_seed",
      definition,
    });

    expect(tx.weleticLoyaltyProgram.create).not.toHaveBeenCalled();
    expect(tx.weleticLoyaltyTier.update).toHaveBeenCalledWith({
      where: { id: "tier_seed_bronze" },
      data: { deletedAt: null },
    });
    expect(tx.weleticLoyaltyTier.create).toHaveBeenCalledOnce();
    expect(policyRevisionMocks.publish).toHaveBeenCalledOnce();
    expect(policyRevisionMocks.verify).toHaveBeenCalledOnce();
  });
});
