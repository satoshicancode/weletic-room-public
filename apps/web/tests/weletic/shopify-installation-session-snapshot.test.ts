import { readShopifySessionSnapshot } from "@/lib/weletic/shopify/session-snapshot";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/shopify/store-owned-credential", () => ({
  readStoreOwnedShopifyCredential: native,
}));
beforeEach(() => {
  native.mockReset();
});

const scope = { appId: "public-app", shop: "company.myshopify.com" };
const pending = {
  id: "pending-1",
  appId: scope.appId,
  state: "pending_approval",
  mappedStoreId: null,
  installationGeneration: "pending-generation-1",
  authenticatedAt: new Date(),
  uninstalledAt: null,
  redactedAt: null,
};
function txFor(record: unknown) {
  return {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ revision: BigInt(4), leaseEpoch: BigInt(2) }])
      .mockResolvedValueOnce(record ? [record] : [])
      .mockResolvedValueOnce([]),
  } as unknown as Prisma.TransactionClient;
}
describe("pending installation session observations", () => {
  const store = {
    id: "store-1",
    projectId: "workspace-1",
    shopDomain: scope.shop,
    complianceState: "active",
    installationGeneration: "pending-generation-1",
  };
  it("uses native public authority without consulting legacy installer ownership", async () => {
    native.mockResolvedValue({
      revision: 3,
      accessToken: "synthetic-token",
      scope: "read_orders",
    });
    const tx = txFor({ ...pending, state: "mapped", mappedStoreId: store.id });
    const snapshot = await readShopifySessionSnapshot(tx, scope, store);
    expect(snapshot.observed.credentialTokenHash).toBe(
      createHash("sha256").update("synthetic-token").digest("hex"),
    );
    expect(native).toHaveBeenCalledWith(tx, {
      ...scope,
      storeId: store.id,
      workspaceId: store.projectId,
      installationGeneration: store.installationGeneration,
    });
    // This transaction deliberately has no InstalledIntegration delegate.
  });
  it("does not turn a missing public credential into legacy authority", async () => {
    native.mockResolvedValue(null);
    const snapshot = await readShopifySessionSnapshot(
      txFor({ ...pending, state: "mapped", mappedStoreId: store.id }),
      scope,
      store,
    );
    expect(snapshot.observed.credentialTokenHash).toBeNull();
  });
  it("propagates public credential verification failure without fallback", async () => {
    native.mockRejectedValue(new Error("credential verification failed"));
    await expect(
      readShopifySessionSnapshot(
        txFor({ ...pending, state: "mapped", mappedStoreId: store.id }),
        scope,
        store,
      ),
    ).rejects.toThrow("credential verification failed");
  });
  it("carries the pending generation without granting worker credential authority", async () => {
    const snapshot = await readShopifySessionSnapshot(
      txFor(pending),
      scope,
      undefined,
    );
    expect(snapshot.observed).toMatchObject({
      installationGeneration: "pending-generation-1",
      credentialTokenHash: null,
      revision: "4",
      epoch: "2",
    });
    expect(snapshot.properties).toBeNull();
  });
  it("keeps first authentication unbound until a record is actually published", async () => {
    expect(
      (await readShopifySessionSnapshot(txFor(null), scope, undefined)).observed
        .installationGeneration,
    ).toBeNull();
  });
  it.each([
    { state: "uninstalled" },
    { state: "redacted" },
    { state: "mapped" },
    { mappedStoreId: "foreign" },
    { installationGeneration: null },
    { authenticatedAt: null },
    { uninstalledAt: new Date() },
    { redactedAt: new Date() },
  ])(
    "refuses refresh authority for invalid pending lifecycle %j",
    async (change) => {
      await expect(
        readShopifySessionSnapshot(
          txFor({ ...pending, ...change }),
          scope,
          undefined,
        ),
      ).rejects.toMatchObject({ code: "stale_session" });
    },
  );
});
