import { json } from "@remix-run/node";
import { merchantReviewListInputSchema } from "../../../apps/web/lib/weletic/reviews/merchant-contract";
import { auditedReviewModerationInputSchema } from "../../../apps/web/lib/weletic/reviews/moderation-contract";
import { readWeleticShopifyRequestBodyBytes } from "../../../apps/web/lib/weletic/shopify/service-auth";
import {
  listShopifyStaffGrantsSchema,
  replaceShopifyStaffGrantSchema,
  shopifyMerchantOverviewInputSchema,
  shopifyStaffExportInputSchema,
} from "../../../apps/web/lib/weletic/shopify/staff-contract";
import {
  merchantShopperListInputSchema,
  merchantShopperProfileInputSchema,
} from "../../../apps/web/lib/weletic/shoppers/merchant-contract";
import type { createMerchantAuthenticator } from "./merchant-authentication.server";
import { weleticApiJson, WeleticGatewayError } from "./weletic-api.server";

const operations = {
  replace: { schema: replaceShopifyStaffGrantSchema, path: "staff/grants" },
  list: { schema: listShopifyStaffGrantsSchema, path: "staff/grants/list" },
  overview: { schema: shopifyMerchantOverviewInputSchema, path: "overview" },
  export: { schema: shopifyStaffExportInputSchema, path: "staff/export" },
  reviews: { schema: merchantReviewListInputSchema, path: "reviews/list" },
  customers: { schema: merchantShopperListInputSchema, path: "customers/list" },
  "customer-profile": {
    schema: merchantShopperProfileInputSchema,
    path: "customers/profile",
  },
  "moderate-review": {
    schema: auditedReviewModerationInputSchema,
    path: "reviews/moderate",
  },
} as const;

function reply(data: unknown, status: number) {
  return json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export function createMerchantAction(
  authenticate: ReturnType<typeof createMerchantAuthenticator>,
  operation: keyof typeof operations = "replace",
) {
  return async (request: Request) => {
    if (request.method !== "POST")
      return reply({ error: "method_not_allowed" }, 405);
    try {
      const bytes = await readWeleticShopifyRequestBodyBytes(request, {
        maxBytes: (operation === "moderate-review" ? 32 : 16) * 1024,
      });
      if (bytes === null) return reply({ error: "invalid_request" }, 400);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return reply({ error: "invalid_request" }, 400);
      }
      const input = operations[operation].schema.safeParse(value);
      if (!input.success) return reply({ error: "invalid_request" }, 400);
      return await authenticate(request, async ({ actor }) => {
        const result = await weleticApiJson<unknown>(
          `/api/internal/shopify/merchant/${operations[operation].path}`,
          {
            method: "POST",
            // Bound headers AND body consumption. An uncertain commit is not
            // retried automatically; the caller must reload current state.
            signal: AbortSignal.timeout(8_000),
            body: JSON.stringify({ actor, input: input.data }),
          },
        );
        return reply(result, 200);
      });
    } catch (error) {
      const status =
        error instanceof WeleticGatewayError &&
        ([400, 401, 403, 409, 413].includes(error.status) ||
          (operation === "customer-profile" && error.status === 404))
          ? error.status
          : 503;
      const code =
        status === 404
          ? "not_found"
          : status === 401
            ? "unauthorized"
            : status === 403
              ? "access_denied"
              : status === 409
                ? "state_changed"
                : status === 400 || status === 413
                  ? "invalid_request"
                  : "staff_access_unavailable";
      return reply({ error: code }, status);
    }
  };
}
