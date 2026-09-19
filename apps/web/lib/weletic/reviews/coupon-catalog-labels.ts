import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { readShopifyCredentialSource } from "@/lib/weletic/shopify/credential-source";
import { z } from "zod";
import { ReviewError } from "./contracts";

const unavailable = () =>
  new ReviewError(
    "unavailable",
    "Verified coupon catalog labels are unavailable",
  );
const gid = /^gid:\/\/shopify\/(Product|ProductVariant|Collection)\/\d+$/;
const title = z.string().trim().min(1).max(200);
const node = z.object({
  id: z.string().regex(gid),
  __typename: z.enum(["Product", "ProductVariant", "Collection"]),
  title,
  product: z
    .object({
      id: z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/),
      title,
    })
    .optional(),
});

/** Internal read, not an authorization gateway. Caller must fence the store
 * before capture and recheck its generation and policy before saving labels.
 * No network call is made while holding the caller's SQL transaction.
 */
export async function captureReviewCouponCatalogLabels(
  identity: {
    storeId: string;
    workspaceId: string;
    shop: string;
    installationGeneration: string | null;
  },
  ids: string[],
): Promise<Array<{ id: string; name: string }>> {
  if (
    ids.length > 250 ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !gid.test(id))
  )
    throw unavailable();
  if (!ids.length) return [];
  try {
    const credential = await readShopifyCredentialSource(identity);
    if (
      credential.source !== "native" ||
      credential.installationGeneration !== identity.installationGeneration ||
      !credential.scope
        .split(",")
        .some((scope) =>
          ["read_products", "write_products"].includes(scope.trim()),
        )
    )
      throw unavailable();
    const response = await shopifyAdminGraphql<unknown>({
      shopifyStoreId: identity.shop,
      accessToken: credential.accessToken,
      allowSdkFallback: false,
      query: `query ReviewCouponTargets($ids: [ID!]!) {
        nodes(ids: $ids) {
          id __typename
          ... on Product { title }
          ... on Collection { title }
          ... on ProductVariant { title product { id title } }
        }
      }`,
      variables: { ids },
    });
    const parsed = z.object({ nodes: z.array(node) }).parse(response);
    if (parsed.nodes.length !== ids.length) throw unavailable();
    const labels = new Map<string, string>();
    for (const item of parsed.nodes) {
      if (
        !ids.includes(item.id) ||
        labels.has(item.id) ||
        item.__typename !== item.id.match(gid)?.[1]
      )
        throw unavailable();
      if (item.__typename === "ProductVariant" && !item.product)
        throw unavailable();
      const name =
        item.__typename === "ProductVariant"
          ? `${item.product!.title} — ${item.title}`
          : item.title;
      // Never truncate a restriction into a different or ambiguous promise.
      labels.set(item.id, title.parse(name));
    }
    return ids.map((id) => ({ id, name: labels.get(id)! }));
  } catch {
    // Provider exceptions can include private request material. Expose neither
    // credentials nor raw GraphQL errors through the merchant gateway.
    throw unavailable();
  }
}
