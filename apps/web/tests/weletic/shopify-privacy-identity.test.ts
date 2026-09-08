import {
  getShopifyComplianceExportRetentionHours,
  getShopifyCustomerTombstoneRetentionDays,
  getShopifyFinancialRetentionDays,
} from "@/lib/weletic/shopify/compliance-config";
import {
  createAllShopifyWebhookBodyDigests,
  createShopifyDerivedPrivacyDigest,
  deriveAllShopifyCustomerPrivacyIdentities,
  deriveAllShopifyShopPrivacyIdentities,
  deriveShopifyCustomerPrivacyIdentity,
  getShopifyCustomerPrivacyPseudonym,
  hasShopifyCustomerPrivacyTombstone,
  loadShopifyPrivacyHmacKeyring,
  matchesShopifyCustomerPrivacyTombstoneOwner,
  parseShopifyCustomerPrivacyPseudonym,
  ShopifyCustomerPrivacyOwnerConflictError,
  upsertShopifyCustomerPrivacyTombstones,
  upsertShopifyShopPrivacyTombstone,
  verifyShopifyDerivedPrivacyDigest,
} from "@/lib/weletic/shopify/privacy-identity";
import { WeleticCustomerPrivacyIdentityKind } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  customerTombstoneUpsert: vi.fn(),
  customerTombstoneUpdateMany: vi.fn(),
  customerTombstoneFindUniqueOrThrow: vi.fn(),
  customerTombstoneFindFirst: vi.fn(),
  shopTombstoneUpsert: vi.fn(),
  shopTombstoneUpdateMany: vi.fn(),
  shopTombstoneFindUniqueOrThrow: vi.fn(),
  requestFindUnique: vi.fn(),
  shopperFindUnique: vi.fn(),
  accountFindUnique: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const client = {
    weleticShopifyCustomerPrivacyTombstone: {
      upsert: mocks.customerTombstoneUpsert,
      updateMany: mocks.customerTombstoneUpdateMany,
      findUniqueOrThrow: mocks.customerTombstoneFindUniqueOrThrow,
      findFirst: mocks.customerTombstoneFindFirst,
    },
    weleticShopifyShopPrivacyTombstone: {
      upsert: mocks.shopTombstoneUpsert,
      updateMany: mocks.shopTombstoneUpdateMany,
      findUniqueOrThrow: mocks.shopTombstoneFindUniqueOrThrow,
    },
    weleticShopifyComplianceRequest: {
      findUnique: mocks.requestFindUnique,
    },
    weleticShopper: { findUnique: mocks.shopperFindUnique },
    weleticLoyaltyAccount: { findUnique: mocks.accountFindUnique },
    $queryRaw: mocks.queryRaw,
  };
  mocks.transaction.mockImplementation(async (callback) => callback(client));
  return { prisma: { ...client, $transaction: mocks.transaction } };
});

function encodedKey(byte: number) {
  return Buffer.alloc(32, byte).toString("base64");
}

describe("versioned Shopify privacy identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `current-2026:${encodedKey(1)},previous-2025:${encodedKey(2)}`,
    );
    mocks.customerTombstoneUpsert.mockImplementation(
      async ({ create }) => create,
    );
    mocks.customerTombstoneUpdateMany.mockResolvedValue({ count: 1 });
    mocks.customerTombstoneFindUniqueOrThrow.mockImplementation(
      async ({ where }) => ({ id: where.id }),
    );
    mocks.shopTombstoneUpsert.mockImplementation(async ({ create }) => create);
    mocks.shopTombstoneUpdateMany.mockResolvedValue({ count: 1 });
    mocks.shopTombstoneFindUniqueOrThrow.mockImplementation(
      async ({ where }) => ({
        id: where.id,
        storeId: "store-a",
        sourceRequestId: null,
      }),
    );
    mocks.requestFindUnique.mockResolvedValue({ id: "request-store-a" });
    mocks.shopperFindUnique.mockResolvedValue({
      id: "shopper-1",
      storeId: "store-a",
    });
    mocks.accountFindUnique.mockResolvedValue({
      id: "account-1",
      storeId: "store-a",
      shopperId: "shopper-1",
    });
    mocks.queryRaw.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses explicit current and previous key ids without cross-tenant or cross-kind correlation", () => {
    const identities = deriveAllShopifyCustomerPrivacyIdentities({
      storeId: "store-a",
      shopifyCustomerId: "gid://shopify/Customer/42",
      email: " MEMBER@Example.COM ",
    });
    expect(identities).toHaveLength(4);
    expect(
      new Set(identities.map(({ identityKeyId }) => identityKeyId)),
    ).toEqual(new Set(["current-2026", "previous-2025"]));
    expect(
      identities.find(
        ({ identityKind, identityKeyId }) =>
          identityKind === WeleticCustomerPrivacyIdentityKind.customer_id &&
          identityKeyId === "current-2026",
      )?.customerDigest,
    ).not.toBe(
      identities.find(
        ({ identityKind, identityKeyId }) =>
          identityKind === WeleticCustomerPrivacyIdentityKind.customer_email &&
          identityKeyId === "current-2026",
      )?.customerDigest,
    );

    const otherStore = deriveShopifyCustomerPrivacyIdentity({
      storeId: "store-b",
      identityKind: WeleticCustomerPrivacyIdentityKind.customer_id,
      identity: "42",
    });
    expect(otherStore.customerDigest).not.toBe(identities[0].customerDigest);
  });

  it("recognizes only configured canonical retained customer pseudonyms", () => {
    const pseudonym = getShopifyCustomerPrivacyPseudonym({
      storeId: "store-a",
      shopifyCustomerId: "42",
    });
    expect(parseShopifyCustomerPrivacyPseudonym(pseudonym)).toEqual({
      value: pseudonym,
      identityKeyId: "current-2026",
      customerDigest: expect.stringMatching(/^[A-F0-9]{64}$/),
    });
    expect(parseShopifyCustomerPrivacyPseudonym("42")).toBeNull();
    expect(() =>
      parseShopifyCustomerPrivacyPseudonym(
        `redacted:v1:retired:${"A".repeat(64)}`,
      ),
    ).toThrow("pseudonym key is unavailable");
    expect(() =>
      parseShopifyCustomerPrivacyPseudonym("redacted:v1:invalid"),
    ).toThrow("pseudonym is invalid");
  });

  it("verifies old keyed signals during rotation while new writes use the current key", () => {
    const oldKeyring = loadShopifyPrivacyHmacKeyring(
      `previous-2025:${encodedKey(2)}`,
    );
    const rotatedKeyring = loadShopifyPrivacyHmacKeyring(
      `current-2026:${encodedKey(1)},previous-2025:${encodedKey(2)}`,
    );
    const oldDigest = createShopifyDerivedPrivacyDigest({
      purpose: "customer_selection",
      values: ["store-a", "42"],
      keyring: oldKeyring,
    });
    expect(oldDigest).toMatch(/^hmac:v1:previous-2025:[A-F0-9]{64}$/);
    expect(
      verifyShopifyDerivedPrivacyDigest({
        encodedDigest: oldDigest,
        purpose: "customer_selection",
        values: ["store-a", "42"],
        keyring: rotatedKeyring,
      }),
    ).toBe(true);
    expect(
      createShopifyDerivedPrivacyDigest({
        purpose: "customer_selection",
        values: ["store-a", "42"],
        keyring: rotatedKeyring,
      }),
    ).toMatch(/^hmac:v1:current-2026:/);
  });

  it("binds authenticated webhook identity to the topic and exact raw bytes across key rotation", () => {
    const rawBodyBytes = Buffer.from('{"customer":{"id":42}}', "utf8");
    const digests = createAllShopifyWebhookBodyDigests({
      topic: "customers/redact",
      rawBodyBytes,
    });

    expect(digests).toHaveLength(2);
    expect(digests[0]).toMatch(/^hmac:v1:current-2026:[A-F0-9]{64}$/);
    expect(digests[1]).toMatch(/^hmac:v1:previous-2025:[A-F0-9]{64}$/);
    expect(
      createAllShopifyWebhookBodyDigests({
        topic: "customers/data_request",
        rawBodyBytes,
      })[0],
    ).not.toBe(digests[0]);
    expect(
      createAllShopifyWebhookBodyDigests({
        topic: "customers/redact",
        rawBodyBytes: Buffer.from('{"customer": {"id":42}}', "utf8"),
      })[0],
    ).not.toBe(digests[0]);
  });

  it("creates ID and normalized-email tombstones without persisting either raw subject", async () => {
    await upsertShopifyCustomerPrivacyTombstones({
      storeId: "store-a",
      shopifyCustomerId: "gid://shopify/Customer/42",
      email: "Member@Example.com",
      shopperId: "shopper-1",
      accountId: "account-1",
      redactedAt: new Date("2026-08-30T00:00:00.000Z"),
      expiresAt: new Date("2036-08-30T00:00:00.000Z"),
    });

    expect(mocks.customerTombstoneUpsert).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(
      mocks.customerTombstoneUpsert.mock.calls.map(([input]) => input),
    );
    expect(serialized).not.toContain("Customer/42");
    expect(serialized).not.toContain("Member@Example.com");
    expect(serialized).not.toContain("member@example.com");
    expect(serialized).toContain("customer_id");
    expect(serialized).toContain("customer_email");
    expect(mocks.shopperFindUnique).toHaveBeenCalledWith({
      where: { storeId_id: { storeId: "store-a", id: "shopper-1" } },
      select: { id: true, storeId: true },
    });
    expect(mocks.accountFindUnique).toHaveBeenCalledWith({
      where: { storeId_id: { storeId: "store-a", id: "account-1" } },
      select: { id: true, storeId: true, shopperId: true },
    });
  });

  it("creates a bounded, tenant-scoped customer pseudonym without the raw id", () => {
    const pseudonym = getShopifyCustomerPrivacyPseudonym({
      storeId: "store-a",
      shopifyCustomerId: "gid://shopify/Customer/42",
    });
    const otherStore = getShopifyCustomerPrivacyPseudonym({
      storeId: "store-b",
      shopifyCustomerId: "42",
    });

    expect(pseudonym).toMatch(/^redacted:v1:current-2026:[A-F0-9]{64}$/);
    expect(pseudonym.length).toBeLessThanOrEqual(191);
    expect(pseudonym).not.toContain("42");
    expect(otherStore).not.toBe(pseudonym);
  });

  it.each([
    {
      label: "shopper",
      prepare: () =>
        mocks.shopperFindUnique.mockResolvedValueOnce({
          id: "shopper-1",
          storeId: "store-b",
        }),
      expected: "shopper owner does not belong",
    },
    {
      label: "account",
      prepare: () =>
        mocks.accountFindUnique.mockResolvedValueOnce({
          id: "account-1",
          storeId: "store-b",
          shopperId: "shopper-1",
        }),
      expected: "account owner does not belong",
    },
    {
      label: "unrelated account",
      prepare: () =>
        mocks.accountFindUnique.mockResolvedValueOnce({
          id: "account-1",
          storeId: "store-a",
          shopperId: "shopper-other",
        }),
      expected: "do not identify the same shopper",
    },
  ])(
    "rejects a cross-tenant or mismatched $label link",
    async ({ prepare, expected }) => {
      prepare();

      await expect(
        upsertShopifyCustomerPrivacyTombstones({
          storeId: "store-a",
          shopifyCustomerId: "42",
          shopperId: "shopper-1",
          accountId: "account-1",
        }),
      ).rejects.toThrow(expected);
      expect(mocks.customerTombstoneUpsert).not.toHaveBeenCalled();
    },
  );

  it("extends repeated-redaction expiry only when the new deadline is later", async () => {
    const laterExpiry = new Date("2037-08-30T00:00:00.000Z");
    await upsertShopifyCustomerPrivacyTombstones({
      storeId: "store-a",
      shopifyCustomerId: "42",
      redactedAt: new Date("2027-08-30T00:00:00.000Z"),
      expiresAt: laterExpiry,
    });

    expect(mocks.customerTombstoneUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.not.objectContaining({
          redactedAt: expect.anything(),
          expiresAt: expect.anything(),
        }),
      }),
    );
    expect(mocks.customerTombstoneUpdateMany).toHaveBeenCalledWith({
      where: {
        id: expect.any(String),
        expiresAt: { lt: laterExpiry },
      },
      data: {
        redactedAt: new Date("2027-08-30T00:00:00.000Z"),
        expiresAt: laterExpiry,
      },
    });
  });

  it("rejects a customer tombstone source request from another store", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(null);

    await expect(
      upsertShopifyCustomerPrivacyTombstones({
        storeId: "store-a",
        shopifyCustomerId: "42",
        sourceRequestId: "request-store-b",
      }),
    ).rejects.toThrow("source request does not belong to the store");
    expect(mocks.requestFindUnique).toHaveBeenCalledWith({
      where: {
        storeId_id: { storeId: "store-a", id: "request-store-b" },
      },
      select: { id: true },
    });
    expect(mocks.customerTombstoneUpsert).not.toHaveBeenCalled();
  });

  it("never rebinds an existing customer identity to a different retained owner", async () => {
    mocks.queryRaw.mockResolvedValueOnce([
      {
        id: "tombstone-existing",
        shopperId: "shopper-other",
        accountId: "account-other",
        sourceRequestId: "request-original",
      },
    ]);

    await expect(
      upsertShopifyCustomerPrivacyTombstones({
        storeId: "store-a",
        email: "member@example.com",
        shopperId: "shopper-1",
        accountId: "account-1",
        sourceRequestId: "request-store-a",
      }),
    ).rejects.toBeInstanceOf(ShopifyCustomerPrivacyOwnerConflictError);
    expect(mocks.customerTombstoneUpsert).not.toHaveBeenCalled();
  });

  it("rejects a different owner that wins a concurrent customer tombstone insert", async () => {
    mocks.queryRaw.mockResolvedValue([]);
    mocks.customerTombstoneUpsert.mockResolvedValueOnce({
      id: "tombstone-race-winner",
      storeId: "store-a",
      identityKind: "customer_id",
      identityKeyId: "current-2026",
      customerDigest: "WINNER_DIGEST",
      shopperId: "shopper-other",
      accountId: "account-other",
      sourceRequestId: "request-first",
    });

    await expect(
      upsertShopifyCustomerPrivacyTombstones({
        storeId: "store-a",
        shopifyCustomerId: "42",
        shopperId: "shopper-1",
        accountId: "account-1",
        sourceRequestId: "request-store-a",
      }),
    ).rejects.toBeInstanceOf(ShopifyCustomerPrivacyOwnerConflictError);

    expect(mocks.customerTombstoneUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
    expect(mocks.customerTombstoneUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects split concurrent owner links that do not identify one shopper", async () => {
    mocks.customerTombstoneUpsert.mockResolvedValueOnce({
      id: "tombstone-split-owner",
      storeId: "store-a",
      identityKind: "customer_id",
      identityKeyId: "current-2026",
      customerDigest: "SPLIT_DIGEST",
      shopperId: "shopper-1",
      accountId: "account-other",
      sourceRequestId: "request-first",
    });
    mocks.customerTombstoneFindUniqueOrThrow.mockResolvedValueOnce({
      id: "tombstone-split-owner",
      shopperId: "shopper-1",
      accountId: "account-other",
      sourceRequestId: "request-first",
    });
    mocks.accountFindUnique.mockResolvedValueOnce({
      id: "account-other",
      storeId: "store-a",
      shopperId: "shopper-other",
    });

    await expect(
      upsertShopifyCustomerPrivacyTombstones({
        storeId: "store-a",
        shopifyCustomerId: "42",
      }),
    ).rejects.toBeInstanceOf(ShopifyCustomerPrivacyOwnerConflictError);

    expect(mocks.accountFindUnique).toHaveBeenCalledWith({
      where: {
        storeId_id: { storeId: "store-a", id: "account-other" },
      },
      select: { id: true, storeId: true, shopperId: true },
    });
  });

  it("detects an owner conflict retained only under the previous HMAC key", async () => {
    mocks.queryRaw.mockImplementation(async (query) =>
      query.values.includes("previous-2025")
        ? [
            {
              id: "tombstone-previous-key",
              identityKind: "customer_email",
              identityKeyId: "previous-2025",
              customerDigest: "PREVIOUS_DIGEST",
              shopperId: "shopper-other",
              accountId: "account-other",
              sourceRequestId: "request-original",
            },
          ]
        : [],
    );

    await expect(
      upsertShopifyCustomerPrivacyTombstones({
        storeId: "store-a",
        email: "member@example.com",
        shopperId: "shopper-1",
        accountId: "account-1",
      }),
    ).rejects.toBeInstanceOf(ShopifyCustomerPrivacyOwnerConflictError);
    expect(mocks.customerTombstoneUpsert).not.toHaveBeenCalled();
  });

  it("allows a later valid customer redaction to fill ownership without rebinding the first audit source", async () => {
    mocks.queryRaw.mockResolvedValueOnce([
      {
        id: "tombstone-existing",
        shopperId: null,
        accountId: null,
        sourceRequestId: "request-original",
      },
    ]);
    mocks.customerTombstoneUpsert.mockResolvedValueOnce({
      id: "tombstone-existing",
      storeId: "store-a",
      identityKind: "customer_id",
      identityKeyId: "current-2026",
      customerDigest: "EXISTING_DIGEST",
      shopperId: null,
      accountId: null,
      sourceRequestId: "request-original",
    });

    mocks.customerTombstoneFindUniqueOrThrow.mockResolvedValueOnce({
      id: "tombstone-existing",
      shopperId: "shopper-1",
      accountId: "account-1",
      sourceRequestId: "request-original",
    });

    await expect(
      upsertShopifyCustomerPrivacyTombstones({
        storeId: "store-a",
        shopifyCustomerId: "42",
        shopperId: "shopper-1",
        accountId: "account-1",
        sourceRequestId: "request-store-a",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        sourceRequestId: "request-original",
        shopperId: "shopper-1",
        accountId: "account-1",
      }),
    ]);
    expect(mocks.customerTombstoneUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { sourceRequestId: "request-store-a" },
      }),
    );
  });

  it("allows a concurrent later redaction to reuse the same customer owner while preserving the winning audit source", async () => {
    mocks.queryRaw.mockResolvedValueOnce([]);
    mocks.customerTombstoneUpsert.mockResolvedValueOnce({
      id: "tombstone-concurrent-winner",
      storeId: "store-a",
      identityKind: "customer_id",
      identityKeyId: "current-2026",
      customerDigest: "WINNER_DIGEST",
      shopperId: "shopper-1",
      accountId: "account-1",
      sourceRequestId: "request-first",
    });
    mocks.customerTombstoneFindUniqueOrThrow.mockResolvedValueOnce({
      id: "tombstone-concurrent-winner",
      shopperId: "shopper-1",
      accountId: "account-1",
      sourceRequestId: "request-first",
    });

    await expect(
      upsertShopifyCustomerPrivacyTombstones({
        storeId: "store-a",
        shopifyCustomerId: "42",
        shopperId: "shopper-1",
        accountId: "account-1",
        sourceRequestId: "request-later",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ sourceRequestId: "request-first" }),
    ]);
    expect(mocks.customerTombstoneUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { sourceRequestId: "request-later" } }),
    );
  });

  it("looks up every active key and supplied identity inside one tenant", async () => {
    mocks.customerTombstoneFindFirst.mockResolvedValueOnce({ id: "tomb-1" });
    await expect(
      hasShopifyCustomerPrivacyTombstone({
        storeId: "store-a",
        shopifyCustomerId: "42",
        email: "member@example.com",
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
    ).resolves.toBe(true);
    const input = mocks.customerTombstoneFindFirst.mock.calls[0][0];
    expect(input.where.storeId).toBe("store-a");
    expect(input.where.OR).toHaveLength(4);
    expect(JSON.stringify(input.where.OR)).not.toContain("member@example.com");
    expect(JSON.stringify(input.where.OR)).not.toContain('"42"');
  });

  it("proves a retained pseudonymous account owner using only linked tombstone digests", async () => {
    mocks.customerTombstoneFindFirst.mockResolvedValueOnce({ id: "tomb-1" });
    await expect(
      matchesShopifyCustomerPrivacyTombstoneOwner({
        storeId: "store-a",
        shopifyCustomerId: "gid://shopify/Customer/42",
        shopperId: "shopper-1",
        accountId: "account-1",
        now: new Date("2026-08-30T00:00:00.000Z"),
      }),
    ).resolves.toBe(true);

    const input = mocks.customerTombstoneFindFirst.mock.calls[0][0];
    expect(input.where).toMatchObject({
      storeId: "store-a",
      AND: [
        { OR: expect.any(Array) },
        { OR: [{ shopperId: "shopper-1" }, { accountId: "account-1" }] },
      ],
    });
    expect(JSON.stringify(input)).not.toContain("Customer/42");
    expect(JSON.stringify(input)).not.toContain('"42"');
  });

  it("domain-separates redacted shop identities and supports previous keys", () => {
    const identities = deriveAllShopifyShopPrivacyIdentities({
      shopDomain: "HTTPS://Example-Store.myshopify.com/admin",
    });
    expect(identities).toHaveLength(2);
    expect(identities[0].shopDomainDigest).toMatch(/^[A-F0-9]{64}$/);
    expect(identities[0].shopDomainDigest).not.toBe(
      identities[1].shopDomainDigest,
    );
  });

  it("extends a repeated shop-redaction tombstone without shortening it", async () => {
    const expiresAt = new Date("2037-08-30T00:00:00.000Z");
    const redactedAt = new Date("2027-08-30T00:00:00.000Z");
    await upsertShopifyShopPrivacyTombstone({
      storeId: "store-a",
      shopDomain: "example-store.myshopify.com",
      redactedAt,
      expiresAt,
    });

    expect(mocks.shopTombstoneUpdateMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), expiresAt: { lt: expiresAt } },
      data: { redactedAt, expiresAt },
    });
  });

  it("rejects a globally unique shop digest already bound to another store", async () => {
    mocks.shopTombstoneUpsert.mockResolvedValueOnce({
      id: "shop-tombstone-store-b",
      storeId: "store-b",
    });

    await expect(
      upsertShopifyShopPrivacyTombstone({
        storeId: "store-a",
        shopDomain: "example-store.myshopify.com",
      }),
    ).rejects.toThrow("already bound to another store");
    expect(mocks.shopTombstoneUpdateMany).not.toHaveBeenCalled();
  });

  it("allows a later shop-redact while preserving the first audit source", async () => {
    mocks.queryRaw.mockResolvedValueOnce([
      {
        id: "shop-tombstone-existing",
        storeId: "store-a",
        sourceRequestId: "request-first",
      },
    ]);
    mocks.shopTombstoneUpsert.mockResolvedValueOnce({
      id: "shop-tombstone-existing",
      storeId: "store-a",
      sourceRequestId: "request-first",
    });

    mocks.shopTombstoneFindUniqueOrThrow.mockResolvedValueOnce({
      id: "shop-tombstone-existing",
      storeId: "store-a",
      sourceRequestId: "request-first",
    });
    await expect(
      upsertShopifyShopPrivacyTombstone({
        storeId: "store-a",
        shopDomain: "example-store.myshopify.com",
        sourceRequestId: "request-later",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ sourceRequestId: "request-first" }),
    );
    expect(mocks.shopTombstoneUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { sourceRequestId: "request-later" } }),
    );
  });

  it("preserves a concurrently published first shop-redact source", async () => {
    // No row was available for SELECT ... FOR UPDATE, but another transaction
    // may win the unique insert before this upsert reaches the database.
    mocks.queryRaw.mockResolvedValueOnce([]);
    mocks.shopTombstoneUpsert.mockResolvedValueOnce({
      id: "shop-tombstone-winner",
      storeId: "store-a",
      sourceRequestId: "request-first",
    });

    mocks.shopTombstoneFindUniqueOrThrow.mockResolvedValueOnce({
      id: "shop-tombstone-winner",
      storeId: "store-a",
      sourceRequestId: "request-first",
    });
    await expect(
      upsertShopifyShopPrivacyTombstone({
        storeId: "store-a",
        shopDomain: "example-store.myshopify.com",
        sourceRequestId: "request-loser",
      }),
    ).resolves.toEqual(
      expect.objectContaining({ sourceRequestId: "request-first" }),
    );

    expect(mocks.shopTombstoneUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
    expect(mocks.shopTombstoneUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { sourceRequestId: "request-loser" } }),
    );
  });

  it("rejects a shop tombstone source request from another store", async () => {
    mocks.requestFindUnique.mockResolvedValueOnce(null);

    await expect(
      upsertShopifyShopPrivacyTombstone({
        storeId: "store-a",
        shopDomain: "example-store.myshopify.com",
        sourceRequestId: "request-store-b",
      }),
    ).rejects.toThrow("source request does not belong to the store");
    expect(mocks.requestFindUnique).toHaveBeenCalledWith({
      where: {
        storeId_id: { storeId: "store-a", id: "request-store-b" },
      },
      select: { id: true },
    });
    expect(mocks.shopTombstoneUpsert).not.toHaveBeenCalled();
  });

  it("fails closed outside tests when the HMAC keyring is absent", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS", "");
    expect(() => loadShopifyPrivacyHmacKeyring()).toThrow(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS is required",
    );
  });
});

describe("Shopify compliance retention configuration", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requires explicit bounded production retention values", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => getShopifyCustomerTombstoneRetentionDays("")).toThrow(
      "WELETIC_SHOPIFY_CUSTOMER_TOMBSTONE_RETENTION_DAYS is required",
    );
    expect(() => getShopifyFinancialRetentionDays("0")).toThrow(
      "must be between",
    );
    expect(() => getShopifyComplianceExportRetentionHours("8761")).toThrow(
      "must be between",
    );
    expect(getShopifyCustomerTombstoneRetentionDays("365")).toBe(365);
    expect(getShopifyFinancialRetentionDays("2555")).toBe(2555);
    expect(getShopifyComplianceExportRetentionHours("24")).toBe(24);
  });
});
