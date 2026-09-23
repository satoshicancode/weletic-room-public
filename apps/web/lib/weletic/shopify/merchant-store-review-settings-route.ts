import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import * as z from "zod/v4";
import { ReviewError } from "../reviews/contracts";
import {
  storeReviewSettingsReadInputSchema,
  storeReviewSettingsWriteInputSchema,
} from "../reviews/store-settings-contract";
import {
  readShopifyMerchantStoreReviewSettingsInTransaction,
  writeShopifyMerchantStoreReviewSettings,
} from "./merchant-store-review-settings";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "./service-auth";
import { ShopifySessionCoordinationError } from "./session-coordination";
import { SessionCredentialWriteBlockedError } from "./session-lifecycle-fence";
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

export function createStoreReviewSettingsRoute(operation: "read" | "write") {
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
      const parsed = envelopeSchema.safeParse(value);
      if (!parsed.success) return reply({ error: "invalid_request" }, 400);
      if (operation === "read") {
        const input = storeReviewSettingsReadInputSchema.safeParse(
          parsed.data.input,
        );
        if (!input.success) return reply({ error: "invalid_request" }, 400);
        return reply(
          await prisma.$transaction((tx) =>
            readShopifyMerchantStoreReviewSettingsInTransaction({
              tx,
              envelope: parsed.data.actor,
              input: input.data,
            }),
          ),
          200,
        );
      }
      const input = storeReviewSettingsWriteInputSchema.safeParse(
        parsed.data.input,
      );
      if (!input.success) return reply({ error: "invalid_request" }, 400);
      return reply(
        await writeShopifyMerchantStoreReviewSettings({
          envelope: parsed.data.actor,
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
      if (error instanceof SessionCredentialWriteBlockedError)
        return reply({ error: "invalid_actor" }, 401);
      if (error instanceof ShopifySessionCoordinationError)
        return reply({ error: "state_changed" }, 409);
      if (error instanceof ReviewError) {
        if (error.code === "conflict")
          return reply({ error: "state_changed" }, 409);
        if (error.code === "disabled")
          return reply({ error: "reviews_disabled" }, 409);
      }
      return reply({ error: "reviews_unavailable" }, 503);
    }
  };
}
