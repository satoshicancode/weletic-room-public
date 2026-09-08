import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantSettingsAction } from "../../../../packages/shopify-app/app/merchant-settings-action.server";
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

describe("Remix shared-settings signed transport adapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.api.mockResolvedValue({ revision: 1 });
  });
  const actor = {
    version: 1 as const,
    appId: "app-a",
    storeId: "store-a",
    shop: "fixture.myshopify.com",
    installationGeneration: "g1",
    userId: "123",
    sessionId: "fixture.myshopify.com_123",
    sessionDigest: "a".repeat(64),
    authenticatedAt: Date.now(),
    requestId: "b".repeat(64),
  };
  function setup() {
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
      ["scope", "read_products"],
      ["associatedUserScope", "read_products"],
      ["expires", Date.now() + 60000],
      ["accessToken", "synthetic-online"],
    ]);
    if (!session) throw new Error("Invalid fixture");
    const withActor: Parameters<
      typeof createMerchantSettingsAction
    >[0] = async (request, action) => {
      await authenticate(request);
      return action({ actor, session });
    };
    return { authenticate, handle: createMerchantSettingsAction(withActor) };
  }
  const incoming = (value: unknown) =>
    new Request("https://fixture.invalid/api/merchant/settings", {
      method: "POST",
      headers: { authorization: "Bearer synthetic" },
      body: JSON.stringify(value),
    });
  const read = { operation: "read", input: {} };
  const update = {
    operation: "update",
    input: {
      expectedRevision: 0,
      expectedInstallationGeneration: "g1",
      settings: { shopperEmailPaused: true },
    },
  };
  it.each([
    read,
    update,
    {
      operation: "review-module",
      input: {
        enabled: false,
        expectedUpdatedAt: null,
        expectedInstallationGeneration: "g1",
      },
    },
  ])(
    "forwards only authenticated actor and validated $operation request",
    async (value) => {
      const { authenticate, handle } = setup();
      const request = incoming(value);
      const response = await handle(request);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(authenticate).toHaveBeenCalledWith(request);
      expect(mocks.api).toHaveBeenCalledWith(
        "/api/internal/shopify/merchant/settings",
        expect.objectContaining({
          method: "POST",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toEqual({
        actor,
        request: value,
      });
    },
  );
  it.each([
    { ...read, actor },
    { ...read, workspaceId: "other" },
    { operation: "read", input: { role: "owner" } },
    { operation: "module", input: { enabled: true } },
    {
      operation: "update",
      input: { ...update.input, settings: { brandName: "x".repeat(17000) } },
    },
  ])("rejects invalid input before authentication: %j", async (value) => {
    const { authenticate, handle } = setup();
    expect((await handle(incoming(value))).status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("rejects GET and malformed JSON without forwarding", async () => {
    const { authenticate, handle } = setup();
    expect(
      (
        await handle(
          new Request("https://fixture.invalid/api/merchant/settings"),
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handle(
          new Request("https://fixture.invalid/api/merchant/settings", {
            method: "POST",
            body: "{",
          }),
        )
      ).status,
    ).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });
  it("never forwards after authentication denial", async () => {
    const { authenticate, handle } = setup();
    authenticate.mockRejectedValue(new WeleticGatewayError("private", 401));
    const response = await handle(incoming(update));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it.each([400, 401, 403, 404, 409, 413, 503])(
    "sanitizes status %s and never retries an uncertain write",
    async (status) => {
      const { handle } = setup();
      mocks.api.mockRejectedValue(
        new WeleticGatewayError("private internal error", status),
      );
      const response = await handle(incoming(update));
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain("private internal error");
      expect(mocks.api).toHaveBeenCalledOnce();
    },
  );
});
