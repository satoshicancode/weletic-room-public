export const ERROR_MAP: Record<
  string,
  { title: string; ctaLabel: string; ctaUrl: string }
> = {
  STRIPE_CONNECTION_REQUIRED: {
    title: "Stripe connection required",
    ctaLabel: "Install Stripe app",
    ctaUrl: "https://marketplace.stripe.com/apps/dub-conversions",
  },
  STRIPE_APP_UPGRADE_REQUIRED: {
    title: "Stripe app upgrade required",
    ctaLabel: "Review permissions",
    ctaUrl: "https://marketplace.stripe.com/apps/dub-conversions",
  },
  SHOPIFY_CONNECTION_REQUIRED: {
    title: "Shopify connection required",
    ctaLabel: "Connect Shopify app",
    ctaUrl: "/we/settings/integrations",
  },
  SHOPIFY_RECONNECT_REQUIRED: {
    title: "Shopify reconnection required",
    ctaLabel: "Reconnect Shopify app",
    ctaUrl: "/we/settings/integrations",
  },
  SHOPIFY_APP_UPGRADE_REQUIRED: {
    title: "Shopify app upgrade required",
    ctaLabel: "Review permissions",
    ctaUrl: "/we/settings/integrations",
  },
  STRIPE_RECONNECT_REQUIRED: {
    title: "Stripe reconnection required",
    ctaLabel: "Reconnect Stripe app",
    ctaUrl: "https://marketplace.stripe.com/apps/dub-conversions",
  },
};
