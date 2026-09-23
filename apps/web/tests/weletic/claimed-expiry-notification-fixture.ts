import { sendPointsExpiryNotification } from "@/lib/weletic/loyalty/points-expiry-notifications";
import { vi } from "vitest";

/** Synthetic worker lease for policy/rendering tests; SQL suites verify ownership. */
export function sendClaimedExpiryNotification(
  args: Parameters<typeof sendPointsExpiryNotification>[0],
) {
  const now = args.now ?? new Date("2026-09-01T00:00:00Z");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const payload = { ...args.payload, installationGeneration: "g1" };
  return sendPointsExpiryNotification({
    ...args,
    payload,
    expectedInstallationGeneration: "g1",
    deliveryClaim: {
      candidate: {
        id: "policy-fixture-job",
        storeId: args.storeId,
        jobType: "INACTIVITY_EXPIRY",
        status: "processing",
        idempotencyKey: "policy-fixture-key",
        payload,
        scheduledFor: now,
        createdAt: now,
        updatedAt: now,
        attempts: 1,
        maxAttempts: 5,
        priority: 0,
        lockedAt: now,
        lockedBy: "policy-worker",
        processedAt: null,
        completedAt: null,
        lastError: null,
        nextRetryAt: null,
        errorLog: [],
      },
      ownerToken: "policy-worker",
      claimedAt: now,
      attempt: 1,
    },
  });
}
