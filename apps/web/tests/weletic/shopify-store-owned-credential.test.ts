import { decrypt, encrypt } from "@/lib/encryption";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertLegacyShopifyCredentialAuthority,
  publishStoreOwnedShopifyCredential,
  readStoreOwnedShopifyCredential,
} from "../../lib/weletic/shopify/store-owned-credential";
const mocks = vi.hoisted(() => ({ lifecycle: vi.fn(), pending: vi.fn() }));
vi.mock("../../lib/weletic/shopify/session-lifecycle-fence", () => ({
  lockShopifySessionLifecycle: mocks.lifecycle,
}));
vi.mock("../../lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: mocks.pending,
}));
const identity = {
  storeId: "store",
  workspaceId: "workspace",
  appId: "public-app",
  shop: "company.myshopify.com",
  installationGeneration: "generation",
};
const material = {
  accessToken: "synthetic-secret-token",
  scope: "read_orders",
};
function row() {
  return {
    id: "credential",
    storeId: identity.storeId,
    appId: identity.appId,
    installationGeneration: identity.installationGeneration,
    revision: 2,
    credentialCiphertext: encrypt(
      JSON.stringify({ version: 1, revision: 2, identity, material }),
    ),
  };
}
function transaction(rows: unknown[] = []) {
  const query = vi.fn().mockResolvedValue(rows);
  const write = vi.fn().mockResolvedValue(1);
  return {
    query,
    write,
    tx: {
      $queryRaw: query,
      $executeRaw: write,
    } as unknown as Prisma.TransactionClient,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SHOPIFY_API_KEY", identity.appId);
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  mocks.lifecycle.mockResolvedValue({
    id: identity.storeId,
    projectId: identity.workspaceId,
    shopDomain: identity.shop,
    installationGeneration: identity.installationGeneration,
  });
  mocks.pending.mockResolvedValue({
    state: "mapped",
    mappedStoreId: identity.storeId,
    installationGeneration: identity.installationGeneration,
    authenticatedAt: new Date(),
    uninstalledAt: null,
    redactedAt: null,
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("store-owned encrypted Shopify credentials", () => {
  it("rejects legacy authority when a native row outlives its admission", async () => {
    const { tx } = transaction([{ id: "native-credential" }]);
    await expect(
      assertLegacyShopifyCredentialAuthority(
        tx,
        identity.storeId,
        identity.appId,
      ),
    ).rejects.toThrow("requires its admission");
  });
  it("permits the legacy boundary only when no native row exists", async () => {
    const { tx } = transaction([]);
    await expect(
      assertLegacyShopifyCredentialAuthority(
        tx,
        identity.storeId,
        identity.appId,
      ),
    ).resolves.toBeUndefined();
  });
  it("returns missing without querying generic installer ownership", async () => {
    const { tx } = transaction();
    expect(await readStoreOwnedShopifyCredential(tx, identity)).toBeNull();
  });
  it("reads only authenticated encrypted material matching the full identity", async () => {
    const { tx } = transaction([row()]);
    expect(await readStoreOwnedShopifyCredential(tx, identity)).toEqual({
      revision: 2,
      ...material,
    });
  });
  it("publishes an encrypted envelope without installer fields or plaintext token in SQL", async () => {
    const { tx, write } = transaction();
    expect(
      await publishStoreOwnedShopifyCredential(tx, {
        identity,
        expectedRevision: null,
        material,
      }),
    ).toEqual({ revision: 1 });
    const sql = write.mock.calls[0][0] as Prisma.Sql;
    expect(JSON.stringify(sql.values)).not.toContain(material.accessToken);
    const envelope = JSON.parse(decrypt(sql.values[5] as string));
    expect(envelope).toEqual({ version: 1, revision: 1, identity, material });
    expect(sql.sql).not.toContain("userId");
  });
  it("refreshes a matching revision with scalar identity CAS", async () => {
    const { tx, write } = transaction([row()]);
    expect(
      await publishStoreOwnedShopifyCredential(tx, {
        identity,
        expectedRevision: 2,
        material,
      }),
    ).toEqual({ revision: 3 });
    expect((write.mock.calls[0][0] as Prisma.Sql).values).toContain(
      identity.installationGeneration,
    );
  });
  it.each([null, 1, 3])(
    "rejects stale expected revision %j before publication",
    async (expectedRevision) => {
      const { tx, write } = transaction([row()]);
      await expect(
        publishStoreOwnedShopifyCredential(tx, {
          identity,
          expectedRevision,
          material,
        }),
      ).rejects.toThrow("revision fence");
      expect(write).not.toHaveBeenCalled();
    },
  );
  it.each([
    "storeId",
    "workspaceId",
    "appId",
    "shop",
    "installationGeneration",
  ])("rejects encrypted envelope swapped across %s", async (field) => {
    const record = row();
    record.credentialCiphertext = encrypt(
      JSON.stringify({
        version: 1,
        revision: 2,
        identity: {
          ...identity,
          [field]: field === "shop" ? "foreign.myshopify.com" : "foreign",
        },
        material,
      }),
    );
    const { tx } = transaction([record]);
    await expect(readStoreOwnedShopifyCredential(tx, identity)).rejects.toThrow(
      "cannot be verified",
    );
  });
  it.each(["plaintext-private-token", "bad-ciphertext"])(
    "never falls back to plaintext %s",
    async (credentialCiphertext) => {
      const { tx } = transaction([{ ...row(), credentialCiphertext }]);
      await expect(
        readStoreOwnedShopifyCredential(tx, identity),
      ).rejects.toThrow(/^Stored Shopify credential cannot be verified$/);
    },
  );
  it("rejects another configured app before lifecycle/database work", async () => {
    const { tx, query } = transaction();
    await expect(
      readStoreOwnedShopifyCredential(tx, { ...identity, appId: "foreign" }),
    ).rejects.toThrow("app identity");
    expect(mocks.lifecycle).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it.each(["pending_approval", "uninstalled", "redacted"])(
    "rejects %s admission",
    async (state) => {
      mocks.pending.mockResolvedValue({ state });
      const { tx, query } = transaction();
      await expect(
        readStoreOwnedShopifyCredential(tx, identity),
      ).rejects.toThrow("mapped admission");
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("rejects stale Store generation before reading a credential", async () => {
    mocks.lifecycle.mockResolvedValue({
      id: identity.storeId,
      projectId: identity.workspaceId,
      shopDomain: identity.shop,
      installationGeneration: "new-generation",
    });
    const { tx, query } = transaction();
    await expect(readStoreOwnedShopifyCredential(tx, identity)).rejects.toThrow(
      "generation changed",
    );
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects a lost scalar update", async () => {
    const { tx, write } = transaction([row()]);
    write.mockResolvedValue(0);
    await expect(
      publishStoreOwnedShopifyCredential(tx, {
        identity,
        expectedRevision: 2,
        material,
      }),
    ).rejects.toThrow("revision fence");
  });
  it("rejects replayed ciphertext from an older revision of the same generation", async () => {
    const { tx } = transaction([{ ...row(), revision: 3 }]);
    await expect(readStoreOwnedShopifyCredential(tx, identity)).rejects.toThrow(
      "cannot be verified",
    );
  });
});
