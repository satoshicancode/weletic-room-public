import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantCommunicationsAction } from "../../../../packages/shopify-app/app/merchant-communications-action.server";
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
  new Request("https://app.example/api/merchant/communications", {
    method: "POST",
    body: JSON.stringify(value),
  });
beforeEach(() => vi.resetAllMocks());
it.each([
  [401, "unauthorized"],
  [403, "access_denied"],
  [409, "state_changed"],
  [503, "communications_unavailable"],
])(
  "sanitizes async %s authentication/gateway failure",
  async (status, error) => {
    const authenticate = vi
      .fn()
      .mockRejectedValue(new WeleticGatewayError("private", status as number));
    const result =
      await createMerchantCommunicationsAction(authenticate)(request());
    expect(result.status).toBe(status);
    expect(await result.json()).toEqual({ error });
  },
);
it("passes authenticated actor with request and validates the acknowledgement", async () => {
  const actor = { fixture: "authenticated actor" };
  const authenticate = vi
    .fn()
    .mockImplementation(async (_request, callback) => callback({ actor }));
  const response = {
    storeId: "store",
    installationGeneration: "generation",
    revision: "a".repeat(64),
    capabilities: { configure: false },
    deliveryIntegration: "not_connected",
    policies: [],
  };
  vi.mocked(weleticApiJson).mockResolvedValue(response);
  const result =
    await createMerchantCommunicationsAction(authenticate)(request());
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual(response);
  expect(weleticApiJson).toHaveBeenCalledWith(
    "/api/internal/shopify/merchant/communications",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ actor, request: { operation: "read" } }),
    }),
  );
  vi.mocked(weleticApiJson).mockResolvedValue({
    ...response,
    deliveryIntegration: "active",
  });
  expect(
    (await createMerchantCommunicationsAction(authenticate)(request())).status,
  ).toBe(503);
});
it("rejects method, oversized body and injected fields before authentication", async () => {
  const authenticate = vi.fn();
  const handler = createMerchantCommunicationsAction(authenticate);
  expect(
    (
      await handler(
        new Request("https://app.example/api/merchant/communications"),
      )
    ).status,
  ).toBe(405);
  expect(
    (await handler(request({ padding: "x".repeat(129 * 1024) }))).status,
  ).toBe(400);
  expect(
    (await handler(request({ operation: "read", storeId: "other" }))).status,
  ).toBe(400);
  expect(authenticate).not.toHaveBeenCalled();
});
