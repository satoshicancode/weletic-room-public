import { prisma } from "@/lib/prisma";
import { scheduleReviewPointsRecovery } from "./points-recovery-scheduling";
import { withReviewMutation } from "./transaction";

/** Reconcile promises created before recovery existed or whose enrollment
 * wake-up was missed. Existing queue identities (including dead letters) are
 * excluded, not reset. Writes recheck ownership under the store fence.
 */
export async function enqueueReviewPointsRecoverySweep({
  batchSize = 50,
}: { batchSize?: number } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
    throw new Error("Invalid review recovery batch size");
  const candidates = await prisma.$queryRaw<
    Array<{
      id: string;
      storeId: string;
      shopperId: string;
      installationGeneration: string;
      recoveryDiscoveryCheckedAt: Date | null;
    }>
  >`
    SELECT c.id, c.storeId, c.shopperId, s.installationGeneration,
      c.recoveryDiscoveryCheckedAt
    FROM WeleticReviewIncentiveClaim c
    JOIN WeleticShopifyStore s ON s.id = c.storeId
    JOIN WeleticReviewSettings r ON r.storeId = c.storeId AND r.enabled = TRUE
    JOIN WeleticLoyaltyProgram p ON p.storeId = c.storeId
      AND p.status = 'active' AND p.killSwitchActive = FALSE
    JOIN WeleticLoyaltyAccount a ON a.storeId = c.storeId
      AND a.shopperId = c.shopperId AND a.status = 'active'
    WHERE c.status = 'reserved' AND c.subjectType = 'product'
      AND s.complianceState = 'active' AND s.storeAccessState = 'active'
      AND s.installationGeneration IS NOT NULL
      AND JSON_UNQUOTE(JSON_EXTRACT(c.awardSnapshot, '$.kind')) = 'points'
      AND JSON_UNQUOTE(JSON_EXTRACT(c.validationSnapshot, '$.installationGeneration'))
        = s.installationGeneration
      AND NOT EXISTS (
        SELECT 1 FROM WeleticLoyaltyOutboxJob j
        WHERE j.storeId = c.storeId
          AND j.idempotencyKey = CONCAT('review_points_recovery:', c.id)
      )
    ORDER BY c.recoveryDiscoveryCheckedAt ASC, c.id ASC
    LIMIT ${batchSize}
  `;
  let enqueued = 0;
  let deferred = 0;
  for (const candidate of candidates) {
    try {
      // Discovery bookkeeping must progress even when financial maintenance
      // blocks scheduling. This conditional update touches no promise, ledger,
      // eligibility or provenance field, and cannot revive scrubbed claims.
      const rotated = await prisma.weleticReviewIncentiveClaim.updateMany({
        where: {
          id: candidate.id,
          storeId: candidate.storeId,
          shopperId: candidate.shopperId,
          status: "reserved",
          subjectType: "product",
          recoveryDiscoveryCheckedAt: candidate.recoveryDiscoveryCheckedAt,
          validationSnapshot: {
            path: "$.installationGeneration",
            equals: candidate.installationGeneration,
          },
        },
        data: { recoveryDiscoveryCheckedAt: new Date() },
      });
      if (rotated.count !== 1) {
        deferred++;
        continue;
      }
      const result = await withReviewMutation(
        candidate.storeId,
        (tx) =>
          scheduleReviewPointsRecovery({
            tx,
            storeId: candidate.storeId,
            claimId: candidate.id,
            shopperId: candidate.shopperId,
            installationGeneration: candidate.installationGeneration,
          }),
        candidate.installationGeneration,
      );
      if (result.created) enqueued++;
    } catch {
      // Pause/privacy/reinstall can race the read. Preserve financial/promise state;
      // report a count without leaking customer or provider details.
      deferred++;
    }
  }
  return { scanned: candidates.length, enqueued, deferred };
}
