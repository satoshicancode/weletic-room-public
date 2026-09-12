import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/loyalty-nudges/route";
import { LoyaltyMaintenanceBlockedError } from "../../lib/weletic/loyalty/maintenance-write-fence";
import { LoyaltyNudgeConflictError } from "../../lib/weletic/loyalty/nudge-service";
import { signWeleticShopifyRequest } from "../../lib/weletic/shopify/service-auth";
import { ShopifyStaffAuthorizationError } from "../../lib/weletic/shopify/staff-authorization";

const mocks = vi.hoisted(() => ({ manage: vi.fn(), transaction: vi.fn() }));
vi.mock("../../lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("../../lib/weletic/shopify/loyalty-nudges", () => ({
  manageShopifyLoyaltyNudgesInTransaction: mocks.manage,
}));
const secret = "synthetic-appearance-route-secret-not-a-credential";
const path = "/api/internal/shopify/merchant/loyalty-nudges";
const actor = {
  version: 1,
  appId: "fixture-app",
  shop: "fixture.myshopify.com",
  storeId: "fixture-store",
  installationGeneration: "fixture-generation",
  userId: "123",
  sessionId: "fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1_000_000,
  requestId: "b".repeat(64),
};
const input = { actor, request: { operation: "read" } };
const tx = { fixture: true };
function request(
  body: string,
  signedBody = body,
  timestamp = String(Date.now()),
) {
  return new Request(`https://backend.example${path}`, {
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
  mocks.transaction.mockImplementation(async (operation) => operation(tx));
  mocks.manage.mockResolvedValue({ fixture: "response" });
});
afterEach(() => vi.unstubAllEnvs());

it("verifies a real body signature before passing the strict actor to one transaction", async () => {
  const response = await POST(request(JSON.stringify(input)));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(mocks.transaction).toHaveBeenCalledExactlyOnceWith(
    expect.any(Function),
    {
      isolationLevel: "RepeatableRead",
    },
  );
  expect(mocks.manage).toHaveBeenCalledExactlyOnceWith({
    tx,
    envelope: actor,
    request: input.request,
  });
});

it.each([
  { ...input, actor: { ...actor, storeId: "foreign-store" } },
  { ...input, request: { operation: "save" } },
])("rejects body tampering before database access", async (tampered) => {
  expect(
    (await POST(request(JSON.stringify(tampered), JSON.stringify(input))))
      .status,
  ).toBe(401);
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it("rejects absent or expired signatures before parsing or database access", async () => {
  expect(
    (
      await POST(
        new Request(`https://backend.example${path}`, {
          method: "POST",
          body: "{",
        }),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await POST(
        request(JSON.stringify(input), undefined, String(Date.now() - 600_000)),
      )
    ).status,
  ).toBe(401);
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it.each([
  { ...input, storeId: "foreign-store" },
  { ...input, actor: { ...actor, owner: true } },
  { ...input, request: { operation: "read", programId: "foreign-program" } },
])("rejects signed authority injection", async (injected) => {
  expect((await POST(request(JSON.stringify(injected)))).status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});

it.each(["{", JSON.stringify({ padding: "x".repeat(33 * 1024) })])(
  "rejects malformed or oversized signed bodies",
  async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  },
);

it.each([
  [new ShopifyStaffAuthorizationError("invalid_actor"), 401, "invalid_actor"],
  [new ShopifyStaffAuthorizationError("access_denied"), 403, "access_denied"],
  [
    new ShopifyStaffAuthorizationError("request_replayed"),
    409,
    "request_replayed",
  ],
  [new LoyaltyMaintenanceBlockedError(), 403, "access_denied"],
  [new LoyaltyNudgeConflictError(), 409, "state_changed"],
  [new Error("private database detail"), 503, "nudges_unavailable"],
])(
  "maps failures without disclosing private details",
  async (error, status, code) => {
    mocks.manage.mockRejectedValue(error);
    const response = await POST(request(JSON.stringify(input)));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  },
);
