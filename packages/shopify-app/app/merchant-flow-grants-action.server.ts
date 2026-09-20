import { json } from "@remix-run/node";
import {
  FlowGrantListResponseSchema,
  FlowGrantMutationResponseSchema,
  FlowGrantsMerchantRequestSchema,
} from "../../../apps/web/lib/weletic/loyalty/flow-grants-merchant-contract";
import { readWeleticShopifyRequestBodyBytes } from "../../../apps/web/lib/weletic/shopify/service-auth";
import type { createMerchantAuthenticator } from "./merchant-authentication.server";
import { weleticApiJson, WeleticGatewayError } from "./weletic-api.server";

const reply = (data: unknown, status: number) =>
  json(data, { status, headers: { "Cache-Control": "private, no-store" } });
export function createMerchantFlowGrantsAction(
  authenticate: ReturnType<typeof createMerchantAuthenticator>,
) {
  return async (request: Request) => {
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
    try {
      const bytes = await readWeleticShopifyRequestBodyBytes(request, {
        maxBytes: 16 * 1024,
      });
      if (bytes === null) return reply({ error: "invalid_request" }, 413);
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      const parsed = FlowGrantsMerchantRequestSchema.safeParse(value);
      if (!parsed.success) return reply({ error: "invalid_request" }, 400);
      const operation = parsed.data;
      return await authenticate(request, async ({ actor }) => {
        if (
          operation.input.expectedInstallationGeneration &&
          operation.input.expectedInstallationGeneration !==
            actor.installationGeneration
        )
          return reply({ error: "state_changed" }, 409);
        // Only the replay nonce is client-selected. Every authority-bearing field
        // remains the freshly Shopify-derived actor; the internal gateway signs it.
        const envelope =
          operation.operation === "list"
            ? actor
            : { ...actor, requestId: operation.attemptId };
        const input = {
          ...operation.input,
          expectedInstallationGeneration: actor.installationGeneration,
        };
        const result = await weleticApiJson<unknown>(
          "/api/internal/shopify/merchant/flow-grants",
          {
            method: "POST",
            signal: AbortSignal.timeout(8000),
            body: JSON.stringify({
              actor: envelope,
              operation: operation.operation,
              input,
            }),
          },
        );
        if (operation.operation === "list") {
          const data = FlowGrantListResponseSchema.parse(result);
          if (data.installationGeneration !== actor.installationGeneration)
            throw new Error("Flow generation mismatch");
          return reply(data, 200);
        }
        const data = FlowGrantMutationResponseSchema.parse(result);
        if (
          operation.operation === "create"
            ? data.revision !== 1 || data.revokedAt !== null
            : data.id !== operation.input.grantId ||
              data.revision !== operation.input.expectedRevision + 1 ||
              data.revokedAt === null
        )
          throw new Error("Flow acknowledgment mismatch");
        return reply(data, 200);
      });
    } catch (error) {
      const status =
        error instanceof WeleticGatewayError &&
        [400, 401, 403, 404, 409, 413].includes(error.status)
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
                  : "flow_grants_unavailable",
        },
        status,
      );
    }
  };
}
