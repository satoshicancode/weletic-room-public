import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import type { Prisma } from "@prisma/client";
import {
  ReviewFlowJobSchema,
  reviewFlowEventId,
  type ReviewFlowJob,
} from "./flow-contract";

/** Called inside the owned review transaction, not from a page render. Legacy
 * null-generation records never acquire a current installation by replay.
 */
export async function enqueueReviewFlowEvent({
  tx,
  storeId,
  generation,
  event,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  generation: string | null;
  event: Omit<ReviewFlowJob, "installationGeneration">;
}) {
  if (!generation) return;
  const payload = ReviewFlowJobSchema.parse({
    ...event,
    installationGeneration: generation,
  });
  await enqueueFlowTriggerJob({
    tx,
    storeId,
    eventId: reviewFlowEventId(payload),
    payload,
  });
}
