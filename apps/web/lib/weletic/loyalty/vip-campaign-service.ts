import { createWeleticId } from "@/lib/weletic/ids";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  assertNoCampaignOverlap,
  assertRunningCampaignImmutability,
  normalizeBonusCampaignTargets,
  normalizeEligibleTierIds,
  parseBonusCampaignSchedule,
} from "./bonus-campaign-policy";
import { publishLoyaltyEarnPolicyRevision } from "./earn-policy-revision";
import {
  bonusCampaignFieldsSchema,
  vipCampaignRequestSchema,
  vipProgramPolicySchema,
  vipTierFieldsSchema,
  type VipTierFields,
} from "./vip-campaign-contract";

export class VipCampaignConflictError extends Error {
  constructor() {
    super("VIP or campaign state changed");
    this.name = "VipCampaignConflictError";
  }
}

const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (item instanceof Date) return item.toISOString();
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(
        Object.entries(item).sort(([first], [second]) =>
          first.localeCompare(second),
        ),
      );
    return item;
  });

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function projectTier(tier: {
  id: string;
  name: string;
  slug: string;
  tierOrder: number;
  minSpendThreshold: bigint;
  minPointsThreshold: bigint;
  pointsMultiplier: unknown;
  entryBonusPoints: bigint;
  gracePeriodDays: number | null;
  perks: unknown;
  iconUrl: string | null;
  color: string | null;
}) {
  return {
    id: tier.id,
    fields: vipTierFieldsSchema.parse({
      name: tier.name,
      slug: tier.slug,
      tierOrder: tier.tierOrder,
      minSpendThreshold: tier.minSpendThreshold.toString(),
      minPointsThreshold: tier.minPointsThreshold.toString(),
      pointsMultiplier: Number(tier.pointsMultiplier),
      entryBonusPoints: tier.entryBonusPoints.toString(),
      gracePeriodDays: tier.gracePeriodDays,
      perks: stringList(tier.perks),
      iconUrl: tier.iconUrl,
      color: tier.color,
    }),
  };
}

function projectCampaign(
  campaign: {
    id: string;
    name: string;
    description: string | null;
    multiplier: unknown;
    startAt: Date;
    endAt: Date;
    isActive: boolean;
    eligibleTierIds: unknown;
    eligibleSkus: unknown;
    eligibleCollectionIds: unknown;
  },
  now = new Date(),
) {
  const targets = normalizeBonusCampaignTargets(campaign);
  const running =
    campaign.isActive && campaign.startAt <= now && campaign.endAt > now;
  const lifecycle = !campaign.isActive
    ? "paused"
    : campaign.startAt > now
      ? "scheduled"
      : running
        ? "running"
        : "ended";
  return {
    id: campaign.id,
    fields: bonusCampaignFieldsSchema.parse({
      name: campaign.name,
      description: campaign.description,
      multiplier: Number(campaign.multiplier),
      startAt: campaign.startAt.toISOString(),
      endAt: campaign.endAt.toISOString(),
      isActive: campaign.isActive,
      eligibleTierIds: normalizeEligibleTierIds(campaign.eligibleTierIds),
      eligibleSkus: targets.eligibleSkus,
      eligibleCollectionIds: targets.eligibleCollectionIds,
    }),
    lifecycle,
    economicsEditable: !running,
  } as const;
}

export async function readVipCampaignStateInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    include: {
      tiers: { orderBy: { tierOrder: "asc" } },
      bonusCampaigns: {
        where: { deletedAt: null },
        orderBy: [{ startAt: "desc" }, { id: "asc" }],
      },
    },
  });
  const policy = vipProgramPolicySchema.parse({
    milestoneMode: program?.vipMilestoneMode ?? "amount_spent",
    timeframe: program?.vipTimeframe ?? "rolling_12m",
    downgradeGraceDays: program?.vipDowngradeGraceDays ?? 30,
    autoDowngradeEnabled: program?.vipAutoDowngradeEnabled ?? true,
  });
  const activeTierRows = (program?.tiers ?? []).filter(
    (tier) => tier.deletedAt === null,
  );
  const tiers = activeTierRows.map(projectTier);
  const campaigns = (program?.bonusCampaigns ?? []).map((campaign) =>
    projectCampaign(campaign),
  );
  const retiredTierIdentities = (program?.tiers ?? [])
    .filter((tier) => tier.deletedAt !== null)
    .map((tier) => ({ id: tier.id, slug: tier.slug, order: tier.tierOrder }));
  const tierNames = new Map(
    (program?.tiers ?? []).map((tier) => [tier.id, tier.name]),
  );
  const tierHistory = program
    ? await tx.weleticLoyaltyTierHistory.findMany({
        where: { account: { storeId, programId: program.id } },
        select: {
          id: true,
          fromTierId: true,
          toTierId: true,
          changeReason: true,
          effectiveAt: true,
        },
        orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
        take: 100,
      })
    : [];
  const revision = createHash("sha256")
    .update(
      stable([
        "vip-campaign-v1",
        storeId,
        policy,
        tiers,
        retiredTierIdentities,
        campaigns,
      ]),
    )
    .digest("hex");
  return {
    programId: program?.id ?? null,
    revision,
    policy,
    tiers,
    campaigns,
    retiredTierIdentities,
    tierHistory: tierHistory.map((entry) => ({
      ...entry,
      fromTierName: entry.fromTierId
        ? tierNames.get(entry.fromTierId) ?? null
        : null,
      toTierName: entry.toTierId ? tierNames.get(entry.toTierId) ?? null : null,
      effectiveAt: entry.effectiveAt.toISOString(),
    })),
  };
}

async function ensureProgram(tx: Prisma.TransactionClient, storeId: string) {
  return tx.weleticLoyaltyProgram.upsert({
    where: { storeId },
    create: {
      id: createWeleticId("wprog_"),
      storeId,
      name: "Customer Loyalty Program",
      status: "draft",
    },
    update: {},
  });
}

function assertTierHierarchy(
  tiers: Array<{ id: string; fields: VipTierFields }>,
  candidate: { id: string | null; fields: VipTierFields },
  milestoneMode: "amount_spent" | "points_earned" | "both",
) {
  const next = [
    ...tiers.filter((tier) => tier.id !== candidate.id),
    { id: candidate.id ?? "new", fields: candidate.fields },
  ].sort((first, second) => first.fields.tierOrder - second.fields.tierOrder);
  if (new Set(next.map((tier) => tier.fields.slug)).size !== next.length)
    throw new VipCampaignConflictError();
  if (new Set(next.map((tier) => tier.fields.tierOrder)).size !== next.length)
    throw new VipCampaignConflictError();
  for (let index = 1; index < next.length; index += 1) {
    const previous = next[index - 1].fields;
    const current = next[index].fields;
    if (
      (milestoneMode === "amount_spent" || milestoneMode === "both") &&
      BigInt(current.minSpendThreshold) <= BigInt(previous.minSpendThreshold)
    )
      throw new VipCampaignConflictError();
    if (
      (milestoneMode === "points_earned" || milestoneMode === "both") &&
      BigInt(current.minPointsThreshold) <= BigInt(previous.minPointsThreshold)
    )
      throw new VipCampaignConflictError();
  }
}

export async function mutateVipCampaignStateInTransaction({
  tx,
  storeId,
  installationGeneration,
  request,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string;
  request: unknown;
}) {
  const parsed = vipCampaignRequestSchema.parse(request);
  if (parsed.operation === "read") throw new Error("Mutation required");
  if (parsed.input.expectedInstallationGeneration !== installationGeneration)
    throw new VipCampaignConflictError();
  const state = await readVipCampaignStateInTransaction(tx, storeId);
  if (parsed.input.expectedRevision !== state.revision)
    throw new VipCampaignConflictError();
  const program = await ensureProgram(tx, storeId);
  let affectedResourceId: string = program.id;

  if (parsed.operation === "save_policy") {
    if (state.tiers[0])
      assertTierHierarchy(
        state.tiers,
        state.tiers[0],
        parsed.input.policy.milestoneMode,
      );
    await tx.weleticLoyaltyProgram.update({
      where: { id: program.id },
      data: {
        vipMilestoneMode: parsed.input.policy.milestoneMode,
        vipTimeframe: parsed.input.policy.timeframe,
        vipDowngradeGraceDays: parsed.input.policy.downgradeGraceDays,
        vipAutoDowngradeEnabled: parsed.input.policy.autoDowngradeEnabled,
      },
    });
  } else if (parsed.operation === "save_tier") {
    if (
      state.retiredTierIdentities.some(
        (tier) =>
          tier.id !== parsed.input.tierId &&
          (tier.slug === parsed.input.tier.slug ||
            tier.order === parsed.input.tier.tierOrder),
      )
    )
      throw new VipCampaignConflictError();
    assertTierHierarchy(
      state.tiers,
      { id: parsed.input.tierId, fields: parsed.input.tier },
      state.policy.milestoneMode,
    );
    const tier = parsed.input.tier;
    const data = {
      name: tier.name,
      slug: tier.slug,
      tierOrder: tier.tierOrder,
      minSpendThreshold: BigInt(tier.minSpendThreshold),
      minPointsThreshold: BigInt(tier.minPointsThreshold),
      pointsMultiplier: tier.pointsMultiplier,
      entryBonusPoints: BigInt(tier.entryBonusPoints),
      gracePeriodDays: tier.gracePeriodDays,
      perks: tier.perks as Prisma.InputJsonValue,
      iconUrl: tier.iconUrl,
      color: tier.color,
    };
    if (parsed.input.tierId) {
      const existing = state.tiers.find(({ id }) => id === parsed.input.tierId);
      if (!existing) throw new VipCampaignConflictError();
      await tx.weleticLoyaltyTier.update({
        where: { id: existing.id },
        data,
      });
      affectedResourceId = existing.id;
    } else {
      const created = await tx.weleticLoyaltyTier.create({
        data: { id: createWeleticId("wtier_"), programId: program.id, ...data },
      });
      affectedResourceId = created.id;
    }
  } else if (parsed.operation === "retire_tier") {
    const existing = state.tiers.find(({ id }) => id === parsed.input.tierId);
    if (!existing) throw new VipCampaignConflictError();
    if (
      state.campaigns.some(({ fields }) =>
        fields.eligibleTierIds.includes(existing.id),
      )
    )
      throw new VipCampaignConflictError();
    if (
      (await tx.weleticLoyaltyAccount.count({
        where: { storeId, currentTierId: existing.id },
      })) > 0
    )
      throw new VipCampaignConflictError();
    await tx.weleticLoyaltyTier.update({
      where: { id: existing.id },
      data: { deletedAt: new Date() },
    });
    affectedResourceId = existing.id;
  } else if (parsed.operation === "save_campaign") {
    const campaign = parsed.input.campaign;
    const schedule = parseBonusCampaignSchedule(campaign);
    const tierIds = normalizeEligibleTierIds(campaign.eligibleTierIds);
    if (tierIds.some((id) => !state.tiers.some((tier) => tier.id === id)))
      throw new VipCampaignConflictError();
    const existing = parsed.input.campaignId
      ? state.campaigns.find(({ id }) => id === parsed.input.campaignId)
      : null;
    if (parsed.input.campaignId && !existing)
      throw new VipCampaignConflictError();
    if (existing)
      assertRunningCampaignImmutability({
        existing: existing.fields,
        updates: campaign,
      });
    if (!existing && schedule.startAt.getTime() < Date.now() - 5 * 60 * 1000)
      throw new VipCampaignConflictError();
    assertNoCampaignOverlap({
      proposed: {
        id: existing?.id,
        startAt: schedule.startAt,
        endAt: schedule.endAt,
        isActive: campaign.isActive,
      },
      existingCampaigns: state.campaigns.map(({ id, fields }) => ({
        id,
        startAt: fields.startAt,
        endAt: fields.endAt,
        isActive: fields.isActive,
      })),
    });
    const data = {
      name: campaign.name,
      description: campaign.description,
      multiplier: schedule.multiplier,
      startAt: schedule.startAt,
      endAt: schedule.endAt,
      isActive: campaign.isActive,
      eligibleTierIds: tierIds as Prisma.InputJsonValue,
      eligibleSkus: campaign.eligibleSkus as Prisma.InputJsonValue,
      eligibleCollectionIds:
        campaign.eligibleCollectionIds as Prisma.InputJsonValue,
    };
    if (existing) {
      await tx.weleticLoyaltyBonusCampaign.update({
        where: { id: existing.id },
        data,
      });
      affectedResourceId = existing.id;
    } else {
      const created = await tx.weleticLoyaltyBonusCampaign.create({
        data: {
          id: createWeleticId("wcamp_"),
          programId: program.id,
          ...data,
        },
      });
      affectedResourceId = created.id;
    }
  } else {
    const existing = state.campaigns.find(
      ({ id }) => id === parsed.input.campaignId,
    );
    if (!existing || new Date(existing.fields.startAt) <= new Date())
      throw new VipCampaignConflictError();
    await tx.weleticLoyaltyBonusCampaign.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
    affectedResourceId = existing.id;
  }

  await publishLoyaltyEarnPolicyRevision({
    tx,
    storeId,
    programId: program.id,
    reason: `vip_campaign_${parsed.operation}`,
  });
  return {
    ...(await readVipCampaignStateInTransaction(tx, storeId)),
    affectedResourceId,
  };
}
