import {
  publishLoyaltyEarnPolicyRevision,
  verifyLoyaltyEarnPolicyRevisionSnapshot,
} from "@/lib/weletic/loyalty/earn-policy-revision";
import { Prisma, PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

type SeededTierDefinition = {
  id: string;
  name: string;
  slug: string;
  tierOrder: number;
  pointsMultiplier: Prisma.Decimal.Value;
  minSpendThreshold: bigint;
  minPointsThreshold: bigint;
  entryBonusPoints: bigint;
};

type SeededRewardDefinition = {
  id: string;
  name: string;
  pointsCost: bigint;
  rewardType: "amount_off";
  discountValue: Prisma.Decimal.Value;
  minOrderAmount: Prisma.Decimal.Value;
};

export type SeededLoyaltyPolicyDefinition = {
  program: {
    id: string;
    name: string;
    pointNameSingular: string;
    pointNamePlural: string;
    pointsPerCurrencyUnit: Prisma.Decimal.Value;
    holdingPeriodDays: number;
    pointsExpiryMonths: number;
  };
  tiers: readonly SeededTierDefinition[];
  rewards?: readonly SeededRewardDefinition[];
};

const WELETIC_LOYALTY_SEED = {
  program: {
    id: "loyalty_weletic_prog",
    name: "Weletic Club Rewards",
    pointNameSingular: "Point",
    pointNamePlural: "Points",
    pointsPerCurrencyUnit: 1,
    holdingPeriodDays: 14,
    pointsExpiryMonths: 12,
  },
  tiers: [
    {
      id: "tier_weletic_bronze",
      name: "Bronze",
      slug: "bronze",
      tierOrder: 1,
      pointsMultiplier: 1,
      minSpendThreshold: BigInt(0),
      minPointsThreshold: BigInt(0),
      entryBonusPoints: BigInt(0),
    },
    {
      id: "tier_weletic_silver",
      name: "Silver",
      slug: "silver",
      tierOrder: 2,
      pointsMultiplier: 1.25,
      minSpendThreshold: BigInt(20000),
      minPointsThreshold: BigInt(0),
      entryBonusPoints: BigInt(100),
    },
    {
      id: "tier_weletic_gold",
      name: "Gold",
      slug: "gold",
      tierOrder: 3,
      pointsMultiplier: 1.5,
      minSpendThreshold: BigInt(50000),
      minPointsThreshold: BigInt(0),
      entryBonusPoints: BigInt(250),
    },
  ],
  rewards: [
    {
      id: "reward_weletic_5off",
      name: "$5 Off Voucher",
      pointsCost: BigInt(500),
      rewardType: "amount_off",
      discountValue: 5,
      minOrderAmount: 25,
    },
    {
      id: "reward_weletic_10off",
      name: "$10 Off Voucher",
      pointsCost: BigInt(1000),
      rewardType: "amount_off",
      discountValue: 10,
      minOrderAmount: 50,
    },
  ],
} satisfies SeededLoyaltyPolicyDefinition;

const YAMAX_LOYALTY_SEED = {
  program: {
    id: "loyalty_yamax_prog",
    name: "Yamax Pro Loyalty",
    pointNameSingular: "Point",
    pointNamePlural: "Points",
    pointsPerCurrencyUnit: 1,
    holdingPeriodDays: 14,
    pointsExpiryMonths: 12,
  },
  tiers: [
    {
      id: "tier_yamax_bronze",
      name: "Bronze",
      slug: "bronze",
      tierOrder: 1,
      pointsMultiplier: 1,
      minSpendThreshold: BigInt(0),
      minPointsThreshold: BigInt(0),
      entryBonusPoints: BigInt(0),
    },
    {
      id: "tier_yamax_silver",
      name: "Silver",
      slug: "silver",
      tierOrder: 2,
      pointsMultiplier: 1.25,
      minSpendThreshold: BigInt(20000),
      minPointsThreshold: BigInt(0),
      entryBonusPoints: BigInt(100),
    },
    {
      id: "tier_yamax_gold",
      name: "Gold",
      slug: "gold",
      tierOrder: 3,
      pointsMultiplier: 1.5,
      minSpendThreshold: BigInt(50000),
      minPointsThreshold: BigInt(0),
      entryBonusPoints: BigInt(250),
    },
  ],
} satisfies SeededLoyaltyPolicyDefinition;

/**
 * Repairs a partially completed legacy seed and installs a verified immutable
 * policy head. The caller owns the transaction so program, tiers, and revision
 * either all commit or all roll back together.
 */
export async function seedStoreLoyaltyPolicy({
  tx,
  storeId,
  definition,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  definition: SeededLoyaltyPolicyDefinition;
}) {
  let program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
  });
  if (!program) {
    program = await tx.weleticLoyaltyProgram.create({
      data: {
        ...definition.program,
        storeId,
        status: "active",
      },
    });
  }

  for (const tier of definition.tiers) {
    const existing = await tx.weleticLoyaltyTier.findUnique({
      where: { id: tier.id },
      select: { id: true, programId: true, deletedAt: true },
    });
    if (existing && existing.programId !== program.id) {
      throw new Error(
        `Seeded loyalty tier ${tier.id} belongs to another loyalty program.`,
      );
    }
    if (!existing) {
      await tx.weleticLoyaltyTier.create({
        data: { ...tier, programId: program.id },
      });
    } else if (existing.deletedAt) {
      await tx.weleticLoyaltyTier.update({
        where: { id: existing.id },
        data: { deletedAt: null },
      });
    }
  }

  for (const reward of definition.rewards ?? []) {
    const existing = await tx.weleticRewardDefinition.findUnique({
      where: { id: reward.id },
      select: { id: true, storeId: true },
    });
    if (existing && existing.storeId !== storeId) {
      throw new Error(
        `Seeded loyalty reward ${reward.id} belongs to another Shopify store.`,
      );
    }
    if (!existing) {
      await tx.weleticRewardDefinition.create({
        data: { ...reward, storeId },
      });
    }
  }

  const revision = await publishLoyaltyEarnPolicyRevision({
    tx,
    storeId,
    programId: program.id,
    reason: "local_seed_policy_synchronized",
  });
  verifyLoyaltyEarnPolicyRevisionSnapshot({
    revisionId: revision.id,
    storeId: revision.storeId,
    programId: revision.programId,
    schemaVersion: revision.schemaVersion,
    snapshot: revision.snapshot,
    fingerprint: revision.fingerprint,
    expectedStoreId: storeId,
    expectedProgramId: program.id,
  });

  return { program, revision };
}

async function main(prisma: PrismaClient) {
  console.log("Seeding Weletic and Yamax workspaces for local testing...");

  // 1. Ensure user admin@weletic.com exists
  let adminUser = await prisma.user.findUnique({
    where: { email: "admin@weletic.com" },
  });

  if (!adminUser) {
    adminUser = await prisma.user.create({
      data: {
        id: "user_admin_weletic",
        email: "admin@weletic.com",
        name: "Weletic Admin",
      },
    });
  }

  // 2. Ensure Workspace "weletic" exists
  let weleticProject = await prisma.project.findUnique({
    where: { slug: "weletic" },
  });

  if (!weleticProject) {
    weleticProject = await prisma.project.create({
      data: {
        id: "ws_weletic_store_main",
        name: "Weletic",
        slug: "weletic",
        plan: "enterprise",
        billingCycleStart: 1,
      },
    });
  }

  // Assign admin@weletic.com as owner of Weletic workspace
  const weleticProjectUser = await prisma.projectUsers.findFirst({
    where: {
      userId: adminUser.id,
      projectId: weleticProject.id,
    },
  });

  if (!weleticProjectUser) {
    await prisma.projectUsers.create({
      data: {
        userId: adminUser.id,
        projectId: weleticProject.id,
        role: "owner",
      },
    });
  }

  // 3. Ensure Program for Weletic exists
  let weleticProgram = await prisma.program.findFirst({
    where: { workspaceId: weleticProject.id },
  });

  if (!weleticProgram) {
    weleticProgram = await prisma.program.create({
      data: {
        id: "prog_weletic_store_main",
        workspaceId: weleticProject.id,
        defaultFolderId: "folder_weletic_default",
        defaultGroupId: "group_weletic_default",
        name: "Weletic Partner Program",
        slug: "weletic",
        accountingCurrency: "USD",
      },
    });
  }

  // 4. Ensure WeleticShopifyStore exists for Weletic
  let weleticStore = await prisma.weleticShopifyStore.findUnique({
    where: { projectId: weleticProject.id },
  });

  if (!weleticStore) {
    weleticStore = await prisma.weleticShopifyStore.create({
      data: {
        id: "store_weletic_shopify_main",
        projectId: weleticProject.id,
        programId: weleticProgram.id,
        shopDomain: "weletic.myshopify.com",
        shopCurrency: "USD",
        defaultLocale: "en",
        apiVersion: "2026-07",
        syncStatus: "succeeded",
      },
    });
  }

  // 5. Ensure Loyalty Program, tiers, and immutable policy head for Weletic.
  await prisma.$transaction((tx) =>
    seedStoreLoyaltyPolicy({
      tx,
      storeId: weleticStore.id,
      definition: WELETIC_LOYALTY_SEED,
    }),
  );

  // 6. Ensure Yamax workspace has store & loyalty setup
  const yamaxProject = await prisma.project.findUnique({
    where: { slug: "yamax" },
  });

  if (yamaxProject) {
    const yamaxUser = await prisma.projectUsers.findFirst({
      where: {
        userId: adminUser.id,
        projectId: yamaxProject.id,
      },
    });

    if (!yamaxUser) {
      await prisma.projectUsers.create({
        data: {
          userId: adminUser.id,
          projectId: yamaxProject.id,
          role: "owner",
        },
      });
    }

    const yamaxProgram = await prisma.program.findFirst({
      where: { workspaceId: yamaxProject.id },
    });

    if (yamaxProgram) {
      let yamaxStore = await prisma.weleticShopifyStore.findUnique({
        where: { projectId: yamaxProject.id },
      });

      if (!yamaxStore) {
        yamaxStore = await prisma.weleticShopifyStore.create({
          data: {
            id: "store_yamax_shopify_main",
            projectId: yamaxProject.id,
            programId: yamaxProgram.id,
            shopDomain: "yamaxpro.myshopify.com",
            shopCurrency: "USD",
            defaultLocale: "en",
            apiVersion: "2026-07",
            syncStatus: "succeeded",
          },
        });
      }

      await prisma.$transaction((tx) =>
        seedStoreLoyaltyPolicy({
          tx,
          storeId: yamaxStore.id,
          definition: YAMAX_LOYALTY_SEED,
        }),
      );
    }
  }

  console.log("All workspaces and loyalty programs seeded successfully!");
}

const invokedScript = process.argv[1];
if (invokedScript && import.meta.url === pathToFileURL(invokedScript).href) {
  const prisma = new PrismaClient();
  main(prisma)
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
