import { reviewHttpError, reviewJson } from "@/lib/weletic/reviews/http";
import { appProxyObservationSchema } from "@/lib/weletic/shopify/app-proxy-contract";
import { observeAppProxyRoute } from "@/lib/weletic/shopify/app-proxy-route";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";

export async function POST(request: Request) {
  try {
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 2048,
    });
    if (!bytes) return reviewJson({ error: { code: "bad_request" } }, 413);
    const body = new TextDecoder().decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reviewJson({ error: { code: "unauthorized" } }, 401);
    const input = appProxyObservationSchema.parse(JSON.parse(body));
    const store = await resolveShopifyStoreByDomain(input.shop);
    if (!store?.storeId)
      return reviewJson({ error: { code: "not_found" } }, 404);
    return reviewJson(await observeAppProxyRoute(store.storeId, input));
  } catch (error) {
    return reviewHttpError(error);
  }
}
