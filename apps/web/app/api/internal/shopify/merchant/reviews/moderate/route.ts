import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { auditedReviewModerationInputSchema } from "@/lib/weletic/reviews/moderation-contract";
import { moderateShopifyMerchantReview } from "@/lib/weletic/shopify/merchant-review-moderation";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifySessionCoordinationError } from "@/lib/weletic/shopify/session-coordination";
import { SessionCredentialWriteBlockedError } from "@/lib/weletic/shopify/session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "@/lib/weletic/shopify/staff-contract";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";
const schema = z
  .object({
    actor: shopifyMerchantActorEnvelopeSchema,
    input: auditedReviewModerationInputSchema,
  })
  .strict();
const reply = (data: unknown, status: number) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });

export async function POST(request: Request) {
  try {
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 32 * 1024,
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
      await moderateShopifyMerchantReview({
        envelope: parsed.data.actor,
        input: parsed.data.input,
      }),
      200,
    );
  } catch (error) {
    if (error instanceof ShopifyStaffAuthorizationError)
      return reply(
        { error: error.code },
        error.code === "access_denied"
          ? 403
          : error.code === "request_replayed"
            ? 409
            : 401,
      );
    if (error instanceof SessionCredentialWriteBlockedError)
      return reply({ error: "invalid_actor" }, 401);
    if (error instanceof ShopifySessionCoordinationError)
      return reply({ error: "state_changed" }, 409);
    if (error instanceof ReviewError) {
      if (error.code === "bad_request")
        return reply({ error: "invalid_request" }, 400);
      if (error.code === "not_found")
        return reply({ error: "review_unavailable" }, 404);
      if (error.code === "conflict")
        return reply({ error: "state_changed" }, 409);
    }
    return reply({ error: "reviews_unavailable" }, 503);
  }
}
