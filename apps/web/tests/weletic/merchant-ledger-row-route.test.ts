import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "../../app/api/internal/shopify/merchant/analytics/ledger-rows/route";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  query: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({
  prisma: { $transaction: mocks.transaction },
}));
vi.mock("../../lib/weletic/shopify/merchant-ledger-row-export", () => ({
  readShopifyMerchantLedgerRowExportInTransaction: mocks.query,
}));
vi.mock("../../lib/weletic/shopify/service-auth", async (original) => ({
  ...(await original<
    typeof import("../../lib/weletic/shopify/service-auth")
  >()),
  verifyWeleticShopifyRequest: mocks.verify,
}));

const actor = {
  version: 1,
  appId: "test-app",
  shop: "staff-fixture.myshopify.com",
  storeId: "store-fixture",
  installationGeneration: "generation-fixture",
  userId: "123",
  sessionId: "staff-fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1_000_000,
  requestId: "b".repeat(64),
};
const input = {
  actor,
  request: {
    filter: {
      startAt: "2026-09-01T00:00:00.000Z",
      endAt: "2026-09-30T23:59:59.999Z",
    },
    expectedInstallationGeneration: "generation-fixture",
  },
};
const request = (body: unknown) =>
  new Request(
    "https://backend.example/api/internal/shopify/merchant/analytics/ledger-rows",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
const tx = { fixture: "transaction" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockReturnValue(true);
  mocks.transaction.mockImplementation(async (operation) => operation(tx));
  mocks.query.mockResolvedValue({ rows: [] });
});

it("verifies the entire body before a repeatable-read owner export", async () => {
  const response = await POST(request(input));
  expect(response.status).toBe(200);
  expect(mocks.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify(input) }),
  );
  expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
    isolationLevel: "RepeatableRead",
  });
  expect(mocks.query).toHaveBeenCalledWith({
    tx,
    envelope: actor,
    request: input.request,
  });
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
});

it("refuses unsigned, injected and unbounded requests before database access", async () => {
  mocks.verify.mockReturnValue(false);
  expect((await POST(request(input))).status).toBe(401);
  mocks.verify.mockReturnValue(true);
  for (const invalid of [
    { ...input, actor: { ...actor, owner: true } },
    { ...input, request: { ...input.request, storeId: "another-store" } },
    {
      ...input,
      request: {
        ...input.request,
        filter: { ...input.request.filter, endAt: "2027-10-01T00:00:00Z" },
      },
    },
  ])
    expect((await POST(request(invalid))).status).toBe(400);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
