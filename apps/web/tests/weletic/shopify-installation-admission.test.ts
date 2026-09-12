import {
  ensurePendingInstallationAfterAuthentication,
  readInstallationAdmissionStatus,
  readPendingInstallation,
} from "@/lib/weletic/shopify/installation-admission";
import {
  assertFreshInstallationStatusIdentity,
  installationAdmissionStatusSchema,
} from "@/lib/weletic/shopify/installation-admission-contract";
import { Prisma } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const now = new Date("2026-09-09T12:00:00Z");
const seconds = now.getTime() / 1000;
const identity = {
  appId: "public-test",
  shop: "company.myshopify.com",
  userId: "123",
  issuedAt: seconds - 1,
  expiresAt: seconds + 50,
};
const pending = {
  id: "pending-id",
  appId: identity.appId,
  identityKeyId: "test-v1",
  shopDomainDigest: "A".repeat(64),
  installationGeneration: "generation-1",
  state: "pending_approval",
  revision: 1,
  mappedStoreId: null,
  authenticatedAt: new Date(now.getTime() - 10_000),
  uninstalledAt: null,
  redactedAt: null,
  expiresAt: null,
  createdAt: now,
  updatedAt: now,
};
function transaction(...results: unknown[]) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  const create = vi
    .fn()
    .mockImplementation(({ data }) => Promise.resolve(data));
  return {
    tx: {
      $queryRaw: query,
      weleticShopifyPendingInstallation: { create },
    } as unknown as Prisma.TransactionClient,
    query,
    create,
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("minimal installation status identity", () => {
  it("accepts only fresh exact-app signed identity", () => {
    expect(
      assertFreshInstallationStatusIdentity(identity, identity.appId, now),
    ).toEqual(identity);
  });
  it.each([
    { appId: "other-app" },
    { issuedAt: seconds + 1 },
    { issuedAt: seconds - 61 },
    { expiresAt: seconds },
    { shop: "company.myshopify.com.evil.invalid" },
    { userId: "0" },
    { token: "must-not-travel" },
  ])("rejects invalid or excess identity fields %j", (change) => {
    expect(() =>
      assertFreshInstallationStatusIdentity(
        { ...identity, ...change },
        identity.appId,
        now,
      ),
    ).toThrow();
  });
  it("rejects private identifiers and activation fields in the projection", () => {
    expect(
      installationAdmissionStatusSchema.safeParse({
        status: "pending_approval",
        storeId: "private",
      }).success,
    ).toBe(false);
    expect(
      installationAdmissionStatusSchema.safeParse({ status: "mapped" }).success,
    ).toBe(false);
  });
});

describe("pending installation authentication", () => {
  it("creates only a pending record with a keyed identity, never a domain or credential", async () => {
    const { tx, create } = transaction([]);
    const row = await ensurePendingInstallationAfterAuthentication(
      tx,
      identity,
      now,
    );
    expect(row).toMatchObject({
      state: "pending_approval",
      revision: 1,
      appId: identity.appId,
      authenticatedAt: now,
    });
    expect(row.installationGeneration).toBeTruthy();
    const data = create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("shop");
    expect(data).not.toHaveProperty("accessToken");
    expect(data).not.toHaveProperty("mappedStoreId");
    expect(JSON.stringify(data)).not.toContain(identity.shop);
  });
  it("keeps a current pending generation stable on refresh", async () => {
    const { tx, create } = transaction([pending]);
    expect(
      await ensurePendingInstallationAfterAuthentication(tx, identity, now),
    ).toEqual(pending);
    expect(create).not.toHaveBeenCalled();
  });
  it.each(["mapped", "uninstalled", "redacted"])(
    "never reopens %s through credential refresh",
    async (state) => {
      const { tx, create } = transaction([{ ...pending, state }]);
      await expect(
        ensurePendingInstallationAfterAuthentication(tx, identity, now),
      ).rejects.toThrow();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it("fails closed on multiple retained HMAC identities", async () => {
    const { tx } = transaction([pending, { ...pending, id: "conflict" }]);
    await expect(readPendingInstallation(tx, identity)).rejects.toThrow(
      "Ambiguous",
    );
  });
  it("scopes the locking lookup to app and keyed shop identity", async () => {
    const { tx, query } = transaction([]);
    await readPendingInstallation(tx, identity);
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain("FOR UPDATE");
    expect(sql.values).toContain(identity.appId);
    expect(sql.values).not.toContain(identity.shop);
  });
});

describe("signed status without merchant data authority", () => {
  async function status(row: unknown, stores: unknown[] = []) {
    vi.stubEnv("SHOPIFY_API_KEY", identity.appId);
    const { tx } = transaction([{ now }], stores, row ? [row] : [], [{ now }]);
    return readInstallationAdmissionStatus(tx, identity);
  }
  it("does not fabricate pending status for an absent installation", async () => {
    expect(await status(null)).toEqual({ status: "unavailable" });
  });
  it.each(["uninstalledAt", "redactedAt"])(
    "fails closed on contradictory %s even after mapping",
    async (field) => {
      expect(await status({ ...pending, [field]: now })).toEqual({
        status: "unavailable",
      });
      expect(
        await status(
          {
            ...pending,
            state: "mapped",
            mappedStoreId: "store-1",
            [field]: now,
          },
          [
            {
              id: "store-1",
              installationGeneration: "generation-1",
              complianceState: "active",
              storeAccessState: "active",
            },
          ],
        ),
      ).toEqual({ status: "unavailable" });
    },
  );
  it("exposes only status for authenticated pending installations", async () => {
    expect(await status(pending)).toEqual({ status: "pending_approval" });
  });
  it.each([
    ["uninstalled", "reauthenticate"],
    ["redacted", "unavailable"],
    ["mapped", "unavailable"],
  ])("handles %s without data access", async (state, expected) => {
    expect(await status({ ...pending, state })).toEqual({ status: expected });
  });
  it("does not infer store approval from a mapping", async () => {
    expect(
      await status({ ...pending, state: "mapped", mappedStoreId: "store-1" }, [
        {
          id: "store-1",
          installationGeneration: "generation-1",
          complianceState: "active",
          storeAccessState: "pending_approval",
        },
      ]),
    ).toEqual({ status: "pending_approval" });
  });
  it("fails closed on a foreign mapping", async () => {
    expect(
      await status(
        { ...pending, state: "mapped", mappedStoreId: "other-store" },
        [
          {
            id: "store-1",
            installationGeneration: "generation-1",
            complianceState: "active",
            storeAccessState: "active",
          },
        ],
      ),
    ).toEqual({ status: "unavailable" });
  });
  it("rejects a pre-reinstall identity even after mapping", async () => {
    expect(
      await status(
        {
          ...pending,
          state: "mapped",
          mappedStoreId: "store-1",
          authenticatedAt: now,
        },
        [
          {
            id: "store-1",
            installationGeneration: "generation-1",
            complianceState: "active",
            storeAccessState: "active",
          },
        ],
      ),
    ).toEqual({ status: "unavailable" });
  });
  it("rechecks bearer expiry after lock waits", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", identity.appId);
    const { tx } = transaction(
      [{ now }],
      [],
      [pending],
      [{ now: new Date(now.getTime() + 60_000) }],
    );
    await expect(
      readInstallationAdmissionStatus(tx, identity),
    ).rejects.toThrow();
  });
});
