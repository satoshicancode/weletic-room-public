import { json } from "@remix-run/node";
import {
  loyaltyAppearanceRequestSchema,
  verifyLoyaltyAppearanceResponse,
} from "../../../apps/web/lib/weletic/loyalty/appearance-contract";
import { readWeleticShopifyRequestBodyBytes } from "../../../apps/web/lib/weletic/shopify/service-auth";
import type { createMerchantAuthenticator } from "./merchant-authentication.server";
import { weleticApiJson, WeleticGatewayError } from "./weletic-api.server";

const reply = (data: unknown, status: number) =>
  json(data, { status, headers: { "Cache-Control": "private, no-store" } });
export function createMerchantLoyaltyAppearanceAction(
  authenticate: ReturnType<typeof createMerchantAuthenticator>,
) {
  return async (request: Request) => {
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
    try {
      const bytes = await readWeleticShopifyRequestBodyBytes(request, {
        maxBytes: 32 * 1024,
      });
      if (bytes === null) return reply({ error: "invalid_request" }, 400);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      const parsed = loyaltyAppearanceRequestSchema.safeParse(value);
      if (!parsed.success) return reply({ error: "invalid_request" }, 400);
      return await authenticate(request, async ({ actor }) => {
        const result = await weleticApiJson<unknown>(
          "/api/internal/shopify/merchant/loyalty-appearance",
          {
            method: "POST",
            signal: AbortSignal.timeout(8_000),
            body: JSON.stringify({ actor, request: parsed.data }),
          },
        );
        return reply(verifyLoyaltyAppearanceResponse(parsed.data, result), 200);
      });
    } catch (error) {
      const status =
        error instanceof WeleticGatewayError &&
        [400, 401, 403, 409, 413].includes(error.status)
          ? error.status
          : 503;
      return reply(
        {
          error:
            status === 401
              ? "unauthorized"
              : status === 403
                ? "access_denied"
                : status === 409
                  ? "state_changed"
                  : status === 400 || status === 413
                    ? "invalid_request"
                    : "appearance_unavailable",
        },
        status,
      );
    }
  };
}
