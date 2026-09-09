import { describe, expect, it, vi } from "vitest";
import { createMerchantAnalyticsAction } from "../../../../packages/shopify-app/app/merchant-analytics-action.server";
import { WeleticGatewayError } from "../../../../packages/shopify-app/app/weletic-api.server";

vi.mock("../../../../packages/shopify-app/app/weletic-api.server", () => ({
  weleticApiJson: vi.fn(),
  WeleticGatewayError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));

describe("merchant analytics action failures", () => {
  it.each([
    [403, "access_denied"],
    [409, "state_changed"],
    [503, "analytics_unavailable"],
  ])("sanitizes asynchronous %s rejection", async (status, error) => {
    const authenticate = vi
      .fn()
      .mockRejectedValue(new WeleticGatewayError("private", status as number));
    const handler = createMerchantAnalyticsAction(authenticate);
    const result = await handler(
      new Request("https://app.example/api/merchant/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "read",
          filter: { startAt: null, endAt: null },
        }),
      }),
    );
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error });
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("rejects GET without authenticating", async () => {
    const authenticate = vi.fn();
    const result = await createMerchantAnalyticsAction(authenticate)(
      new Request("https://app.example/api/merchant/analytics"),
    );
    expect(result.status).toBe(405);
    expect(authenticate).not.toHaveBeenCalled();
  });
});
