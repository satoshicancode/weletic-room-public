import { prisma } from "@/lib/prisma";
import { readShopifyMerchantOverviewInTransaction } from "@/lib/weletic/shopify/merchant-overview";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifySessionCoordinationError } from "@/lib/weletic/shopify/session-coordination";
import { SessionCredentialWriteBlockedError } from "@/lib/weletic/shopify/session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import {
  shopifyMerchantActorEnvelopeSchema,
  shopifyMerchantOverviewInputSchema,
} from "@/lib/weletic/shopify/staff-contract";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";
const schema = z
  .object({
    actor: shopifyMerchantActorEnvelopeSchema,
    input: shopifyMerchantOverviewInputSchema,
  })
  .strict();
function reply(data: unknown, status: number) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  try {
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
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
    const result = await prisma.$transaction((tx) =>
      readShopifyMerchantOverviewInTransaction({
        tx,
        envelope: parsed.data.actor,
      }),
    );
    return reply(result, 200);
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
    return reply({ error: "overview_unavailable" }, 503);
  }
}
