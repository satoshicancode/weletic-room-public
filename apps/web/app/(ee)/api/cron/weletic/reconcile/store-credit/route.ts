import { withCron } from "@/lib/cron/with-cron";
import { reconcilePendingStoreCreditRedemptionsSweep } from "@/lib/weletic/loyalty/store-credit-reconciliation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = withCron(async () => {
  const result = await reconcilePendingStoreCreditRedemptionsSweep({
    batchSize: 50,
  });
  return Response.json(result);
});

export const POST = GET;
