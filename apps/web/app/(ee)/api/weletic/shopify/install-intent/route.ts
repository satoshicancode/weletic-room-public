import { withWorkspace } from "@/lib/auth";
import { createShopifyInstallIntent } from "@/lib/weletic/shopify/install-intent";
import { NextResponse } from "next/server";
import { z } from "zod";

const createIntentSchema = z.object({
  shopDomain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-zA-Z0-9-]+\.myshopify\.com$/, {
      message:
        "Invalid Shopify domain format. Expected e.g. store.myshopify.com",
    }),
  ttlSeconds: z.number().int().min(60).max(3600).optional(),
});

// POST /api/weletic/shopify/install-intent - generate a signed, one-time installation intent for connecting Shopify
export const POST = withWorkspace(
  async ({ req, workspace }) => {
    const body = await req.json();
    const { shopDomain, ttlSeconds } = createIntentSchema.parse(body);

    const intent = await createShopifyInstallIntent({
      workspaceId: workspace.id,
      shopDomain,
      ttlSeconds,
    });

    const shopifyAppUrl =
      process.env.SHOPIFY_APP_URL || "https://shopify.weletic.com";
    const installUrl = `${shopifyAppUrl}/auth?shop=${encodeURIComponent(
      intent.shopDomain,
    )}&intent=${encodeURIComponent(intent.token)}`;

    return NextResponse.json({
      ...intent,
      installUrl,
    });
  },
  { requiredRoles: ["owner"] },
);
