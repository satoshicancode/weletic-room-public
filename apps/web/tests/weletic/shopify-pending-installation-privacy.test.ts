import { handlePendingInstallationPrivacy } from "@/lib/weletic/shopify/pending-installation-privacy";
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  ensure: vi.fn(),
  revoke: vi.fn(),
  pending: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/session-coordination", () => ({
  ensureShopifySessionCoordination: mocks.ensure,
  revokeShopifySessionCoordination: mocks.revoke,
}));
vi.mock("@/lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: mocks.pending,
}));
const scope = { appId: "public-app", shop: "company.myshopify.com" };
const now = new Date("2026-09-09T12:00:00Z");
const row = {
  id: "pending-1",
  state: "pending_approval",
  revision: 1,
  mappedStoreId: null,
  authenticatedAt: new Date(now.getTime() - 60_000),
  installationGeneration: "generation-1",
};
function fixture(stores: unknown[] = []) {
  const query = vi
    .fn()
    .mockResolvedValueOnce(stores)
    .mockResolvedValueOnce([{ now }]);
  const removeSessions = vi.fn().mockResolvedValue({ count: 1 });
  const removeAudit = vi.fn().mockResolvedValue({ count: 1 });
  const update = vi.fn().mockResolvedValue({});
  const create = vi.fn().mockResolvedValue({});
  const removeCoordinator = vi.fn().mockResolvedValue({ count: 1 });
  return {
    tx: {
      $queryRaw: query,
      weleticShopifyAppSession: { deleteMany: removeSessions },
      weleticShopifySessionCoordination: { deleteMany: removeCoordinator },
      weleticShopifyPendingInstallationChange: { deleteMany: removeAudit },
      weleticShopifyPendingInstallation: { update, create },
    } as unknown as Prisma.TransactionClient,
    removeSessions,
    removeAudit,
    removeCoordinator,
    update,
    create,
  };
}
describe("unmapped installation privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pending.mockResolvedValue(row);
  });
  it("defers a concurrently mapped store without touching credentials", async () => {
    const { tx, removeSessions } = fixture([{ id: "store-1" }]);
    expect(
      await handlePendingInstallationPrivacy(tx, scope, "shop/redact", null),
    ).toEqual({ disposition: "mapped" });
    expect(mocks.ensure).not.toHaveBeenCalled();
    expect(removeSessions).not.toHaveBeenCalled();
  });
  it.each(["customers/data_request", "customers/redact"] as const)(
    "handles %s without retaining customer data",
    async (topic) => {
      const { tx, removeSessions, update, create } = fixture();
      expect(
        await handlePendingInstallationPrivacy(tx, scope, topic, null),
      ).toEqual({ disposition: "no_customer_data" });
      expect(mocks.revoke).not.toHaveBeenCalled();
      expect(mocks.ensure).not.toHaveBeenCalled();
      expect(removeSessions).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it("revokes stale leases and deletes only this shop's sessions before freezing", async () => {
    const { tx, removeSessions, update } = fixture();
    expect(
      await handlePendingInstallationPrivacy(tx, scope, "app/uninstalled", now),
    ).toEqual({ disposition: "uninstalled" });
    expect(mocks.revoke).toHaveBeenCalledWith(tx, scope);
    expect(removeSessions).toHaveBeenCalledWith({
      where: { shop: scope.shop },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { state: "uninstalled", uninstalledAt: now, revision: 2 },
    });
    expect(mocks.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      removeSessions.mock.invocationCallOrder[0],
    );
  });
  it("does not freeze a later authenticated generation for an old uninstall", async () => {
    const { tx, removeSessions } = fixture();
    expect(
      await handlePendingInstallationPrivacy(
        tx,
        scope,
        "app/uninstalled",
        new Date(now.getTime() - 120_000),
      ),
    ).toEqual({ disposition: "stale_generation" });
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(removeSessions).not.toHaveBeenCalled();
  });
  it.each([null, new Date("invalid"), new Date(now.getTime() + 1)])(
    "rejects invalid uninstall cutoff %j",
    async (cutoff) => {
      const { tx, update } = fixture();
      await expect(
        handlePendingInstallationPrivacy(tx, scope, "app/uninstalled", cutoff),
      ).rejects.toThrow();
      expect(mocks.revoke).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );
  it("redacts operator audit and authentication identity while retaining a bounded keyed fence", async () => {
    const { tx, removeAudit, removeCoordinator, update } = fixture();
    await handlePendingInstallationPrivacy(tx, scope, "shop/redact", null);
    expect(removeAudit).toHaveBeenCalledWith({
      where: { pendingInstallationId: row.id },
    });
    expect(removeCoordinator).toHaveBeenCalledWith({
      where: { appId: scope.appId, shop: scope.shop },
    });
    expect(update.mock.calls[0][0].data).toMatchObject({
      state: "redacted",
      installationGeneration: null,
      authenticatedAt: null,
      mappedStoreId: null,
      redactedAt: now,
      revision: 2,
    });
    expect(update.mock.calls[0][0].data.expiresAt.getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });
  it("does not extend retention for a replayed redaction", async () => {
    mocks.pending.mockResolvedValue({ ...row, state: "redacted" });
    const { tx, update, removeCoordinator } = fixture();
    expect(
      await handlePendingInstallationPrivacy(tx, scope, "shop/redact", null),
    ).toEqual({ disposition: "already_redacted" });
    expect(update).not.toHaveBeenCalled();
    expect(removeCoordinator).toHaveBeenCalledWith({
      where: { appId: scope.appId, shop: scope.shop },
    });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("propagates credential deletion failure so the transaction rolls back", async () => {
    const { tx, removeSessions, update } = fixture();
    removeSessions.mockRejectedValue(new Error("storage unavailable"));
    await expect(
      handlePendingInstallationPrivacy(tx, scope, "shop/redact", null),
    ).rejects.toThrow("storage unavailable");
    expect(update).not.toHaveBeenCalled();
  });
});
