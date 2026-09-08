import { withWorkspace } from "@/lib/auth";
import { readShopifySessionHealth } from "@/lib/weletic/shopify/session-health";
import { NextResponse } from "next/server";

export const GET = withWorkspace(async ({ workspace }) => {
  const health = await readShopifySessionHealth(workspace.id);
  return NextResponse.json(health, {
    headers: { "Cache-Control": "private, no-store" },
  });
});
