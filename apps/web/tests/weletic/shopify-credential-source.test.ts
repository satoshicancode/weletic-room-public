import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readShopifyCredentialSource } from "../../lib/weletic/shopify/credential-source";
const mocks = vi.hoisted(() => ({
  lock: vi.fn(),
  admission: vi.fn(),
  observe: vi.fn(),
  read: vi.fn(),
  legacy: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (callback: (tx: object) => unknown) => callback({}),
  },
}));
vi.mock("@/lib/weletic/shopify/session-lifecycle-fence", () => ({
  lockShopifySessionLifecycle: mocks.lock,
  SessionCredentialWriteBlockedError: class extends Error {},
}));
vi.mock("@/lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: mocks.admission,
}));
vi.mock("@/lib/weletic/shopify/session-coordination", async (original) => ({
  ...(await original<
    typeof import("@/lib/weletic/shopify/session-coordination")
  >()),
  observeShopifySessionCoordination: mocks.observe,
}));
vi.mock("@/lib/weletic/shopify/store-owned-credential", () => ({
  readStoreOwnedShopifyCredential: mocks.read,
  assertLegacyShopifyCredentialAuthority: mocks.legacy,
}));
const input = {
  storeId: "store",
  workspaceId: "workspace",
  shop: "company.myshopify.com",
  installationGeneration: "generation",
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SHOPIFY_API_KEY", "public-app");
  mocks.lock.mockResolvedValue({
    id: input.storeId,
    projectId: input.workspaceId,
    installationGeneration: input.installationGeneration,
  });
  mocks.admission.mockResolvedValue({ state: "mapped" });
  mocks.read.mockResolvedValue({
    revision: 2,
    accessToken: "synthetic-token",
    scope: "read_orders",
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("store-locked credential source selection", () => {
  it("reads native authority in Store/coordinator/admission/credential order", async () => {
    expect(await readShopifyCredentialSource(input)).toMatchObject({
      source: "native",
      revision: 2,
      installationGeneration: "generation",
    });
    expect(mocks.lock.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.observe.mock.invocationCallOrder[0],
    );
    expect(mocks.observe.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.admission.mock.invocationCallOrder[0],
    );
    expect(mocks.admission.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.read.mock.invocationCallOrder[0],
    );
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { projectId: "foreign", installationGeneration: "generation" },
    { projectId: "workspace", installationGeneration: "new" },
  ])("rejects changed Store authority %j", async (store) => {
    mocks.lock.mockResolvedValue(store);
    await expect(readShopifyCredentialSource(input)).rejects.toThrow(
      "identity changed",
    );
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it("does not recover a missing native credential from legacy storage", async () => {
    mocks.read.mockResolvedValue(null);
    await expect(readShopifyCredentialSource(input)).rejects.toThrow(
      "fresh authentication",
    );
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("requires proof of absent native authority before selecting legacy", async () => {
    mocks.admission.mockResolvedValue(null);
    expect(await readShopifyCredentialSource(input)).toEqual({
      source: "legacy",
    });
    expect(mocks.legacy).toHaveBeenCalledWith(
      expect.anything(),
      "store",
      "public-app",
    );
    mocks.legacy.mockRejectedValue(new Error("Native credential still exists"));
    await expect(readShopifyCredentialSource(input)).rejects.toThrow(
      "Native credential still exists",
    );
  });
});
