"use server";

import { trackRewardActivityLog } from "@/lib/api/activity-log/track-reward-activity-log";
import { recordAuditLog } from "@/lib/api/audit-logs/record-audit-log";
import { createId } from "@/lib/api/create-id";
import { getGroupOrThrow } from "@/lib/api/groups/get-group-or-throw";
import { metadataCache } from "@/lib/api/metadata-cache";
import { getRewardOrThrow } from "@/lib/api/partners/get-reward-or-throw";
import { serializeReward } from "@/lib/api/partners/serialize-reward";
import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { queueRewardProcessing } from "@/lib/api/rewards/queue-reward-processing";
import { prisma } from "@/lib/prisma";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import { getWeleticShopifyInstallation } from "@/lib/weletic/shopify/get-installation";
import { ensureShopifySegmentWebhooksRegistered } from "@/lib/weletic/shopify/provision-webhooks";
import {
  getShopifyRewardConfigCore,
  ShopifyEcommerceRewardConfigSchema,
  upsertShopifyEcommerceRewardSchema,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";
import { formatRewardDescription } from "@/ui/partners/format-reward-description";
import { Prisma } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { authActionClient } from "../safe-action";
import { throwIfNoPermission } from "../throw-if-no-permission";

export const upsertShopifyEcommerceRewardAction = authActionClient
  .inputSchema(upsertShopifyEcommerceRewardSchema)
  .action(async ({ parsedInput, ctx }) => {
    const { workspace, user } = ctx;
    const { groupId, rewardId, config, activityDescription } = parsedInput;

    throwIfNoPermission({
      role: workspace.role,
      requiredRoles: ["owner", "member"],
    });

    const programId = getDefaultProgramIdOrThrow(workspace);
    const program = await prisma.program.findUniqueOrThrow({
      where: { id: programId },
      select: { accountingCurrency: true },
    });

    const group = await getGroupOrThrow({
      groupId,
      programId,
      includeExpandedFields: true,
    });

    const existingReward = rewardId
      ? await getRewardOrThrow({ rewardId, programId })
      : group.saleReward;

    if (rewardId && group.saleRewardId !== rewardId) {
      throw new Error("Reward is not the sale reward assigned to this group.");
    }
    if (!rewardId && group.saleReward) {
      throw new Error(
        "This group already has a sale reward. Edit or explicitly replace it.",
      );
    }
    if (existingReward && existingReward.event !== "sale") {
      throw new Error("Only sale rewards can use Shopify eCommerce config.");
    }
    if (
      rewardId &&
      existingReward &&
      !ShopifyEcommerceRewardConfigSchema.safeParse(existingReward.config)
        .success
    ) {
      throw new Error(
        "Remove the standard sale reward before creating a Shopify eCommerce reward.",
      );
    }

    const configCore = getShopifyRewardConfigCore(config);
    if (configCore.customerSegmentMode === "shopify_segment") {
      const installation = await getWeleticShopifyInstallation(workspace.id);
      const provisioned = await ensureShopifySegmentWebhooksRegistered({
        shopDomain: installation.shopDomain,
        accessToken: installation.accessToken,
        segmentId: configCore.shopifySegment!.id,
      });
      if (!provisioned.success) {
        throw new Error(
          `Unable to subscribe to Shopify segment changes: ${provisioned.failed
            .map(({ error }) => error)
            .join("; ")}`,
        );
      }
    }

    const baseRate = configCore.baseReturningRate;
    const isFlat = configCore.baseRateType === "flat";
    const baseAmountInCents = isFlat
      ? Number(
          decimalToMinorUnits(String(baseRate), program.accountingCurrency),
        )
      : null;
    const effectiveAt = new Date();
    const existingConfig = ShopifyEcommerceRewardConfigSchema.safeParse(
      existingReward?.config,
    );
    const previousHistory = existingConfig.success
      ? existingConfig.data.history ?? [
          {
            effectiveAt: existingReward!.updatedAt.toISOString(),
            config: getShopifyRewardConfigCore(existingConfig.data),
          },
        ]
      : [];
    const configWithHistory = {
      ...configCore,
      history: [
        ...previousHistory,
        { effectiveAt: effectiveAt.toISOString(), config: configCore },
      ],
    };
    // Dub's maxDuration is measured in months, so capped renewal counts remain
    // authoritative in the Shopify JSON config instead of being misrepresented.
    const maxDuration =
      configCore.subscriptionRules.mode === "first_sale" ? 0 : null;

    const { reward, isUpdate } = await prisma.$transaction(async (tx) => {
      if (existingReward) {
        const updatedReward = await tx.reward.update({
          where: { id: existingReward.id },
          data: {
            type: isFlat ? "flat" : "percentage",
            amountInPercentage: !isFlat ? new Prisma.Decimal(baseRate) : null,
            amountInCents: baseAmountInCents,
            maxDuration,
            config: configWithHistory as Prisma.InputJsonValue,
          },
        });

        // Ensure partner group is linked
        if (group.saleRewardId !== updatedReward.id) {
          await tx.partnerGroup.update({
            where: { id: group.id },
            data: { saleRewardId: updatedReward.id },
          });
        }

        return { reward: updatedReward, isUpdate: true };
      } else {
        const newRewardId = createId({ prefix: "rw_" });
        const createdReward = await tx.reward.create({
          data: {
            id: newRewardId,
            programId,
            event: "sale",
            type: isFlat ? "flat" : "percentage",
            amountInPercentage: !isFlat ? new Prisma.Decimal(baseRate) : null,
            amountInCents: baseAmountInCents,
            maxDuration,
            config: configWithHistory as Prisma.InputJsonValue,
          },
        });

        await tx.partnerGroup.update({
          where: { id: group.id },
          data: { saleRewardId: createdReward.id },
        });

        return { reward: createdReward, isUpdate: false };
      }
    });

    await queueRewardProcessing({
      event: isUpdate ? "reward-updated" : "reward-created",
      groupId: group.id,
      occurredAt: new Date().toISOString(),
      rewardSnapshot: {
        id: reward.id,
        event: reward.event,
        description: formatRewardDescription(serializeReward(reward), {
          includeEarnPrefix: false,
        }),
        activityDescription,
      },
    });

    waitUntil(
      Promise.allSettled([
        recordAuditLog({
          workspaceId: workspace.id,
          programId,
          action: isUpdate ? "reward.updated" : "reward.created",
          description: `Shopify eCommerce Reward ${reward.id} ${
            isUpdate ? "updated" : "created"
          }`,
          actor: user,
          targets: [
            {
              type: "reward",
              id: reward.id,
              metadata: serializeReward(reward),
            },
          ],
        }),

        trackRewardActivityLog({
          workspaceId: workspace.id,
          programId,
          userId: user.id,
          resourceId: reward.id,
          parentResourceType: "group",
          parentResourceId: group.id,
          old: existingReward ?? null,
          new: reward,
          description: activityDescription,
        }),
      ]),
    );

    await Promise.all([
      metadataCache.invalidateReward(programId, reward.id),
      metadataCache.invalidateGroup(programId, group.id, group.slug),
      metadataCache.invalidateProgram(programId, workspace.id),
    ]);

    return {
      success: true,
      reward: serializeReward(reward),
    };
  });
