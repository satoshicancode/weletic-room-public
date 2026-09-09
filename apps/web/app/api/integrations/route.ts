import { withWorkspace } from "@/lib/auth";
import { readWorkspaceIntegrationInventory } from "@/lib/weletic/shopify/integration-inventory";
import { installedIntegrationSchema } from "@/lib/zod/schemas/integration";
import { NextResponse } from "next/server";

// Configuration inventory, not installation health or loyalty approval.
export const GET = withWorkspace(
  async ({ workspace }) => {
    const integrations = await readWorkspaceIntegrationInventory(workspace.id);

    return NextResponse.json(
      integrations.map((integration) =>
        installedIntegrationSchema.parse(integration),
      ),
      { headers: { "Cache-Control": "private, no-store" } },
    );
  },
  {
    requiredPermissions: ["workspaces.read"],
  },
);
