import { shouldEnforceCronAuth } from "@/lib/cron/should-enforce-cron-auth";
import { verifyVercelSignature } from "@/lib/cron/verify-vercel";
import { weleticShopifySessionRenewalSweepJob } from "@/lib/jobs/handlers/weletic-shopify-session-renewal-sweep-job";
import { shopifySessionRenewalEnabled } from "@/lib/weletic/shopify/session-renewal";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    // Sensitive maintenance never adopts the generic local-development bypass.
    if (!shouldEnforceCronAuth())
      return Response.json({ error: "Unauthorized" }, { status: 401, headers });
    await verifyVercelSignature(request);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  }
  try {
    if (!shopifySessionRenewalEnabled())
      return Response.json({ status: "disabled" }, { headers });
    const appId = process.env.SHOPIFY_API_KEY?.trim();
    if (!appId) throw new Error("Shopify app identity is required");
    const scheduledAt = new Date(
      Math.floor(Date.now() / 60_000) * 60_000,
    ).toISOString();
    const dispatched = await weleticShopifySessionRenewalSweepJob.dispatch(
      { scheduledAt, appId },
      { deduplicationId: `${appId}:${scheduledAt}` },
    );
    return Response.json({ status: dispatched.status }, { headers });
  } catch {
    return Response.json(
      { error: "Shopify renewal dispatch unavailable" },
      { status: 503, headers },
    );
  }
}
