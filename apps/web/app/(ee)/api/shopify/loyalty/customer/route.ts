import { NextResponse } from "next/server";

// Customer identity must come from Shopify App Proxy or Customer Account JWT
// verification in the standalone Shopify app. Caller-supplied customer IDs are
// intentionally rejected at this legacy public boundary.
export const GET = async () =>
  NextResponse.json(
    {
      error: {
        code: "gone",
        message: "Use the authenticated Shopify loyalty gateway.",
      },
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
