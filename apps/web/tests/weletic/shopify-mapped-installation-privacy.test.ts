import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  freezeMappedInstallationAdmission,
  redactMappedInstallationAdmission,
} from "../../lib/weletic/shopify/mapped-installation-privacy";
vi.mock("../../lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyShopPrivacyIdentities: () => [
    { identityKeyId: "test-key", shopDomainDigest: "test-digest" },
  ],
}));

const now = new Date("2026-09-09T12:00:00Z");
const scope = {
  storeId: "store-1",
  shop: "company.myshopify.com",
  installationGeneration: "generation-1",
};
const row = {
  id: "pending-1",
  appId: "public-test",
  identityKeyId: "test-key",
  shopDomainDigest: "test-digest",
  mappedStoreId: scope.storeId,
  installationGeneration: scope.installationGeneration,
  state: "mapped",
  authenticatedAt: new Date(now.getTime() - 1000),
  uninstalledAt: null,
  redactedAt: null,
  revision: 2,
};
function transaction(record: unknown = row) {
  const update = vi.fn().mockResolvedValue({});
  const erase = vi.fn().mockResolvedValue({ count: 1 });
  const query = vi.fn().mockResolvedValue(record ? [record] : []);
  return {
    update,
    erase,
    query,
    tx: {
      $queryRaw: query,
      weleticShopifyPendingInstallation: { update },
      weleticShopifyPendingInstallationChange: { deleteMany: erase },
    } as unknown as Prisma.TransactionClient,
  };
}
beforeEach(() => vi.stubEnv("SHOPIFY_API_KEY", "public-test"));
afterEach(() => vi.unstubAllEnvs());
describe("mapped admission privacy lifecycle", () => {
  it("freezes only the exact generation while preserving its mapping", async () => {
    const { tx, update } = transaction();
    expect(
      await freezeMappedInstallationAdmission(tx, { ...scope, cutoff: now }),
    ).toBe("frozen");
    expect(update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: { state: "uninstalled", uninstalledAt: now, revision: 3 },
    });
  });
  it("does not freeze authority authenticated after an older uninstall", async () => {
    const { tx, update } = transaction({
      ...row,
      authenticatedAt: new Date(now.getTime() + 1000),
    });
    expect(
      await freezeMappedInstallationAdmission(tx, { ...scope, cutoff: now }),
    ).toBe("stale_generation");
    expect(update).not.toHaveBeenCalled();
  });
  it("keeps duplicate uninstall cutoff and revision stable", async () => {
    const { tx, update } = transaction({
      ...row,
      state: "uninstalled",
      uninstalledAt: now,
    });
    expect(
      await freezeMappedInstallationAdmission(tx, {
        ...scope,
        cutoff: new Date(now.getTime() + 1000),
      }),
    ).toBe("unchanged");
    expect(update).not.toHaveBeenCalled();
  });
  it.each([
    { appId: "foreign-app" },
    { mappedStoreId: "foreign-store" },
    { installationGeneration: "foreign-generation" },
    { state: "pending_approval" },
    { state: "redacted" },
    { authenticatedAt: null },
    { redactedAt: now },
    { identityKeyId: "foreign-key" },
    { shopDomainDigest: "foreign-shop" },
  ])("rejects an inconsistent mapped identity %j", async (change) => {
    const { tx, update, erase } = transaction({ ...row, ...change });
    await expect(
      freezeMappedInstallationAdmission(tx, { ...scope, cutoff: now }),
    ).rejects.toThrow("identity changed");
    await expect(
      redactMappedInstallationAdmission(tx, {
        ...scope,
        redactedAt: now,
        expiresAt: now,
      }),
    ).rejects.toThrow("identity changed");
    expect(update).not.toHaveBeenCalled();
    expect(erase).not.toHaveBeenCalled();
  });
  it("erases audit and mapping without fabricating a new record", async () => {
    const { tx, update, erase } = transaction();
    await redactMappedInstallationAdmission(tx, {
      ...scope,
      redactedAt: now,
      expiresAt: now,
    });
    expect(erase).toHaveBeenCalledWith({
      where: { pendingInstallationId: row.id },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: {
        state: "redacted",
        mappedStoreId: null,
        installationGeneration: null,
        authenticatedAt: null,
        uninstalledAt: null,
        redactedAt: now,
        expiresAt: now,
        revision: 3,
      },
    });
    expect(erase.mock.invocationCallOrder[0]).toBeLessThan(
      update.mock.invocationCallOrder[0],
    );
  });
  it("leaves legacy company installations without an admission record untouched", async () => {
    const { tx, update, erase } = transaction(null);
    expect(
      await freezeMappedInstallationAdmission(tx, { ...scope, cutoff: now }),
    ).toBe("legacy");
    await redactMappedInstallationAdmission(tx, {
      ...scope,
      redactedAt: now,
      expiresAt: now,
    });
    expect(update).not.toHaveBeenCalled();
    expect(erase).not.toHaveBeenCalled();
  });
  it("freezes and erases admission during the pre-provisioned but unmapped interval", async () => {
    const { tx, query, update, erase } = transaction(null);
    const unmapped = { ...row, mappedStoreId: null, state: "pending_approval" };
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([unmapped]);
    expect(
      await freezeMappedInstallationAdmission(tx, { ...scope, cutoff: now }),
    ).toBe("frozen");
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ state: "uninstalled" }),
      }),
    );
    query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { ...unmapped, state: "uninstalled", uninstalledAt: now },
      ]);
    await redactMappedInstallationAdmission(tx, {
      ...scope,
      redactedAt: now,
      expiresAt: now,
    });
    expect(erase).toHaveBeenCalledOnce();
    expect(update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          state: "redacted",
          authenticatedAt: null,
          installationGeneration: null,
        }),
      }),
    );
  });
});
