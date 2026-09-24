import { PUBLIC_LOYALTY_API_ORIGIN } from "../../packages/shopify-app/app/public-runtime-policy.mjs";

const internal = "/api/internal/shopify/";
// Exact paths, not prefix grants: new endpoints require an explicit review.
export const loyaltyRoutes = Object.freeze([
  ...[
    "catalog",
    "installation/status",
    "installation/reconnect",
    "sessions",
    "sessions/coordinated",
    "sessions/coordination",
    "loyalty/program",
    "loyalty/customer",
    "loyalty/customer/birthday",
    "loyalty/customer/redeem",
    "loyalty/customer/nudge-collections",
    "loyalty/customer/activity",
    "loyalty/customer/activity/claim",
    "loyalty/customer/referral/bind",
    "loyalty/referral/claim",
    "loyalty/checkout/reserve",
    "loyalty/checkout/release",
    "merchant/analytics",
    "merchant/analytics/ledger-rows",
    "merchant/analytics/redemption-rows",
    "merchant/analytics/tier-history",
    "merchant/communications",
    "merchant/customers/list",
    "merchant/customers/profile",
    "merchant/earning-rules",
    "merchant/flow-grants",
    "merchant/imports",
    "merchant/loyalty-appearance",
    "merchant/loyalty-configuration",
    "merchant/loyalty-nudges",
    "merchant/overview",
    "merchant/referral-configuration",
    "merchant/reward-catalog",
    "merchant/settings",
    "merchant/staff/export",
    "merchant/staff/grants",
    "merchant/staff/grants/list",
    "merchant/vip-campaigns",
  ].map((path) => internal + path),
  "/api/shopify/integration/webhook",
  "/api/shopify/flow/lifecycle",
  "/api/shopify/flow/points-adjustment",
  "/api/shopify/gdpr/customers-data-request",
  "/api/shopify/gdpr/customers-redact",
  "/api/shopify/gdpr/shop-redact",
  "/api/shopify/loyalty/customer",
  "/api/shopify/loyalty/customer/redeem",
  "/api/shopify/loyalty/customer/referral/bind",
  "/api/shopify/loyalty/checkout/reserve",
  "/api/shopify/loyalty/checkout/release",
  "/api/cron/weletic/loyalty/outbox",
  "/api/cron/weletic/shopify/compliance",
  "/api/cron/weletic/shopify/session-renewal",
  "/api/cron/weletic/shopify/sync",
  "/api/cron/fx-rates",
  "/api/cron/queue/retry",
  "/api/jobs/process/weletic-shopify-session-renewal-job",
  "/api/jobs/process/weletic-shopify-session-renewal-sweep-job",
]);
const paths = new Set(loyaltyRoutes);
// Explicit route admission only; application signatures, tenant/staff identity,
// invitation authorization and per-store module switches remain authoritative.
export const reviewRoutes = Object.freeze([
  ...[
    "list",
    "photo",
    "health",
    "request",
    "submit",
    "upload",
    "open-submit",
    "open-prepare",
    "open-upload",
    "store-list",
    "store-submit",
    "store-invitations",
  ].map((action) => internal + "reviews/" + action),
  ...[
    "list",
    "moderate",
    "incentives/read",
    "incentives/draft",
    "incentives/activate",
    "incentives/coupons",
    "translations/read",
    "translations/write",
    "open-policy/read",
    "open-policy/write",
    "collection/read",
    "collection/write",
    "store/list",
    "store/moderate",
    "store/settings/read",
    "store/settings/write",
  ].map((action) => internal + "merchant/reviews/" + action),
]);
const reviewPaths = new Set(reviewRoutes);
const reviewReadPaths = new Set(
  ["list", "store-list", "store-invitations", "photo", "health"].map(
    (action) => internal + "reviews/" + action,
  ),
);
const host = new URL(PUBLIC_LOYALTY_API_ORIGIN).host;

export function admitsLoyaltyRequest(request, { reviewsEnabled = false } = {}) {
  if (!request || request.headers?.host !== host) return false;
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(request.method ?? ""))
    return false;
  // Preserve raw signed bodies and query strings. Never decode/normalize paths
  // into a different route, trust forwarded routing, or admit framework RPC.
  const raw = request.url;
  if (
    typeof raw !== "string" ||
    !raw.startsWith("/") ||
    /[\\#\u0000-\u0020]/.test(raw)
  )
    return false;
  const path = raw.split("?")[0];
  if (
    path.includes("%") ||
    path.includes("//") ||
    path.split("/").some((p) => p === "." || p === "..")
  )
    return false;
  for (const name of Object.keys(request.headers)) {
    if (
      /^(x-middleware-|x-invoke-|x-nextjs-|next-router-)/.test(name) ||
      [
        "x-matched-path",
        "next-url",
        "next-action",
        "rsc",
        "x-original-url",
        "x-rewrite-url",
        "x-now-route-matches",
      ].includes(name)
    )
      return false;
  }
  const query = new URLSearchParams(
    raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "",
  );
  for (const key of query.keys()) {
    if (/^(__next|nxtP|nxtI)/.test(key) || key === "_rsc") return false;
  }
  if (
    request.headers["x-forwarded-host"] !== undefined &&
    request.headers["x-forwarded-host"] !== host
  )
    return false;
  if (
    request.headers["x-forwarded-proto"] !== undefined &&
    request.headers["x-forwarded-proto"] !== "https"
  )
    return false;
  if (request.rawHeaders) {
    const count = request.rawHeaders.filter(
      (v, i) => i % 2 === 0 && v.toLowerCase() === "host",
    ).length;
    if (count !== 1) return false;
  }
  return (
    paths.has(path) ||
    (reviewsEnabled === true &&
      reviewPaths.has(path) &&
      request.method === (reviewReadPaths.has(path) ? "GET" : "POST")) ||
    /^\/api\/shopify\/compliance\/exports\/[A-Za-z0-9_-]{1,128}$/.test(path)
  );
}
