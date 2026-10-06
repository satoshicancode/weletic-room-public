-- AlterTable
DROP INDEX `WeleticLoyaltyOutboxJob_status_scheduledFor_nextRetryAt_idx` ON `WeleticLoyaltyOutboxJob`;
CREATE INDEX `WeleticLoyaltyOutboxJob_status_scheduledFor_priority_nextRetryAt_idx` ON `WeleticLoyaltyOutboxJob`(`status`, `scheduledFor`, `priority`, `nextRetryAt`);
