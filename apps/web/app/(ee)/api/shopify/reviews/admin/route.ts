import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { listAdminReviews } from "@/lib/weletic/reviews/admin";
import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { reviewHttpError, reviewJson } from "@/lib/weletic/reviews/http";
import { reviewModuleToggleSchema } from "@/lib/weletic/reviews/module-contract";
import {
  moderateNativeReview,
  updateReviewSettings,
} from "@/lib/weletic/reviews/service";
import { readWeleticShopifyRequestBodyBytes } from "@/lib/weletic/shopify/service-auth";
import { z } from "zod";

async function resolveStore(projectId: string) {
  const store = await prisma.weleticShopifyStore.findFirst({
    where: { projectId, complianceState: "active" },
    select: { id: true, shopDomain: true },
  });
  if (!store)
    throw new ReviewError(
      "not_found",
      "Connect an active Shopify store to manage reviews",
    );
  return store;
}

export const GET = withWorkspace(
  async ({ workspace, searchParams }) => {
    try {
      const store = await resolveStore(workspace.id);
      if (searchParams.mediaId) {
        const media = await prisma.weleticReviewMedia.findFirst({
          where: {
            id: searchParams.mediaId,
            storeId: store.id,
            status: "uploaded",
            reviewId: { not: null },
          },
        });
        if (!media) throw new ReviewError("not_found", "Photo unavailable");
        return reviewJson({
          url: await storage.getSignedDownloadUrl({
            key: media.objectKey,
            bucket: "private",
            expiresIn: 60,
          }),
        });
      }
      const [settings, list] = await Promise.all([
        prisma.weleticReviewSettings.findUnique({
          where: { storeId: store.id },
        }),
        listAdminReviews(store.id, searchParams),
      ]);
      return reviewJson({
        ...list,
        settings: settings ?? {
          enabled: false,
          sendAfterDays: 7,
          expiresAfterDays: 30,
          autoPublish: false,
          photoUploadsEnabled: true,
          requestEmailEnabled: false,
        },
        shopDomain: store.shopDomain,
        canConfigure: workspace.users[0]?.role === "owner",
      });
    } catch (error) {
      return reviewHttpError(error);
    }
  },
  { requiredPermissions: ["loyalty.read"] },
);

export const POST = withWorkspace(
  async ({ workspace, req, session }) => {
    try {
      const store = await resolveStore(workspace.id);
      const bytes = await readWeleticShopifyRequestBodyBytes(req, {
        maxBytes: 64 * 1024,
      });
      if (!bytes) throw new ReviewError("bad_request", "Request too large");
      const data = z
        .discriminatedUnion("action", [
          reviewModuleToggleSchema.extend({ action: z.literal("module") }),
          z
            .object({ action: z.literal("settings"), settings: z.unknown() })
            .strict(),
          z
            .object({
              action: z.literal("moderate"),
              reviewId: z.string().max(191),
              patch: z.unknown(),
            })
            .strict(),
        ])
        .parse(JSON.parse(new TextDecoder().decode(bytes)));
      if (data.action === "settings" || data.action === "module") {
        if (workspace.users[0]?.role !== "owner")
          return reviewJson(
            {
              error: {
                code: "forbidden",
                message: "Only workspace owners can configure reviews",
              },
            },
            403,
          );
        return reviewJson(
          await updateReviewSettings(
            store.id,
            data.action === "settings" ? data.settings : null,
            data.action === "module"
              ? {
                  enabled: data.enabled,
                  expectedUpdatedAt: data.expectedUpdatedAt,
                  expectedInstallationGeneration:
                    data.expectedInstallationGeneration,
                }
              : undefined,
          ),
        );
      }
      return reviewJson(
        await moderateNativeReview(
          store.id,
          data.reviewId,
          session.user.id,
          data.patch,
        ),
      );
    } catch (error) {
      return reviewHttpError(error);
    }
  },
  { requiredPermissions: ["loyalty.write"] },
);
