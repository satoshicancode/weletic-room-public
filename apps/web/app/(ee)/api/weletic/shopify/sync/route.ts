import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { withWorkspace } from "@/lib/auth";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import { NextResponse } from "next/server";

// POST /api/weletic/shopify/sync - run an authenticated Shopify catalog sync.
export const POST = withWorkspace(
  async ({ workspace }) => {
    getDefaultProgramIdOrThrow(workspace);
    const result = await syncWeleticShopifyCatalog({
      workspaceId: workspace.id,
    });
    return NextResponse.json(result, { status: 202 });
  },
  { requiredRoles: ["owner"] },
);
