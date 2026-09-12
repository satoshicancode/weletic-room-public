import { withCron } from "@/lib/cron/with-cron";
import { processOutboxJobsBatch } from "@/lib/weletic/loyalty/outbox";
import { enqueuePointsExpiryLifecycleJobs } from "@/lib/weletic/loyalty/points-expiry-scheduler";
import { enqueueRewardExpiryReminderJobs } from "@/lib/weletic/loyalty/reward-expiry-scheduler";
import { enqueueTierReviewSweepJobs } from "@/lib/weletic/loyalty/tier-review-scheduling";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const runOutboxBatch = withCron(async ({ searchParams }) => {
  const requestedBatchSize = Number(searchParams.batchSize || 50);
  const batchSize = Number.isInteger(requestedBatchSize)
    ? Math.min(100, Math.max(1, requestedBatchSize))
    : 50;

  const [expirySweep, tierSweep, rewardExpirySweep] = await Promise.all([
    enqueuePointsExpiryLifecycleJobs({
      batchSize,
    }),
    enqueueTierReviewSweepJobs({
      batchSize,
    }),
    enqueueRewardExpiryReminderJobs({ batchSize }),
  ]);
  const outbox = await processOutboxJobsBatch({
    batchSize,
    workerId: `cron_${crypto.randomUUID()}`,
  });

  return Response.json({ expirySweep, tierSweep, rewardExpirySweep, outbox });
});

export const GET = runOutboxBatch;
export const POST = runOutboxBatch;
