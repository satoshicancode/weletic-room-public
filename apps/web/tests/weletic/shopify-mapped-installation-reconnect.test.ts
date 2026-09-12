import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observePendingInstallationReconnect,
  preparePendingInstallationReconnect,
} from "../../lib/weletic/shopify/installation-reconnect";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  ensure: vi.fn(),
  observe: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("../../lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: mocks.read,
}));
vi.mock("../../lib/weletic/shopify/session-coordination", () => ({
  ensureShopifySessionCoordination: mocks.ensure,
  observeShopifySessionCoordination: mocks.observe,
  revokeShopifySessionCoordination: mocks.revoke,
}));
vi.mock("../../lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyShopPrivacyIdentities: () => [
    { identityKeyId: "test", shopDomainDigest: "digest" },
  ],
}));
const now = new Date("2026-09-09T12:00:00Z");
const cutoff = new Date(now.getTime() - 5000);
const actor = {
  appId: "public-app",
  shop: "company.myshopify.com",
  userId: "123",
  issuedAt: now.getTime() / 1000 - 2,
  expiresAt: now.getTime() / 1000 + 30,
};
const store = {
  id: "store",
  projectId: "workspace",
  shopDomain: actor.shop,
  installationGeneration: "old",
  complianceState: "frozen",
  uninstalledAt: cutoff,
  redactedAt: null,
  storeAccessState: "active",
  storeAccessRevision: 8,
};
const pending = {
  id: "pending",
  state: "uninstalled",
  mappedStoreId: "store",
  installationGeneration: "old",
  authenticatedAt: new Date(now.getTime() - 60_000),
  uninstalledAt: cutoff,
  redactedAt: null,
  revision: 3,
};
const observation = {
  expectedRevision: 3,
  expectedInstallationGeneration: "old",
  expectedStoreAccessRevision: 8,
};
function fixture(
  options: {
    store?: object;
    pending?: object;
    tombstones?: unknown[];
    blocking?: unknown[];
    completed?: unknown[];
    cleanups?: unknown[];
    native?: unknown[];
    legacy?: number;
    programs?: unknown[];
    afterLock?: Date;
    workspace?: object | null;
    changed?: number;
  } = {},
) {
  mocks.read.mockResolvedValue({ ...pending, ...options.pending });
  let clockReads = 0;
  const query = vi.fn(async (sql: Prisma.Sql): Promise<unknown[]> => {
    const text = sql.sql;
    if (text.includes(" AS now"))
      return [{ now: ++clockReads > 1 ? options.afterLock ?? now : now }];
    if (text.includes("FROM WeleticShopifyStore"))
      return [{ ...store, ...options.store }];
    if (text.includes("ShopPrivacyTombstone")) return options.tombstones ?? [];
    if (text.includes("ComplianceRequest"))
      return text.includes("phase = 'completed'")
        ? options.completed ?? [{ id: "completed-current-uninstall" }]
        : options.blocking ?? [];
    if (text.includes("VoucherCleanup")) return options.cleanups ?? [];
    if (text.includes("InstallationCredential")) return options.native ?? [];
    if (text.includes("WeleticLoyaltyProgram"))
      return (
        options.programs ?? [{ status: "disabled", killSwitchActive: true }]
      );
    throw new Error("Unexpected test query");
  });
  const update = vi.fn().mockResolvedValue({});
  const execute = vi.fn().mockResolvedValue(options.changed ?? 1);
  const remove = vi.fn().mockResolvedValue({ count: 0 });
  const grants = vi.fn().mockResolvedValue({ count: 1 });
  const accessAudit = vi.fn().mockResolvedValue({});
  const pendingAudit = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: query,
    $executeRaw: execute,
    project: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          options.workspace === undefined
            ? { id: "workspace" }
            : options.workspace,
        ),
    },
    installedIntegration: {
      count: vi.fn().mockResolvedValue(options.legacy ?? 0),
    },
    weleticShopifyAppSession: { deleteMany: remove },
    weleticShopifyStaffGrant: { deleteMany: grants },
    weleticShopifyPendingInstallation: { update },
    weleticShopifyStoreAccessChange: { create: accessAudit },
    weleticShopifyPendingInstallationChange: { create: pendingAudit },
  } as unknown as Prisma.TransactionClient;
  return {
    tx,
    query,
    execute,
    update,
    remove,
    grants,
    accessAudit,
    pendingAudit,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SHOPIFY_API_KEY", actor.appId);
});
afterEach(() => vi.unstubAllEnvs());
describe("Shopify-native mapped reconnect", () => {
  it("observes current mapping and access revision without recreating credentials", async () => {
    const f = fixture();
    expect(await observePendingInstallationReconnect(f.tx, actor)).toEqual(
      observation,
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
  it("reopens the same Store with new generation, no grants, pending approval and no User", async () => {
    const f = fixture();
    expect(
      await preparePendingInstallationReconnect(f.tx, actor, observation),
    ).toEqual({ status: "pending_approval" });
    const data = f.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      state: "mapped",
      revision: 4,
      uninstalledAt: null,
      authenticatedAt: new Date(actor.issuedAt * 1000),
    });
    expect(data.installationGeneration).not.toBe("old");
    expect(data).not.toHaveProperty("mappedStoreId");
    expect(f.execute.mock.calls[0][0].values).toContain(
      data.installationGeneration,
    );
    expect(f.execute.mock.calls[0][0].sql).toContain(
      "storeAccessState = 'pending_approval'",
    );
    expect(f.grants).toHaveBeenCalledWith({
      where: { storeId: "store", appId: actor.appId },
    });
    expect(f.accessAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        revision: 9,
        previousState: "active",
        nextState: "pending_approval",
      }),
    });
    expect(f.pendingAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operation: "reconnect",
        operator: "shopify:123",
        mappedStoreId: "store",
        revision: 4,
      }),
    });
    expect(mocks.revoke.mock.invocationCallOrder[0]).toBeLessThan(
      f.execute.mock.invocationCallOrder[0],
    );
  });
  it.each([
    { store: { complianceState: "active" } },
    { store: { redactedAt: now } },
    { store: { installationGeneration: "newer" } },
    { store: { storeAccessRevision: 2147483646 } },
    { pending: { mappedStoreId: "foreign" } },
    { pending: { authenticatedAt: now } },
    { pending: { uninstalledAt: new Date(cutoff.getTime() - 1) } },
    { tombstones: [{ id: "erased" }] },
    { blocking: [{ id: "unfinished" }] },
    { completed: [] },
    { cleanups: [{ id: "voucher" }] },
    { native: [{ id: "old-token" }] },
    { legacy: 1 },
    { programs: [{ status: "active", killSwitchActive: false }] },
    { programs: [{ status: "disabled", killSwitchActive: false }] },
    { workspace: null },
    { afterLock: new Date(now.getTime() + 60_000) },
  ])(
    "rejects unsafe reconnect %j before resetting authority",
    async (options) => {
      const f = fixture(options);
      await expect(
        preparePendingInstallationReconnect(f.tx, actor, observation),
      ).rejects.toThrow();
      expect(mocks.revoke).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 7])(
    "rejects missing or stale company revision %s",
    async (expectedStoreAccessRevision) => {
      const f = fixture();
      await expect(
        preparePendingInstallationReconnect(f.tx, actor, {
          ...observation,
          expectedStoreAccessRevision,
        }),
      ).rejects.toThrow("observation changed");
      expect(mocks.revoke).not.toHaveBeenCalled();
    },
  );
  it("rejects a lost Store CAS without publishing admission or audit", async () => {
    const f = fixture({ changed: 0 });
    await expect(
      preparePendingInstallationReconnect(f.tx, actor, observation),
    ).rejects.toThrow("Store revision fence");
    expect(f.update).not.toHaveBeenCalled();
    expect(f.accessAudit).not.toHaveBeenCalled();
  });
});
