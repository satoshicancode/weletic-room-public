import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileLegacyShopifyScopes } from "../../scripts/loyalty/reconcile-shopify-installation-scopes";

const mocks = vi.hoisted(() => ({
  store: vi.fn(),
  lifecycle: vi.fn(),
  legacy: vi.fn(),
  advance: vi.fn(),
  query: vi.fn(),
  update: vi.fn(),
  graphql: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/weletic/shopify/session-coordination", () => ({
  advanceLegacyShopifySessionRevision: mocks.advance,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.store },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/encryption", () => ({
  decryptOrPassthrough: (value: string) => value,
}));
vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  canonicalizeShopifyDomain: (value: string) =>
    /^[a-z0-9-]+\.myshopify\.com$/.test(value) ? value : null,
}));
vi.mock("@/lib/weletic/shopify/session-lifecycle-fence", () => ({
  lockShopifySessionLifecycle: mocks.lifecycle,
}));
vi.mock("@/lib/weletic/shopify/legacy-connection-fence", () => ({
  lockLegacyShopifyConnection: mocks.legacy,
}));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  shopifyAdminGraphqlRequest: mocks.graphql,
}));

const options = {
  storeDomain: "fixture.myshopify.com",
  confirmStaging: true,
  apply: true,
};
const tx = {
  $queryRaw: mocks.query,
  installedIntegration: {
    updateMany: mocks.update,
  },
};
const installation = () => ({
  id: "legacy-id",
  updatedAt: new Date(0),
  credentials: {
    shop: options.storeDomain,
    accessToken: "synthetic-token",
    scope: "read_products",
    installationGeneration: "generation-test",
  },
});

describe("legacy-only Shopify scope reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("WELETIC_LOYALTY_TEST_STORE_ALLOWLIST", options.storeDomain);
    mocks.store.mockResolvedValue({
      id: "store-test",
      projectId: "workspace-test",
      complianceState: "active",
    });
    mocks.lifecycle.mockResolvedValue({
      id: "store-test",
      projectId: "workspace-test",
      installationGeneration: "generation-test",
    });
    mocks.transaction.mockImplementation(async (callback) => callback(tx));
    mocks.query.mockResolvedValue([installation()]);
    mocks.graphql.mockResolvedValue({
      currentAppInstallation: {
        accessScopes: [
          { handle: "read_products" },
          { handle: "write_discounts" },
        ],
      },
    });
    mocks.update.mockResolvedValue({ count: 1 });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("rejects public/native authority before reading tokens or making remote requests", async () => {
    mocks.legacy.mockRejectedValue(new Error("managed by Shopify"));
    await expect(reconcileLegacyShopifyScopes(options)).rejects.toThrow(
      "managed by Shopify",
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rejects frozen or privacy-blocked lifecycle before legacy lookup", async () => {
    mocks.lifecycle.mockRejectedValue(new Error("frozen"));
    await expect(reconcileLegacyShopifyScopes(options)).rejects.toThrow(
      "frozen",
    );
    expect(mocks.legacy).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it("rejects a mismatched credential generation", async () => {
    const row = installation();
    row.credentials.installationGeneration = "old-generation";
    mocks.query.mockResolvedValue([row]);
    await expect(reconcileLegacyShopifyScopes(options)).rejects.toThrow(
      "credential",
    );
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it("publishes bounded verified legacy scopes in the same locked transaction", async () => {
    const result = await reconcileLegacyShopifyScopes(options);
    expect(result).toMatchObject({ updated: true, added: ["write_discounts"] });
    expect(JSON.stringify(result)).not.toContain("synthetic-token");
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5000,
      timeout: 15000,
    });
    expect(mocks.graphql).toHaveBeenCalledWith(
      expect.objectContaining({ maxRetries: 0, requestTimeoutMs: 5000 }),
    );
    expect(mocks.lifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.legacy.mock.invocationCallOrder[0],
    );
    expect(mocks.legacy.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.query.mock.invocationCallOrder[0],
    );
    expect(mocks.advance.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.update.mock.invocationCallOrder[0],
    );
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "legacy-id",
          projectId: "workspace-test",
          updatedAt: new Date(0),
        }),
      }),
    );
  });
  it("keeps preview read-only", async () => {
    await expect(
      reconcileLegacyShopifyScopes({ ...options, apply: false }),
    ).resolves.toMatchObject({ updated: false, dryRun: true });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.advance).not.toHaveBeenCalled();
  });
  it("rejects scope publication once SDK coordination has been promoted", async () => {
    mocks.advance.mockRejectedValue(new Error("stale_session"));
    await expect(reconcileLegacyShopifyScopes(options)).rejects.toThrow(
      "stale_session",
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("does not acknowledge a failed compare-and-swap", async () => {
    mocks.update.mockResolvedValue({ count: 0 });
    await expect(reconcileLegacyShopifyScopes(options)).rejects.toThrow(
      "changed concurrently",
    );
  });
  it("retains staging confirmation before database access", async () => {
    await expect(
      reconcileLegacyShopifyScopes({ ...options, confirmStaging: false }),
    ).rejects.toThrow("confirmation");
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it("rejects production even for an allowlisted store", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(reconcileLegacyShopifyScopes(options)).rejects.toThrow(
      "production",
    );
    expect(mocks.store).not.toHaveBeenCalled();
  });
});
