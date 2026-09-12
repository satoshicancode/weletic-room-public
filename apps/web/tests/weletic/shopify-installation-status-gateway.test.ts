import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInstallationReconnectAction } from "../../../../packages/shopify-app/app/installation-reconnect-action.server";
import { createInstallationStatusAction } from "../../../../packages/shopify-app/app/installation-status-action.server";
import { createInstallationStatusClient } from "../../../../packages/shopify-app/app/installation-status-client";
import { WeleticGatewayError } from "../../../../packages/shopify-app/app/weletic-api.server";
const mocks = vi.hoisted(() => ({ gateway: vi.fn() }));
vi.mock(
  "../../../../packages/shopify-app/app/weletic-api.server",
  async (original) => ({
    ...(await original<
      typeof import("../../../../packages/shopify-app/app/weletic-api.server")
    >()),
    weleticApiJson: mocks.gateway,
  }),
);
const request = (body = "{}", method = "POST") =>
  new Request("https://app.invalid/api/installation/status", {
    method,
    ...(method === "POST" ? { body } : {}),
    headers: { Authorization: "Bearer synthetic.jwt.signature" },
  });
const actor = {
  shop: "company.myshopify.com",
  userId: "123",
  token: "never-forward-this",
  issuedAt: 100,
  expiresAt: 150,
};
describe("installation reconnect action", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("SHOPIFY_API_KEY", "public-test");
  });
  afterEach(() => vi.unstubAllEnvs());
  it("keeps observation private and performs bootstrap only after fenced preparation", async () => {
    mocks.gateway
      .mockResolvedValueOnce({
        expectedRevision: 3,
        expectedInstallationGeneration: "private-generation",
      })
      .mockResolvedValueOnce({ status: "pending_approval" });
    const bootstrap = vi
      .fn()
      .mockResolvedValue({ session: { accessToken: "never-return" } });
    const response = await createInstallationReconnectAction(
      vi.fn().mockResolvedValue(actor),
      bootstrap,
    )(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending_approval" });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(mocks.gateway.mock.invocationCallOrder[1]).toBeLessThan(
      bootstrap.mock.invocationCallOrder[0],
    );
    expect(JSON.stringify(mocks.gateway.mock.calls)).not.toContain(actor.token);
    expect(JSON.parse(mocks.gateway.mock.calls[1][1].body)).toMatchObject({
      operation: "prepare",
      observation: {
        expectedRevision: 3,
        expectedInstallationGeneration: "private-generation",
      },
    });
  });
  it.each(["observation", "prepare", "bootstrap"])(
    "fails closed without retries on %s failure",
    async (phase) => {
      const bootstrap = vi.fn().mockResolvedValue({});
      if (phase === "observation")
        mocks.gateway.mockRejectedValueOnce(new Error("private-error"));
      else {
        mocks.gateway.mockResolvedValueOnce({
          expectedRevision: 3,
          expectedInstallationGeneration: "private-generation",
        });
        if (phase === "prepare")
          mocks.gateway.mockRejectedValueOnce(new Error("private-error"));
        else {
          mocks.gateway.mockResolvedValueOnce({ status: "pending_approval" });
          bootstrap.mockRejectedValueOnce(new Error("private-error"));
        }
      }
      const response = await createInstallationReconnectAction(
        vi.fn().mockResolvedValue(actor),
        bootstrap,
      )(request());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(
        /private-error|private-generation/,
      );
      expect(mocks.gateway).toHaveBeenCalledTimes(
        phase === "observation" ? 1 : 2,
      );
      expect(bootstrap).toHaveBeenCalledTimes(phase === "bootstrap" ? 1 : 0);
    },
  );
  it.each([
    '{"approve":true}',
    '{"shop":"foreign.myshopify.com"}',
    "null",
    "[]",
  ])("rejects browser-controlled authority %s", async (body) => {
    const verify = vi.fn();
    const bootstrap = vi.fn();
    expect(
      (
        await createInstallationReconnectAction(
          verify,
          bootstrap,
        )(request(body))
      ).status,
    ).toBe(400);
    expect(verify).not.toHaveBeenCalled();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
});
describe("installation status gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SHOPIFY_API_KEY", "public-test");
    mocks.gateway.mockResolvedValue({ status: "pending_approval" });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("attests only verified identity and does not forward bearer material", async () => {
    const verify = vi.fn().mockResolvedValue(actor);
    const response = await createInstallationStatusAction(verify)(request());
    expect(await response.json()).toEqual({ status: "pending_approval" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.gateway.mock.calls[0][0]).toBe(
      "/api/internal/shopify/installation/status",
    );
    expect(JSON.parse(mocks.gateway.mock.calls[0][1].body)).toEqual({
      appId: "public-test",
      shop: actor.shop,
      userId: actor.userId,
      issuedAt: 100,
      expiresAt: 150,
    });
  });
  it.each([
    "[]",
    "null",
    "invalid",
    '{"shop":"foreign.myshopify.com"}',
    '{"apply":true}',
  ])("rejects caller-controlled input %s", async (body) => {
    const verify = vi.fn();
    expect(
      (await createInstallationStatusAction(verify)(request(body))).status,
    ).toBe(400);
    expect(verify).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
  it("rejects GET without authentication or backend access", async () => {
    const verify = vi.fn();
    expect(
      (await createInstallationStatusAction(verify)(request("", "GET"))).status,
    ).toBe(405);
    expect(verify).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
  it("does not retry or fall back when identity verification fails", async () => {
    const verify = vi
      .fn()
      .mockRejectedValue(
        new WeleticGatewayError("synthetic-sensitive-message", 401),
      );
    const response = await createInstallationStatusAction(verify)(request());
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("synthetic-sensitive-message");
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
  it("rejects excess private fields from the backend", async () => {
    mocks.gateway.mockResolvedValue({
      status: "active",
      storeId: "private-store",
    });
    const response = await createInstallationStatusAction(
      vi.fn().mockResolvedValue(actor),
    )(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-store");
  });
  it("client uses a fresh bearer and a body with no selectable tenant", async () => {
    const token = vi.fn().mockResolvedValue("fresh-token");
    const transport = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "pending_approval" }), {
        status: 200,
      }),
    );
    expect(await createInstallationStatusClient(token, transport)()).toEqual({
      status: "pending_approval",
    });
    expect(token).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe("/api/installation/status");
    const options = transport.mock.calls[0][1];
    expect(options.body).toBe("{}");
    expect(new Headers(options.headers).get("authorization")).toBe(
      "Bearer fresh-token",
    );
  });
});
