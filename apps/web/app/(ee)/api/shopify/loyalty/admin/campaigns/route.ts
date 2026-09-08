import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  BonusCampaignPolicyError,
  normalizeEligibleCollectionIds,
  normalizeEligibleSkus,
  normalizeEligibleTierIds,
  parseBonusCampaignSchedule,
} from "@/lib/weletic/loyalty/bonus-campaign-policy";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { Prisma } from "@prisma/client";

function readCampaignId(value: unknown) {
  if (typeof value !== "string" || !/^wcamp_[A-Za-z0-9_-]{3,64}$/.test(value)) {
    throw new DubApiError({
      code: "bad_request",
      message: "Campaign ID is invalid.",
    });
  }
  return value;
}

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
      include: {
        bonusCampaigns: {
          where: { deletedAt: null },
          orderBy: { startAt: "desc" },
        },
      },
    });

    if (!program) {
      return loyaltySuccessResponse(
        { campaigns: [] },
        { headers: COMMON_CORS_HEADERS },
      );
    }

    return loyaltySuccessResponse(
      {
        campaigns: program.bonusCampaigns,
        programId: program.id,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

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

    const storeId = store.id;
    const body = await parseRequestBody(req);
    const {
      campaignId,
      name,
      description = null,
      multiplier = 2.0,
      startAt: requestedStartAt,
      startsAt,
      endAt: requestedEndAt,
      endsAt,
      isActive = true,
      eligibleTierIds: requestedEligibleTierIds,
      targetTiers,
      eligibleSkus: requestedEligibleSkus,
      eligibleCollectionIds: requestedEligibleCollectionIds,
    } = body;
    const startAt = requestedStartAt ?? startsAt;
    const endAt = requestedEndAt ?? endsAt;
    if (typeof name !== "string" || !name.trim() || !startAt || !endAt) {
      throw new DubApiError({
        code: "bad_request",
        message: "Fields 'name', 'startAt', and 'endAt' are required.",
      });
    }
    const normalizedName = name.trim();
    if (normalizedName.length > 120) {
      throw new DubApiError({
        code: "bad_request",
        message: "Campaign name must be 120 characters or fewer.",
      });
    }
    if (
      description !== null &&
      (typeof description !== "string" || description.length > 500)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "Campaign description must be 500 characters or fewer.",
      });
    }
    if (typeof isActive !== "boolean") {
      throw new DubApiError({
        code: "bad_request",
        message: "Campaign 'isActive' must be a boolean.",
      });
    }
    const normalizedCampaignId =
      campaignId === undefined || campaignId === null
        ? null
        : readCampaignId(campaignId);
    const normalizedDescription =
      typeof description === "string" ? description.trim() || null : null;
    const hasRequestedEligibleSkus = Object.prototype.hasOwnProperty.call(
      body,
      "eligibleSkus",
    );
    const hasRequestedEligibleCollectionIds =
      Object.prototype.hasOwnProperty.call(body, "eligibleCollectionIds");
    let eligibleTierIds: string[];
    let eligibleSkus: string[] | undefined;
    let eligibleCollectionIds: string[] | undefined;
    let schedule: ReturnType<typeof parseBonusCampaignSchedule>;
    try {
      eligibleTierIds = normalizeEligibleTierIds(
        requestedEligibleTierIds ?? targetTiers,
      );
      eligibleSkus = hasRequestedEligibleSkus
        ? normalizeEligibleSkus(requestedEligibleSkus)
        : undefined;
      eligibleCollectionIds = hasRequestedEligibleCollectionIds
        ? normalizeEligibleCollectionIds(requestedEligibleCollectionIds)
        : undefined;
      schedule = parseBonusCampaignSchedule({
        startAt,
        endAt,
        multiplier,
      });
    } catch (error) {
      if (error instanceof BonusCampaignPolicyError) {
        throw new DubApiError({ code: "bad_request", message: error.message });
      }
      throw error;
    }

    if (
      !normalizedCampaignId &&
      schedule.startAt.getTime() < Date.now() - 5 * 60 * 1000
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "A new bonus campaign cannot start in the past.",
      });
    }

    const campaign = await withActiveStoreLoyaltyMutation({
      storeId,
      action: "loyalty_campaign_write",
      operation: async (tx) => {
        const program = await tx.weleticLoyaltyProgram.upsert({
          where: { storeId },
          create: {
            id: createWeleticId("wprog_"),
            storeId,
            name: "Customer Loyalty Program",
            status: "draft",
          },
          update: {},
        });
        if (eligibleTierIds.length > 0) {
          const validTierCount = await tx.weleticLoyaltyTier.count({
            where: {
              programId: program.id,
              id: { in: eligibleTierIds },
              deletedAt: null,
            },
          });
          if (validTierCount !== eligibleTierIds.length) {
            throw new DubApiError({
              code: "bad_request",
              message:
                "One or more selected VIP tiers do not belong to this loyalty program.",
            });
          }
        }
        const now = new Date();
        const existing = normalizedCampaignId
          ? await tx.weleticLoyaltyBonusCampaign.findFirst({
              where: {
                id: normalizedCampaignId,
                programId: program.id,
                deletedAt: null,
              },
            })
          : null;
        if (normalizedCampaignId && !existing) {
          throw new DubApiError({
            code: "not_found",
            message: `Campaign '${normalizedCampaignId}' not found for this store.`,
          });
        }
        if (existing && existing.startAt <= now) {
          throw new DubApiError({
            code: "conflict",
            message:
              "Only a campaign that has not started can be edited. Historical campaign evidence is retained.",
          });
        }
        if (existing && schedule.startAt <= now) {
          throw new DubApiError({
            code: "bad_request",
            message: "A scheduled campaign cannot be moved into the past.",
          });
        }
        if (isActive) {
          const overlap = await tx.weleticLoyaltyBonusCampaign.findFirst({
            where: {
              programId: program.id,
              isActive: true,
              deletedAt: null,
              ...(normalizedCampaignId
                ? { id: { not: normalizedCampaignId } }
                : {}),
              startAt: { lt: schedule.endAt },
              endAt: { gt: schedule.startAt },
            },
            select: { id: true, name: true },
          });
          if (overlap) {
            throw new DubApiError({
              code: "conflict",
              message: `Bonus campaign overlaps '${overlap.name}'. Only one campaign can run at a time.`,
            });
          }
        }
        let savedCampaign;
        if (existing) {
          savedCampaign = await tx.weleticLoyaltyBonusCampaign.update({
            where: { id: existing.id },
            data: {
              name: normalizedName,
              description: normalizedDescription,
              multiplier: new Prisma.Decimal(schedule.multiplier),
              startAt: schedule.startAt,
              endAt: schedule.endAt,
              isActive,
              eligibleTierIds: eligibleTierIds as Prisma.InputJsonValue,
              ...(eligibleSkus === undefined
                ? {}
                : { eligibleSkus: eligibleSkus as Prisma.InputJsonValue }),
              ...(eligibleCollectionIds === undefined
                ? {}
                : {
                    eligibleCollectionIds:
                      eligibleCollectionIds as Prisma.InputJsonValue,
                  }),
            },
          });
        } else {
          savedCampaign = await tx.weleticLoyaltyBonusCampaign.create({
            data: {
              id: createWeleticId("wcamp_"),
              programId: program.id,
              name: normalizedName,
              description: normalizedDescription,
              multiplier: new Prisma.Decimal(schedule.multiplier),
              startAt: schedule.startAt,
              endAt: schedule.endAt,
              isActive,
              eligibleTierIds: eligibleTierIds as Prisma.InputJsonValue,
              eligibleSkus: (eligibleSkus ?? []) as Prisma.InputJsonValue,
              eligibleCollectionIds: (eligibleCollectionIds ??
                []) as Prisma.InputJsonValue,
            },
          });
        }
        await publishLoyaltyEarnPolicyRevision({
          tx,
          storeId,
          programId: program.id,
          reason: existing
            ? "bonus_campaign_updated"
            : "bonus_campaign_created",
        });
        return savedCampaign;
      },
    });

    return loyaltySuccessResponse(
      {
        success: true,
        campaign,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

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

    const requestedId = searchParams.campaignId || searchParams.id;

    if (!requestedId) {
      throw new DubApiError({
        code: "bad_request",
        message: "Missing required parameter: 'campaignId' or 'id'.",
      });
    }
    const campaignId = readCampaignId(requestedId);

    await withActiveStoreLoyaltyMutation({
      storeId: store.id,
      action: "loyalty_campaign_delete",
      operation: async (tx) => {
        const program = await tx.weleticLoyaltyProgram.findUnique({
          where: { storeId: store.id },
          select: { id: true },
        });
        if (!program) {
          throw new DubApiError({
            code: "not_found",
            message: `Campaign '${campaignId}' not found for this store.`,
          });
        }
        const existing = await tx.weleticLoyaltyBonusCampaign.findFirst({
          where: {
            id: campaignId,
            programId: program.id,
            deletedAt: null,
          },
        });
        if (!existing) {
          throw new DubApiError({
            code: "not_found",
            message: `Campaign '${campaignId}' not found for this store.`,
          });
        }
        if (existing.startAt <= new Date()) {
          throw new DubApiError({
            code: "conflict",
            message:
              "Only a campaign that has not started can be deleted. Historical campaign evidence is retained.",
          });
        }
        const retired = await tx.weleticLoyaltyBonusCampaign.update({
          where: { id: campaignId },
          data: { deletedAt: new Date(), isActive: false },
        });
        await publishLoyaltyEarnPolicyRevision({
          tx,
          storeId: store.id,
          programId: program.id,
          reason: "bonus_campaign_retired",
        });
        return retired;
      },
    });

    return loyaltySuccessResponse(
      { success: true, deletedCampaignId: campaignId },
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
