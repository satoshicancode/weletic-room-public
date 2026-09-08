import { defineJob } from "@/lib/jobs";
import {
  renewInstalledShopifySession,
  shopifyRenewalJobSchema,
} from "@/lib/weletic/shopify/session-renewal";

export const weleticShopifySessionRenewalJob = defineJob({
  name: "weletic-shopify-session-renewal-job",
  schema: shopifyRenewalJobSchema,
  defaults: {
    retries: 3,
    flowControl: { key: "weletic-shopify-session-renewal", parallelism: 10 },
  },
  async handle(input) {
    await renewInstalledShopifySession(input);
  },
});
