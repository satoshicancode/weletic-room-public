import { defaultStoreReviewSettingsPolicy } from "@/lib/weletic/reviews/store-settings-contract";
import { beforeEach, expect, it, vi } from "vitest";
import { POST as read } from "../../app/api/internal/shopify/merchant/reviews/store/settings/read/route";
import { POST as write } from "../../app/api/internal/shopify/merchant/reviews/store/settings/write/route";

const m = vi.hoisted(() => ({
  verify: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: m.transaction } }));
vi.mock("@/lib/weletic/shopify/merchant-store-review-settings", () => ({
  readShopifyMerchantStoreReviewSettingsInTransaction: m.read,
  writeShopifyMerchantStoreReviewSettings: m.write,
}));
vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  verifyWeleticShopifyRequest: m.verify,
  readWeleticShopifyRequestBodyBytes: async (
    request: Request,
    { maxBytes }: { maxBytes: number },
  ) => {
    const bytes = new Uint8Array(await request.arrayBuffer());
    return bytes.length <= maxBytes ? bytes : null;
  },
}));
const actor = {
  version: 1,
  storeId: "store-a",
  appId: "app-a",
  shop: "shop.myshopify.com",
  installationGeneration: "generation-a",
  userId: "123",
  sessionId: "shop.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1,
  requestId: "b".repeat(64),
};
const patch = {
  expectedRevision: 0,
  expectedInstallationGeneration: "generation-a",
  policy: defaultStoreReviewSettingsPolicy(),
};
const request = (input: unknown, method = "POST") =>
  new Request("http://localhost/api", {
    method,
    ...(method === "POST" ? { body: JSON.stringify({ actor, input }) } : {}),
  });
beforeEach(() => {
  vi.resetAllMocks();
  m.verify.mockReturnValue(true);
  m.transaction.mockImplementation((callback) => callback({ fixture: true }));
  m.read.mockResolvedValue({ revision: 0 });
  m.write.mockResolvedValue({ revision: 1 });
});
it("verifies signed bytes before reading under staff authorization", async () => {
  const response = await read(request({}));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(m.verify).toHaveBeenCalledWith(
    expect.objectContaining({ body: JSON.stringify({ actor, input: {} }) }),
  );
  expect(m.read).toHaveBeenCalledExactlyOnceWith({
    tx: { fixture: true },
    envelope: actor,
    input: {},
  });
});
it("routes only strict, revision-fenced writes", async () => {
  expect((await write(request(patch))).status).toBe(200);
  expect(m.write).toHaveBeenCalledExactlyOnceWith({
    envelope: actor,
    input: patch,
  });
  expect((await write(request({ ...patch, storeId: "foreign" }))).status).toBe(
    400,
  );
  expect(m.write).toHaveBeenCalledTimes(1);
});
it.each([read, write])(
  "rejects unsigned and unsupported methods",
  async (route) => {
    m.verify.mockReturnValue(false);
    expect((await route(request(patch))).status).toBe(401);
    expect((await route(request({}, "GET"))).status).toBe(405);
    expect(m.read).not.toHaveBeenCalled();
    expect(m.write).not.toHaveBeenCalled();
  },
);
