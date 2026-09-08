import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import { Prisma } from "@prisma/client";

export interface CreateTierInput {
  programId: string;
  name: string;
  slug: string;
  tierOrder: number;
  minSpendThreshold: bigint; // minor units
  minPointsThreshold: bigint;
  pointsMultiplier?: number;
  perks?: string[];
  iconUrl?: string;
  entryBonusPoints?: bigint;
}

export interface UpdateTierInput {
  name?: string;
  slug?: string;
  tierOrder?: number;
  minSpendThreshold?: bigint;
  minPointsThreshold?: bigint;
  pointsMultiplier?: number;
  perks?: string[];
  iconUrl?: string | null;
  entryBonusPoints?: bigint;
}

/**
 * Creates a VIP Tier inside the caller's policy-publication transaction.
 */
export async function createLoyaltyTier(
  input: CreateTierInput,
  tx: Prisma.TransactionClient,
) {
  const tier = await tx.weleticLoyaltyTier.create({
    data: {
      id: createWeleticId("wtier_"),
      programId: input.programId,
      name: input.name,
      slug: input.slug.toLowerCase().trim(),
      tierOrder: input.tierOrder,
      minSpendThreshold: input.minSpendThreshold,
      minPointsThreshold: input.minPointsThreshold,
      pointsMultiplier: input.pointsMultiplier
        ? new Prisma.Decimal(input.pointsMultiplier)
        : new Prisma.Decimal(1.0),
      perks: input.perks
        ? (input.perks as Prisma.InputJsonValue)
        : Prisma.DbNull,
      iconUrl: input.iconUrl || null,
      entryBonusPoints: input.entryBonusPoints || BigInt(0),
    },
  });

  return tier;
}

/**
 * Updates a VIP Tier inside the caller's policy-publication transaction.
 */
export async function updateLoyaltyTier(
  tierId: string,
  input: UpdateTierInput,
  tx: Prisma.TransactionClient,
) {
  const data: Prisma.WeleticLoyaltyTierUpdateInput = {};

  if (input.name !== undefined) data.name = input.name;
  if (input.slug !== undefined) data.slug = input.slug.toLowerCase().trim();
  if (input.tierOrder !== undefined) data.tierOrder = input.tierOrder;
  if (input.minSpendThreshold !== undefined)
    data.minSpendThreshold = input.minSpendThreshold;
  if (input.minPointsThreshold !== undefined)
    data.minPointsThreshold = input.minPointsThreshold;
  if (input.pointsMultiplier !== undefined)
    data.pointsMultiplier = new Prisma.Decimal(input.pointsMultiplier);
  if (input.perks !== undefined)
    data.perks = input.perks as Prisma.InputJsonValue;
  if (input.iconUrl !== undefined) data.iconUrl = input.iconUrl;
  if (input.entryBonusPoints !== undefined)
    data.entryBonusPoints = input.entryBonusPoints;

  const updated = await tx.weleticLoyaltyTier.update({
    where: { id: tierId },
    data,
  });

  return updated;
}

/**
 * Lists all tiers for a loyalty program, ordered ascending by tierOrder.
 */
export async function listLoyaltyTiers(programId: string) {
  return await prisma.weleticLoyaltyTier.findMany({
    where: { programId, deletedAt: null },
    orderBy: { tierOrder: "asc" },
  });
}

/**
 * Retrieves the effective points multiplier for an account's current tier.
 */
export async function getAccountTierMultiplier(
  accountId: string,
): Promise<number> {
  const account = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    include: { currentTier: true },
  });

  if (!account || !account.currentTier) {
    return 1.0;
  }

  return Number(account.currentTier.pointsMultiplier);
}

/**
 * Evaluates an account's VIP tier progression and lifecycle maintenance.
 */
export async function evaluateAccountTier(
  accountId: string,
  options: {
    expectedInstallationGeneration?: string | null;
    loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  } = {},
) {
  const account = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    include: {
      currentTier: true,
      program: {
        include: {
          tiers: {
            where: { deletedAt: null },
            orderBy: { tierOrder: "desc" },
          },
        },
      },
    },
  });

  if (!account) {
    throw new Error(`Loyalty account ${accountId} not found.`);
  }

  const result = await evaluateTierMaintenanceCycle({
    storeId: account.storeId,
    accountId,
    expectedInstallationGeneration: options.expectedInstallationGeneration,
    loyaltyMaintenancePermit: options.loyaltyMaintenancePermit,
  });
  const tierChanged = result.tierChanged;

  const refreshedAccount = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    include: {
      currentTier: true,
      program: {
        include: {
          tiers: {
            where: { deletedAt: null },
            orderBy: { tierOrder: "asc" },
          },
        },
      },
    },
  });

  const allTiers = refreshedAccount?.program?.tiers || [];
  const currentTier =
    refreshedAccount?.currentTier || (allTiers.length > 0 ? allTiers[0] : null);

  const nextTier = currentTier
    ? allTiers.find((t) => t.tierOrder > currentTier.tierOrder) || null
    : null;

  const rollingSpend = refreshedAccount?.tierSpendRolling12Months || BigInt(0);
  const lifetimePoints = refreshedAccount?.lifetimePointsEarned || BigInt(0);

  let progress: {
    nextTierName: string;
    nextTierOrder: number;
    spendThreshold: bigint;
    pointsThreshold: bigint;
    spendRemaining: bigint;
    pointsRemaining: bigint;
    rollingSpend: bigint;
    lifetimePoints: bigint;
  } | null = null;

  if (nextTier) {
    const spendRemaining =
      nextTier.minSpendThreshold > rollingSpend
        ? nextTier.minSpendThreshold - rollingSpend
        : BigInt(0);
    const pointsRemaining =
      nextTier.minPointsThreshold > lifetimePoints
        ? nextTier.minPointsThreshold - lifetimePoints
        : BigInt(0);

    progress = {
      nextTierName: nextTier.name,
      nextTierOrder: nextTier.tierOrder,
      spendThreshold: nextTier.minSpendThreshold,
      pointsThreshold: nextTier.minPointsThreshold,
      spendRemaining,
      pointsRemaining,
      rollingSpend,
      lifetimePoints,
    };
  }

  return {
    currentTier,
    tierChanged,
    nextTier,
    progress,
  };
}

/**
 * Returns tier information and next tier progress for an account.
 */
export async function getAccountTierProgress(accountId: string) {
  const account = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    include: {
      currentTier: true,
      program: {
        include: {
          tiers: {
            where: { deletedAt: null },
            orderBy: { tierOrder: "asc" },
          },
        },
      },
    },
  });

  if (!account) {
    throw new Error(`Loyalty account ${accountId} not found.`);
  }

  const allTiers = account.program.tiers;
  const currentTier = account.currentTier || allTiers[0] || null;
  const rollingSpend = account.tierSpendRolling12Months;
  const lifetimePoints = account.lifetimePointsEarned;

  const nextTier = currentTier
    ? allTiers.find((t) => t.tierOrder > currentTier.tierOrder) || null
    : null;

  return {
    currentTier,
    allTiers,
    nextTier,
    rollingSpend,
    lifetimePoints,
    perks: currentTier?.perks ? (currentTier.perks as string[]) : [],
    multiplier: currentTier ? Number(currentTier.pointsMultiplier) : 1.0,
  };
}
