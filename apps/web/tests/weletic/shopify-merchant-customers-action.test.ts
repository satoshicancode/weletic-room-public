import { beforeEach, describe, expect, it, vi } from "vitest";
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

describe("authenticated Remix Customers adapters", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.api.mockResolvedValue({
      items: [],
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    });
  });
  const actor = {
    version: 1 as const,
    appId: "app-a",
    storeId: "store-a",
    shop: "fixture.myshopify.com",
    installationGeneration: "generation-a",
    userId: "123",
    sessionId: "fixture.myshopify.com_123",
    sessionDigest: "a".repeat(64),
    authenticatedAt: Date.now(),
    requestId: "b".repeat(64),
  };
  function setup(operation: "customers" | "customer-profile") {
    const authenticate = vi
      .fn<(request: Request) => Promise<void>>()
      .mockResolvedValue(undefined);
    const session = deserializeShopifySession([
      ["id", actor.sessionId],
      ["shop", actor.shop],
      ["state", ""],
      ["isOnline", true],
      ["userId", 123],
      ["accountOwner", false],
      ["collaborator", false],
      ["scope", "read_customers"],
      ["associatedUserScope", "read_customers"],
      ["expires", Date.now() + 60000],
      ["accessToken", "synthetic-online"],
    ]);
    if (!session) throw new Error("Invalid session fixture");
    const withActor: Parameters<typeof createMerchantAction>[0] = async (
      request,
      action,
    ) => {
      await authenticate(request);
      return action({ actor, session });
    };
    return {
      authenticate,
      handle: createMerchantAction(withActor, operation),
    };
  }
  function request(input: unknown) {
    return new Request("https://fixture.invalid/api/merchant/customers", {
      method: "POST",
      headers: { authorization: "Bearer synthetic" },
      body: JSON.stringify(input),
    });
  }
  it.each([
    ["customers", {}, "/api/internal/shopify/merchant/customers/list"],
    [
      "customer-profile",
      { shopperId: "shopper-a" },
      "/api/internal/shopify/merchant/customers/profile",
    ],
  ] as const)(
    "forwards %s through authenticated actor and a bounded signed transport",
    async (operation, input, path) => {
      const { authenticate, handle } = setup(operation);
      const incoming = request(input);
      const response = await handle(incoming);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(authenticate.mock.calls[0][0]).toBe(incoming);
      expect(mocks.api).toHaveBeenCalledWith(
        path,
        expect.objectContaining({
          method: "POST",
          signal: expect.any(AbortSignal),
        }),
      );
      const envelope = JSON.parse(mocks.api.mock.calls[0][1].body);
      expect(envelope.actor).toEqual(actor);
      expect(envelope.input).toMatchObject(input);
      expect(Object.keys(envelope).sort()).toEqual(["actor", "input"]);
    },
  );
  it.each(["customers", "customer-profile"] as const)(
    "rejects identity injection on %s before authentication",
    async (operation) => {
      const { authenticate, handle } = setup(operation);
      const response = await handle(
        request({ shopperId: "shopper-a", actor, workspaceId: "other" }),
      );
      expect(response.status).toBe(400);
      expect(authenticate).not.toHaveBeenCalled();
      expect(mocks.api).not.toHaveBeenCalled();
    },
  );
  it("does not forward a request after authentication denies it", async () => {
    const { authenticate, handle } = setup("customers");
    authenticate.mockRejectedValue(
      new WeleticGatewayError("private identity error", 401),
    );
    const result = await handle(request({}));
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "unauthorized" });
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409, 503])(
    "sanitizes profile status %s without retry",
    async (status) => {
      const { handle } = setup("customer-profile");
      mocks.api.mockRejectedValue(
        new WeleticGatewayError("private backend detail", status),
      );
      const response = await handle(request({ shopperId: "shopper-a" }));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("private backend detail");
      expect(mocks.api).toHaveBeenCalledOnce();
    },
  );
  it("rejects GET and oversized JSON without forwarding", async () => {
    const { handle, authenticate } = setup("customers");
    expect(
      (
        await handle(
          new Request("https://fixture.invalid/api/merchant/customers"),
        )
      ).status,
    ).toBe(405);
    expect((await handle(request({ search: "x".repeat(17000) }))).status).toBe(
      400,
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
