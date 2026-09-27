import { json } from "@remix-run/node";
import {
  hostedPricingUrl,
  subscriptionPageSchema,
  subscriptionStatusSchema,
} from "../../../apps/web/lib/weletic/shopify/app-pricing-contract";
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
  billing = false,
  bootstrap?: (request: Request) => Promise<unknown>,
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
      const beforeRequest = billing ? request.clone() : null;
      const afterRequest = billing ? request.clone() : null;
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
      if (billing) {
        if (!bootstrap || !beforeRequest)
          throw new Error("Billing authentication unavailable");
        await bootstrap(beforeRequest);
      }
      const result = await weleticApiJson<unknown>(
        billing
          ? "/api/internal/shopify/installation/billing"
          : "/api/internal/shopify/installation/status",
        {
          method: "POST",
          signal: AbortSignal.timeout(billing ? 45_000 : 8_000),
          body: JSON.stringify({
            appId: requireEnv("SHOPIFY_API_KEY"),
            shop: identity.shop,
            userId: identity.userId,
            issuedAt: identity.issuedAt,
            expiresAt: identity.expiresAt,
          }),
        },
      );
      if (billing) {
        const status = subscriptionStatusSchema.parse(result);
        if (status.credentialsChanged) {
          if (!bootstrap || !afterRequest)
            throw new Error("Billing credential publication unavailable");
          await bootstrap(afterRequest);
        }
        return reply(
          subscriptionPageSchema.parse({
            ...status,
            pricingUrl: hostedPricingUrl(
              identity.shop,
              requireEnv("SHOPIFY_APP_HANDLE"),
            ),
            supportEmail: requireEnv("WELETIC_SUPPORT_EMAIL"),
          }),
          200,
        );
      }
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
