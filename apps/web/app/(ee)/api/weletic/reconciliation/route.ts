import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { reconcileWeleticShopifyOrders } from "@/lib/weletic/commerce/reconcile-shopify";
import { NextResponse } from "next/server";

export const GET = withWorkspace(async ({ workspace }) => {
  const issues = await prisma.weleticReconciliationIssue.findMany({
    where: { store: { projectId: workspace.id } },
    orderBy: [{ status: "asc" }, { detectedAt: "desc" }],
    take: 250,
  });
  return NextResponse.json(issues);
});

export const POST = withWorkspace(
  async ({ workspace }) => {
    const result = await reconcileWeleticShopifyOrders({
      workspaceId: workspace.id,
    });
    return NextResponse.json(result);
  },
  { requiredRoles: ["owner"] },
);
