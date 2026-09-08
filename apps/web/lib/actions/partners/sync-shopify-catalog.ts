"use server";

import { authActionClient } from "@/lib/actions/safe-action";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import * as z from "zod/v4";

const schema = z.object({
  workspaceId: z.string().min(1),
});

export const syncShopifyCatalogAction = authActionClient
  .schema(schema)
  .action(async ({ parsedInput: { workspaceId } }) => {
    try {
      const result = await syncWeleticShopifyCatalog({ workspaceId });
      return {
        success: true,
        stats: result.stats,
        runId: result.runId,
      };
    } catch (error: any) {
      throw new Error(
        error.message || "Failed to synchronize Shopify catalog.",
      );
    }
  });
