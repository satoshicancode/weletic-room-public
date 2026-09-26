import { defineJob } from "@/lib/jobs";
import {
  listSubscriptionRefreshPage,
  subscriptionSweepSchema,
} from "@/lib/weletic/shopify/app-pricing-schedule";
import { createHash } from "node:crypto";
import { weleticShopifySubscriptionJob } from "./weletic-shopify-subscription-job";

export const weleticShopifySubscriptionSweepJob = defineJob({
  name: "weletic-shopify-subscription-sweep-job",
  schema: subscriptionSweepSchema,
  defaults: {
    retries: 3,
    flowControl: {
      key: "weletic-shopify-subscription-sweep",
      parallelism: 1,
    },
  },
  async handle(input) {
    const { jobs, nextCursor } = await listSubscriptionRefreshPage(input);
    const dispatch = await weleticShopifySubscriptionJob.dispatchBatch(
      jobs,
      (job) => ({
        deduplicationId: createHash("sha256")
          .update(JSON.stringify(job))
          .digest("hex"),
      }),
    );
    if (dispatch.failed > 0)
      throw new Error("Shopify subscription dispatch unavailable");
    // Failed publication is retained by the existing Job recovery mechanism.
    // Advance by stores scanned, not successful renewals; one unhealthy store
    // cannot prevent dispatch to later stores in the same sweep.
    if (nextCursor) {
      const continuation = {
        ...input,
        afterId: nextCursor,
      };
      await weleticShopifySubscriptionSweepJob.dispatch(continuation, {
        // A lost execution acknowledgement can replay this page after its child
        // was published. Keep that replay on the same continuation chain.
        deduplicationId: createHash("sha256")
          .update(
            JSON.stringify([
              continuation.appId,
              continuation.scheduledAt,
              continuation.afterId,
            ]),
          )
          .digest("hex"),
      });
    }
  },
});
