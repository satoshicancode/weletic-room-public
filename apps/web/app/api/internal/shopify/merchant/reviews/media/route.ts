import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { merchantReviewMediaInputSchema } from "@/lib/weletic/reviews/merchant-contract";
import { readShopifyMerchantReviewMedia } from "@/lib/weletic/shopify/merchant-review-media";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "@/lib/weletic/shopify/staff-contract";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

const schema = z
  .object({
    actor: shopifyMerchantActorEnvelopeSchema,
    input: merchantReviewMediaInputSchema,
  })
  .strict();
const reply = (data: unknown, status: number) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });

export async function POST(request: Request) {
  try {
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 16 * 1024,
    });
    if (bytes === null) return reply({ error: "invalid_request" }, 400);
    const body = new TextDecoder().decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reply({ error: "unauthorized" }, 401);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return reply({ error: "invalid_request" }, 400);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    return reply(
      await readShopifyMerchantReviewMedia({
        envelope: parsed.data.actor,
        input: parsed.data.input,
      }),
      200,
    );
  } catch (error) {
    if (error instanceof ShopifyStaffAuthorizationError)
      return reply(
        { error: error.code },
        error.code === "access_denied" ? 403 : 401,
      );
    if (error instanceof ReviewError && error.code === "not_found")
      return reply({ error: "media_unavailable" }, 404);
    return reply({ error: "reviews_unavailable" }, 503);
  }
}
