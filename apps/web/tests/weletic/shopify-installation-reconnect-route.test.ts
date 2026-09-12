import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/installation/reconnect/route";
import { signWeleticShopifyRequest } from "../../lib/weletic/shopify/service-auth";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  observe: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock(
  "../../lib/weletic/shopify/installation-reconnect",
  async (original) => ({
    ...(await original<
      typeof import("../../lib/weletic/shopify/installation-reconnect")
    >()),
    observePendingInstallationReconnect: mocks.observe,
    preparePendingInstallationReconnect: mocks.prepare,
  }),
);
const secret = "synthetic-service-secret-for-reconnect-tests";
const path = "/api/internal/shopify/installation/reconnect";
const identity = {
  appId: "test-app",
  shop: "test.myshopify.com",
  userId: "123",
  issuedAt: 100,
  expiresAt: 150,
};
const observation = {
  expectedRevision: 2,
  expectedInstallationGeneration: "old",
};
function request(
  body: string,
  signedBody = body,
  signedPath = path,
  timestamp = String(Date.now()),
) {
  return new Request(`https://backend.invalid${path}`, {
    method: "POST",
    body,
    headers: {
      "x-weletic-timestamp": timestamp,
      "x-weletic-signature": signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path: signedPath,
        body: signedBody,
        secret,
      }),
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
  mocks.transaction.mockImplementation((callback) => callback({}));
  mocks.observe.mockResolvedValue(observation);
  mocks.prepare.mockResolvedValue({ status: "pending_approval" });
});
afterEach(() => vi.unstubAllEnvs());
describe("reconnect HTTP boundary with real service HMAC", () => {
  it.each(["observe", "prepare"])(
    "dispatches signed %s only through a transaction",
    async (operation) => {
      const body = JSON.stringify({
        operation,
        identity,
        ...(operation === "prepare" ? { observation } : {}),
      });
      const response = await POST(request(body));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(await response.json()).toEqual(
        operation === "observe" ? observation : { status: "pending_approval" },
      );
    },
  );
  it.each(["tampered-body", "wrong-path", "stale-signature", "unsigned"])(
    "rejects %s before database access",
    async (kind) => {
      const body = JSON.stringify({ operation: "observe", identity });
      const input =
        kind === "unsigned"
          ? new Request(`https://backend.invalid${path}`, {
              method: "POST",
              body,
            })
          : request(
              body,
              kind === "tampered-body" ? "{}" : body,
              kind === "wrong-path" ? "/different" : path,
              String(Date.now() - (kind === "stale-signature" ? 600_000 : 0)),
            );
      expect((await POST(input)).status).toBe(401);
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    "not-json",
    JSON.stringify({
      operation: "prepare",
      identity,
      observation,
      approve: true,
    }),
    "x".repeat(4097),
  ])("rejects invalid or oversized signed payload", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("returns a fixed failure without leaking transaction details", async () => {
    mocks.prepare.mockRejectedValue(new Error("private database detail"));
    const response = await POST(
      request(JSON.stringify({ operation: "prepare", identity, observation })),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "reconnect_unavailable" });
  });
});
