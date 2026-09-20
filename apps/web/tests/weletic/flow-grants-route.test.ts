import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/flow-grants/route";
import { FlowGrantMutationError } from "../../lib/weletic/shopify/merchant-flow-grants";
import { signWeleticShopifyRequest } from "../../lib/weletic/shopify/service-auth";
import { ShopifyStaffAuthorizationError } from "../../lib/weletic/shopify/staff-authorization";

vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  manage: vi.fn(),
  read: vi.fn(),
}));
vi.mock("../../lib/weletic/shopify/merchant-flow-grants-read", () => ({
  readShopifyFlowGrantsInTransaction: mocks.read,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("../../lib/weletic/shopify/merchant-flow-grants", async (original) => ({
  ...(await original<
    typeof import("../../lib/weletic/shopify/merchant-flow-grants")
  >()),
  manageShopifyFlowGrantInTransaction: mocks.manage,
}));
const secret = "synthetic-service-secret-flow-grants-only";
const path = "/api/internal/shopify/merchant/flow-grants";
const tx = { fixture: true };
const actor = () => ({
  version: 1,
  appId: "app-a",
  storeId: "store-a",
  shop: "fixture.myshopify.com",
  installationGeneration: "g1",
  userId: "123",
  sessionId: "fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: Date.now(),
  requestId: "b".repeat(64),
});
const input = () => ({
  allowCredit: true,
  allowDebit: false,
  maxAbsolutePointsPerAction: "100",
  absolutePointsBudget: "1000",
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  expectedRevision: 0,
  expectedInstallationGeneration: "g1",
});
const value = () => ({ actor: actor(), operation: "create", input: input() });
function request(
  body: string,
  signedBody = body,
  signedPath = path,
  timestamp = String(Date.now()),
) {
  return new Request(`https://example.invalid${path}`, {
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
  mocks.transaction.mockImplementation((fn) => fn(tx));
  mocks.manage.mockResolvedValue({
    id: `wflowgrant_${"a".repeat(20)}`,
    revision: 1,
    revokedAt: null,
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("signed Flow grant gateway (real HMAC, mocked SQL/owner service)", () => {
  it("routes listing/recovery only through the authorized read service", async () => {
    mocks.read.mockResolvedValue({ grants: [], nextCursor: null });
    const payload = {
      actor: actor(),
      operation: "list",
      input: {
        expectedInstallationGeneration: "g1",
        approvalRequestId: "c".repeat(64),
      },
    };
    const result = await POST(request(JSON.stringify(payload)));
    expect(result.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith({
      tx,
      envelope: payload.actor,
      input: { ...payload.input, limit: 20 },
    });
    expect(mocks.manage).not.toHaveBeenCalled();
  });
  it.each(["create", "revoke"])(
    "forwards strict %s through one Serializable transaction",
    async (operation) => {
      const payload = {
        ...value(),
        operation,
        input:
          operation === "create"
            ? input()
            : {
                grantId: `wflowgrant_${"a".repeat(20)}`,
                expectedRevision: 1,
                expectedInstallationGeneration: "g1",
              },
      };
      const result = await POST(request(JSON.stringify(payload)));
      expect(result.status).toBe(200);
      expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: "Serializable",
      });
      expect(mocks.manage).toHaveBeenCalledExactlyOnceWith({
        tx,
        envelope: payload.actor,
        operation,
        input: payload.input,
      });
      expect(result.headers.get("cache-control")).toBe("private, no-store");
    },
  );
  it.each(["body", "path", "expired"])(
    "rejects invalid %s signatures before SQL",
    async (kind) => {
      const body = JSON.stringify(value());
      const result = await POST(
        request(
          kind === "body" ? body + " " : body,
          body,
          kind === "path" ? "/other" : path,
          String(Date.now() - (kind === "expired" ? 3600000 : 0)),
        ),
      );
      expect(result.status).toBe(401);
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    "operation",
    "actor",
    "unknown",
    "numeric",
    "revision",
    "generation",
  ])("rejects signed invalid %s", async (kind) => {
    const payload: any = value();
    if (kind === "operation") payload.operation = "enable_all";
    if (kind === "actor") payload.actor.owner = true;
    if (kind === "unknown") payload.input.storeId = "foreign";
    if (kind === "numeric") payload.input.absolutePointsBudget = 1000;
    if (kind === "revision") payload.input.expectedRevision = 1;
    if (kind === "generation")
      delete payload.input.expectedInstallationGeneration;
    expect((await POST(request(JSON.stringify(payload)))).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("bounds requests and rejects malformed JSON", async () => {
    expect((await POST(request("x".repeat(16385)))).status).toBe(413);
    expect((await POST(request("{"))).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each([
    ["access_denied", 403],
    ["invalid_actor", 401],
    ["request_replayed", 409],
  ] as const)("maps owner authority failure %s", async (code, status) => {
    mocks.manage.mockRejectedValue(new ShopifyStaffAuthorizationError(code));
    expect((await POST(request(JSON.stringify(value())))).status).toBe(status);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["invalid_expiry", 400],
    ["unavailable", 404],
    ["state_changed", 409],
  ] as const)("maps grant rejection %s", async (code, status) => {
    mocks.manage.mockRejectedValue(new FlowGrantMutationError(code));
    expect((await POST(request(JSON.stringify(value())))).status).toBe(status);
  });
  it("does not retry or leak an ambiguous commit failure", async () => {
    mocks.transaction.mockRejectedValue(
      new Error("private database and token details"),
    );
    const result = await POST(request(JSON.stringify(value())));
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "flow_grants_unavailable" });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});
