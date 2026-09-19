-- Additive only. Apply to a fresh isolated rehearsal database first.
-- Shared/production application requires separate scoped approval.
-- Rollout: pause review email writers; add column; deploy compatible readers,
-- writers and privacy cleanup; verify; resume. Do not roll back to an old email
-- writer after evidence exists: it can rebuild a different body under the same key.
-- Never drop retained evidence to force a resend of an ambiguous attempt.
ALTER TABLE `WeleticReviewRequest`
  ADD COLUMN `encryptedDeliverySnapshot` MEDIUMTEXT NULL,
  ADD INDEX `review_request_retention_expiry` (`expiresAt`, `id`);
