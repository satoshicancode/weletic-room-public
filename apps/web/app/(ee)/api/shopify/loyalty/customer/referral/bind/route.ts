import { NextResponse } from "next/server";

export const POST = async () =>
  NextResponse.json(
    {
      error: {
        code: "gone",
        message: "Use the authenticated Shopify loyalty gateway.",
      },
    },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
