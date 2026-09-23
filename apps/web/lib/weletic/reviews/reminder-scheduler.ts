import { prisma } from "@/lib/prisma";
import { LOYALTY_MAINTENANCE_METADATA_KEY } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import { Prisma } from "@prisma/client";
import { withReviewMutation } from "./transaction";

/** Scheduling only. A reminder row is a durable intent committed with the
 * original receipt. Queue outages/maintenance never undo that receipt. A left
 * join skips already-enqueued intents without rescanning them every cron turn.
 * Existing jobs (including dead letters) are never reset or resurrected.
 */
export async function enqueueReviewReminderJobs({
  batchSize = 50,
  now = new Date(),
}: { batchSize?: number; now?: Date } = {}) {
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("Invalid review reminder scheduling batch");
  const path = `$.${LOYALTY_MAINTENANCE_METADATA_KEY}`;
  const candidates = await prisma.$queryRaw<
    Array<{
      id: string;
      storeId: string;
      requestId: string;
      installationGeneration: string;
    }>
  >(Prisma.sql`
    SELECT r.id, r.storeId, r.requestId, r.installationGeneration
    FROM WeleticReviewReminder r
    JOIN WeleticShopifyStore s ON s.id = r.storeId
    JOIN WeleticReviewRequest q ON q.id = r.requestId AND q.storeId = r.storeId
    JOIN WeleticReviewSettings c ON c.storeId = r.storeId
    LEFT JOIN WeleticLoyaltyProgram p ON p.storeId = r.storeId
    LEFT JOIN WeleticLoyaltyOutboxJob j ON j.storeId = r.storeId
      AND j.idempotencyKey = CONCAT('review_reminder_email:', r.id)
    WHERE r.status = 'queued' AND j.id IS NULL
      AND s.storeAccessState = 'active' AND s.complianceState = 'active'
      AND s.installationGeneration = r.installationGeneration
      AND q.installationGeneration = r.installationGeneration
      AND q.status = 'sent' AND q.expiresAt > ${now}
      AND c.enabled = true AND c.requestEmailEnabled = true
      AND COALESCE(JSON_CONTAINS_PATH(p.metadata, 'one', ${path}), 0) = 0
    ORDER BY r.updatedAt ASC, r.id ASC LIMIT ${batchSize}
  `);
  const result = {
    scanned: candidates.length,
    enqueued: 0,
    alreadyQueued: 0,
    deferred: 0,
  };
  for (const candidate of candidates) {
    try {
      // Observational discovery progress, not send authority. Rotate even
      // malformed/blocked intents before the operational transaction so its
      // rollback cannot pin a poison page ahead of other company stores.
      const scanned = await prisma.weleticReviewReminder.updateMany({
        where: {
          id: candidate.id,
          storeId: candidate.storeId,
          requestId: candidate.requestId,
          installationGeneration: candidate.installationGeneration,
          status: "queued",
          request: {
            storeId: candidate.storeId,
            store: {
              storeAccessState: "active",
              complianceState: "active",
              installationGeneration: candidate.installationGeneration,
            },
          },
        },
        data: { updatedAt: now },
      });
      if (scanned.count !== 1) {
        result.deferred++;
        continue;
      }
      const created = await withReviewMutation(
        candidate.storeId,
        async (tx) => {
          const row = await tx.weleticReviewReminder.findFirst({
            where: {
              id: candidate.id,
              storeId: candidate.storeId,
              requestId: candidate.requestId,
              installationGeneration: candidate.installationGeneration,
              status: "queued",
              request: {
                storeId: candidate.storeId,
                installationGeneration: candidate.installationGeneration,
                status: "sent",
                expiresAt: { gt: now },
              },
            },
          });
          const settings = await tx.weleticReviewSettings.findUnique({
            where: { storeId: candidate.storeId },
          });
          if (!row || !settings?.enabled || !settings.requestEmailEnabled)
            return null;
          return (
            await enqueueOutboxJobFromProgramTransaction({
              tx,
              storeId: candidate.storeId,
              jobType: "REVIEW_REQUEST_EMAIL",
              payload: {
                requestId: row.requestId,
                reminderId: row.id,
                installationGeneration: row.installationGeneration,
              },
              idempotencyKey: `review_reminder_email:${row.id}`,
              scheduledFor: row.scheduledFor,
            })
          ).created;
        },
        candidate.installationGeneration,
      );
      if (created === null) result.deferred++;
      else if (created) result.enqueued++;
      else result.alreadyQueued++;
    } catch {
      // No provider or customer details in scheduler telemetry. The durable row
      // stays discoverable; caller can alert on nonzero deferred counts.
      result.deferred++;
    }
  }
  return result;
}
