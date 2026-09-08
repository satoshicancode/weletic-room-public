import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import {
  createLoyaltyTier,
  listLoyaltyTiers,
  updateLoyaltyTier,
} from "@/lib/weletic/loyalty/tiers";
import type { Prisma } from "@prisma/client";

const MAX_TIER_VALUE = BigInt("1000000000000000");

function readTierText(value: unknown, field: string, maximum: number) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    throw new DubApiError({
      code: "bad_request",
      message: `${field} must contain between 1 and ${maximum} characters.`,
    });
  }
  return text;
}

function readTierSlug(value: unknown) {
  const slug = readTierText(value, "slug", 64).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "slug must contain lowercase letters, numbers, and hyphens only.",
    });
  }
  return slug;
}

function readTierInteger(
  value: unknown,
  field: string,
  { minimum, maximum }: { minimum: number; maximum: number },
) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new DubApiError({
      code: "bad_request",
      message: `${field} must be a whole number from ${minimum} to ${maximum}.`,
    });
  }
  return parsed;
}

function readTierBigInt(value: unknown, field: string) {
  const normalized =
    typeof value === "bigint" ? value.toString() : String(value);
  if (!/^\d+$/.test(normalized)) {
    throw new DubApiError({
      code: "bad_request",
      message: `${field} must be a non-negative whole number.`,
    });
  }
  const parsed = BigInt(normalized);
  if (parsed > MAX_TIER_VALUE) {
    throw new DubApiError({
      code: "bad_request",
      message: `${field} is above the supported maximum.`,
    });
  }
  return parsed;
}

function readTierMultiplier(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    throw new DubApiError({
      code: "bad_request",
      message: "pointsMultiplier must be between 1 and 100.",
    });
  }
  return parsed;
}

function readTierPerks(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new DubApiError({
      code: "bad_request",
      message: "perks must be an array with at most 20 items.",
    });
  }
  return value.map((perk) => readTierText(perk, "perk", 120));
}

function readTierIconUrl(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) {
    throw new DubApiError({
      code: "bad_request",
      message: "iconUrl must be a valid HTTPS URL.",
    });
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("not https");
    return url.toString();
  } catch {
    throw new DubApiError({
      code: "bad_request",
      message: "iconUrl must be a valid HTTPS URL.",
    });
  }
}

function readTierId(value: unknown) {
  if (typeof value !== "string" || !/^wtier_[A-Za-z0-9_-]{3,64}$/.test(value)) {
    throw new DubApiError({
      code: "bad_request",
      message: "VIP tier ID is invalid.",
    });
  }
  return value;
}

type TierCandidate = {
  id?: string;
  name: string;
  slug: string;
  tierOrder: number;
  minSpendThreshold: bigint;
  minPointsThreshold: bigint;
};

async function assertTierHierarchy({
  tx,
  programId,
  milestoneMode,
  candidate,
}: {
  tx: Prisma.TransactionClient;
  programId: string;
  milestoneMode: string;
  candidate: TierCandidate;
}) {
  const others = await tx.weleticLoyaltyTier.findMany({
    where: {
      programId,
      ...(candidate.id ? { id: { not: candidate.id } } : {}),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      tierOrder: true,
      minSpendThreshold: true,
      minPointsThreshold: true,
      deletedAt: true,
    },
  });
  const retiredIdentityConflict = others.find(
    (tier) =>
      tier.deletedAt &&
      (tier.slug === candidate.slug || tier.tierOrder === candidate.tierOrder),
  );
  if (retiredIdentityConflict) {
    throw new DubApiError({
      code: "conflict",
      message:
        "A retired VIP tier permanently reserves this slug or tier order for historical audit integrity.",
    });
  }
  const tiers = [...others.filter((tier) => !tier.deletedAt), candidate].sort(
    (first, second) => first.tierOrder - second.tierOrder,
  );
  if (new Set(tiers.map((tier) => tier.tierOrder)).size !== tiers.length) {
    throw new DubApiError({
      code: "conflict",
      message: "Each VIP tier must have a unique tier order.",
    });
  }
  if (new Set(tiers.map((tier) => tier.slug)).size !== tiers.length) {
    throw new DubApiError({
      code: "conflict",
      message: "Each VIP tier must have a unique slug.",
    });
  }
  for (let index = 1; index < tiers.length; index += 1) {
    const previous = tiers[index - 1];
    const current = tiers[index];
    if (
      (milestoneMode === "amount_spent" || milestoneMode === "both") &&
      current.minSpendThreshold <= previous.minSpendThreshold
    ) {
      throw new DubApiError({
        code: "conflict",
        message: "Spend thresholds must increase with each VIP tier.",
      });
    }
    if (
      (milestoneMode === "points_earned" || milestoneMode === "both") &&
      current.minPointsThreshold <= previous.minPointsThreshold
    ) {
      throw new DubApiError({
        code: "conflict",
        message: "Points thresholds must increase with each VIP tier.",
      });
    }
  }
}

// GET /api/shopify/loyalty/admin/tiers - List all VIP tiers for store/program
export const GET = withWorkspace(
  async ({ workspace }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const program = await prisma.weleticLoyaltyProgram.findUnique({
      where: { storeId: store.id },
    });

    if (!program) {
      return loyaltySuccessResponse([], { headers: COMMON_CORS_HEADERS });
    }

    const tiers = await listLoyaltyTiers(program.id);

    return loyaltySuccessResponse(
      tiers.map((t) => ({
        id: t.id,
        programId: t.programId,
        name: t.name,
        slug: t.slug,
        tierOrder: t.tierOrder,
        minSpendThreshold: t.minSpendThreshold.toString(),
        minPointsThreshold: t.minPointsThreshold.toString(),
        pointsMultiplier: Number(t.pointsMultiplier),
        perks: t.perks,
        iconUrl: t.iconUrl,
        entryBonusPoints: t.entryBonusPoints.toString(),
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      })),
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

// POST /api/shopify/loyalty/admin/tiers - Create a new VIP tier
export const POST = withWorkspace(
  async ({ workspace, req }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const body = await parseRequestBody(req);
    const {
      name,
      slug,
      tierOrder,
      minSpendThreshold,
      minPointsThreshold,
      pointsMultiplier,
      perks,
      iconUrl,
      entryBonusPoints,
    } = body;

    if (!name || !slug) {
      throw new DubApiError({
        code: "bad_request",
        message: "Tier 'name' and 'slug' are required.",
      });
    }

    const candidate = {
      name: readTierText(name, "name", 80),
      slug: readTierSlug(slug),
      tierOrder: readTierInteger(tierOrder ?? 1, "tierOrder", {
        minimum: 1,
        maximum: 100,
      }),
      minSpendThreshold: readTierBigInt(
        minSpendThreshold ?? 0,
        "minSpendThreshold",
      ),
      minPointsThreshold: readTierBigInt(
        minPointsThreshold ?? 0,
        "minPointsThreshold",
      ),
    };
    const normalizedMultiplier = readTierMultiplier(pointsMultiplier ?? 1);
    const normalizedEntryBonus = readTierBigInt(
      entryBonusPoints ?? 0,
      "entryBonusPoints",
    );
    const normalizedPerks = readTierPerks(perks);
    const normalizedIconUrl = readTierIconUrl(iconUrl);

    const tier = await withActiveStoreLoyaltyMutation({
      storeId: store.id,
      action: "loyalty_tier_create",
      operation: async (tx) => {
        let program = await tx.weleticLoyaltyProgram.findUnique({
          where: { storeId: store.id },
        });
        if (!program) {
          program = await tx.weleticLoyaltyProgram.create({
            data: {
              id: createWeleticId("wprog_"),
              storeId: store.id,
              name: "Customer Loyalty Program",
              status: "draft",
            },
          });
        }
        await assertTierHierarchy({
          tx,
          programId: program.id,
          milestoneMode: program.vipMilestoneMode,
          candidate,
        });
        const created = await createLoyaltyTier(
          {
            programId: program.id,
            ...candidate,
            pointsMultiplier: normalizedMultiplier,
            perks: normalizedPerks,
            iconUrl: normalizedIconUrl || undefined,
            entryBonusPoints: normalizedEntryBonus,
          },
          tx,
        );
        await publishLoyaltyEarnPolicyRevision({
          tx,
          storeId: store.id,
          programId: program.id,
          reason: "vip_tier_created",
        });
        return created;
      },
    });

    return loyaltySuccessResponse(
      {
        id: tier.id,
        programId: tier.programId,
        name: tier.name,
        slug: tier.slug,
        tierOrder: tier.tierOrder,
        minSpendThreshold: tier.minSpendThreshold.toString(),
        minPointsThreshold: tier.minPointsThreshold.toString(),
        pointsMultiplier: Number(tier.pointsMultiplier),
        perks: tier.perks,
        iconUrl: tier.iconUrl,
        entryBonusPoints: tier.entryBonusPoints.toString(),
        createdAt: tier.createdAt,
        updatedAt: tier.updatedAt,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

// PUT /api/shopify/loyalty/admin/tiers - Update an existing VIP tier
export const PUT = withWorkspace(
  async ({ workspace, req }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const body = await parseRequestBody(req);
    const {
      id,
      tierId,
      name,
      slug,
      tierOrder,
      minSpendThreshold,
      minPointsThreshold,
      pointsMultiplier,
      perks,
      iconUrl,
      entryBonusPoints,
    } = body;
    const requestedId = id || tierId;

    if (!requestedId) {
      throw new DubApiError({
        code: "bad_request",
        message: "Missing required field: 'id' or 'tierId'.",
      });
    }
    const targetId = readTierId(requestedId);

    const tier = await withActiveStoreLoyaltyMutation({
      storeId: store.id,
      action: "loyalty_tier_update",
      operation: async (tx) => {
        const lockedProgram = await tx.weleticLoyaltyProgram.findUnique({
          where: { storeId: store.id },
        });
        const existing = lockedProgram
          ? await tx.weleticLoyaltyTier.findFirst({
              where: {
                id: targetId,
                programId: lockedProgram.id,
                deletedAt: null,
              },
            })
          : null;
        if (!lockedProgram || !existing) {
          throw new DubApiError({
            code: "not_found",
            message: `Tier '${targetId}' not found for this store program.`,
          });
        }
        const candidate = {
          id: existing.id,
          name:
            name === undefined ? existing.name : readTierText(name, "name", 80),
          slug: slug === undefined ? existing.slug : readTierSlug(slug),
          tierOrder:
            tierOrder === undefined
              ? existing.tierOrder
              : readTierInteger(tierOrder, "tierOrder", {
                  minimum: 1,
                  maximum: 100,
                }),
          minSpendThreshold:
            minSpendThreshold === undefined
              ? existing.minSpendThreshold
              : readTierBigInt(minSpendThreshold, "minSpendThreshold"),
          minPointsThreshold:
            minPointsThreshold === undefined
              ? existing.minPointsThreshold
              : readTierBigInt(minPointsThreshold, "minPointsThreshold"),
        };
        const normalizedMultiplier =
          pointsMultiplier === undefined
            ? Number(existing.pointsMultiplier)
            : readTierMultiplier(pointsMultiplier);
        const normalizedEntryBonus =
          entryBonusPoints === undefined
            ? existing.entryBonusPoints
            : readTierBigInt(entryBonusPoints, "entryBonusPoints");
        const normalizedPerks =
          perks === undefined
            ? Array.isArray(existing.perks)
              ? existing.perks.filter(
                  (perk): perk is string => typeof perk === "string",
                )
              : []
            : readTierPerks(perks);
        const normalizedIconUrl =
          iconUrl === undefined ? existing.iconUrl : readTierIconUrl(iconUrl);
        await assertTierHierarchy({
          tx,
          programId: lockedProgram.id,
          milestoneMode: lockedProgram.vipMilestoneMode,
          candidate,
        });
        const updated = await updateLoyaltyTier(
          targetId,
          {
            ...candidate,
            pointsMultiplier: normalizedMultiplier,
            perks: normalizedPerks,
            iconUrl: normalizedIconUrl,
            entryBonusPoints: normalizedEntryBonus,
          },
          tx,
        );
        await publishLoyaltyEarnPolicyRevision({
          tx,
          storeId: store.id,
          programId: lockedProgram.id,
          reason: "vip_tier_updated",
        });
        return updated;
      },
    });

    return loyaltySuccessResponse(
      {
        id: tier.id,
        programId: tier.programId,
        name: tier.name,
        slug: tier.slug,
        tierOrder: tier.tierOrder,
        minSpendThreshold: tier.minSpendThreshold.toString(),
        minPointsThreshold: tier.minPointsThreshold.toString(),
        pointsMultiplier: Number(tier.pointsMultiplier),
        perks: tier.perks,
        iconUrl: tier.iconUrl,
        entryBonusPoints: tier.entryBonusPoints.toString(),
        updatedAt: tier.updatedAt,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

// DELETE /api/shopify/loyalty/admin/tiers - Delete a VIP tier
export const DELETE = withWorkspace(
  async ({ workspace, searchParams }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const requestedId = searchParams.id || searchParams.tierId;

    if (!requestedId) {
      throw new DubApiError({
        code: "bad_request",
        message: "Missing required parameter: 'id' or 'tierId'.",
      });
    }
    const id = readTierId(requestedId);

    await withActiveStoreLoyaltyMutation({
      storeId: store.id,
      action: "loyalty_tier_delete",
      operation: async (tx) => {
        const lockedProgram = await tx.weleticLoyaltyProgram.findUnique({
          where: { storeId: store.id },
          select: { id: true },
        });
        if (!lockedProgram) {
          throw new DubApiError({
            code: "not_found",
            message: `Tier '${id}' not found for this store program.`,
          });
        }
        const current = await tx.weleticLoyaltyTier.findFirst({
          where: {
            id,
            programId: lockedProgram.id,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!current) {
          throw new DubApiError({
            code: "not_found",
            message: `Tier '${id}' not found for this store program.`,
          });
        }
        const assignedAccounts = await tx.weleticLoyaltyAccount.count({
          where: { currentTierId: id },
        });
        if (assignedAccounts > 0) {
          throw new DubApiError({
            code: "conflict",
            message:
              "This tier still has current members and cannot be retired until they are reassigned.",
          });
        }
        const retired = await tx.weleticLoyaltyTier.update({
          where: { id },
          data: { deletedAt: new Date() },
        });
        await publishLoyaltyEarnPolicyRevision({
          tx,
          storeId: store.id,
          programId: lockedProgram.id,
          reason: "vip_tier_retired",
        });
        return retired;
      },
    });

    return loyaltySuccessResponse(
      { success: true, deletedId: id },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

export const OPTIONS = () => {
  return new Response(null, {
    status: 204,
    headers: COMMON_CORS_HEADERS,
  });
};
