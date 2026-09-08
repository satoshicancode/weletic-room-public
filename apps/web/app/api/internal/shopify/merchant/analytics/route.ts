import { prisma } from "@/lib/prisma";
import { merchantAnalyticsRequestSchema } from "@/lib/weletic/loyalty/merchant-analytics-contract";
import { readShopifyMerchantAnalyticsInTransaction } from "@/lib/weletic/shopify/merchant-analytics";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifySessionCoordinationError } from "@/lib/weletic/shopify/session-coordination";
import { SessionCredentialWriteBlockedError } from "@/lib/weletic/shopify/session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "@/lib/weletic/shopify/staff-contract";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
const bodySchema = z
  .object({
    actor: shopifyMerchantActorEnvelopeSchema,
    request: merchantAnalyticsRequestSchema,
  })
  .strict();
const reply = (data: unknown, status: number) =>
  NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
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
    const parsed = bodySchema.safeParse(value);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    const result = await prisma.$transaction(
      (tx) =>
        readShopifyMerchantAnalyticsInTransaction({
          tx,
          envelope: parsed.data.actor,
          request: parsed.data.request,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
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
    if (
      error instanceof ShopifySessionCoordinationError ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034")
    )
      return reply({ error: "state_changed" }, 409);
    return reply({ error: "analytics_unavailable" }, 503);
  }
}
