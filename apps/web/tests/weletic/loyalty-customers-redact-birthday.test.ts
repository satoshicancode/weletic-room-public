import { describe, expect, it } from "vitest";

import { customersRedact } from "../../app/(ee)/api/shopify/integration/webhook/customers-redact";

describe("legacy Shopify customer redact handler", () => {
  it("refuses inline mutation outside the durable compliance plane", async () => {
    await expect(
      customersRedact({
        workspaceId: "workspace_target",
        event: {
          shop_domain: "target.myshopify.com",
          orders_to_redact: [],
          customer: { id: 42 },
        },
      }),
    ).rejects.toThrow("durable compliance ingress");
  });
});
