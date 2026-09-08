import { prisma } from "@/lib/prisma";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { ShopifySessionCoordinationError } from "@/lib/weletic/shopify/session-coordination";
import { SessionCredentialWriteBlockedError } from "@/lib/weletic/shopify/session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import {
  listShopifyStaffGrantsSchema,
  shopifyMerchantActorEnvelopeSchema,
} from "@/lib/weletic/shopify/staff-contract";
import {
  listShopifyStaffGrantsInTransaction,
  ShopifyStaffGrantCursorError,
} from "@/lib/weletic/shopify/staff-grant-list";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";

const schema = z
  .object({
    actor: shopifyMerchantActorEnvelopeSchema,
    input: listShopifyStaffGrantsSchema,
  })
  .strict();

function response(data: unknown, status: number) {
  return NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/** Owner-only grant-list gateway. Service authentication alone grants nothing:
 * the entire actor + list input is signed, then owner evidence, installation,
 * nonce and permissions are resolved in the list transaction.
 */
export async function POST(request: Request) {
  try {
    if (request.method !== "POST")
      return response({ error: "method_not_allowed" }, 405);
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 16 * 1024,
    });
    if (bytes === null) return response({ error: "invalid_request" }, 400);
    const body = new TextDecoder().decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return response({ error: "unauthorized" }, 401);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      return response({ error: "invalid_request" }, 400);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) return response({ error: "invalid_request" }, 400);
    const result = await prisma.$transaction((tx) =>
      listShopifyStaffGrantsInTransaction({
        tx,
        envelope: parsed.data.actor,
        input: parsed.data.input,
      }),
    );
    return response(result, 200);
  } catch (error) {
    if (error instanceof ShopifyStaffAuthorizationError) {
      const status =
        error.code === "access_denied"
          ? 403
          : error.code === "request_replayed"
            ? 409
            : 401;
      return response({ error: error.code }, status);
    }
    if (error instanceof ShopifyStaffGrantCursorError)
      return response({ error: "invalid_cursor" }, 400);
    if (error instanceof SessionCredentialWriteBlockedError)
      return response({ error: "invalid_actor" }, 401);
    if (error instanceof ShopifySessionCoordinationError)
      return response({ error: "state_changed" }, 409);
    // Never expose encrypted payloads, database errors or request bodies.
    return response({ error: "staff_access_unavailable" }, 503);
  }
}
