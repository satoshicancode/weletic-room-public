import { withWorkspace } from "@/lib/auth";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import { NextResponse } from "next/server";

// POST /api/shopify/integration/sync - Admin 1-Click Catalog Reconciliation
export const POST = withWorkspace(
  async ({ workspace }) => {
    try {
      const result = await syncWeleticShopifyCatalog({
        workspaceId: workspace.id,
      });
      return NextResponse.json({
        success: true,
        stats: result.stats,
        runId: result.runId,
      });
    } catch (error: any) {
      const isLockError =
        error.message?.includes("already running") ||
        error.message?.includes("Could not acquire lock");
      return NextResponse.json(
        {
          error: {
            message: error.message || "Failed to synchronize Shopify catalog.",
          },
        },
        { status: isLockError ? 409 : 500 },
      );
    }
  },
  {
    requiredPermissions: ["integrations.write"],
  },
);
