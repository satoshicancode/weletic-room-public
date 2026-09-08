import { prisma } from "@/lib/prisma";
import { loyaltyCommunicationsRequestSchema } from "@/lib/weletic/loyalty/communications-contract";
import { LoyaltyCommunicationsConflictError } from "@/lib/weletic/loyalty/communications-service";
import { manageShopifyCommunicationsInTransaction } from "@/lib/weletic/shopify/communications";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifySessionCoordinationError } from "@/lib/weletic/shopify/session-coordination";
import { SessionCredentialWriteBlockedError } from "@/lib/weletic/shopify/session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "@/lib/weletic/shopify/staff-contract";
import { isShopifyStoreOperationalWritesBlocked } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
const bodySchema = z
  .object({
    actor: shopifyMerchantActorEnvelopeSchema,
    request: loyaltyCommunicationsRequestSchema,
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
    // Three localized bodies can require up to 60KB of UTF-8 before JSON escaping.
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 128 * 1024,
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
        manageShopifyCommunicationsInTransaction({
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
    if (isShopifyStoreOperationalWritesBlocked(error))
      return reply({ error: "access_denied" }, 403);
    if (
      error instanceof LoyaltyCommunicationsConflictError ||
      error instanceof ShopifySessionCoordinationError ||
      (error instanceof Prisma.PrismaClientKnownRequestError &&
        ["P2034", "P2002"].includes(error.code))
    )
      return reply({ error: "state_changed" }, 409);
    return reply({ error: "communications_unavailable" }, 503);
  }
}
