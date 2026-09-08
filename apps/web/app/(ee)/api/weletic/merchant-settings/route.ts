import { withWorkspace } from "@/lib/auth";
import {
  merchantSettingsHttpError,
  merchantSettingsJson,
} from "@/lib/weletic/merchant-settings/http";
import {
  readMerchantSettings,
  updateMerchantSettings,
} from "@/lib/weletic/merchant-settings/service";
import { readWeleticShopifyRequestBodyBytes } from "@/lib/weletic/shopify/service-auth";

export const GET = withWorkspace(
  async ({ workspace }) => {
    try {
      return merchantSettingsJson(await readMerchantSettings(workspace.id));
    } catch (error) {
      return merchantSettingsHttpError(error);
    }
  },
  { requiredPermissions: ["loyalty.read"] },
);

export const PATCH = withWorkspace(
  async ({ workspace, req }) => {
    try {
      const body = await readWeleticShopifyRequestBodyBytes(req, {
        maxBytes: 16 * 1024,
      });
      if (body === null) throw new SyntaxError("Invalid settings body");
      return merchantSettingsJson(
        await updateMerchantSettings(
          workspace.id,
          JSON.parse(new TextDecoder().decode(body)),
          workspace.users[0]?.role ?? "",
        ),
      );
    } catch (error) {
      return merchantSettingsHttpError(error);
    }
  },
  { requiredPermissions: ["loyalty.write"] },
);
