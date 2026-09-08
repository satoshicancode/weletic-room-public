import { prisma } from "@/lib/prisma";
import {
  createLoyaltyTier,
  updateLoyaltyTier,
} from "@/lib/weletic/loyalty/tiers";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyTier: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

function transactionMock() {
  return {
    weleticLoyaltyTier: {
      create: vi.fn().mockResolvedValue({ id: "wtier_created" }),
      update: vi.fn().mockResolvedValue({ id: "wtier_updated" }),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("loyalty tier transaction boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates only through the caller-provided transaction", async () => {
    const tx = transactionMock();

    await createLoyaltyTier(
      {
        programId: "wprog_1",
        name: "Bronze",
        slug: "bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
      },
      tx,
    );

    expect(tx.weleticLoyaltyTier.create).toHaveBeenCalledOnce();
    expect(prisma.weleticLoyaltyTier.create).not.toHaveBeenCalled();
  });

  it("updates only through the caller-provided transaction", async () => {
    const tx = transactionMock();

    await updateLoyaltyTier("wtier_1", { pointsMultiplier: 1.25 }, tx);

    expect(tx.weleticLoyaltyTier.update).toHaveBeenCalledOnce();
    expect(prisma.weleticLoyaltyTier.update).not.toHaveBeenCalled();
  });
});
