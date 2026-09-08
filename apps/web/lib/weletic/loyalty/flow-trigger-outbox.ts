import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  enqueueOutboxJobFromProgramTransaction,
  type FlowTriggerPayload,
} from "@/lib/weletic/loyalty/outbox";
import type { Prisma } from "@prisma/client";

/**
 * Persists a Flow event beside the loyalty mutation that produced it. The
 * deterministic key makes repeated producer calls converge on one job.
 */
export function enqueueFlowTriggerJob({
  storeId,
  eventId,
  payload,
  scheduledFor,
  loyaltyMaintenancePermit,
  tx,
}: {
  storeId: string;
  eventId: string;
  payload: FlowTriggerPayload;
  scheduledFor?: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx: Prisma.TransactionClient;
}) {
  return enqueueOutboxJobFromProgramTransaction({
    storeId,
    jobType: "FLOW_TRIGGER",
    payload,
    idempotencyKey: `flow_trigger:${payload.handle}:${eventId}`,
    scheduledFor,
    loyaltyMaintenancePermit,
    tx,
  });
}
