import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  InvalidLoyaltyBrandingError,
  normalizeStoredLoyaltyBranding,
  parseLoyaltyBrandingInput,
} from "@/lib/weletic/loyalty/branding";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { Prisma } from "@prisma/client";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readBrandingRequestBody(body: unknown) {
  if (!isRecord(body)) {
    throw new DubApiError({
      code: "bad_request",
      message: "Request body must be an object containing 'branding'.",
    });
  }
  const unknownKeys = Object.keys(body).filter((key) => key !== "branding");
  if (unknownKeys.length > 0) {
    throw new DubApiError({
      code: "bad_request",
      message: `Unsupported request field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}.`,
    });
  }
  if (!Object.hasOwn(body, "branding")) {
    throw new DubApiError({
      code: "bad_request",
      message: "'branding' object is required.",
    });
  }
  return body.branding;
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
      select: {
        id: true,
        name: true,
        branding: true,
      },
    });

    return loyaltySuccessResponse(
      {
        branding: normalizeStoredLoyaltyBranding(
          program?.branding,
          program?.name,
        ),
        programId: program?.id ?? null,
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

    const brandingInput = readBrandingRequestBody(await parseRequestBody(req));

    const updatedProgram = await withActiveStoreLoyaltyMutation({
      storeId: store.id,
      action: "loyalty_branding_update",
      operation: async (tx) => {
        const program = await tx.weleticLoyaltyProgram.upsert({
          where: { storeId: store.id },
          create: {
            id: createWeleticId("wprog_"),
            storeId: store.id,
            name: "Customer Loyalty Program",
            status: "draft",
          },
          update: {},
        });
        let branding;
        try {
          branding = parseLoyaltyBrandingInput(brandingInput, {
            current: normalizeStoredLoyaltyBranding(
              program.branding,
              program.name,
            ),
          });
        } catch (error) {
          if (error instanceof InvalidLoyaltyBrandingError) {
            throw new DubApiError({
              code: "bad_request",
              message: error.message,
            });
          }
          throw error;
        }
        const updated = await tx.weleticLoyaltyProgram.update({
          where: { storeId: store.id },
          data: { branding: branding as unknown as Prisma.InputJsonValue },
        });
        await publishLoyaltyEarnPolicyRevision({
          tx,
          storeId: store.id,
          programId: program.id,
          reason: "loyalty_program_initialized_from_branding",
        });
        return updated;
      },
    });

    return loyaltySuccessResponse(
      {
        success: true,
        branding: normalizeStoredLoyaltyBranding(
          updatedProgram.branding,
          updatedProgram.name,
        ),
      },
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
