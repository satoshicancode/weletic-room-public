import { prisma } from "@/lib/prisma";
import { shopifyEarningRulesInputSchema } from "@/lib/weletic/loyalty/earning-rule-contract";
import { EarningRuleWriteError } from "@/lib/weletic/loyalty/earning-rule-writer";
import { LoyaltyMaintenanceBlockedError } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { manageShopifyEarningRulesInTransaction } from "@/lib/weletic/shopify/earning-rules";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifySessionCoordinationError } from "@/lib/weletic/shopify/session-coordination";
import { SessionCredentialWriteBlockedError } from "@/lib/weletic/shopify/session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "@/lib/weletic/shopify/staff-contract";
import { ShopifyStoreOperationalWritesBlockedError } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";

export const dynamic = "force-dynamic";
const bodySchema = z
  .object({
    actor: shopifyMerchantActorEnvelopeSchema,
    request: shopifyEarningRulesInputSchema,
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
    const parsed = bodySchema.safeParse(value);
    if (!parsed.success) return reply({ error: "invalid_request" }, 400);
    const data = await prisma.$transaction(
      (tx) =>
        manageShopifyEarningRulesInTransaction({
          tx,
          envelope: parsed.data.actor,
          request: parsed.data.request,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return reply(data, 200);
  } catch (error) {
    if (error instanceof EarningRuleWriteError)
      return reply(
        { error: error.code === "not_found" ? "not_found" : "state_changed" },
        error.code === "not_found" ? 404 : 409,
      );
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
      error instanceof ShopifyStoreOperationalWritesBlockedError ||
      error instanceof LoyaltyMaintenanceBlockedError
    )
      return reply({ error: "state_changed" }, 409);
    // Request validation is complete above. Zod failures here concern internal
    // or stored data, not client input. Never leak values or retry a mutation.
    return reply({ error: "earning_rules_unavailable" }, 503);
  }
}
