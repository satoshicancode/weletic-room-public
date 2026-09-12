import { DEFAULT_LOYALTY_BRANDING } from "@/lib/weletic/loyalty/branding";
import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantLoyaltyAppearanceAction } from "../../../../packages/shopify-app/app/merchant-loyalty-appearance-action.server";
import {
  weleticApiJson,
  WeleticGatewayError,
} from "../../../../packages/shopify-app/app/weletic-api.server";
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
const request = (value: unknown = { operation: "read" }) =>
  new Request("https://app.example.test/api/merchant/loyalty-appearance", {
    method: "POST",
    body: JSON.stringify(value),
  });
beforeEach(() => vi.resetAllMocks());
it.each([
  [401, "unauthorized"],
  [403, "access_denied"],
  [409, "state_changed"],
  [503, "appearance_unavailable"],
])("sanitizes asynchronous %s errors", async (status, error) => {
  const authenticate = vi
    .fn()
    .mockRejectedValue(
      new WeleticGatewayError("private recipient or token", status as number),
    );
  const result =
    await createMerchantLoyaltyAppearanceAction(authenticate)(request());
  expect(result.status).toBe(status);
  expect(await result.json()).toEqual({ error });
  expect(weleticApiJson).not.toHaveBeenCalled();
});
it("forwards only authenticated actor and verified input with a bounded request", async () => {
  const actor = { signedFixture: true };
  const authenticate = vi
    .fn()
    .mockImplementation(async (_request, callback) => callback({ actor }));
  const response = {
    storeId: "store-1",
    installationGeneration: "generation-1",
    revision: "a".repeat(64),
    programConfigured: true,
    capabilities: { configure: true },
    branding: { ...DEFAULT_LOYALTY_BRANDING },
  };
  vi.mocked(weleticApiJson).mockResolvedValue(response);
  const result =
    await createMerchantLoyaltyAppearanceAction(authenticate)(request());
  expect(result.status).toBe(200);
  expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await result.json()).toEqual(response);
  expect(weleticApiJson).toHaveBeenCalledWith(
    "/api/internal/shopify/merchant/loyalty-appearance",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ actor, request: { operation: "read" } }),
      signal: expect.any(AbortSignal),
    }),
  );
});
it("rejects method, oversized body, injected ownership and invalid JSON before authentication", async () => {
  const authenticate = vi.fn();
  const run = createMerchantLoyaltyAppearanceAction(authenticate);
  expect((await run(new Request("https://app.example.test"))).status).toBe(405);
  expect((await run(request({ padding: "x".repeat(33 * 1024) }))).status).toBe(
    400,
  );
  expect(
    (await run(request({ operation: "read", storeId: "foreign" }))).status,
  ).toBe(400);
  expect(
    (
      await run(
        new Request("https://app.example.test", { method: "POST", body: "{" }),
      )
    ).status,
  ).toBe(400);
  expect(authenticate).not.toHaveBeenCalled();
});
