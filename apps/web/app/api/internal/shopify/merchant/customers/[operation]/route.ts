import { prisma } from "@/lib/prisma";
import {
  listShopifyMerchantShoppersInTransaction,
  readShopifyMerchantShopperInTransaction,
} from "@/lib/weletic/shopify/merchant-shoppers";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifySessionCoordinationError } from "@/lib/weletic/shopify/session-coordination";
import { SessionCredentialWriteBlockedError } from "@/lib/weletic/shopify/session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "@/lib/weletic/shopify/staff-contract";
import {
  merchantShopperListInputSchema,
  merchantShopperProfileInputSchema,
} from "@/lib/weletic/shoppers/merchant-contract";
import { ShopperProfileError } from "@/lib/weletic/shoppers/profile-query";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
const reply = (data: unknown, status: number) =>
  NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });

export async function POST(
  request: Request,
  context: { params: Promise<{ operation: string }> },
) {
  try {
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
    const { operation } = await context.params;
    if (operation !== "list" && operation !== "profile")
      return reply({ error: "not_found" }, 404);
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
    const schema = z
      .object({
        actor: shopifyMerchantActorEnvelopeSchema,
        input:
          operation === "list"
            ? merchantShopperListInputSchema
            : merchantShopperProfileInputSchema,
      })
      .strict();
    const parsed = schema.safeParse(value);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    const read =
      operation === "list"
        ? listShopifyMerchantShoppersInTransaction
        : readShopifyMerchantShopperInTransaction;
    const result = await prisma.$transaction(async (tx) =>
      read({ tx, envelope: parsed.data.actor, input: parsed.data.input }),
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
    if (error instanceof ShopperProfileError)
      return reply(
        { error: error.code },
        error.code === "not_found" ? 404 : 400,
      );
    return reply({ error: "customers_unavailable" }, 503);
  }
}
