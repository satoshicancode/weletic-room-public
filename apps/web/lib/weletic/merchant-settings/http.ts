import { ShopifyStoreOperationalWritesBlockedError } from "@/lib/weletic/shopify/store-compliance-state";
import { ZodError } from "zod";
import { MerchantSettingsError } from "./contracts";

export function merchantSettingsJson(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
export function merchantSettingsHttpError(error: unknown) {
  if (error instanceof MerchantSettingsError)
    return merchantSettingsJson(
      { error: { code: error.code, message: error.message } },
      { not_found: 404, conflict: 409, forbidden: 403 }[error.code],
    );
  if (error instanceof ZodError || error instanceof SyntaxError)
    return merchantSettingsJson(
      { error: { code: "bad_request", message: "Invalid merchant settings" } },
      400,
    );
  if (error instanceof ShopifyStoreOperationalWritesBlockedError)
    return merchantSettingsJson(
      {
        error: {
          code: "conflict",
          message:
            "Store connection changed or is unavailable. Reload before saving",
        },
      },
      409,
    );
  return merchantSettingsJson(
    {
      error: {
        code: "unavailable",
        message: "Merchant settings temporarily unavailable",
      },
    },
    503,
  );
}
