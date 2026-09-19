import { authorizeShopifyMerchantInTransaction } from "@/lib/weletic/shopify/staff-authorization";
import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  snapshot: vi.fn(),
  session: vi.fn(),
  evidence: vi.fn(),
  query: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/encryption", () => ({ decrypt: () => "{}" }));
vi.mock("@/lib/weletic/shopify/session-lifecycle-fence", () => ({
  lockShopifySessionLifecycle: mocks.lock,
}));
vi.mock("@/lib/weletic/shopify/session-snapshot", () => ({
  configuredShopifySessionScope: (shop: string) => ({ appId: "app", shop }),
  readShopifySessionSnapshot: mocks.snapshot,
}));
vi.mock("@/lib/weletic/shopify/session-online-binding", async (original) => ({
  ...(await original<object>()),
  readShopifySessionPayload: mocks.session,
}));
vi.mock("@/lib/weletic/shopify/session-online-evidence", async (original) => ({
  ...(await original<object>()),
  readOnlineSessionEvidence: mocks.evidence,
}));
const now = new Date("2026-09-20T00:00:00Z");
const actor = {
  version: 1,
  storeId: "store",
  appId: "app",
  shop: "test.myshopify.com",
  installationGeneration: "generation",
  userId: "123",
  sessionId: "test.myshopify.com_123",
  sessionDigest: createHash("sha256").update("encrypted").digest("hex"),
  authenticatedAt: now.getTime(),
  requestId: "b".repeat(64),
};
const tx = {
  $queryRaw: mocks.query,
  weleticShopifyMerchantAction: { create: mocks.create },
} as unknown as Prisma.TransactionClient;
const run = (recordAction?: boolean) =>
  authorizeShopifyMerchantInTransaction({
    tx,
    envelope: actor,
    permission: "reviews.configure",
    ...(recordAction === undefined ? {} : { recordAction }),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.lock.mockResolvedValue({
    id: "store",
    projectId: "workspace",
    installationGeneration: "generation",
  });
  mocks.snapshot.mockResolvedValue({
    observed: {
      credentialTokenHash: "token-hash",
      installationGeneration: "generation",
    },
  });
  mocks.session.mockReturnValue({
    onlineBinding: actor,
    properties: [
      ["id", actor.sessionId],
      ["expires", now.getTime() + 60000],
    ],
  });
  mocks.evidence.mockReturnValue({
    userId: 123,
    accountOwner: true,
    collaborator: false,
  });
  mocks.query
    .mockResolvedValueOnce([
      {
        payload: "encrypted",
        shop: actor.shop,
        isOnline: true,
        expiresAt: new Date(now.getTime() + 60000),
      },
    ])
    .mockResolvedValueOnce([{ now }])
    .mockResolvedValueOnce([]);
});
it("preflight checks the real authorization path without creating a receipt", async () => {
  expect(await run(false)).toMatchObject({
    permission: "reviews.configure",
    storeId: "store",
    owner: true,
  });
  expect(mocks.query).toHaveBeenCalledTimes(3);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("default authorization still records the one-use receipt", async () => {
  await run();
  expect(mocks.create).toHaveBeenCalledOnce();
});
it("preflight still rejects a previously consumed action", async () => {
  mocks.query
    .mockReset()
    .mockResolvedValueOnce([
      {
        payload: "encrypted",
        shop: actor.shop,
        isOnline: true,
        expiresAt: new Date(now.getTime() + 60000),
      },
    ])
    .mockResolvedValueOnce([{ now }])
    .mockResolvedValueOnce([{ id: "existing" }]);
  await expect(run(false)).rejects.toThrow("request_replayed");
  expect(mocks.create).not.toHaveBeenCalled();
});
it("preflight cannot bypass session generation validation", async () => {
  mocks.lock.mockResolvedValue({
    id: "store",
    installationGeneration: "reinstalled",
  });
  await expect(run(false)).rejects.toThrow("invalid_actor");
  expect(mocks.create).not.toHaveBeenCalled();
});
it("preflight cannot bypass a missing staff grant", async () => {
  mocks.evidence.mockReturnValue({
    userId: 123,
    accountOwner: false,
    collaborator: false,
  });
  await expect(run(false)).rejects.toThrow("access_denied");
  expect(mocks.create).not.toHaveBeenCalled();
});
