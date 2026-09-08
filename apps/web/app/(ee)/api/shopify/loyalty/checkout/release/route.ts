import { NextResponse } from "next/server";

export const POST = async () =>
  NextResponse.json(
    {
      error: {
        code: "gone",
        message: "Use the Shopify checkout session-token gateway.",
      },
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
