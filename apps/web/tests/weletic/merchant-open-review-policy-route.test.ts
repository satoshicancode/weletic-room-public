import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as read } from "../../app/api/internal/shopify/merchant/reviews/open-policy/read/route";
import { POST as write } from "../../app/api/internal/shopify/merchant/reviews/open-policy/write/route";
import { ReviewError } from "../../lib/weletic/reviews/contracts";
import { signWeleticShopifyRequest } from "../../lib/weletic/shopify/service-auth";
import { ShopifyStaffAuthorizationError } from "../../lib/weletic/shopify/staff-authorization";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("../../lib/weletic/shopify/merchant-open-review-policy", () => ({
  readShopifyMerchantOpenReviewPolicy: mocks.read,
  writeShopifyMerchantOpenReviewPolicy: mocks.write,
}));
const secret = "open-policy-route-test-only-secret-000000";
const actor = {
  version: 1,
  appId: "app_1",
  shop: "test.myshopify.com",
  storeId: "store_1",
  installationGeneration: "generation_1",
  userId: "42",
  sessionId: "test.myshopify.com_42",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1,
  requestId: "b".repeat(64),
};
const patch = {
  expectedInstallationGeneration: "generation_1",
  expectedRevision: 0,
  policy: {
    enabled: false,
    photoUploadsEnabled: false,
    maxSubmissionsPer24Hours: 3,
  },
};
function request(operation: string, body: string, signedBody = body) {
  const path =
    "/api/internal/shopify/merchant/reviews/open-policy/" + operation;
  const timestamp = String(Date.now());
  return new Request("https://backend.example" + path, {
    method: "POST",
    body,
    headers: {
      "x-weletic-timestamp": timestamp,
      "x-weletic-signature": signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body: signedBody,
        secret,
      }),
    },
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
  mocks.read.mockResolvedValue({ fixture: "read" });
  mocks.write.mockResolvedValue({ fixture: "write" });
});
afterEach(() => vi.unstubAllEnvs());

describe.each([
  ["read", read, {}, mocks.read],
  ["write", write, patch, mocks.write],
] as const)(
  "%s signed open-policy HTTP route",
  (operation, handler, input, execute) => {
    it("verifies the real complete-body HMAC and forwards the strict envelope", async () => {
      const response = await handler(
        request(operation, JSON.stringify({ actor, input })),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(execute).toHaveBeenCalledExactlyOnceWith({
        envelope: actor,
        input,
      });
    });
    it("rejects unsigned and body-tampered requests without entering the gateway", async () => {
      expect(
        (
          await handler(
            new Request("https://backend.example", {
              method: "POST",
              body: JSON.stringify({ actor, input }),
            }),
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await handler(
            request(operation, JSON.stringify({ actor, input }), "{}"),
          )
        ).status,
      ).toBe(401);
      expect(execute).not.toHaveBeenCalled();
    });
    it("rejects method, malformed JSON, excess bytes and authority injection", async () => {
      expect(
        (await handler(new Request("https://backend.example"))).status,
      ).toBe(405);
      for (const body of [
        "{",
        JSON.stringify({ actor, input, storeId: "foreign" }),
        JSON.stringify({ actor: { ...actor, owner: true }, input }),
        JSON.stringify({ actor, input: { ...input, storeId: "foreign" } }),
        "x".repeat(65 * 1024),
      ]) {
        expect((await handler(request(operation, body))).status).toBe(400);
      }
      expect(execute).not.toHaveBeenCalled();
    });
    it.each([
      ["not_found", 404, "review_unavailable"],
      ["conflict", 409, "state_changed"],
      ["bad_request", 400, "invalid_request"],
    ] as const)("sanitizes %s failures", async (code, status, error) => {
      execute.mockRejectedValue(
        new ReviewError(code, "private database content"),
      );
      const response = await handler(
        request(operation, JSON.stringify({ actor, input })),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    });
    it("masks unexpected errors without retrying an uncertain write", async () => {
      execute.mockRejectedValue(new Error("private details"));
      const response = await handler(
        request(operation, JSON.stringify({ actor, input })),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "reviews_unavailable" });
      expect(execute).toHaveBeenCalledTimes(1);
    });
    it.each([
      ["access_denied", 403],
      ["invalid_actor", 401],
      ["request_replayed", 409],
    ] as const)(
      "preserves the %s authorization disposition",
      async (code, status) => {
        execute.mockRejectedValue(new ShopifyStaffAuthorizationError(code));
        const response = await handler(
          request(operation, JSON.stringify({ actor, input })),
        );
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual({ error: code });
      },
    );
  },
);
it("rejects policy bytes beyond the 16 KiB bound", async () => {
  const body = JSON.stringify({ actor, input: patch }) + " ".repeat(16 * 1024);
  expect((await write(request("write", body))).status).toBe(400);
  expect(mocks.write).not.toHaveBeenCalled();
});
