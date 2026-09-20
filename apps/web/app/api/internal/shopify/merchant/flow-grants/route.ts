import { prisma } from "@/lib/prisma";
import {
  CreateFlowPointsGrantSchema,
  ListFlowPointsGrantsSchema,
  RevokeFlowPointsGrantSchema,
} from "@/lib/weletic/loyalty/flow-action-grant-contract";
import { LoyaltyMaintenanceBlockedError } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { LoyaltyProgramWriteBlockedError } from "@/lib/weletic/loyalty/program-write-fence";
import {
  FlowGrantMutationError,
  manageShopifyFlowGrantInTransaction,
} from "@/lib/weletic/shopify/merchant-flow-grants";
import { readShopifyFlowGrantsInTransaction } from "@/lib/weletic/shopify/merchant-flow-grants-read";
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
import { z } from "zod";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const bodySchema = z
  .object({
    actor: z.unknown(),
    operation: z.enum(["create", "revoke", "list"]),
    input: z.unknown(),
  })
  .strict();
const reply = (error: string, status: number) =>
  Response.json(
    { error },
    {
      status,
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );

export async function POST(request: Request) {
  try {
    if (request.method !== "POST") return reply("method_not_allowed", 405);
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 16 * 1024,
    });
    if (bytes === null) return reply("invalid_request", 413);
    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return reply("invalid_request", 400);
    }
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reply("unauthorized", 401);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return reply("invalid_request", 400);
    }
    const parsed = bodySchema.safeParse(value);
    if (!parsed.success) return reply("invalid_request", 400);
    const actor = shopifyMerchantActorEnvelopeSchema.safeParse(
      parsed.data.actor,
    );
    const input = (
      parsed.data.operation === "create"
        ? CreateFlowPointsGrantSchema
        : parsed.data.operation === "revoke"
          ? RevokeFlowPointsGrantSchema
          : ListFlowPointsGrantsSchema
    ).safeParse(parsed.data.input);
    if (!actor.success || !input.success) return reply("invalid_request", 400);
    const result = await prisma.$transaction(
      async (tx) =>
        parsed.data.operation === "list"
          ? readShopifyFlowGrantsInTransaction({
              tx,
              envelope: actor.data,
              input: input.data,
            })
          : manageShopifyFlowGrantInTransaction({
              tx,
              envelope: actor.data,
              operation: parsed.data.operation,
              input: input.data,
            }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return Response.json(result, {
      headers: {
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ShopifyStaffAuthorizationError)
      return reply(
        error.code,
        error.code === "access_denied"
          ? 403
          : error.code === "request_replayed"
            ? 409
            : 401,
      );
    if (error instanceof SessionCredentialWriteBlockedError)
      return reply("invalid_actor", 401);
    if (error instanceof FlowGrantMutationError)
      return reply(
        error.code,
        error.code === "invalid_expiry"
          ? 400
          : error.code === "unavailable"
            ? 404
            : 409,
      );
    if (
      error instanceof ShopifySessionCoordinationError ||
      error instanceof ShopifyStoreOperationalWritesBlockedError ||
      error instanceof LoyaltyMaintenanceBlockedError ||
      error instanceof LoyaltyProgramWriteBlockedError
    )
      return reply("state_changed", 409);
    // In particular, never blindly retry an ambiguously committed grant creation.
    return reply("flow_grants_unavailable", 503);
  }
}
