import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShopifyCredentialUnavailableError } from "../../lib/weletic/shopify/credential-errors";
import { lockLegacyShopifyConnection } from "../../lib/weletic/shopify/legacy-connection-fence";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  coordinator: vi.fn(),
  admission: vi.fn(),
  legacy: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  deriveAllShopifyShopPrivacyIdentities: () => [
    { identityKeyId: "test-key", shopDomainDigest: "test-digest" },
  ],
}));
vi.mock("@/lib/weletic/shopify/session-coordination", async (original) => ({
  ...(await original<
    typeof import("../../lib/weletic/shopify/session-coordination")
  >()),
  ensureShopifySessionCoordination: mocks.coordinator,
}));
vi.mock("@/lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: mocks.admission,
}));
vi.mock("@/lib/weletic/shopify/store-owned-credential", () => ({
  assertLegacyShopifyCredentialAuthority: mocks.legacy,
}));
const input = { workspaceId: "workspace", shop: "company.myshopify.com" };
const store = {
  id: "store",
  projectId: input.workspaceId,
  shopDomain: input.shop,
};
const tx = { $queryRaw: mocks.query } as unknown as Prisma.TransactionClient;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SHOPIFY_API_KEY", "public-app");
  mocks.query.mockImplementation(async (sql: Prisma.Sql) =>
    sql.sql.includes("WeleticShopifyShopPrivacyTombstone") ? [] : [store],
  );
  mocks.admission.mockResolvedValue(null);
});
afterEach(() => vi.unstubAllEnvs());

describe("legacy callback authority fence", () => {
  it("locks Store, coordinator, admission and credential authority in order", async () => {
    await lockLegacyShopifyConnection(tx, input);
    expect(mocks.query.mock.calls[0][0].sql).toContain("FOR UPDATE");
    expect(mocks.query.mock.calls[1][0].sql).toContain(
      "WeleticShopifyShopPrivacyTombstone",
    );
    expect(mocks.query.mock.invocationCallOrder[1]).toBeLessThan(
      mocks.coordinator.mock.invocationCallOrder[0],
    );
    const calls = [
      mocks.query,
      mocks.coordinator,
      mocks.admission,
      mocks.legacy,
    ];
    for (let i = 1; i < calls.length; i++)
      expect(calls[i - 1].mock.invocationCallOrder[0]).toBeLessThan(
        calls[i].mock.invocationCallOrder[0],
      );
    expect(mocks.legacy).toHaveBeenCalledWith(tx, "store", "public-app");
  });
  it("anchors an unbound shop before permitting legacy creation", async () => {
    mocks.query.mockResolvedValue([]);
    await lockLegacyShopifyConnection(tx, input);
    expect(mocks.coordinator).toHaveBeenCalledWith(tx, {
      appId: "public-app",
      shop: input.shop,
    });
    expect(mocks.admission).toHaveBeenCalled();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("rejects a retained privacy tombstone before locking the coordinator", async () => {
    mocks.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "tombstone" }]);
    await expect(lockLegacyShopifyConnection(tx, input)).rejects.toThrow(
      "redacted privacy lifecycle",
    );
    expect(mocks.coordinator).not.toHaveBeenCalled();
  });
  it.each(["pending_approval", "mapped", "uninstalled", "redacted"])(
    "rejects %s public admission even without a Store",
    async (state) => {
      mocks.query.mockResolvedValue([]);
      mocks.admission.mockResolvedValue({ state });
      await expect(lockLegacyShopifyConnection(tx, input)).rejects.toThrow(
        "managed by Shopify",
      );
      expect(mocks.legacy).not.toHaveBeenCalled();
    },
  );
  it.each([
    [{ ...store, projectId: "foreign" }],
    [{ ...store, shopDomain: "other.myshopify.com" }],
    [store, { ...store, id: "duplicate" }],
  ])("rejects foreign or ambiguous Store bindings %j", async (...stores) => {
    mocks.query.mockResolvedValue(stores);
    await expect(lockLegacyShopifyConnection(tx, input)).rejects.toThrow(
      "binding changed",
    );
    expect(mocks.coordinator).not.toHaveBeenCalled();
  });
  it("rejects orphan native credentials without leaking internal details", async () => {
    mocks.legacy.mockRejectedValue(
      new ShopifyCredentialUnavailableError("private detail"),
    );
    await expect(lockLegacyShopifyConnection(tx, input)).rejects.toThrow(
      "managed by Shopify",
    );
  });
  it("does not treat a database failure as permission to use legacy storage", async () => {
    const outage = new Error("storage unavailable");
    mocks.legacy.mockRejectedValue(outage);
    await expect(lockLegacyShopifyConnection(tx, input)).rejects.toBe(outage);
  });
});
