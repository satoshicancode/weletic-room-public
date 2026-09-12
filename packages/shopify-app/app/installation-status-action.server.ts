import { json } from "@remix-run/node";
import { installationAdmissionStatusSchema } from "../../../apps/web/lib/weletic/shopify/installation-admission-contract";
import { readWeleticShopifyRequestBodyBytes } from "../../../apps/web/lib/weletic/shopify/service-auth";
import type { verifyShopifyMerchantIdentity } from "./merchant-identity.server";
import {
  requireEnv,
  weleticApiJson,
  WeleticGatewayError,
} from "./weletic-api.server";

export function createInstallationStatusAction(
  verify: (
    request: Request,
  ) => ReturnType<typeof verifyShopifyMerchantIdentity>,
) {
  return async (request: Request) => {
    const reply = (value: unknown, status: number) =>
      json(value, {
        status,
        headers: { "Cache-Control": "private, no-store" },
      });
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
    try {
      const bytes = await readWeleticShopifyRequestBodyBytes(request, {
        maxBytes: 1024,
      });
      if (!bytes) return reply({ error: "invalid_request" }, 400);
      let input: unknown;
      try {
        input = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).length
      )
        return reply({ error: "invalid_request" }, 400);
      const identity = await verify(request);
      const result = await weleticApiJson<unknown>(
        "/api/internal/shopify/installation/status",
        {
          method: "POST",
          signal: AbortSignal.timeout(8_000),
          body: JSON.stringify({
            appId: requireEnv("SHOPIFY_API_KEY"),
            shop: identity.shop,
            userId: identity.userId,
            issuedAt: identity.issuedAt,
            expiresAt: identity.expiresAt,
          }),
        },
      );
      return reply(installationAdmissionStatusSchema.parse(result), 200);
    } catch (error) {
      const status =
        error instanceof WeleticGatewayError && error.status === 401
          ? 401
          : 503;
      return reply(
        { error: status === 401 ? "unauthorized" : "status_unavailable" },
        status,
      );
    }
  };
}
