import {
  ReviewMediaCleanupPayloadSchema,
  ReviewRequestEmailPayloadSchema,
  ReviewSummarySyncPayloadSchema,
} from "@/lib/weletic/loyalty/outbox";
import { WeleticLoyaltyOutboxJob } from "@prisma/client";
import { deliverReviewRequest } from "./email";
import { cleanupReviewPhoto } from "./media";
import { deliverReviewReminder } from "./reminder-email";
import { deliverStoreReviewRequest } from "./store-email";
import {
  enqueueReviewSummaryPage,
  syncProductReviewSummary,
} from "./summary-sync";

export async function executeNativeReviewJob(job: WeleticLoyaltyOutboxJob) {
  switch (job.jobType) {
    case "REVIEW_REQUEST_EMAIL": {
      const payload = ReviewRequestEmailPayloadSchema.parse(job.payload);
      if ("storeRequestId" in payload) {
        await deliverStoreReviewRequest({
          storeId: job.storeId,
          requestId: payload.storeRequestId,
          installationGeneration: payload.installationGeneration,
        });
        break;
      }
      if (payload.reminderId) {
        if (!payload.installationGeneration)
          throw new Error("Reminder generation required");
        await deliverReviewReminder({
          storeId: job.storeId,
          requestId: payload.requestId,
          reminderId: payload.reminderId,
          installationGeneration: payload.installationGeneration,
        });
        break;
      }
      await deliverReviewRequest(
        job.storeId,
        payload.requestId,
        payload.installationGeneration ?? null,
      );
      break;
    }
    case "REVIEW_SUMMARY_SYNC": {
      const payload = ReviewSummarySyncPayloadSchema.parse(job.payload);
      if (payload.productId === "*") {
        await enqueueReviewSummaryPage({
          storeId: job.storeId,
          generation: payload.installationGeneration ?? null,
          revision: payload.revision ?? job.id,
          afterProductId: payload.afterProductId,
        });
        break;
      }
      await syncProductReviewSummary(
        job.storeId,
        payload.productId,
        payload.installationGeneration ?? null,
      );
      break;
    }
    case "REVIEW_MEDIA_CLEANUP": {
      const payload = ReviewMediaCleanupPayloadSchema.parse(job.payload);
      await cleanupReviewPhoto(job.storeId, payload.mediaId);
      break;
    }
    default:
      throw new Error("Unsupported native review job");
  }
}
