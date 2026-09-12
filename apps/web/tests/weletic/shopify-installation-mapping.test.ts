import { mapPendingInstallationInTransaction } from "@/lib/weletic/shopify/installation-admission-operator";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  lifecycle: vi.fn(),
  pending: vi.fn(),
  observe: vi.fn(),
}));
vi.mock("@/lib/weletic/shopify/session-lifecycle-fence", () => ({
  lockShopifySessionLifecycle: mocks.lifecycle,
}));
vi.mock("@/lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: mocks.pending,
}));
vi.mock("@/lib/weletic/shopify/session-coordination", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/session-coordination")
  >()),
  observeShopifySessionCoordination: mocks.observe,
}));

const input = {
  shop: "company.myshopify.com",
  storeId: "store-1",
  pendingInstallationId: "pending-1",
  expectedInstallationGeneration: "generation-1",
  expectedRevision: 1,
  expectedStoreAccessRevision: 1,
  operator: "company-operator",
  reason: "Approved company mapping",
};
const pending = {
  id: "pending-1",
  state: "pending_approval",
  revision: 1,
  mappedStoreId: null,
  installationGeneration: "generation-1",
  authenticatedAt: new Date(),
  uninstalledAt: null,
  redactedAt: null,
};
function fixture(
  access = { storeAccessState: "pending_approval", storeAccessRevision: 1 },
) {
  const query = vi.fn().mockResolvedValue([access]);
  const update = vi.fn().mockResolvedValue(1);
  const audit = vi.fn().mockResolvedValue({});
  return {
    tx: {
      $queryRaw: query,
      $executeRaw: update,
      weleticShopifyPendingInstallationChange: { create: audit },
    } as unknown as Prisma.TransactionClient,
    update,
    audit,
  };
}
describe("operator-only pending installation mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SHOPIFY_API_KEY", "public-test");
    mocks.lifecycle.mockResolvedValue({
      id: "store-1",
      installationGeneration: "generation-1",
    });
    mocks.pending.mockResolvedValue(pending);
    mocks.observe.mockResolvedValue({ epoch: "1", revision: "1" });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("previews without mapping or activation", async () => {
    const { tx, update, audit } = fixture();
    expect(await mapPendingInstallationInTransaction(tx, input)).toEqual({
      applied: false,
      state: "mapped",
      revision: 2,
      loyaltyActivated: false,
    });
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it("audits the immutable target and exact generation with the CAS", async () => {
    const { tx, update, audit } = fixture();
    await mapPendingInstallationInTransaction(tx, { ...input, apply: true });
    const sql = update.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain("mappedStoreId IS NULL");
    expect(sql.values).toContain("generation-1");
    expect(audit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        pendingInstallationId: "pending-1",
        mappedStoreId: "store-1",
        installationGeneration: "generation-1",
        operation: "map",
        revision: 2,
        operator: input.operator,
        reason: input.reason,
      }),
    });
    expect(mocks.lifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.observe.mock.invocationCallOrder[0],
    );
    expect(mocks.observe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.pending.mock.invocationCallOrder[0],
    );
  });
  it.each([
    { id: "foreign" },
    { state: "mapped" },
    { state: "uninstalled" },
    { state: "redacted" },
    { revision: 2 },
    { mappedStoreId: "foreign" },
    { installationGeneration: "old" },
    { authenticatedAt: null },
    { uninstalledAt: new Date() },
    { redactedAt: new Date() },
  ])("rejects changed pending authority %j", async (change) => {
    mocks.pending.mockResolvedValue({ ...pending, ...change });
    const { tx, update, audit } = fixture();
    await expect(
      mapPendingInstallationInTransaction(tx, { ...input, apply: true }),
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });
  it.each([
    { storeAccessState: "active", storeAccessRevision: 1 },
    { storeAccessState: "suspended", storeAccessRevision: 1 },
    { storeAccessState: "pending_approval", storeAccessRevision: 2 },
  ])("rejects changed store authority %j", async (access) => {
    const { tx, update } = fixture(access);
    await expect(
      mapPendingInstallationInTransaction(tx, input),
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });
  it("does not audit a lost update", async () => {
    const { tx, update, audit } = fixture();
    update.mockResolvedValue(0);
    await expect(
      mapPendingInstallationInTransaction(tx, { ...input, apply: true }),
    ).rejects.toThrow();
    expect(audit).not.toHaveBeenCalled();
  });
  it("propagates audit failure for transaction rollback", async () => {
    const { tx, audit } = fixture();
    audit.mockRejectedValue(new Error("audit unavailable"));
    await expect(
      mapPendingInstallationInTransaction(tx, { ...input, apply: true }),
    ).rejects.toThrow("audit unavailable");
  });
});
