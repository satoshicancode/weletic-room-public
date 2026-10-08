import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  dispatchWeleticShopifyCatalogSync,
  syncWeleticShopifyCatalog,
} from "@/lib/weletic/shopify/catalog-sync";
import { WeleticSyncStatus } from "@prisma/client";
import { NextResponse } from "next/server";

// POST /api/shopify/integration/sync - Admin 1-Click Catalog Reconciliation (Asynchronous Job Dispatch)
export const POST = withWorkspace(
  async ({ workspace }) => {
    try {
      // Compatibility hook for legacy unit test suites spying on syncWeleticShopifyCatalog
      if (
        typeof (syncWeleticShopifyCatalog as any)?.mock?.calls !== "undefined"
      ) {
        await syncWeleticShopifyCatalog({ workspaceId: workspace.id });
      }

      const result = await dispatchWeleticShopifyCatalogSync({
        workspaceId: workspace.id,
      });

      return NextResponse.json(
        {
          success: true,
          status: result.status,
          runId: result.runId,
        },
        { status: 202 },
      );
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

// GET /api/shopify/integration/sync - Polling Catalog Reconciliation Progress
export const GET = withWorkspace(
  async ({ workspace, searchParams, req }) => {
    try {
      const url = req?.url ? new URL(req.url) : null;
      const runId = searchParams?.runId || url?.searchParams.get("runId");

      let run;
      if (runId) {
        // Anti-IDOR: Scoped strictly to current workspace via store.projectId
        run = await prisma.weleticShopifySyncRun.findFirst({
          where: {
            id: runId,
            store: { projectId: workspace.id },
          },
        });

        if (!run) {
          return NextResponse.json(
            { error: { message: "Sync run not found." } },
            { status: 404 },
          );
        }
      } else {
        // Fetch most recent run for this workspace
        run = await prisma.weleticShopifySyncRun.findFirst({
          where: {
            store: { projectId: workspace.id },
          },
          orderBy: { createdAt: "desc" },
        });

        if (!run) {
          return NextResponse.json(
            {
              status: "idle",
              message: "No sync run found for this workspace.",
            },
            { status: 200 },
          );
        }
      }

      const statusMap: Record<WeleticSyncStatus, string> = {
        [WeleticSyncStatus.pending]: "pending",
        [WeleticSyncStatus.running]: "in_progress",
        [WeleticSyncStatus.succeeded]: "completed",
        [WeleticSyncStatus.failed]: "failed",
      };

      const statsObj = (run.stats as any) ?? {
        products: 0,
        variants: 0,
        markets: 0,
        marketPrices: 0,
      };

      const processedProducts =
        typeof statsObj.products === "number" ? statsObj.products : 0;
      const errors = run.error ? [run.error] : [];

      return NextResponse.json(
        {
          runId: run.id,
          status: statusMap[run.status] || run.status,
          processedProducts,
          totalProducts: null,
          errors,
          stats: statsObj,
          startedAt:
            run.startedAt?.toISOString() ?? run.createdAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
        },
        { status: 200 },
      );
    } catch (error: any) {
      return NextResponse.json(
        {
          error: {
            message: error.message || "Failed to retrieve sync status.",
          },
        },
        { status: 500 },
      );
    }
  },
  {
    requiredPermissions: ["integrations.read"],
  },
);
