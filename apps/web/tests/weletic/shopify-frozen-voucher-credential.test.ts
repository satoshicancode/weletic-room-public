import { encrypt } from "@/lib/encryption";
import { Prisma } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFrozenStoreOwnedVoucherCredential } from "../../lib/weletic/shopify/store-owned-credential";
const admission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/shopify/installation-admission", () => ({
  readPendingInstallation: admission,
}));
const proof = {
  storeId: "store",
  cleanupId: "cleanup",
  redemptionId: "redemption",
  lockOwner: "worker",
  leaseVersion: 2,
  source: "app_uninstalled",
  expectedCode: "VOUCHER",
};
const identity = {
  storeId: "store",
  workspaceId: "workspace",
  appId: "public-app",
  shop: "company.myshopify.com",
  installationGeneration: "generation",
};
const store = {
  id: identity.storeId,
  projectId: identity.workspaceId,
  shopDomain: identity.shop,
  installationGeneration: identity.installationGeneration,
  complianceState: "frozen",
};
const pending = {
  mappedStoreId: "store",
  installationGeneration: "generation",
  state: "uninstalled",
  authenticatedAt: new Date(0),
  uninstalledAt: new Date(1),
  redactedAt: null,
};
const lease = {
  id: "cleanup",
  storeId: "store",
  redemptionId: "redemption",
  source: "app_uninstalled",
  status: "processing",
  lockedBy: "worker",
  leaseVersion: 2,
  expectedDiscountCodeCanonical: "VOUCHER",
  live: 1,
};
function fixture(
  change: {
    store?: object;
    lease?: object;
    requests?: object[];
    credential?: object;
  } = {},
) {
  const query = vi.fn(async (sql: Prisma.Sql): Promise<unknown[]> => {
    if (sql.sql.includes("FROM WeleticShopifyStore "))
      return [{ ...store, ...change.store }];
    if (sql.sql.includes("FROM WeleticShopifySessionCoordination"))
      return [{ revision: BigInt(1), leaseEpoch: BigInt(1) }];
    if (sql.sql.includes("FROM WeleticShopifyInstallationCredential"))
      return [
        {
          id: "credential",
          storeId: identity.storeId,
          appId: identity.appId,
          installationGeneration: "generation",
          revision: 1,
          credentialCiphertext: encrypt(
            JSON.stringify({
              version: 1,
              revision: 1,
              identity,
              material: {
                accessToken: "synthetic-token",
                scope: "write_discounts",
              },
            }),
          ),
          ...change.credential,
        },
      ];
    if (sql.sql.includes("FROM WeleticShopifyVoucherCleanup WHERE"))
      return [{ ...lease, ...change.lease }];
    if (sql.sql.includes("FROM WeleticShopifyVoucherCleanupRequestLink"))
      return (
        change.requests ?? [
          {
            requestType: "app_uninstalled",
            shopDomain: identity.shop,
            payloadCiphertext: encrypt(
              JSON.stringify({
                shopDomain: identity.shop,
                installationGeneration: identity.installationGeneration,
              }),
            ),
          },
        ]
      );
    throw new Error("Unexpected SQL");
  });
  return {
    query,
    tx: { $queryRaw: query } as unknown as Prisma.TransactionClient,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("SHOPIFY_API_KEY", identity.appId);
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  admission.mockResolvedValue(pending);
});
afterEach(() => vi.unstubAllEnvs());
describe("frozen voucher credential capability", () => {
  it("rechecks lease expiry after linked-request lock waits", async () => {
    const { query, tx } = fixture();
    const original = query.getMockImplementation()!;
    query.mockImplementation(async (sql) =>
      sql.sql.includes("SELECT (lockedAt") ? [{ live: 0 }] : original(sql),
    );
    await expect(
      readFrozenStoreOwnedVoucherCredential(tx, proof),
    ).rejects.toThrow("expired during authorization");
  });
  it("opens only the exact frozen generation for a current linked cleanup lease", async () => {
    expect(
      await readFrozenStoreOwnedVoucherCredential(fixture().tx, proof),
    ).toEqual({
      shopDomain: identity.shop,
      installationGeneration: "generation",
      accessToken: "synthetic-token",
      scope: "write_discounts",
    });
  });
  it.each(["active", "redacted"])(
    "rejects %s stores",
    async (complianceState) => {
      await expect(
        readFrozenStoreOwnedVoucherCredential(
          fixture({ store: { complianceState } }).tx,
          proof,
        ),
      ).rejects.toThrow("lifecycle changed");
    },
  );
  it.each([
    { live: 0 },
    { leaseVersion: 3 },
    { lockedBy: "other" },
    { status: "completed" },
    { redemptionId: "other" },
    { expectedDiscountCodeCanonical: "OTHER" },
    { source: "customer_redact" },
  ])("rejects changed cleanup authority %j", async (change) => {
    await expect(
      readFrozenStoreOwnedVoucherCredential(
        fixture({ lease: change }).tx,
        proof,
      ),
    ).rejects.toThrow("lease changed");
  });
  it("rejects new-generation admission even when a frozen credential remains", async () => {
    admission.mockResolvedValue({ ...pending, installationGeneration: "new" });
    await expect(
      readFrozenStoreOwnedVoucherCredential(fixture().tx, proof),
    ).rejects.toThrow("admission changed");
  });
  it.each(["missing", "old-generation", "foreign-shop", "corrupt"])(
    "rejects %s uninstall request authority",
    async (kind) => {
      const requests =
        kind === "missing"
          ? []
          : [
              {
                requestType: "app_uninstalled",
                shopDomain:
                  kind === "foreign-shop"
                    ? "foreign.myshopify.com"
                    : identity.shop,
                payloadCiphertext:
                  kind === "corrupt"
                    ? "not-encrypted"
                    : encrypt(
                        JSON.stringify({
                          shopDomain: identity.shop,
                          installationGeneration: "old-generation",
                        }),
                      ),
              },
            ];
      await expect(
        readFrozenStoreOwnedVoucherCredential(fixture({ requests }).tx, proof),
      ).rejects.toThrow("request is unavailable");
    },
  );
  it("accepts a linked unfinished shop-redaction path without requiring an uninstall timestamp", async () => {
    admission.mockResolvedValue({
      ...pending,
      state: "mapped",
      uninstalledAt: null,
    });
    expect(
      await readFrozenStoreOwnedVoucherCredential(
        fixture({
          lease: { source: "shop_redact" },
          requests: [
            {
              requestType: "shop_redact",
              shopDomain: identity.shop,
              payloadCiphertext: null,
            },
          ],
        }).tx,
        { ...proof, source: "shop_redact" },
      ),
    ).toMatchObject({ accessToken: "synthetic-token" });
  });
});
