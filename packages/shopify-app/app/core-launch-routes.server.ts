import { isCoreLaunch } from "../../../apps/web/lib/weletic/core-launch-policy";

const deferredPaths = new Set([
  "/loyalty-referrals",
  "/loyalty-vip",
  "/loyalty-analytics",
  "/loyalty-imports",
  "/loyalty-nudges",
  "/api/merchant/referral-configuration",
  "/api/merchant/vip-campaigns",
  "/api/merchant/imports",
  "/api/merchant/loyalty-nudges",
  "/api/merchant/analytics",
  "/api/merchant/analytics/tier-history",
  "/api/merchant/store-reviews",
  "/api/merchant/store-review-settings/write",
  "/api/merchant/open-review-policy/write",
  "/api/merchant/review-incentives/coupons",
  "/api/merchant/review-translations/write",
  "/api/pos/loyalty",
]);
export function assertCoreLaunchMerchantRoute(request: Request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
  if (isCoreLaunch() && deferredPaths.has(path))
    throw new Response("Unavailable in the core launch", {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    });
}
