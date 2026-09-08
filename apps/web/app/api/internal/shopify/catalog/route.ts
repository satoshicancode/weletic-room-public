import { prisma } from "@/lib/prisma";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";

const shopSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(255)
  .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

async function getWorkspace(shop: string) {
  const resolution = await resolveShopifyStoreByDomain(shop);
  if (!resolution) return null;

  return prisma.project.findUnique({
    where: { id: resolution.workspaceId },
    select: {
      id: true,
      defaultProgramId: true,
      weleticShopifyStore: {
        select: {
          syncStatus: true,
          lastFullSyncAt: true,
          markets: { select: { id: true } },
          _count: { select: { products: true } },
        },
      },
    },
  });
}

function parseShop(request: Request) {
  return shopSchema.safeParse(new URL(request.url).searchParams.get("shop"));
}

export async function GET(request: Request) {
  if (!verifyWeleticShopifyRequest({ request, body: "" })) {
    return unauthorized();
  }

  const parsedShop = parseShop(request);
  if (!parsedShop.success) {
    return NextResponse.json({ error: "Invalid shop" }, { status: 400 });
  }

  const workspace = await getWorkspace(parsedShop.data);
  const store = workspace?.weleticShopifyStore;
  return NextResponse.json({
    isConnected: Boolean(workspace),
    hasStore: Boolean(store),
    totalProducts: store?._count.products ?? 0,
    totalMarkets: store?.markets.length ?? 0,
    lastSyncAt: store?.lastFullSyncAt ?? null,
    syncStatus: store?.syncStatus ?? "pending",
  });
}

export async function POST(request: Request) {
  const rawBody = await readWeleticShopifyRequestBody(request);
  if (rawBody === null) {
    return NextResponse.json(
      { error: "Request body is too large" },
      { status: 413 },
    );
  }
  if (!verifyWeleticShopifyRequest({ request, body: rawBody })) {
    return unauthorized();
  }

  const parsedShop = parseShop(request);
  if (!parsedShop.success || (rawBody && rawBody !== "{}")) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const workspace = await getWorkspace(parsedShop.data);
  if (!workspace?.defaultProgramId) {
    return NextResponse.json(
      { error: "Connect this Shopify store to a Weletic program first" },
      { status: 409 },
    );
  }

  try {
    const result = await syncWeleticShopifyCatalog({
      workspaceId: workspace.id,
    });
    return NextResponse.json({
      success: true,
      runId: result.runId,
      stats: result.stats,
    });
  } catch (error) {
    console.error("[Shopify internal catalog sync error]", error);
    return NextResponse.json(
      { error: "Unable to synchronize the Shopify catalog" },
      { status: 500 },
    );
  }
}
