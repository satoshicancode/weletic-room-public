import { withWorkspace } from "@/lib/auth";
import { listShopifyCustomerSegments } from "@/lib/weletic/shopify/customer-segments";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const GET = withWorkspace(async ({ workspace, searchParams }) => {
  const { q } = z
    .object({ q: z.string().trim().max(100).optional() })
    .parse(searchParams);
  const segments = await listShopifyCustomerSegments({
    workspaceId: workspace.id,
    query: q,
  });
  return NextResponse.json(segments);
});
