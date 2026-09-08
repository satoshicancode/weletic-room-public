import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hset: vi.fn(),
  hget: vi.fn(),
  expire: vi.fn(),
  del: vi.fn(),
  zadd: vi.fn(),
  zrange: vi.fn(),
  zrem: vi.fn(),
  zremrangebyscore: vi.fn(),
  ttl: vi.fn(),
  eval: vi.fn(),
}));

vi.mock("@/lib/upstash", () => ({ redis: mocks }));

import {
  auditShopifyCustomerPrivacyFences,
  deleteExactIndexedShopifyCheckoutCache,
  deleteShopifyCheckoutCache,
  purgeShopifyCustomerPrivacyCacheBatch,
  purgeShopifyStorePrivacyCacheBatch,
  writeShopifyCheckoutCache,
  writeShopifyCustomerSegmentCache,
} from "@/lib/weletic/shopify/privacy-cache";

describe("Shopify privacy cache indexes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hset.mockResolvedValue(1);
    mocks.hget.mockResolvedValue(null);
    mocks.expire.mockResolvedValue(1);
    mocks.del.mockResolvedValue(1);
    mocks.zadd.mockResolvedValue(1);
    mocks.zrange.mockResolvedValue([]);
    mocks.zrem.mockResolvedValue(1);
    mocks.zremrangebyscore.mockResolvedValue(0);
    mocks.ttl.mockResolvedValue(60);
    mocks.eval.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses keyed cache names and deduplicating expiry-scored indexes", async () => {
    const firstKey = await writeShopifyCheckoutCache({
      checkoutToken: "raw-checkout-token",
      fields: { order: { customer: { id: "customer-42" } } },
      storeId: "store-internal-1",
      customerId: "customer-42",
    });
    const secondKey = await writeShopifyCheckoutCache({
      checkoutToken: "raw-checkout-token",
      fields: { clickId: "click-1" },
      storeId: "store-internal-1",
      customerId: "customer-42",
    });

    expect(firstKey).toBe(secondKey);
    expect(firstKey).not.toContain("raw-checkout-token");
    const indexedWrites = mocks.eval.mock.calls.filter(
      ([, keys]) =>
        Array.isArray(keys) && String(keys[0]).includes(":checkout:"),
    );
    expect(indexedWrites).toHaveLength(2);
    for (const [, keys, args] of indexedWrites) {
      const [dataKey, ...indexAndFenceKeys] = keys as string[];
      expect(dataKey).toBe(firstKey);
      for (const indexKey of indexAndFenceKeys) {
        expect(indexKey).not.toContain("store-internal-1");
        expect(indexKey).not.toContain("customer-42");
      }
      expect(args[0]).toBe(2);
      expect(args[1]).toBe(2);
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 24 * 60 * 60 + 1])(
    "rejects a checkout cache TTL that can outlive its privacy fence: %s",
    async (ttlSeconds) => {
      await expect(
        writeShopifyCheckoutCache({
          checkoutToken: "raw-checkout-token",
          fields: { order: { customer: { id: "customer-42" } } },
          ttlSeconds,
          storeId: "store-internal-1",
          customerId: "customer-42",
        }),
      ).rejects.toThrow("no longer than 24 hours");
      expect(mocks.eval).not.toHaveBeenCalled();
      expect(mocks.hset).not.toHaveBeenCalled();
    },
  );

  it("purges indexed customer cache and the pre-index legacy segment key", async () => {
    await writeShopifyCustomerSegmentCache({
      storeId: "store-1",
      workspaceId: "workspace-1",
      customerId: "gid://shopify/Customer/42",
      segmentId: "gid://shopify/Segment/9",
      member: true,
    });
    const segmentWrite = mocks.eval.mock.calls[0];
    const segmentKey = segmentWrite[1][0] as string;
    mocks.zrange.mockResolvedValueOnce([segmentKey]);

    await expect(
      purgeShopifyCustomerPrivacyCacheBatch({
        storeId: "store-1",
        workspaceId: "workspace-1",
        customerId: "42",
      }),
    ).resolves.toMatchObject({ completed: true, deleted: 1 });

    expect(segmentKey).not.toContain(":42");
    expect(segmentKey).not.toContain("Customer/42");
    expect(mocks.del).toHaveBeenCalledWith(
      "shopify:segment-membership:workspace-1:42",
    );
    expect(mocks.del).toHaveBeenCalledWith(segmentKey);
  });

  it("drains a store index in exact bounded pages", async () => {
    mocks.zrange
      .mockResolvedValueOnce(["cache-a", "cache-b"])
      .mockResolvedValueOnce([]);

    const first = await purgeShopifyStorePrivacyCacheBatch({
      storeId: "store-1",
      batchSize: 2,
    });
    expect(first).toMatchObject({
      completed: false,
      deleted: 2,
      cursor: { indexPosition: 0 },
    });
    const second = await purgeShopifyStorePrivacyCacheBatch({
      storeId: "store-1",
      cursor: first.cursor,
      batchSize: 2,
    });
    expect(second).toMatchObject({ completed: true, deleted: 0 });
    expect(mocks.zrange).toHaveBeenNthCalledWith(
      1,
      expect.not.stringContaining("store-1"),
      0,
      1,
    );
    expect(mocks.del).toHaveBeenCalledWith("cache-a", "cache-b");
  });

  it("explicitly deletes both derived and pre-deploy raw checkout keys", async () => {
    await deleteShopifyCheckoutCache("legacy-token-42");
    const deletedKeys = mocks.del.mock.calls.at(-1) ?? [];
    expect(deletedKeys).toContain("shopify:checkout:legacy-token-42");
    expect(deletedKeys).toContainEqual(
      expect.stringMatching(/^shopify:privacy-cache:v1:checkout:/),
    );
    expect(deletedKeys[0]).not.toContain("legacy-token-42");
  });

  it("exactly deindexes current and previous checkout keys before deleting data", async () => {
    const currentSecret = btoa(
      String.fromCharCode(...new Uint8Array(32).fill(0x31)),
    );
    const previousSecret = btoa(
      String.fromCharCode(...new Uint8Array(32).fill(0x32)),
    );
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `current:${currentSecret},previous:${previousSecret}`,
    );
    mocks.eval.mockResolvedValueOnce([2, 2]);

    await expect(
      deleteExactIndexedShopifyCheckoutCache({
        checkoutToken: "checkout-token-42",
        storeId: "store-42",
        customerId: "customer-42",
      }),
    ).resolves.toEqual({
      deletedDataCount: 2,
      removedIndexMembershipCount: 2,
    });

    const [script, keys, args] = mocks.eval.mock.calls[0] as [
      string,
      string[],
      number[],
    ];
    const dataCount = args[0];
    const dataKeys = keys.slice(0, dataCount);
    const indexKeys = keys.slice(dataCount);
    expect(dataKeys).toHaveLength(3);
    expect(dataKeys).toContain("shopify:checkout:checkout-token-42");
    expect(dataKeys).toContainEqual(expect.stringContaining(":current:"));
    expect(dataKeys).toContainEqual(expect.stringContaining(":previous:"));
    expect(
      indexKeys.filter((key) => key.includes(":store-index:")),
    ).toHaveLength(2);
    expect(
      indexKeys.filter((key) => key.includes(":customer-index:")),
    ).toHaveLength(2);
    expect(keys).not.toContainEqual(expect.stringContaining(":fence:"));
    expect(keys.join("\n")).not.toContain("store-42");
    expect(keys.join("\n")).not.toContain("customer-42");
    expect(String(script)).toContain(
      'redis.call("ZREM", KEYS[indexPosition], KEYS[dataPosition])',
    );
    expect(String(script)).toContain('redis.call("DEL", KEYS[dataPosition])');
  });

  it("omits customer indexes when an exact checkout has no customer identity", async () => {
    const currentSecret = btoa(
      String.fromCharCode(...new Uint8Array(32).fill(0x41)),
    );
    const previousSecret = btoa(
      String.fromCharCode(...new Uint8Array(32).fill(0x42)),
    );
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `current:${currentSecret},previous:${previousSecret}`,
    );
    mocks.eval.mockResolvedValueOnce([0, 0]);

    await deleteExactIndexedShopifyCheckoutCache({
      checkoutToken: "anonymous-checkout",
      storeId: "store-42",
    });

    const [, keys, args] = mocks.eval.mock.calls[0] as [
      string,
      string[],
      number[],
    ];
    const indexKeys = keys.slice(args[0]);
    expect(indexKeys).toHaveLength(2);
    expect(indexKeys).toEqual([
      expect.stringContaining(":store-index:"),
      expect.stringContaining(":store-index:"),
    ]);
    expect(indexKeys).not.toContainEqual(
      expect.stringContaining(":customer-index:"),
    );
  });

  it("is idempotent and returns only non-sensitive deletion counts", async () => {
    mocks.eval.mockResolvedValueOnce([2, 1]).mockResolvedValueOnce([0, 0]);
    const input = {
      checkoutToken: "idempotent-checkout",
      storeId: "store-42",
      customerId: "customer-42",
    };

    await expect(
      deleteExactIndexedShopifyCheckoutCache(input),
    ).resolves.toEqual({
      deletedDataCount: 2,
      removedIndexMembershipCount: 1,
    });
    await expect(
      deleteExactIndexedShopifyCheckoutCache(input),
    ).resolves.toEqual({
      deletedDataCount: 0,
      removedIndexMembershipCount: 0,
    });
  });

  it("never scans, drains, or deletes an index or privacy fence", async () => {
    mocks.eval.mockResolvedValueOnce([1, 1]);

    await deleteExactIndexedShopifyCheckoutCache({
      checkoutToken: "exact-checkout",
      storeId: "store-42",
      customerId: "customer-42",
    });

    const [script, keys, args] = mocks.eval.mock.calls[0] as [
      string,
      string[],
      number[],
    ];
    const dataCount = args[0];
    const indexKeys = keys.slice(dataCount);
    expect(indexKeys).not.toHaveLength(0);
    expect(keys).not.toContainEqual(expect.stringContaining(":fence:"));
    expect(String(script)).not.toMatch(/ZSCAN|ZRANGE|ZREMRANGE/i);
    expect(String(script)).not.toContain(
      'redis.call("DEL", KEYS[indexPosition])',
    );
    expect(mocks.zrange).not.toHaveBeenCalled();
    expect(mocks.del).not.toHaveBeenCalled();
    expect(mocks.zrem).not.toHaveBeenCalled();
  });

  it("preserves unrelated members while removing only exact checkout members", async () => {
    const unrelatedMember = "shopify:privacy-cache:v1:checkout:unrelated";
    const remainingMembers = new Set<string>();
    mocks.eval.mockImplementationOnce((_script, keys, args) => {
      const exactKeys = keys as string[];
      const dataCount = Number((args as number[])[0]);
      remainingMembers.add(unrelatedMember);
      for (const dataKey of exactKeys.slice(0, dataCount)) {
        remainingMembers.add(dataKey);
      }
      let removedIndexMembershipCount = 0;
      for (const dataKey of exactKeys.slice(0, dataCount)) {
        if (remainingMembers.delete(dataKey)) removedIndexMembershipCount += 1;
      }
      return [0, removedIndexMembershipCount];
    });

    await deleteExactIndexedShopifyCheckoutCache({
      checkoutToken: "owned-checkout",
      storeId: "store-42",
      customerId: "customer-42",
    });

    expect(remainingMembers).toEqual(new Set([unrelatedMember]));
    const [, keys] = mocks.eval.mock.calls[0] as [string, string[], number[]];
    expect(keys).not.toContain(unrelatedMember);
  });

  it("audits rotation-aware customer privacy fence TTLs without identities", async () => {
    const currentSecret = btoa(
      String.fromCharCode(...new Uint8Array(32).fill(0x51)),
    );
    const previousSecret = btoa(
      String.fromCharCode(...new Uint8Array(32).fill(0x52)),
    );
    vi.stubEnv(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
      `current:${currentSecret},previous:${previousSecret}`,
    );
    mocks.ttl.mockResolvedValueOnce(3_600).mockResolvedValueOnce(1_200);

    await expect(
      auditShopifyCustomerPrivacyFences({
        storeId: "store-42",
        customerId: "customer-42",
      }),
    ).resolves.toEqual({ fenceCount: 2, allTtlValid: true });
    const auditedKeys = mocks.ttl.mock.calls.flat();
    expect(auditedKeys).toHaveLength(2);
    expect(auditedKeys).toEqual([
      expect.stringContaining(":customer-fence:"),
      expect.stringContaining(":customer-fence:"),
    ]);
    expect(auditedKeys.join("\n")).not.toContain("store-42");
    expect(auditedKeys.join("\n")).not.toContain("customer-42");

    mocks.ttl.mockReset();
    mocks.ttl.mockResolvedValueOnce(-2).mockResolvedValueOnce(90_001);
    await expect(
      auditShopifyCustomerPrivacyFences({
        storeId: "store-42",
        customerId: "customer-42",
      }),
    ).resolves.toEqual({ fenceCount: 1, allTtlValid: false });
  });

  it("uses the same customer fence in purge and the atomic cache write", async () => {
    await purgeShopifyCustomerPrivacyCacheBatch({
      storeId: "store-1",
      workspaceId: "workspace-1",
      customerId: "42",
    });
    const fenceWrite = mocks.eval.mock.calls[0];
    const customerFenceKeys = fenceWrite[1] as string[];

    mocks.eval.mockResolvedValueOnce(0);
    await writeShopifyCustomerSegmentCache({
      storeId: "store-1",
      workspaceId: "workspace-1",
      customerId: "42",
      segmentId: "segment-1",
      member: true,
    });
    const atomicWrite = mocks.eval.mock.calls.at(-1)!;
    const atomicWriteKeys = atomicWrite[1] as string[];

    expect(customerFenceKeys).not.toHaveLength(0);
    expect(
      customerFenceKeys.every((key) => atomicWriteKeys.includes(key)),
    ).toBe(true);
    expect(String(atomicWrite[0])).toContain('redis.call("EXISTS", KEYS[i])');
    expect(mocks.hset).not.toHaveBeenCalled();
    expect(mocks.zadd).not.toHaveBeenCalled();
  });

  it("uses the same store fence to close a paused checkout-writer race", async () => {
    await purgeShopifyStorePrivacyCacheBatch({ storeId: "store-1" });
    const fenceWrite = mocks.eval.mock.calls[0];
    const storeFenceKeys = fenceWrite[1] as string[];

    mocks.eval.mockResolvedValueOnce(0);
    await writeShopifyCheckoutCache({
      checkoutToken: "checkout-after-fence",
      fields: { order: { customer: { id: "42" } } },
      storeId: "store-1",
      customerId: "42",
    });
    const atomicWrite = mocks.eval.mock.calls.at(-1)!;
    const atomicWriteKeys = atomicWrite[1] as string[];

    expect(storeFenceKeys).not.toHaveLength(0);
    expect(storeFenceKeys.every((key) => atomicWriteKeys.includes(key))).toBe(
      true,
    );
    expect(String(atomicWrite[0])).toContain('redis.call("DEL", KEYS[1])');
  });
});
