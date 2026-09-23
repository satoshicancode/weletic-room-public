import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import * as z from "zod/v4";
import {
  reviewCollectionReadInputSchema,
  reviewCollectionWriteInputSchema,
} from "../reviews/collection-contract";
import { ReviewError } from "../reviews/contracts";
import {
  readShopifyMerchantReviewCollectionInTransaction,
  writeShopifyMerchantReviewCollection,
} from "./merchant-review-collection";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "./service-auth";
import { ShopifyStaffAuthorizationError } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

const envelopeSchema = z
  .object({ actor: shopifyMerchantActorEnvelopeSchema, input: z.unknown() })
  .strict();
const reply = (data: unknown, status: number) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });

export function createReviewCollectionRoute(operation: "read" | "write") {
  return async (request: Request) => {
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
      const envelope = envelopeSchema.safeParse(value);
      if (!envelope.success) return reply({ error: "invalid_request" }, 400);
      // Parse separately: the legacy collection fields use Zod 3 while the
      // signed Shopify actor uses Zod 4. Never compose incompatible schemas.
      if (operation === "read") {
        const input = reviewCollectionReadInputSchema.safeParse(
          envelope.data.input,
        );
        if (!input.success) return reply({ error: "invalid_request" }, 400);
        return reply(
          await prisma.$transaction((tx) =>
            readShopifyMerchantReviewCollectionInTransaction({
              tx,
              envelope: envelope.data.actor,
              input: input.data,
            }),
          ),
          200,
        );
      }
      const input = reviewCollectionWriteInputSchema.safeParse(
        envelope.data.input,
      );
      if (!input.success) return reply({ error: "invalid_request" }, 400);
      return reply(
        await writeShopifyMerchantReviewCollection({
          envelope: envelope.data.actor,
          input: input.data,
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
      if (error instanceof ReviewError && error.code === "conflict")
        return reply({ error: "state_changed" }, 409);
      return reply({ error: "reviews_unavailable" }, 503);
    }
  };
}
