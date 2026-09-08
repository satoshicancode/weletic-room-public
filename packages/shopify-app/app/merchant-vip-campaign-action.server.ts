import { json } from "@remix-run/node";
import {
  vipCampaignRequestSchema,
  vipCampaignResponseSchema,
} from "../../../apps/web/lib/weletic/loyalty/vip-campaign-contract";
import { readWeleticShopifyRequestBodyBytes } from "../../../apps/web/lib/weletic/shopify/service-auth";
import type { createMerchantAuthenticator } from "./merchant-authentication.server";
import { weleticApiJson, WeleticGatewayError } from "./weletic-api.server";

const reply = (data: unknown, status: number) =>
  json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });

export function createMerchantVipCampaignAction(
  authenticate: ReturnType<typeof createMerchantAuthenticator>,
) {
  return async (request: Request) => {
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
    try {
      const bytes = await readWeleticShopifyRequestBodyBytes(request, {
        maxBytes: 64 * 1024,
      });
      if (bytes === null) return reply({ error: "invalid_request" }, 400);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      const parsed = vipCampaignRequestSchema.safeParse(value);
      if (!parsed.success) return reply({ error: "invalid_request" }, 400);
      return authenticate(request, async ({ actor }) => {
        const data = await weleticApiJson<unknown>(
          "/api/internal/shopify/merchant/vip-campaigns",
          {
            method: "POST",
            signal: AbortSignal.timeout(8_000),
            body: JSON.stringify({ actor, request: parsed.data }),
          },
        );
        return reply(vipCampaignResponseSchema.parse(data), 200);
      });
    } catch (error) {
      const status =
        error instanceof WeleticGatewayError &&
        [400, 401, 403, 404, 409, 413].includes(error.status)
          ? error.status
          : 503;
      const code =
        status === 401
          ? "unauthorized"
          : status === 403
            ? "access_denied"
            : status === 409
              ? "state_changed"
              : status === 400 || status === 413
                ? "invalid_request"
                : "vip_campaign_unavailable";
      return reply({ error: code }, status);
    }
  };
}
