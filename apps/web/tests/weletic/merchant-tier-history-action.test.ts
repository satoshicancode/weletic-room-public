import { describe, expect, it, vi } from "vitest";
import { createMerchantTierHistoryExportAction } from "../../../../packages/shopify-app/app/merchant-tier-history-export-action.server";
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

const request = () =>
  new Request("https://app.example/api/merchant/analytics/tier-history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filter: {
        startAt: "2026-09-01T00:00:00.000Z",
        endAt: "2026-09-30T23:59:59.999Z",
      },
      expectedInstallationGeneration: "generation-1",
    }),
  });

describe("merchant tier-history action", () => {
  it.each([
    [403, "access_denied"],
    [409, "state_changed"],
    [503, "tier_history_unavailable"],
  ])("sanitizes asynchronous %s rejection", async (status, error) => {
    const authenticate = vi
      .fn()
      .mockRejectedValue(new WeleticGatewayError("private", status as number));
    const result =
      await createMerchantTierHistoryExportAction(authenticate)(request());
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error });
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("rejects GET and malformed payloads without authentication", async () => {
    const authenticate = vi.fn();
    const handle = createMerchantTierHistoryExportAction(authenticate);
    expect(
      (
        await handle(
          new Request(
            "https://app.example/api/merchant/analytics/tier-history",
          ),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handle(
          new Request(
            "https://app.example/api/merchant/analytics/tier-history",
            {
              method: "POST",
              body: JSON.stringify({ cursor: null }),
            },
          ),
        )
      ).status,
    ).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });
});
