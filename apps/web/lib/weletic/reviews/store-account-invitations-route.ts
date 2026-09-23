import {
  readWeleticShopifyRequestBodyBytes,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { reviewHttpError, reviewJson } from "./http";
import { resolveStoreReviewAccountIdentity } from "./store-account-identity";
import {
  listStoreAccountInvitations,
  storeAccountInvitationQuerySchema,
} from "./store-account-invitations";

const contextSchema = z
  .object({
    shop: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    customerId: z.string().regex(/^[1-9][0-9]{0,19}$/),
    source: z.literal("customer_account"),
  })
  .merge(storeAccountInvitationQuerySchema)
  .strict();

export async function storeAccountInvitationsRoute(request: Request) {
  try {
    if (request.method !== "GET")
      return reviewJson({ error: { code: "method_not_allowed" } }, 405);
    const bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: 1,
    });
    if (bytes === null || bytes.length !== 0)
      return reviewJson({ error: { code: "bad_request" } }, 400);
    if (!verifyWeleticShopifyRequest({ request, body: "" }))
      return reviewJson({ error: { code: "unauthorized" } }, 401);
    const url = new URL(request.url);
    if (
      [...url.searchParams.keys()].some(
        (key) => url.searchParams.getAll(key).length !== 1,
      )
    )
      throw new ReviewError("bad_request", "Invalid review context");
    const {
      shop,
      customerId,
      source: _source,
      ...query
    } = contextSchema.parse(Object.fromEntries(url.searchParams));
    const identity = await resolveStoreReviewAccountIdentity(shop, customerId);
    return reviewJson(
      await listStoreAccountInvitations({
        storeId: identity.storeId,
        shopperId: identity.shopperId,
        expectedInstallationGeneration: identity.installationGeneration,
        query,
      }),
    );
  } catch (error) {
    return reviewHttpError(error);
  }
}
