import { z } from "zod";

export const SUBSCRIPTION_VERIFICATION_MS = 5 * 60_000;
export const pricingIdentitySchema = z
  .object({
    appId: z.string().regex(/^[a-z0-9_-]{1,191}$/),
    partnerAppId: z.string().regex(/^gid:\/\/shopify\/App\/[1-9][0-9]*$/),
    shopId: z.string().regex(/^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/),
    installationGeneration: z.string().min(1).max(64),
  })
  .strict();
export type PricingIdentity = z.infer<typeof pricingIdentitySchema>;
export type SubscriptionDecision = {
  status: "paid" | "private_free" | "development" | "inactive" | "unavailable";
  planHandle: string | null;
  cancelAtEndOfCycle: boolean;
  cycleEndsAt: Date | null;
};
export const unavailableSubscription = (): SubscriptionDecision => ({
  status: "unavailable",
  planHandle: null,
  cancelAtEndOfCycle: false,
  cycleEndsAt: null,
});
const subscription = z.object({
  app: z.object({ id: z.string() }),
  shop: z.object({ id: z.string() }),
  billingPeriod: z.string(),
  cancelAtEndOfCycle: z.boolean(),
  trialEndsAt: z.string().datetime().nullable(),
  currentBillingCycle: z
    .object({
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
    })
    .nullable(),
  items: z.array(
    z.object({
      handle: z.string().nullable(),
      price: z.object({
        __typename: z.string(),
        active: z.boolean(),
        currency: z.string(),
        amount: z.string().optional(),
      }),
    }),
  ),
});

/** Partner response only. Redirect/query-string values are not inputs here. */
export function interpretActiveSubscription(
  value: unknown,
  identity: PricingIdentity,
  plans: {
    publicHandle: string;
    privateHandle: string;
    verifiedDevelopmentStore?: boolean;
  },
  now: Date,
): SubscriptionDecision {
  pricingIdentitySchema.parse(identity);
  if (
    !Number.isFinite(now.getTime()) ||
    !plans.publicHandle ||
    !plans.privateHandle ||
    plans.publicHandle === plans.privateHandle
  )
    return unavailableSubscription();
  const parsed = z
    .object({
      data: z.object({ activeSubscription: subscription.nullable() }),
      errors: z.array(z.unknown()).optional(),
    })
    .safeParse(value);
  if (!parsed.success || parsed.data.errors?.length)
    return unavailableSubscription();
  const current = parsed.data.data.activeSubscription;
  if (current === null)
    return { ...unavailableSubscription(), status: "inactive" };
  if (
    current.app.id !== identity.partnerAppId ||
    current.shop.id !== identity.shopId
  )
    return unavailableSubscription();
  const end = current.currentBillingCycle
    ? new Date(current.currentBillingCycle.endTime)
    : null;
  if (
    current.billingPeriod !== "EVERY_30_DAYS" ||
    current.items.length !== 1 ||
    current.trialEndsAt !== null ||
    (end && end <= now) ||
    (current.currentBillingCycle &&
      new Date(current.currentBillingCycle.startTime) > now)
  )
    return { ...unavailableSubscription(), status: "inactive" };
  const item = current.items[0];
  const price = item.price;
  if (
    price.__typename !== "FlatRatePrice" ||
    !price.active ||
    price.currency !== "USD"
  )
    return { ...unavailableSubscription(), status: "inactive" };
  const status =
    item.handle === plans.publicHandle &&
    /^500(?:\.0+)?$/.test(price.amount ?? "") &&
    end
      ? "paid"
      : item.handle === plans.publicHandle &&
          plans.verifiedDevelopmentStore === true &&
          /^0(?:\.0+)?$/.test(price.amount ?? "")
        ? "development"
        : item.handle === plans.privateHandle &&
            /^0(?:\.0+)?$/.test(price.amount ?? "")
          ? "private_free"
          : "inactive";
  if (current.cancelAtEndOfCycle && !end)
    return { ...unavailableSubscription(), status: "inactive" };
  return {
    status,
    planHandle: item.handle,
    cancelAtEndOfCycle: current.cancelAtEndOfCycle,
    cycleEndsAt: end,
  };
}

export function hasFreshSubscription(
  snapshot: PricingIdentity &
    SubscriptionDecision & { verifiedAt: Date; validUntil: Date },
  identity: PricingIdentity,
  now: Date,
) {
  return (
    snapshot.appId === identity.appId &&
    snapshot.partnerAppId === identity.partnerAppId &&
    snapshot.shopId === identity.shopId &&
    snapshot.installationGeneration === identity.installationGeneration &&
    ["paid", "private_free", "development"].includes(snapshot.status) &&
    Number.isFinite(now.getTime()) &&
    snapshot.verifiedAt <= now &&
    snapshot.validUntil > now &&
    snapshot.validUntil.getTime() - snapshot.verifiedAt.getTime() <=
      SUBSCRIPTION_VERIFICATION_MS &&
    (!snapshot.cycleEndsAt || snapshot.cycleEndsAt > now)
  );
}

export const subscriptionStatusSchema = z
  .object({
    status: z.enum([
      "paid",
      "private_free",
      "development",
      "inactive",
      "unavailable",
    ]),
    validUntil: z.string().datetime().nullable(),
    credentialsChanged: z.boolean(),
  })
  .strict();
export const subscriptionPageSchema = subscriptionStatusSchema
  .extend({ pricingUrl: z.string().url(), supportEmail: z.string().email() })
  .strict();
export function hostedPricingUrl(shop: string, appHandle: string) {
  if (
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ||
    !/^[a-z0-9][a-z0-9-]*$/.test(appHandle)
  )
    throw new Error("Hosted pricing identity unavailable");
  return `https://admin.shopify.com/store/${shop.slice(0, -".myshopify.com".length)}/charges/${appHandle}/pricing_plans`;
}
