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
) {
  try {
    const action = subpath.slice("reviews/".length);
    if (request.method === "GET" && action === "write")
      return reviewFormResponse();
    const allowed =
      request.method === "GET"
        ? ["list", "photo"]
        : request.method === "POST"
          ? ["request", "submit", "upload"]
          : [];
    if (!allowed.includes(action))
      throw new WeleticGatewayError("Review route unavailable", 404);
    const query = new URLSearchParams({ shop });
    if (request.method === "GET") {
      const url = new URL(request.url);
      for (const key of [
        "productId",
        "sort",
        "rating",
        "cursor",
        "limit",
        "mediaId",
      ]) {
        const value = url.searchParams.get(key);
        if (value !== null) query.set(key, value);
      }
    }
    // Stream a narrowly bounded JSON envelope; never request.text() a photo.
    let body: string | undefined;
    if (request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        throw new WeleticGatewayError("Use JSON", 415);
      const max = action === "upload" ? 3 * 1024 * 1024 : 64 * 1024;
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
    const result = await weleticApiJson<unknown>(
      `/api/internal/shopify/reviews/${action}?${query}`,
      { method: request.method, ...(body ? { body } : {}) },
    );
    return privateCustomerJson(result, {}, "Cookie");
  } catch (error) {
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
      "Cookie",
    );
  }
}
