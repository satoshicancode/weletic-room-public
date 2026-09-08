import { prisma } from "@/lib/prisma";
import { resolveComplianceShopifyStoreByDomain } from "@/lib/weletic/shopify/compliance-store-resolver";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import {
  shopifySessionLeaseSchema,
  shopifySessionObservationSchema,
  shopifySessionShopSchema,
} from "@/lib/weletic/shopify/session-contract-validation";
import {
  acquireShopifySessionLease,
  releaseShopifySessionLease,
  renewShopifySessionLease,
  ShopifySessionCoordinationError,
} from "@/lib/weletic/shopify/session-coordination";
import {
  lockShopifySessionLifecycle,
  SessionCredentialWriteBlockedError,
} from "@/lib/weletic/shopify/session-lifecycle-fence";
import {
  assertShopifySessionObservation,
  configuredShopifySessionScope,
  readShopifySessionSnapshot,
} from "@/lib/weletic/shopify/session-snapshot";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
const respond = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers });
const inputSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("acquire"),
      shop: shopifySessionShopSchema,
      token: z.string().regex(/^[a-f0-9]{64}$/),
      observed: shopifySessionObservationSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("renew"),
      shop: shopifySessionShopSchema,
      lease: shopifySessionLeaseSchema,
      // Additive transition: new clients revalidate before provider I/O;
      // earlier coordinated clients may still renew without this field.
      observed: shopifySessionObservationSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("release"),
      shop: shopifySessionShopSchema,
      lease: shopifySessionLeaseSchema,
    })
    .strict(),
]);

function failure(error: unknown) {
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return respond({ error: "Invalid request" }, 400);
  if (error instanceof ShopifySessionCoordinationError) {
    return respond(
      { error: error.code },
      error.code === "invalid_scope" ? 400 : 409,
    );
  }
  if (error instanceof SessionCredentialWriteBlockedError)
    return respond({ error: "installation_blocked" }, 409);
  // No provider/SQL exception text can leave this authority boundary.
  return respond({ error: "Session coordination unavailable" }, 503);
}

async function resolveStore(shop: string) {
  const resolved = await resolveComplianceShopifyStoreByDomain(shop);
  if (
    resolved?.resolvedFromTombstone ||
    resolved?.complianceState === "redacted"
  ) {
    throw new SessionCredentialWriteBlockedError(
      "Shopify installation is unavailable.",
    );
  }
  return resolved?.storeId ?? null;
}

export async function GET(request: Request) {
  if (!verifyWeleticShopifyRequest({ request, body: "" }))
    return respond({ error: "Unauthorized" }, 401);
  try {
    const shop = shopifySessionShopSchema.parse(
      new URL(request.url).searchParams.get("shop"),
    );
    const scope = configuredShopifySessionScope(shop);
    const storeId = await resolveStore(shop);
    const snapshot = await prisma.$transaction(async (tx) => {
      const store = await lockShopifySessionLifecycle({ tx, shop, storeId });
      return readShopifySessionSnapshot(tx, scope, store);
    });
    return respond(snapshot);
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  const body = await readWeleticShopifyRequestBody(request);
  if (body === null)
    return respond({ error: "Request body is too large" }, 413);
  if (!verifyWeleticShopifyRequest({ request, body }))
    return respond({ error: "Unauthorized" }, 401);
  try {
    const input = inputSchema.parse(JSON.parse(body));
    const scope = configuredShopifySessionScope(input.shop);
    // Releasing an old owner is safe even after the installation is frozen or
    // erased. It cannot recreate the coordinator or modify a newer epoch.
    if (input.action === "release") {
      const released = await prisma.$transaction((tx) =>
        releaseShopifySessionLease(tx, { ...scope, ...input.lease }),
      );
      return respond({ released });
    }
    const storeId = await resolveStore(scope.shop);
    const result = await prisma.$transaction(async (tx) => {
      const store = await lockShopifySessionLifecycle({
        tx,
        shop: scope.shop,
        storeId,
      });
      if (input.action === "renew") {
        await renewShopifySessionLease(tx, { ...scope, ...input.lease });
        if (input.observed) {
          const current = await readShopifySessionSnapshot(tx, scope, store);
          assertShopifySessionObservation(current.observed, input.observed);
        }
        return { renewed: true };
      }
      const lease = await acquireShopifySessionLease(
        tx,
        scope,
        input.token,
        input.observed,
      );
      const current = await readShopifySessionSnapshot(tx, scope, store);
      assertShopifySessionObservation(current.observed, input.observed);
      return {
        lease: {
          token: lease.token,
          epoch: lease.epoch,
          revision: lease.revision,
        },
      };
    });
    return respond(result);
  } catch (error) {
    return failure(error);
  }
}
