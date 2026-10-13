import { defineJob } from "@/lib/jobs";
import {
  refreshScheduledSubscription,
  subscriptionJobSchema,
} from "@/lib/weletic/shopify/app-pricing-schedule";
export const weleticShopifySubscriptionJob = defineJob({
  name: "weletic-shopify-subscription-job",
  schema: subscriptionJobSchema,
  defaults: {
    retries: 2,
    flowControl: {
      key: "weletic-shopify-subscription",
      parallelism: 1,
      rate: 2,
      period: "1s",
    },
  },
  async handle(input) {
    await refreshScheduledSubscription(input);
  },
});
