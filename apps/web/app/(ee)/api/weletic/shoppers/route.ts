import { withWorkspace } from "@/lib/auth";
import { listMerchantShoppers } from "@/lib/weletic/shoppers/directory";
import { shopperHttpError, shopperJson } from "@/lib/weletic/shoppers/http";

export const GET = withWorkspace(
  async ({ workspace, searchParams }) => {
    try {
      return shopperJson(
        await listMerchantShoppers(workspace.id, searchParams),
      );
    } catch (error) {
      return shopperHttpError(error);
    }
  },
  { requiredPermissions: ["loyalty.read"] },
);
