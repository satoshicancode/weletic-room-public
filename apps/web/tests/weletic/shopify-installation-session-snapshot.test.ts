import { encrypt } from "@/lib/encryption";
import {
  assertShopifySessionObservation,
  readShopifySessionSnapshot,
} from "@/lib/weletic/shopify/session-snapshot";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/shopify/store-owned-credential", () => ({
  readStoreOwnedShopifyCredential: native,
}));
beforeEach(() => {
  native.mockReset();
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
});
afterEach(() => vi.unstubAllEnvs());

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
function txFor(record: unknown, sessionRows: unknown[] = []) {
  return {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ revision: BigInt(4), leaseEpoch: BigInt(2) }])
      .mockResolvedValueOnce(record ? [record] : [])
      .mockResolvedValueOnce(sessionRows),
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
  const properties = [
    ["id", `offline_${scope.shop}`],
    ["shop", scope.shop],
    ["isOnline", false],
    ["state", "synthetic-state"],
    ["accessToken", "synthetic-token"],
  ];
  function sessionRow() {
    return {
      shop: scope.shop,
      isOnline: false,
      payload: encrypt(JSON.stringify(properties)),
    };
  }
  it("forces fresh authentication after mapping without losing the persisted observation", async () => {
    native.mockResolvedValue(null);
    const row = sessionRow();
    const mapped = { ...pending, state: "mapped", mappedStoreId: store.id };
    const tx = txFor(mapped, [row]);
    const snapshot = await readShopifySessionSnapshot(tx, scope, store);
    expect(snapshot.properties).toBeNull();
    expect(snapshot.observed).toMatchObject({
      installationGeneration: store.installationGeneration,
      credentialTokenHash: null,
      revision: "4",
      epoch: "2",
      sessionDigest: createHash("sha256")
        .update(`present:${row.payload}`)
        .digest("hex"),
    });
    const changed = sessionRow();
    const later = await readShopifySessionSnapshot(
      txFor(mapped, [changed]),
      scope,
      store,
    );
    expect(later.observed.sessionDigest).not.toBe(
      snapshot.observed.sessionDigest,
    );
    expect(() =>
      assertShopifySessionObservation(later.observed, snapshot.observed),
    ).toThrow();
  });
  it("continues to return the pending session before workspace mapping", async () => {
    const snapshot = await readShopifySessionSnapshot(
      txFor(pending, [sessionRow()]),
      scope,
      undefined,
    );
    expect(snapshot.properties).toEqual(properties);
    expect(native).not.toHaveBeenCalled();
  });
  it("returns the session after matching store-owned credential publication", async () => {
    native.mockResolvedValue({
      revision: 1,
      accessToken: "synthetic-token",
      scope: "read_orders",
    });
    const snapshot = await readShopifySessionSnapshot(
      txFor({ ...pending, state: "mapped", mappedStoreId: store.id }, [
        sessionRow(),
      ]),
      scope,
      store,
    );
    expect(snapshot.properties).toEqual(properties);
    expect(snapshot.observed.credentialTokenHash).not.toBeNull();
  });
  it("still rejects divergent credential tokens rather than treating them as cache misses", async () => {
    native.mockResolvedValue({
      revision: 1,
      accessToken: "different-token",
      scope: "read_orders",
    });
    await expect(
      readShopifySessionSnapshot(
        txFor({ ...pending, state: "mapped", mappedStoreId: store.id }, [
          sessionRow(),
        ]),
        scope,
        store,
      ),
    ).rejects.toMatchObject({ code: "stale_session" });
  });
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
