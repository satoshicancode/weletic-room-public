import { EarningRuleWriteError } from "@/lib/weletic/loyalty/earning-rule-writer";
import { signWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { ShopifyStaffAuthorizationError } from "@/lib/weletic/shopify/staff-authorization";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { POST } from "../../app/api/internal/shopify/merchant/earning-rules/route";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), manage: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("@/lib/weletic/shopify/earning-rules", () => ({
  manageShopifyEarningRulesInTransaction: mocks.manage,
}));
const path = "/api/internal/shopify/merchant/earning-rules";
const secret = "synthetic-service-secret-for-http-tests-only";
const tx = { fixture: "transaction identity" };
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
const body = () =>
  JSON.stringify({ actor: actor(), request: { operation: "read" } });
function request(
  payload = body(),
  signedPayload = payload,
  signedPath = path,
  timestamp = String(Date.now()),
) {
  return new Request(`https://local.test${path}`, {
    method: "POST",
    body: payload,
    headers: {
      "x-weletic-timestamp": timestamp,
      "x-weletic-signature": signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path: signedPath,
        body: signedPayload,
        secret,
      }),
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
  mocks.transaction.mockImplementation(async (callback) => callback(tx));
  mocks.manage.mockResolvedValue({ fixture: "projected result" });
});
afterEach(() => vi.unstubAllEnvs());
describe("signed earning-rule HTTP route (real HMAC, mocked database/gateway)", () => {
  it.each(["save", "retire"])(
    "forwards a valid signed %s exactly once",
    async (operation) => {
      const input = {
        expectedInstallationGeneration: "g1",
        expectedRevision: "c".repeat(64),
        ruleId: "rule-a",
        ...(operation === "save"
          ? {
              rule: {
                name: "Purchase",
                description: null,
                triggerCode: "order_paid",
                priority: 0,
                multiplier: "1.0001",
                fixedPoints: null,
                maxPointsPerEvent: null,
                minOrderSubtotal: null,
                excludeDiscountedItems: false,
                excludeTaxesAndShipping: true,
                purchaseType: "both",
                subscriptionCadence: "every_payment",
                subscriptionPaymentLimit: null,
                maxEventsPerCustomer: null,
                limitInterval: null,
                conditions: null,
                isActive: false,
              },
            }
          : {}),
      };
      const data = { actor: actor(), request: { operation, input } };
      expect((await POST(request(JSON.stringify(data)))).status).toBe(200);
      expect(mocks.manage).toHaveBeenCalledExactlyOnceWith({
        tx,
        envelope: data.actor,
        request: data.request,
      });
      expect(mocks.transaction).toHaveBeenCalledTimes(1);
    },
  );
  it("verifies the body and opens one Serializable transaction", async () => {
    const payload = body();
    const response = await POST(request(payload));
    expect(response.status).toBe(200);
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
    expect(mocks.manage).toHaveBeenCalledExactlyOnceWith({
      tx,
      envelope: JSON.parse(payload).actor,
      request: { operation: "read" },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("rejects unsigned requests before any database access", async () => {
    expect(
      (
        await POST(
          new Request(`https://local.test${path}`, {
            method: "POST",
            body: body(),
          }),
        )
      ).status,
    ).toBe(401);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it.each(["actor", "operation", "path", "timestamp"])(
    "rejects tampered %s",
    async (kind) => {
      const payload = body();
      const altered =
        kind === "actor"
          ? payload.replace("store-a", "store-b")
          : kind === "operation"
            ? payload.replace("read", "retire")
            : payload;
      const response = await POST(
        request(
          altered,
          payload,
          kind === "path" ? "/other" : path,
          kind === "timestamp"
            ? String(Date.now() - 600000)
            : String(Date.now()),
        ),
      );
      expect(response.status).toBe(401);
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([
    "{",
    "x".repeat(16385),
    "あ".repeat(6000),
    JSON.stringify({ actor: {}, request: { operation: "read" } }),
  ])(
    "rejects invalid/bounded input before database access",
    async (payload) => {
      expect((await POST(request(payload))).status).toBe(400);
      expect(mocks.transaction).not.toHaveBeenCalled();
    },
  );
  it("treats stored schema errors as unavailable, not invalid client input", async () => {
    const invalid = z.string().safeParse(123);
    if (invalid.success) throw new Error("invalid test fixture");
    mocks.manage.mockRejectedValue(invalid.error);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "earning_rules_unavailable",
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
  it.each([
    [
      new EarningRuleWriteError({
        code: "conflict",
        message: "private detail",
      }),
      409,
      "state_changed",
    ],
    [
      new EarningRuleWriteError({
        code: "not_found",
        message: "private detail",
      }),
      404,
      "not_found",
    ],
    [new ShopifyStaffAuthorizationError("access_denied"), 403, "access_denied"],
    [
      new ShopifyStaffAuthorizationError("request_replayed"),
      409,
      "request_replayed",
    ],
    [new Error("private database detail"), 503, "earning_rules_unavailable"],
  ])("sanitizes service errors without retry", async (error, status, code) => {
    mocks.manage.mockRejectedValue(error);
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.manage).toHaveBeenCalledTimes(1);
  });
});
