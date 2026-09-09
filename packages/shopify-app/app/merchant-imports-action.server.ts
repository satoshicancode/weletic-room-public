import { json } from "@remix-run/node";
import {
  HISTORICAL_IMPORT_MAX_SOURCE_BYTES,
  historicalImportContextResponseSchema,
  historicalImportMerchantRequestSchema,
  verifyHistoricalImportExecutionResponse,
  verifyHistoricalImportHistoryResponse,
  verifyHistoricalImportPreparationResponse,
  verifyHistoricalImportReconciliationResponse,
  verifyHistoricalImportStatusResponse,
} from "../../../apps/web/lib/weletic/loyalty/historical-import-contract";
import { readWeleticShopifyRequestBodyBytes } from "../../../apps/web/lib/weletic/shopify/service-auth";
import type { createMerchantAuthenticator } from "./merchant-authentication.server";
import { weleticApiJson, WeleticGatewayError } from "./weletic-api.server";

const reply = (data: unknown, status: number) =>
  json(data, { status, headers: { "Cache-Control": "private, no-store" } });
export function createMerchantImportsAction(
  authenticate: ReturnType<typeof createMerchantAuthenticator>,
) {
  return async (request: Request) => {
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
    try {
      const bytes = await readWeleticShopifyRequestBodyBytes(request, {
        maxBytes:
          Math.ceil(HISTORICAL_IMPORT_MAX_SOURCE_BYTES / 3) * 4 + 16 * 1024,
      });
      if (bytes === null) return reply({ error: "invalid_request" }, 400);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      const parsed = historicalImportMerchantRequestSchema.safeParse(value);
      if (!parsed.success) return reply({ error: "invalid_request" }, 400);
      return await authenticate(request, async ({ actor }) => {
        const result = await weleticApiJson<unknown>(
          "/api/internal/shopify/merchant/imports",
          {
            method: "POST",
            signal: AbortSignal.timeout(
              parsed.data.request.operation === "commit" ||
                parsed.data.request.operation === "rollback"
                ? 35_000
                : 8_000,
            ),
            body: JSON.stringify({ actor, ...parsed.data }),
          },
        );
        const response =
          parsed.data.request.operation === "commit" ||
          parsed.data.request.operation === "rollback"
            ? verifyHistoricalImportExecutionResponse(
                parsed.data.request,
                result,
              )
            : parsed.data.request.operation === "context"
              ? historicalImportContextResponseSchema.parse(result)
              : parsed.data.request.operation === "status"
                ? verifyHistoricalImportStatusResponse(
                    parsed.data.request,
                    result,
                  )
                : parsed.data.request.operation === "reconcile"
                  ? verifyHistoricalImportReconciliationResponse(
                      parsed.data.request,
                      result,
                    )
                  : parsed.data.request.operation === "history"
                    ? verifyHistoricalImportHistoryResponse(
                        parsed.data.request,
                        result,
                      )
                    : verifyHistoricalImportPreparationResponse(
                        parsed.data.request,
                        result,
                      );
        if (response.storeId !== actor.storeId)
          throw new Error("Invalid import store");
        return reply(response, 200);
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
                    : "imports_unavailable",
        },
        status,
      );
    }
  };
}
