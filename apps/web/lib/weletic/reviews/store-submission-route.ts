import { prisma } from "@/lib/prisma";
import { ratelimit } from "@/lib/upstash";
import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { reviewHttpError, reviewJson } from "./http";
import {
  storeReviewSubmissionSchema,
  submitAuthenticatedStoreReview,
} from "./store-service";

const contextSchema = z
  .object({
    shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    customerId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    source: z.literal("customer_account"),
  })
  .strict();

/** The Shopify customer-account SDK supplies identity to the signed gateway.
 * Body fields can name an invitation, but can never choose its shopper/store.
 */
export async function storeReviewSubmissionRoute(request: Request) {
  try {
    if (request.method !== "POST")
      return reviewJson({ error: { code: "method_not_allowed" } }, 405);
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 64 * 1024,
    });
    if (bytes === null)
      return reviewJson({ error: { code: "bad_request" } }, 413);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!verifyWeleticShopifyRequest({ request, body }))
      return reviewJson({ error: { code: "unauthorized" } }, 401);
    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some(
        (key) => url.searchParams.getAll(key).length !== 1,
      )
    )
      throw new ReviewError("bad_request", "Invalid review context");
    const context = contextSchema.parse(Object.fromEntries(url.searchParams));
    const input = storeReviewSubmissionSchema.parse(JSON.parse(body));
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { shopDomain: context.shop },
      select: {
        id: true,
        installationGeneration: true,
        complianceState: true,
        storeAccessState: true,
      },
    });
    if (
      !store?.installationGeneration ||
      store.complianceState !== "active" ||
      store.storeAccessState !== "active"
    )
      throw new ReviewError("not_found", "Store unavailable");
    const shopper = await prisma.weleticShopper.findMany({
      where: {
        storeId: store.id,
        shopifyCustomerId: {
          in: [
            context.customerId,
            `gid://shopify/Customer/${context.customerId}`,
          ],
        },
      },
      select: { id: true },
      take: 2,
    });
    if (!shopper.length)
      throw new ReviewError("not_found", "Review invitation unavailable");
    if (shopper.length !== 1)
      throw new ReviewError("unavailable", "Review identity unavailable");
    const bucket = createHash("sha256")
      .update(JSON.stringify([store.id, context.customerId]))
      .digest("hex");
    const limit = await ratelimit(60, "1 h").limit(
      `weletic:reviews:store:${bucket}`,
    );
    if (!limit.success)
      return reviewJson({ error: { code: "rate_limited" } }, 429);
    const result = await submitAuthenticatedStoreReview({
      storeId: store.id,
      shopperId: shopper[0].id,
      expectedInstallationGeneration: store.installationGeneration,
      input,
    });
    return reviewJson(result, result.duplicate ? 200 : 201);
  } catch (error) {
    return reviewHttpError(error);
  }
}
