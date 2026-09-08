import { withWorkspace } from "@/lib/auth";
import { LoyaltyMaintenanceBlockedError } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { LoyaltySettingsWriteError } from "@/lib/weletic/loyalty/settings-writer";
import { manageWorkspaceLoyaltyConfiguration } from "@/lib/weletic/loyalty/workspace-configuration";
import {
  merchantSettingsHttpError,
  merchantSettingsJson,
} from "@/lib/weletic/merchant-settings/http";
import { readWeleticShopifyRequestBodyBytes } from "@/lib/weletic/shopify/service-auth";
import { Prisma } from "@prisma/client";

function configurationError(error: unknown) {
  if (error instanceof LoyaltySettingsWriteError)
    return merchantSettingsJson(
      { error: { code: error.code, message: error.message } },
      error.code === "conflict" ? 409 : 400,
    );
  if (
    error instanceof LoyaltyMaintenanceBlockedError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2034")
  )
    return merchantSettingsJson(
      {
        error: {
          code: "conflict",
          message:
            "Configuration changed or is unavailable. Reload before saving",
        },
      },
      409,
    );
  return merchantSettingsHttpError(error);
}

export const GET = withWorkspace(
  async ({ workspace, permissions }) => {
    try {
      return merchantSettingsJson(
        await manageWorkspaceLoyaltyConfiguration({
          workspaceId: workspace.id,
          role: workspace.users[0]?.role ?? "",
          permissions,
        }),
      );
    } catch (error) {
      return configurationError(error);
    }
  },
  { requiredPermissions: ["loyalty.read"] },
);

export const PATCH = withWorkspace(
  async ({ workspace, permissions, req }) => {
    try {
      const bytes = await readWeleticShopifyRequestBodyBytes(req, {
        maxBytes: 16 * 1024,
      });
      if (bytes === null) throw new SyntaxError("Invalid configuration body");
      return merchantSettingsJson(
        await manageWorkspaceLoyaltyConfiguration(
          {
            workspaceId: workspace.id,
            role: workspace.users[0]?.role ?? "",
            permissions,
          },
          JSON.parse(new TextDecoder().decode(bytes)),
        ),
      );
    } catch (error) {
      return configurationError(error);
    }
  },
  { requiredPermissions: ["loyalty.write"] },
);
