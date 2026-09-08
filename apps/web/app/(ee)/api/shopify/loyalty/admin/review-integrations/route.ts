import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { JUDGEME_PROVIDER } from "@/lib/weletic/loyalty/review-providers/judgeme";
import { reviewJson } from "@/lib/weletic/reviews/http";

async function resolveStore(projectId: string) {
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { projectId },
    select: { id: true, shopDomain: true },
  });
  if (!store) {
    throw new DubApiError({
      code: "not_found",
      message: "Shopify store not connected to this workspace.",
    });
  }
  return store;
}

export const GET = withWorkspace(
  async ({ workspace }) => {
    const store = await resolveStore(workspace.id);
    const integration = await prisma.weleticLoyaltyReviewIntegration.findUnique(
      {
        where: {
          storeId_provider: {
            storeId: store.id,
            provider: JUDGEME_PROVIDER,
          },
        },
        select: {
          provider: true,
          enabled: true,
          lastVerifiedAt: true,
        },
      },
    );
    return loyaltySuccessResponse(
      {
        provider: JUDGEME_PROVIDER,
        connected: Boolean(integration?.enabled),
        lastVerifiedAt: integration?.lastVerifiedAt ?? null,
        legacy: true,
        newConnectionsEnabled: false,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  { requiredPermissions: ["loyalty.read"] },
);

export const POST = withWorkspace(
  async () =>
    reviewJson(
      {
        error: {
          code: "gone",
          message:
            "New Judge.me connections are disabled. Configure native reviews in Reviews settings.",
        },
      },
      410,
    ),
  { requiredPermissions: ["loyalty.write"] },
);
