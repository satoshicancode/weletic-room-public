import { withCron } from "@/lib/cron/with-cron";
import { recoverStuckOrdersPaidWebhooks } from "@/lib/weletic/shopify/orders-paid-recovery";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const runOrdersPaidRecovery = withCron(async ({ searchParams }) => {
  const requestedBatchSize = Number(searchParams.batchSize || 10);
  const limit = Number.isInteger(requestedBatchSize)
    ? Math.min(50, Math.max(1, requestedBatchSize))
    : 10;

  const results = await recoverStuckOrdersPaidWebhooks({
    limit,
    inFlightLeaseMs: 180_000,
    maxAttempts: 5,
  });

  return Response.json({
    recovered: results.length,
    results,
  });
});

export const GET = runOrdersPaidRecovery;
export const POST = runOrdersPaidRecovery;
