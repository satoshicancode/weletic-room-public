import { openReviewSubmissionSchema } from "../../../apps/web/lib/weletic/reviews/open-submission-contract";
import { reviewFormResponse } from "./reviews-form.server";
import {
  privateCustomerJson,
  weleticApiJson,
  WeleticGatewayError,
} from "./weletic-api.server";

/** Called only after authenticate.public.appProxy has verified Shopify HMAC. */
export async function reviewProxyResponse(
  request: Request,
  shop: string,
  subpath: string,
  authenticatedCustomerId?: string,
) {
  return reviewGatewayResponse(
    request,
    shop,
    subpath,
    authenticatedCustomerId,
    "app_proxy",
  );
}

/** Only called after customer-account SDK verification. The source is fixed by
 * this server entrypoint, not caller JSON/query. */
export async function reviewCustomerAccountResponse(
  request: Request,
  shop: string,
  subpath: string,
  authenticatedCustomerId: string,
) {
  if (
    !(
      (request.method === "GET" && subpath === "reviews/store-invitations") ||
      (request.method === "POST" &&
        [
          "reviews/open-prepare",
          "reviews/open-submit",
          "reviews/open-upload",
          "reviews/store-submit",
        ].includes(subpath))
    )
  )
    return privateCustomerJson(
      { error: { code: "not_found" } },
      { status: 404 },
    );
  return reviewGatewayResponse(
    request,
    shop,
    subpath,
    authenticatedCustomerId,
    "customer_account",
  );
}

async function reviewGatewayResponse(
  request: Request,
  shop: string,
  subpath: string,
  authenticatedCustomerId: string | undefined,
  source: "app_proxy" | "customer_account",
) {
  const vary = source === "customer_account" ? "Authorization" : "Cookie";
  try {
    const action = subpath.slice("reviews/".length);
    if (
      ["store-submit", "store-invitations"].includes(action) &&
      source !== "customer_account"
    )
      throw new WeleticGatewayError("Review route unavailable", 404);
    if (request.method === "GET" && action === "open-write")
      return reviewFormResponse(
        new URL(request.url).searchParams.get("locale"),
        "open",
      );
    if (request.method === "GET" && action === "write")
      return reviewFormResponse(
        new URL(request.url).searchParams.get("locale"),
      );
    const allowed =
      request.method === "GET"
        ? ["list", "store-list", "store-invitations", "photo"]
        : request.method === "POST"
          ? [
              "request",
              "submit",
              "upload",
              "open-submit",
              "open-prepare",
              "open-upload",
              "store-submit",
            ]
          : [];
    if (!allowed.includes(action))
      throw new WeleticGatewayError("Review route unavailable", 404);
    const query = new URLSearchParams({ shop });
    if (
      [
        "open-submit",
        "open-prepare",
        "open-upload",
        "store-submit",
        "store-invitations",
      ].includes(action)
    ) {
      if (
        !authenticatedCustomerId ||
        !/^[1-9][0-9]{0,19}$/.test(authenticatedCustomerId)
      )
        throw new WeleticGatewayError("Customer authentication required", 401);
      query.set("customerId", authenticatedCustomerId);
      query.set("source", source);
    }
    if (request.method === "GET") {
      const url = new URL(request.url);
      const keys =
        action === "store-invitations"
          ? ["limit", "cursor"]
          : [
              "productId",
              "sort",
              "rating",
              "cursor",
              "limit",
              "mediaId",
              "locale",
            ];
      for (const key of keys) {
        const value = url.searchParams.get(key);
        if (value !== null) query.set(key, value);
      }
    }
    // Stream a narrowly bounded JSON envelope; never request.text() a photo.
    let body: string | undefined;
    if (request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new WeleticGatewayError("Use JSON", 415);
      const max = ["upload", "open-upload"].includes(action)
        ? 3 * 1024 * 1024
        : 64 * 1024;
      const reader = request.body?.getReader();
      if (!reader) throw new WeleticGatewayError("Missing body", 400);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > max) {
            await reader.cancel();
            throw new WeleticGatewayError("Request body is too large", 413);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      body = Buffer.concat(chunks).toString("utf8");
    }
    if (action === "open-submit") {
      let valid = false;
      try {
        const { authorBinding, ...content } = JSON.parse(body || "");
        valid =
          typeof authorBinding === "string" &&
          /^[a-f0-9]{64}$/.test(authorBinding) &&
          openReviewSubmissionSchema.safeParse(content).success;
      } catch {
        /* Definite pre-dispatch rejection, not a provider outcome. */
      }
      if (!valid)
        return privateCustomerJson(
          { error: { code: "invalid_review_input" } },
          { status: 400 },
          vary,
        );
    }
    const result = await weleticApiJson<unknown>(
      `/api/internal/shopify/reviews/${action}?${query}`,
      { method: request.method, ...(body ? { body } : {}) },
    );
    return privateCustomerJson(result, {}, vary);
  } catch (error) {
    if (
      subpath === "reviews/open-upload" &&
      error instanceof WeleticGatewayError &&
      error.reviewPhotoValidationRejected
    )
      return privateCustomerJson(
        { error: { code: "invalid_open_photo" } },
        { status: 400 },
        vary,
      );
    return privateCustomerJson(
      {
        error: {
          code: "review_error",
          message:
            error instanceof WeleticGatewayError
              ? error.message
              : "Reviews temporarily unavailable",
        },
      },
      { status: error instanceof WeleticGatewayError ? error.status : 503 },
      vary,
    );
  }
}
