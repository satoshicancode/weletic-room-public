import {
  interpretActiveSubscription,
  pricingIdentitySchema,
  unavailableSubscription,
  type PricingIdentity,
} from "./app-pricing-contract";
import { readBoundedShopifyJson } from "./read-bounded-json";

const query = `query CoreLaunchSubscription($appId: ID!, $shopId: ID!) {
  activeSubscription(appId: $appId, shopId: $shopId) {
    app { id } shop { id } billingPeriod cancelAtEndOfCycle trialEndsAt
    currentBillingCycle { startTime endTime }
    items { handle price { __typename active currency ... on FlatRatePrice { amount } } }
  }
}`;

/** Organization token stays on the backend; never use an Admin API token here.
 * No automatic network retries, redirect following or provider-body logging.
 */
export async function fetchActiveAppSubscription(
  identity: PricingIdentity,
  {
    env = process.env,
    customFetch = fetch,
    now = new Date(),
    verifiedDevelopmentStore = false,
  }: {
    env?: NodeJS.ProcessEnv;
    customFetch?: typeof fetch;
    now?: Date;
    verifiedDevelopmentStore?: boolean;
  } = {},
) {
  pricingIdentitySchema.parse(identity);
  const organization = env.SHOPIFY_PARTNER_ORGANIZATION_ID;
  const token = env.SHOPIFY_PARTNER_API_TOKEN;
  if (
    !organization ||
    !/^[1-9][0-9]*$/.test(organization) ||
    !token ||
    identity.appId !== env.SHOPIFY_API_KEY ||
    identity.partnerAppId !== env.SHOPIFY_PARTNER_APP_ID
  )
    return unavailableSubscription();
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await customFetch(
      `https://partners.shopify.com/${organization}/api/2026-07/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": token,
        },
        body: JSON.stringify({
          query,
          variables: { appId: identity.partnerAppId, shopId: identity.shopId },
        }),
      },
    );
    if (!response.ok) return unavailableSubscription();
    const payload = await readBoundedShopifyJson(response, signal);
    return interpretActiveSubscription(
      payload,
      identity,
      {
        publicHandle: env.WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE ?? "",
        privateHandle: env.WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE ?? "",
        verifiedDevelopmentStore,
      },
      now,
    );
  } catch {
    return unavailableSubscription();
  }
}
