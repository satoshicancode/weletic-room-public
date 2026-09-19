import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantAction } from "../../../../packages/shopify-app/app/merchant-action.server";
import { createMerchantReviewIncentivesClient } from "../../../../packages/shopify-app/app/merchant-review-incentives-client";
const api = vi.hoisted(() => vi.fn());
vi.mock("../../../../packages/shopify-app/app/weletic-api.server", () => ({
  weleticApiJson: api,
  WeleticGatewayError: class extends Error {},
}));
const transport = vi.fn<typeof fetch>();
const client = createMerchantReviewIncentivesClient(
  async () => "synthetic-token",
  transport,
);
const view = {
  revision: 0,
  installationGeneration: "g1",
  mode: "legacy",
  activePolicy: null,
  latestPolicy: null,
};
const input = {
  expectedRevision: 0,
  expectedInstallationGeneration: "g1",
  draft: { kind: "none" as const },
};
const saved = {
  policyId: "policy",
  revision: 1,
  contentDigest: "c".repeat(64),
  activated: false,
};
it("activates the exact saved revision and rejects mismatched or ambiguous responses without retry", async () => {
  const activationInput = {
    expectedRevision: 1,
    expectedInstallationGeneration: "g1",
    expectedActivePolicyId: null,
    policyId: "policy",
    contentDigest: "c".repeat(64),
  };
  const result = {
    activationId: "activation",
    policyId: "policy",
    revision: 1,
    effectiveAt: "2026-09-20T00:00:00.000Z",
  };
  transport.mockResolvedValueOnce(Response.json(result));
  expect(await client.activate(activationInput)).toEqual(result);
  expect(transport).toHaveBeenLastCalledWith(
    "/api/merchant/review-incentives/activate",
    expect.objectContaining({ body: JSON.stringify(activationInput) }),
  );
  transport.mockResolvedValueOnce(
    Response.json({ ...result, policyId: "foreign" }),
  );
  await expect(client.activate(activationInput)).rejects.toMatchObject({
    code: "unavailable",
  });
  transport.mockRejectedValueOnce(new Error("response lost"));
  const calls = transport.mock.calls.length;
  await expect(client.activate(activationInput)).rejects.toBeDefined();
  expect(transport).toHaveBeenCalledTimes(calls + 1);
});
it("validates coupon pages and rejects duplicates or a non-advancing cursor", async () => {
  transport.mockResolvedValueOnce(
    Response.json({
      items: [{ id: "reward", name: "Coupon" }],
      nextCursor: "next",
    }),
  );
  expect(await client.coupons({ query: " gift " })).toMatchObject({
    nextCursor: "next",
  });
  expect(transport).toHaveBeenLastCalledWith(
    "/api/merchant/review-incentives/coupons",
    expect.objectContaining({ body: JSON.stringify({ query: "gift" }) }),
  );
  transport.mockResolvedValueOnce(
    Response.json({ items: [], nextCursor: "next" }),
  );
  await expect(client.coupons({ cursor: "next" })).rejects.toMatchObject({
    code: "unavailable",
  });
  transport.mockResolvedValueOnce(
    Response.json({
      items: [
        { id: "reward", name: "Coupon" },
        { id: "reward", name: "Duplicate" },
      ],
      nextCursor: null,
    }),
  );
  await expect(client.coupons()).rejects.toMatchObject({ code: "unavailable" });
});
beforeEach(() => {
  vi.resetAllMocks();
});
it("reads via authenticated POST without browser store selectors", async () => {
  transport.mockResolvedValue(Response.json(view));
  expect(await client.read()).toEqual(view);
  expect(transport).toHaveBeenCalledWith(
    "/api/merchant/review-incentives/read",
    expect.objectContaining({
      method: "POST",
      body: "{}",
      cache: "no-store",
      credentials: "omit",
      headers: expect.objectContaining({
        Authorization: "Bearer synthetic-token",
      }),
    }),
  );
});
it.each([
  { ...view, privateToken: "private" },
  { ...view, revision: 1 },
  { ...view, mode: "versioned" },
])("rejects inconsistent or extra response fields", async (body) => {
  transport.mockResolvedValue(Response.json(body));
  await expect(client.read()).rejects.toMatchObject({ code: "unavailable" });
});
it("accepts only the expected next unactivated revision", async () => {
  transport.mockResolvedValueOnce(Response.json(saved));
  expect(await client.draft(input)).toEqual(saved);
  transport.mockResolvedValueOnce(Response.json({ ...saved, revision: 2 }));
  await expect(client.draft(input)).rejects.toMatchObject({
    code: "unavailable",
  });
  transport.mockResolvedValueOnce(Response.json({ ...saved, activated: true }));
  await expect(client.draft(input)).rejects.toMatchObject({
    code: "unavailable",
  });
});
it.each([
  [401, "reauthenticate"],
  [403, "denied"],
  [409, "reload"],
  [503, "unavailable"],
] as const)("maps %s without retrying a save", async (status, code) => {
  transport.mockResolvedValue(new Response(null, { status }));
  await expect(client.draft(input)).rejects.toMatchObject({ code });
  expect(transport).toHaveBeenCalledTimes(1);
});
it("does not retry ambiguous responses", async () => {
  transport.mockRejectedValue(new Error("connection lost"));
  await expect(client.draft(input)).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each(["review-incentives-read", "review-incentives-draft"] as const)(
  "routes %s through the authenticated merchant envelope",
  async (operation) => {
    const actor = { trusted: "server actor" };
    const authenticate = vi.fn(async (_request, callback) =>
      callback({ actor }),
    );
    const handle = createMerchantAction(authenticate, operation);
    const body = operation.endsWith("read") ? {} : input;
    api.mockResolvedValue(operation.endsWith("read") ? view : saved);
    expect(
      (
        await handle(
          new Request("http://localhost/api", {
            method: "POST",
            body: JSON.stringify(body),
          }),
        )
      ).status,
    ).toBe(200);
    expect(api).toHaveBeenCalledWith(
      `/api/internal/shopify/merchant/reviews/incentives/${operation.endsWith("read") ? "read" : "draft"}`,
      expect.objectContaining({ body: JSON.stringify({ actor, input: body }) }),
    );
    expect((await handle(new Request("http://localhost/api"))).status).toBe(
      405,
    );
  },
);
