import { getShopifyAdminGraphqlUrl } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { readBoundedShopifyJson } from "@/lib/weletic/shopify/read-bounded-json";
import { fetchShopifyTokenAuthorityCredential } from "@/lib/weletic/shopify/token-authority";
import { z } from "zod";
import { ReviewError } from "./contracts";

const responseSchema = z.object({
  errors: z.array(z.unknown()).max(0).optional(),
  data: z.object({
    customer: z.object({
      id: z.string(),
      defaultEmailAddress: z
        .object({ emailAddress: z.string().max(320).email() })
        .nullable(),
    }),
  }),
});

const query = `query WeleticOpenReviewCustomer($id: ID!) {
  customer(id: $id) { id defaultEmailAddress { emailAddress } }
}`;

async function admission(storeId: string, installationGeneration: string) {
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: {
      shopDomain: true,
      installationGeneration: true,
      storeAccessState: true,
      complianceState: true,
      uninstalledAt: true,
      redactedAt: true,
    },
  });
  if (
    !store ||
    store.installationGeneration !== installationGeneration ||
    store.storeAccessState !== "active" ||
    store.complianceState !== "active" ||
    store.uninstalledAt ||
    store.redactedAt ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store.shopDomain)
  )
    throw new Error("Unavailable");
  const settings = await prisma.weleticReviewSettings.findUnique({
    where: { storeId },
    select: { enabled: true },
  });
  if (!settings?.enabled) throw new Error("Unavailable");
  return store;
}

/** Server-only prerequisite, NOT authentication. Identity must come from a
 * verified Shopify session/proxy envelope, never shopper JSON. Run outside the
 * write transaction; its callback must still fence admission, policy and privacy
 * inside that transaction. No profile sync, enrollment or consent mutation.
 */
export async function readOpenReviewCustomer({
  storeId,
  installationGeneration,
  shopifyCustomerId,
}: {
  storeId: string;
  installationGeneration: string;
  shopifyCustomerId: string;
}): Promise<{ shopifyCustomerId: string; email: string | null }> {
  try {
    const customerId = shopifyCustomerId.replace(
      /^gid:\/\/shopify\/Customer\//,
      "",
    );
    if (
      !storeId ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(installationGeneration) ||
      !/^[1-9][0-9]{0,19}$/.test(customerId)
    )
      throw new Error("Unavailable");
    const before = await admission(storeId, installationGeneration);
    const credential = await fetchShopifyTokenAuthorityCredential({
      shopDomain: before.shopDomain,
      installationGeneration,
    });
    const scopes = new Set(
      credential.scope.split(",").map((scope) => scope.trim()),
    );
    if (
      credential.shopDomain !== before.shopDomain ||
      (!scopes.has("read_customers") && !scopes.has("write_customers"))
    )
      throw new Error("Unavailable");
    const signal = AbortSignal.timeout(5000);
    const response = await fetch(getShopifyAdminGraphqlUrl(before.shopDomain), {
      method: "POST",
      cache: "no-store",
      redirect: "error",
      signal,
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": credential.accessToken,
      },
      body: JSON.stringify({
        query,
        variables: { id: `gid://shopify/Customer/${customerId}` },
      }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("Unavailable");
    }
    const parsed = responseSchema.parse(
      await readBoundedShopifyJson(response, signal),
    );
    const customer = parsed.data.customer;
    if (customer.id !== `gid://shopify/Customer/${customerId}`)
      throw new Error("Unavailable");
    const after = await admission(storeId, installationGeneration);
    if (after.shopDomain !== before.shopDomain) throw new Error("Unavailable");
    return {
      shopifyCustomerId: customerId,
      // Only an explicit Shopify null is absence. Missing/protected fields and
      // partial GraphQL errors must not bypass email-based privacy suppression.
      email: customer.defaultEmailAddress?.emailAddress ?? null,
    };
  } catch {
    // Never surface customer data, credentials or upstream errors to shoppers.
    throw new ReviewError("unavailable", "Review identity unavailable");
  }
}
