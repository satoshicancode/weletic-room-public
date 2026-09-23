import { prisma } from "@/lib/prisma";
import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { storeMerchantListInputSchema } from "@/lib/weletic/reviews/store-merchant-contract";
import { listShopifyMerchantStoreReviewsInTransaction } from "@/lib/weletic/shopify/merchant-store-reviews";
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
    input: storeMerchantListInputSchema,
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
      await prisma.$transaction((tx) =>
        listShopifyMerchantStoreReviewsInTransaction({
          tx,
          envelope: parsed.data.actor,
          input: parsed.data.input,
        }),
      ),
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
    if (error instanceof ReviewError && error.code === "bad_request")
      return reply({ error: "invalid_request" }, 400);
    return reply({ error: "reviews_unavailable" }, 503);
  }
}
