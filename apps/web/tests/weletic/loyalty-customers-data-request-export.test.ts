import { describe, expect, it } from "vitest";

import { customersDataRequest } from "../../app/(ee)/api/shopify/integration/webhook/customers-data-request";

describe("legacy Shopify customer data request handler", () => {
  it("refuses inline export delivery outside the durable compliance plane", async () => {
    await expect(
      customersDataRequest({
        workspaceId: "workspace_target",
        event: {
          shop_domain: "target.myshopify.com",
          orders_requested: [101],
          customer: { id: 42 },
        },
      }),
    ).rejects.toThrow("durable compliance ingress");
  });
});
