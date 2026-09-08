import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueueOutboxJobFromProgramTransaction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction,
}));

import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";

describe("Shopify Flow durable enqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueueOutboxJobFromProgramTransaction.mockResolvedValue({
      job: { id: "woutbox_flow_1" },
      created: true,
    });
  });

  it("uses the caller transaction and a deterministic event identity", async () => {
    const tx = { transaction: "same-boundary" };
    await enqueueFlowTriggerJob({
      storeId: "wstore_1",
      eventId: "wpledger_1",
      payload: {
        accountId: "wacc_1",
        handle: "weletic-points-earned",
        pointsDelta: "25",
        pointsBalance: "150",
        reason: "order_purchase",
      },
      tx: tx as never,
    });
    expect(enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledWith({
      storeId: "wstore_1",
      jobType: "FLOW_TRIGGER",
      payload: {
        accountId: "wacc_1",
        handle: "weletic-points-earned",
        pointsDelta: "25",
        pointsBalance: "150",
        reason: "order_purchase",
      },
      idempotencyKey: "flow_trigger:weletic-points-earned:wpledger_1",
      scheduledFor: undefined,
      loyaltyMaintenancePermit: undefined,
      tx,
    });
  });
});
