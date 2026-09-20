import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantFlowGrantsAction } from "../../../../packages/shopify-app/app/merchant-flow-grants-action.server";
import { deserializeShopifySession } from "../../../../packages/shopify-app/app/session-properties.server";
const mocks = vi.hoisted(() => ({ api: vi.fn(), authenticate: vi.fn() }));
vi.mock(
  "../../../../packages/shopify-app/app/weletic-api.server",
  async (original) => ({
    ...(await original<
      typeof import("../../../../packages/shopify-app/app/weletic-api.server")
    >()),
    weleticApiJson: mocks.api,
  }),
);
const actor = {
  version: 1 as const,
  appId: "public-app",
  storeId: "store-a",
  shop: "fixture.myshopify.com",
  installationGeneration: "g1",
  userId: "123",
  sessionId: "fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: Date.now(),
  requestId: "b".repeat(64),
};
const attemptId = "c".repeat(64);
const grantId = `wflowgrant_${"a".repeat(20)}`;
const create = {
  operation: "create",
  attemptId,
  input: {
    allowCredit: true,
    allowDebit: false,
    maxAbsolutePointsPerAction: "100",
    absolutePointsBudget: "1000",
    expiresAt: "2030-01-01T00:00:00.000Z",
    expectedRevision: 0,
    expectedInstallationGeneration: "g1",
  },
};
const list = {
  grants: [],
  nextCursor: null,
  installationGeneration: "g1",
  observedAt: "2026-09-20T00:00:00.000Z",
};
const authenticate: Parameters<
  typeof createMerchantFlowGrantsAction
>[0] = async (request, operation) => {
  await mocks.authenticate(request);
  const session = deserializeShopifySession([
    ["id", actor.sessionId],
    ["shop", actor.shop],
    ["state", ""],
    ["isOnline", true],
    ["userId", 123],
    ["accountOwner", true],
    ["collaborator", false],
    ["scope", "read_products"],
    ["associatedUserScope", "read_products"],
    ["expires", Date.now() + 60000],
    ["accessToken", "synthetic-online"],
  ]);
  if (!session) throw new Error("Invalid synthetic session fixture");
  return operation({ actor, session });
};
const handle = createMerchantFlowGrantsAction(authenticate);
const request = (value: unknown) =>
  new Request("https://example.invalid/api/merchant/flow-grants", {
    method: "POST",
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.api.mockResolvedValue({ id: grantId, revision: 1, revokedAt: null });
});
describe("embedded Flow grant adapter (mocked Shopify identity/gateway)", () => {
  it("uses the stable attempt nonce without accepting browser authority fields", async () => {
    expect((await handle(request(create))).status).toBe(200);
    const dispatched = JSON.parse(mocks.api.mock.calls[0][1].body);
    expect(dispatched).toEqual({
      actor: { ...actor, requestId: attemptId },
      operation: "create",
      input: create.input,
    });
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
  it.each(["actor", "store", "attempt", "numeric"])(
    "rejects invalid %s before authentication or gateway",
    async (field) => {
      const value: any = structuredClone(create);
      if (field === "actor") value.actor = actor;
      if (field === "store") value.input.storeId = "foreign";
      if (field === "attempt") delete value.attemptId;
      if (field === "numeric") value.input.absolutePointsBudget = 1000;
      expect((await handle(request(value))).status).toBe(400);
      expect(mocks.authenticate).not.toHaveBeenCalled();
      expect(mocks.api).not.toHaveBeenCalled();
    },
  );
  it("bootstraps list generation only from the authenticated actor", async () => {
    mocks.api.mockResolvedValue(list);
    expect(
      (await handle(request({ operation: "list", input: {} }))).status,
    ).toBe(200);
    expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toEqual({
      actor,
      operation: "list",
      input: { limit: 20, expectedInstallationGeneration: "g1" },
    });
  });
  it("preserves a prior approval nonce for authenticated read-back", async () => {
    mocks.api.mockResolvedValue(list);
    expect(
      (
        await handle(
          request({
            operation: "list",
            input: { approvalRequestId: attemptId },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      JSON.parse(mocks.api.mock.calls[0][1].body).input.approvalRequestId,
    ).toBe(attemptId);
  });
  it("rejects changed installation generation without dispatch", async () => {
    expect(
      (
        await handle(
          request({
            ...create,
            input: { ...create.input, expectedInstallationGeneration: "g2" },
          }),
        )
      ).status,
    ).toBe(409);
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it.each([
    { revision: 2 },
    { revokedAt: "2026-09-20T00:00:00.000Z" },
    { owner: true },
  ])("rejects mismatched create acknowledgement %j", async (change) => {
    mocks.api.mockResolvedValue({
      id: grantId,
      revision: 1,
      revokedAt: null,
      ...change,
    });
    expect((await handle(request(create))).status).toBe(503);
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
  it("validates revoke identity and revision", async () => {
    const revoke = {
      operation: "revoke",
      attemptId,
      input: {
        grantId,
        expectedRevision: 1,
        expectedInstallationGeneration: "g1",
      },
    };
    mocks.api.mockResolvedValue({
      id: grantId,
      revision: 2,
      revokedAt: "2026-09-20T00:00:00.000Z",
    });
    expect((await handle(request(revoke))).status).toBe(200);
    mocks.api.mockResolvedValue({
      id: `wflowgrant_${"z".repeat(20)}`,
      revision: 2,
      revokedAt: "2026-09-20T00:00:00.000Z",
    });
    expect((await handle(request(revoke))).status).toBe(503);
  });
  it("does not accept another installation's list", async () => {
    mocks.api.mockResolvedValue({ ...list, installationGeneration: "g2" });
    expect(
      (await handle(request({ operation: "list", input: {} }))).status,
    ).toBe(503);
  });
  it("contains failures without retrying the mutation", async () => {
    mocks.api.mockRejectedValue(new Error("sensitive upstream details"));
    const result = await handle(request(create));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("sensitive");
    expect(mocks.api).toHaveBeenCalledTimes(1);
  });
});
