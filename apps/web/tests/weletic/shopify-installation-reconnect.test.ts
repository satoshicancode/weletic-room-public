import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observePendingInstallationReconnect,
  preparePendingInstallationReconnect,
} from "../../lib/weletic/shopify/installation-reconnect";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  ensure: vi.fn(),
  revoke: vi.fn(),
  observe: vi.fn(),
}));
vi.mock("../../lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyShopPrivacyIdentities: () => [
    { identityKeyId: "test", shopDomainDigest: "digest" },
  ],
}));
vi.mock("../../lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: mocks.read,
}));
vi.mock("../../lib/weletic/shopify/session-coordination", () => ({
  ensureShopifySessionCoordination: mocks.ensure,
  revokeShopifySessionCoordination: mocks.revoke,
  observeShopifySessionCoordination: mocks.observe,
}));
const now = new Date("2026-09-09T12:00:00Z");
const seconds = now.getTime() / 1000;
const identity = {
  appId: "public-test",
  shop: "company.myshopify.com",
  userId: "123",
  issuedAt: seconds - 2,
  expiresAt: seconds + 30,
};
const pending = {
  id: "pending",
  state: "uninstalled",
  mappedStoreId: null,
  redactedAt: null,
  uninstalledAt: new Date(now.getTime() - 5000),
  installationGeneration: "old-generation",
  revision: 3,
};
const observation = {
  expectedRevision: 3,
  expectedInstallationGeneration: "old-generation",
};
function transaction(stores: unknown[] = [], afterLock = now) {
  const query = vi
    .fn()
    .mockResolvedValueOnce([{ now }])
    .mockResolvedValueOnce(stores)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ now: afterLock }]);
  const remove = vi.fn().mockResolvedValue({ count: 1 });
  const update = vi.fn().mockResolvedValue({});
  return {
    remove,
    update,
    tx: {
      $queryRaw: query,
      weleticShopifyAppSession: { deleteMany: remove },
      weleticShopifyPendingInstallation: { update },
    } as unknown as Prisma.TransactionClient,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SHOPIFY_API_KEY", identity.appId);
  mocks.read.mockResolvedValue(pending);
});
afterEach(() => vi.unstubAllEnvs());
describe("authenticated pending reconnect", () => {
  it("observes revision/generation without authentication mutations", async () => {
    const { tx, update, remove } = transaction();
    expect(await observePendingInstallationReconnect(tx, identity)).toEqual(
      observation,
    );
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it("rotates pending generation and revokes old authentication without approval", async () => {
    const { tx, update, remove } = transaction();
    expect(
      await preparePendingInstallationReconnect(tx, identity, observation),
    ).toEqual({ status: "pending_approval" });
    expect(remove).toHaveBeenCalledWith({ where: { shop: identity.shop } });
    const data = update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      state: "pending_approval",
      revision: 4,
      uninstalledAt: null,
      expiresAt: null,
      authenticatedAt: new Date(identity.issuedAt * 1000),
    });
    expect(data.installationGeneration).not.toBe("old-generation");
    expect(data).not.toHaveProperty("mappedStoreId");
    expect(data).not.toHaveProperty("storeAccessState");
    expect(mocks.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0],
    );
  });
  it.each([
    { state: "pending_approval" },
    { state: "mapped" },
    { state: "redacted" },
    { mappedStoreId: "store" },
    { redactedAt: now },
    { uninstalledAt: null },
    { uninstalledAt: new Date(identity.issuedAt * 1000) },
    { revision: 2147483646 },
  ])("rejects stale or ineligible admission %j", async (change) => {
    mocks.read.mockResolvedValue({ ...pending, ...change });
    const { tx, update, remove } = transaction();
    await expect(
      preparePendingInstallationReconnect(tx, identity, observation),
    ).rejects.toThrow();
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it.each([
    { expectedRevision: 2 },
    { expectedInstallationGeneration: "foreign" },
    { approve: true },
  ])("rejects stale/injected observation %j", async (change) => {
    const { tx } = transaction();
    await expect(
      preparePendingInstallationReconnect(tx, identity, {
        ...observation,
        ...change,
      }),
    ).rejects.toThrow();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("does not bypass mapped-store cleanup", async () => {
    const { tx } = transaction([{ id: "existing-store" }]);
    await expect(
      preparePendingInstallationReconnect(tx, identity, observation),
    ).rejects.toThrow("Mapped installation");
    expect(mocks.read).toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("rechecks authentication expiry after lock waits", async () => {
    const { tx } = transaction([], new Date(now.getTime() + 60_000));
    await expect(
      preparePendingInstallationReconnect(tx, identity, observation),
    ).rejects.toThrow();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
