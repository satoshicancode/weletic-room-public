import { defineJob } from "@/lib/jobs";
import {
  listDueShopifySessionRenewals,
  shopifyRenewalSweepSchema,
} from "@/lib/weletic/shopify/session-renewal";
import { createHash } from "node:crypto";
import { weleticShopifySessionRenewalJob } from "./weletic-shopify-session-renewal-job";

export const weleticShopifySessionRenewalSweepJob = defineJob({
  name: "weletic-shopify-session-renewal-sweep-job",
  schema: shopifyRenewalSweepSchema,
  defaults: {
    retries: 3,
    flowControl: {
      key: "weletic-shopify-session-renewal-sweep",
      parallelism: 1,
    },
  },
  async handle(input) {
    const { jobs, nextCursor } = await listDueShopifySessionRenewals(input);
    const dispatch = await weleticShopifySessionRenewalJob.dispatchBatch(
      jobs,
      (job) => ({
        deduplicationId: createHash("sha256")
          .update(JSON.stringify(job))
          .digest("hex"),
      }),
    );
    if (dispatch.failed > 0)
      throw new Error("Shopify renewal dispatch unavailable");
    // Failed publication is retained by the existing Job recovery mechanism.
    // Advance by stores scanned, not successful renewals; one unhealthy store
    // cannot prevent dispatch to later stores in the same sweep.
    if (nextCursor) {
      const continuation = {
        ...input,
        afterId: nextCursor,
      };
      await weleticShopifySessionRenewalSweepJob.dispatch(continuation, {
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
