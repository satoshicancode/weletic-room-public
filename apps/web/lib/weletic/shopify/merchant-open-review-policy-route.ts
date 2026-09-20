import { NextResponse } from "next/server";
import * as z from "zod/v4";
import { ReviewError } from "../reviews/contracts";
import {
  openReviewPolicyReadSchema,
  openReviewPolicyWriteSchema,
} from "../reviews/open-submission-policy";
import {
  readShopifyMerchantOpenReviewPolicy,
  writeShopifyMerchantOpenReviewPolicy,
} from "./merchant-open-review-policy";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "./service-auth";
import { ShopifySessionCoordinationError } from "./session-coordination";
import { SessionCredentialWriteBlockedError } from "./session-lifecycle-fence";
import { ShopifyStaffAuthorizationError } from "./staff-authorization";
import { shopifyMerchantActorEnvelopeSchema } from "./staff-contract";

const reply = (data: unknown, status: number) =>
  NextResponse.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });

export function createOpenReviewPolicyRoute(operation: "read" | "write") {
  const schema = z
    .object({
      actor: shopifyMerchantActorEnvelopeSchema,
      input:
        operation === "read"
          ? openReviewPolicyReadSchema
          : openReviewPolicyWriteSchema,
    })
    .strict();
  const execute =
    operation === "read"
      ? readShopifyMerchantOpenReviewPolicy
      : writeShopifyMerchantOpenReviewPolicy;
  return async (request: Request) => {
    try {
      if (request.method !== "POST")
        return reply({ error: "method_not_allowed" }, 405);
      // Bound the complete signed actor and policy command before parsing.
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
        await execute({
          envelope: parsed.data.actor,
          input: parsed.data.input,
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
      if (error instanceof SessionCredentialWriteBlockedError)
        return reply({ error: "invalid_actor" }, 401);
      if (error instanceof ShopifySessionCoordinationError)
        return reply({ error: "state_changed" }, 409);
      if (error instanceof ReviewError) {
        if (error.code === "bad_request")
          return reply({ error: "invalid_request" }, 400);
        if (error.code === "not_found")
          return reply({ error: "review_unavailable" }, 404);
        if (error.code === "conflict")
          return reply({ error: "state_changed" }, 409);
      }
      return reply({ error: "reviews_unavailable" }, 503);
    }
  };
}
