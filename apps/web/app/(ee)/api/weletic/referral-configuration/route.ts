import { withWorkspace } from "@/lib/auth";
import { LoyaltyMaintenanceBlockedError } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { referralConfigurationRequestSchema } from "@/lib/weletic/loyalty/referral-configuration-contract";
import { RewardDefinitionConflictError } from "@/lib/weletic/loyalty/rewards";
import { manageWorkspaceReferralConfiguration } from "@/lib/weletic/loyalty/workspace-referral-configuration";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { merchantSettingsJson } from "@/lib/weletic/merchant-settings/http";
import { readWeleticShopifyRequestBodyBytes } from "@/lib/weletic/shopify/service-auth";
import { ShopifyStoreOperationalWritesBlockedError } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";

function failure(code: string, status: number) {
  return merchantSettingsJson({ error: { code } }, status);
}
function serviceError(error: unknown) {
  if (error instanceof MerchantSettingsError)
    return failure(
      error.code,
      { forbidden: 403, not_found: 404, conflict: 409 }[error.code],
    );
  if (error instanceof RewardDefinitionConflictError)
    return failure("conflict", 409);
  if (
    error instanceof LoyaltyMaintenanceBlockedError ||
    error instanceof ShopifyStoreOperationalWritesBlockedError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034")
  )
    return failure("conflict", 409);
  // Request parsing has already completed. Internal schema/database details
  // must not be exposed or misclassified as merchant input errors.
  return failure("unavailable", 503);
}
export const GET = withWorkspace(
  async ({ workspace, permissions }) => {
    try {
      return merchantSettingsJson(
        await manageWorkspaceReferralConfiguration(
          {
            workspaceId: workspace.id,
            role: workspace.users[0]?.role ?? "",
            permissions,
          },
          { operation: "read" },
        ),
      );
    } catch (error) {
      return serviceError(error);
    }
  },
  { requiredPermissions: ["loyalty.read"] },
);

export const POST = withWorkspace(
  async ({ workspace, permissions, req }) => {
    let value: unknown;
    try {
      const bytes = await readWeleticShopifyRequestBodyBytes(req, {
        maxBytes: 64 * 1024,
      });
      if (bytes === null) return failure("bad_request", 400);
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return failure("bad_request", 400);
    }
    const parsed = referralConfigurationRequestSchema.safeParse(value);
    if (!parsed.success || parsed.data.operation === "read")
      return failure("bad_request", 400);
    try {
      return merchantSettingsJson(
        await manageWorkspaceReferralConfiguration(
          {
            workspaceId: workspace.id,
            role: workspace.users[0]?.role ?? "",
            permissions,
          },
          parsed.data,
        ),
      );
    } catch (error) {
      return serviceError(error);
    }
  },
  { requiredPermissions: ["loyalty.write"] },
);
