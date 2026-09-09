import { json } from "@remix-run/node";
import { installationAdmissionStatusSchema } from "../../../apps/web/lib/weletic/shopify/installation-admission-contract";
import { readWeleticShopifyRequestBodyBytes } from "../../../apps/web/lib/weletic/shopify/service-auth";
import type { verifyShopifyMerchantIdentity } from "./merchant-identity.server";
import {
  requireEnv,
  weleticApiJson,
  WeleticGatewayError,
} from "./weletic-api.server";

export function createInstallationReconnectAction(
  verify: (
    request: Request,
  ) => ReturnType<typeof verifyShopifyMerchantIdentity>,
  bootstrap: (request: Request) => Promise<unknown>,
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
      const bootstrapRequest = request.clone();
      const bytes = await readWeleticShopifyRequestBodyBytes(request, {
        maxBytes: 1024,
      });
      let input: unknown;
      try {
        input = bytes ? JSON.parse(new TextDecoder().decode(bytes)) : null;
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
      const verified = await verify(request);
      const identity = {
        appId: requireEnv("SHOPIFY_API_KEY"),
        shop: verified.shop,
        userId: verified.userId,
        issuedAt: verified.issuedAt,
        expiresAt: verified.expiresAt,
      };
      const call = (body: unknown) =>
        weleticApiJson<unknown>(
          "/api/internal/shopify/installation/reconnect",
          {
            method: "POST",
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify(body),
          },
        );
      const observation = await call({ operation: "observe", identity });
      // The internal observation never enters the browser. Backend validates its
      // strict shape and repeats freshness/current-state checks before mutation.
      const prepared = installationAdmissionStatusSchema.parse(
        await call({ operation: "prepare", identity, observation }),
      );
      if (prepared.status !== "pending_approval")
        throw new Error("Unexpected reconnect state");
      await bootstrap(bootstrapRequest);
      return reply(prepared, 200);
    } catch (error) {
      const unauthorized =
        error instanceof WeleticGatewayError && error.status === 401;
      return reply(
        { error: unauthorized ? "unauthorized" : "reconnect_unavailable" },
        unauthorized ? 401 : 503,
      );
    }
  };
}
