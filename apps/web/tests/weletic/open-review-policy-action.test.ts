import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantAction } from "../../../../packages/shopify-app/app/merchant-action.server";
import { deserializeShopifySession } from "../../../../packages/shopify-app/app/session-properties.server";
import { WeleticGatewayError } from "../../../../packages/shopify-app/app/weletic-api.server";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock(
  "../../../../packages/shopify-app/app/weletic-api.server",
  async (original) => ({
    ...(await original<
      typeof import("../../../../packages/shopify-app/app/weletic-api.server")
    >()),
    weleticApiJson: mocks.api,
  }),
);
beforeEach(() => vi.resetAllMocks());
const input = {
  expectedInstallationGeneration: "generation_1",
  expectedRevision: 0,
  policy: {
    enabled: false,
    photoUploadsEnabled: false,
    maxSubmissionsPer24Hours: 3,
  },
};
const request = (value: unknown) =>
  new Request("https://fixture.invalid", {
    method: "POST",
    body: JSON.stringify(value),
  });
it.each(["read", "write"] as const)(
  "forwards %s with server-derived actor and bounded transport",
  async (operation) => {
    const actor = {
      version: 1 as const,
      appId: "app_1",
      shop: "test.myshopify.com",
      storeId: "store_1",
      installationGeneration: "generation_1",
      userId: "42",
      sessionId: "test.myshopify.com_42",
      sessionDigest: "a".repeat(64),
      authenticatedAt: Date.now(),
      requestId: "b".repeat(64),
    };
    const session = deserializeShopifySession([
      ["id", actor.sessionId],
      ["shop", actor.shop],
      ["state", ""],
      ["isOnline", true],
      ["userId", 42],
      ["accountOwner", true],
      ["collaborator", false],
      ["scope", "read_products"],
      ["associatedUserScope", "read_products"],
      ["expires", Date.now() + 60000],
      ["accessToken", "synthetic-online"],
    ]);
    if (!session) throw new Error("Invalid fixture");
    const authenticate: Parameters<typeof createMerchantAction>[0] = async (
      _request,
      action,
    ) => action({ actor, session });
    const handler = createMerchantAction(
      authenticate,
      `open-review-policy-${operation}`,
    );
    const value = operation === "read" ? {} : input;
    mocks.api.mockResolvedValue({ fixture: operation });
    const response = await handler(request(value));
    expect(response.status).toBe(200);
    expect(mocks.api).toHaveBeenCalledExactlyOnceWith(
      "/api/internal/shopify/merchant/reviews/open-policy/" + operation,
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toEqual({
      actor,
      input: value,
    });
  },
);
it.each(["read", "write"] as const)(
  "forwards %s only through authentication",
  async (operation) => {
    const authenticate = vi.fn(async (): Promise<never> => {
      throw new WeleticGatewayError("Authentication required", 401);
    });
    const handler = createMerchantAction(
      authenticate,
      `open-review-policy-${operation}`,
    );
    const value = operation === "read" ? {} : input;
    expect((await handler(request(value))).status).toBe(401);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.api).not.toHaveBeenCalled();
  },
);
it.each(["read", "write"] as const)(
  "preserves permission denials for %s, without leaking provider details",
  async (operation) => {
    const authenticate = vi.fn<() => Promise<never>>();
    // The authenticated callback/SQL gateway are covered separately; this checks
    // that the adapter does not turn denied access into an ambiguous 503.
    authenticate.mockRejectedValue(
      new WeleticGatewayError("private content", 403),
    );
    const handler = createMerchantAction(
      authenticate,
      `open-review-policy-${operation}`,
    );
    const response = await handler(request(operation === "read" ? {} : input));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access_denied" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  },
);
it("rejects injected authority and excessive payloads before authentication", async () => {
  const authenticate = vi.fn<() => Promise<never>>();
  const handler = createMerchantAction(
    authenticate,
    "open-review-policy-write",
  );
  for (const value of [
    { ...input, actor: {} },
    { ...input, body: "x".repeat(66000) },
  ]) {
    expect((await handler(request(value))).status).toBe(400);
  }
  expect(authenticate).not.toHaveBeenCalled();
});
