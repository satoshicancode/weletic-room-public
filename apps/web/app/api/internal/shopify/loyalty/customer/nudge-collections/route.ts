import { prisma } from "@/lib/prisma";
import { ratelimit } from "@/lib/upstash";
import { readCustomerNudgeCollectionMembership } from "@/lib/weletic/loyalty/nudge-collection-reader";
import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";
import { createShopifyDerivedPrivacyDigest } from "@/lib/weletic/shopify/privacy-identity";
import { verifyWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";

export const dynamic = "force-dynamic";
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request: Request) {
  if (!verifyWeleticShopifyRequest({ request, body: "" }))
    return loyaltyErrorResponse(
      "unauthorized",
      "Unauthorized service request",
      401,
      undefined,
      { headers },
    );
  const params = new URL(request.url).searchParams;
  const shop = params.get("shop");
  const customerId = params.get("customerId");
  const rawProducts = params.get("productIds");
  if (
    !shop ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
    !customerId ||
    !/^[1-9]\d{0,19}$/.test(customerId) ||
    !rawProducts ||
    rawProducts.length > 1049 ||
    [...params.keys()].some(
      (key) =>
        !["shop", "customerId", "productIds"].includes(key) ||
        params.getAll(key).length !== 1,
    )
  )
    return loyaltyErrorResponse(
      "bad_request",
      "Invalid membership request",
      400,
      undefined,
      { headers },
    );
  const products = rawProducts.split(",");
  if (
    products.length > 50 ||
    products.some((id) => !/^[1-9]\d{0,19}$/.test(id))
  )
    return loyaltyErrorResponse(
      "bad_request",
      "Invalid product identifiers",
      400,
      undefined,
      { headers },
    );
  try {
    // Do not use the credential-bearing resolver: it can verify/rebind tokens.
    // Ambiguous persisted aliases must fail closed, never select the first store.
    const stores = await prisma.weleticShopifyStore.findMany({
      where: {
        OR: [{ shopDomain: shop }, { project: { shopifyStoreId: shop } }],
      },
      select: { id: true },
      take: 2,
    });
    if (stores.length !== 1)
      return loyaltyErrorResponse(
        "store_not_found",
        "Store unavailable",
        404,
        undefined,
        { headers },
      );
    const storeKey = createShopifyDerivedPrivacyDigest({
      purpose: "nudge_membership",
      values: [stores[0].id],
    });
    const shopperKey = createShopifyDerivedPrivacyDigest({
      purpose: "nudge_membership",
      values: [stores[0].id, customerId],
    });
    const limits = await Promise.all([
      ratelimit(60, "1 m").limit(`loyalty:nudge-membership:store:${storeKey}`),
      ratelimit(10, "1 m").limit(
        `loyalty:nudge-membership:shopper:${shopperKey}`,
      ),
    ]);
    if (limits.some((limit) => limit.reason === "timeout"))
      return loyaltyErrorResponse(
        "unavailable",
        "Membership lookup unavailable",
        503,
        undefined,
        { headers },
      );
    if (limits.some((limit) => !limit.success))
      return loyaltyErrorResponse(
        "rate_limited",
        "Membership lookup rate limited",
        429,
        undefined,
        { headers },
      );
    const membership = await readCustomerNudgeCollectionMembership({
      storeId: stores[0].id,
      shopifyCustomerId: customerId,
      productIds: products.map((id) => `gid://shopify/Product/${id}`),
    });
    return loyaltySuccessResponse({ membership }, { headers });
  } catch {
    return loyaltyErrorResponse(
      "unavailable",
      "Membership lookup unavailable",
      503,
      undefined,
      { headers },
    );
  }
}
