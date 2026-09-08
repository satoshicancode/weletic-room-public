import { withCron } from "@/lib/cron/with-cron";
import {
  boundedComplianceRecoveryBatchSize,
  processShopifyComplianceBatch,
  processShopifyComplianceRequest,
} from "@/lib/weletic/shopify/compliance-worker";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const payloadSchema = z.object({ requestId: z.string().min(1) });

const run = withCron(async ({ rawBody, searchParams, req }) => {
  const workerId = `compliance_${crypto.randomUUID()}`;
  if (req.method === "POST" && rawBody) {
    const { requestId } = payloadSchema.parse(JSON.parse(rawBody));
    return Response.json(
      await processShopifyComplianceRequest({ requestId, workerId }),
    );
  }

  const batchSize = boundedComplianceRecoveryBatchSize(
    Number(searchParams.batchSize || 3),
  );
  return Response.json(
    await processShopifyComplianceBatch({ batchSize, workerId }),
  );
});

export const GET = run;
export const POST = run;
