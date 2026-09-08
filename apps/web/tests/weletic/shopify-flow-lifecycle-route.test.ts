import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { persistShopifyFlowLifecycleEvent } = vi.hoisted(() => ({
  persistShopifyFlowLifecycleEvent: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/flow-lifecycle", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/weletic/loyalty/flow-lifecycle")
    >();
  return { ...original, persistShopifyFlowLifecycleEvent };
});

import { POST } from "../../app/(ee)/api/shopify/flow/lifecycle/route";

describe("Shopify Flow lifecycle callback", () => {
  const secret = "flow-lifecycle-test-secret-at-least-32-bytes";
  const payload = {
    flow_trigger_definition_id: "Weletic points earned",
    has_enabled_flow: true,
    shop_id: "690933842",
    shopify_domain: "shop.myshopify.com",
    timestamp: "2026-09-05T12:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SHOPIFY_WEBHOOK_SECRET = secret;
    persistShopifyFlowLifecycleEvent.mockResolvedValue({
      status: "updated",
      storeId: "wstore_1",
    });
  });

  function request(body: string, signature?: string) {
    return new Request("https://app.weletic.com/api/shopify/flow/lifecycle", {
      method: "POST",
      headers: signature ? { "x-shopify-hmac-sha256": signature } : undefined,
      body,
    });
  }

  it("verifies the exact raw body HMAC before persisting", async () => {
    const body = JSON.stringify(payload);
    const signature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("base64");
    const response = await POST(request(body, signature));

    expect(response.status).toBe(200);
    expect(persistShopifyFlowLifecycleEvent).toHaveBeenCalledWith(payload);
  });

  it("rejects invalid signatures without writing state", async () => {
    const response = await POST(request(JSON.stringify(payload), "invalid"));
    expect(response.status).toBe(401);
    expect(persistShopifyFlowLifecycleEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed lifecycle payloads after authentication", async () => {
    const body = JSON.stringify({ ...payload, timestamp: "not-a-date" });
    const signature = crypto
      .createHmac("sha256", secret)
      .update(body)
      .digest("base64");
    const response = await POST(request(body, signature));
    expect(response.status).toBe(400);
    expect(persistShopifyFlowLifecycleEvent).not.toHaveBeenCalled();
  });
});
