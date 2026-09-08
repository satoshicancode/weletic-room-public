-- Additive invalidation outcome projections; preserve existing enum ordering.
ALTER TABLE `WeleticProductReview` MODIFY `rewardStatus` ENUM('pending', 'awarded', 'ineligible', 'reversed', 'invalidated', 'recovery_pending', 'unrecoverable') NOT NULL DEFAULT 'pending';
