-- Migration: 0004_reviews_r2_video.sql
-- Description: Add video review settings, media properties, and product review provenance columns

ALTER TABLE "WeleticReviewSettings" ADD COLUMN "videoUploadsEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "WeleticProductReview" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'verified_customer';
ALTER TABLE "WeleticProductReview" ADD COLUMN "createdByUserId" TEXT;

ALTER TABLE "WeleticReviewMedia" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'photo';
ALTER TABLE "WeleticReviewMedia" ADD COLUMN "durationMs" INTEGER;
ALTER TABLE "WeleticReviewMedia" ADD COLUMN "width" INTEGER;
ALTER TABLE "WeleticReviewMedia" ADD COLUMN "height" INTEGER;
ALTER TABLE "WeleticReviewMedia" ADD COLUMN "videoCodec" TEXT;
ALTER TABLE "WeleticReviewMedia" ADD COLUMN "audioCodec" TEXT;
