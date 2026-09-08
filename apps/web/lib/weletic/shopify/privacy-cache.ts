import { redis } from "@/lib/upstash";

const CACHE_CONTEXT = "weletic:shopify:privacy-cache:v1";
const INDEX_TTL_SECONDS = 25 * 60 * 60;
const DEFAULT_CHECKOUT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_PURGE_BATCH_SIZE = 25;

const WRITE_INDEXED_CACHE_SCRIPT = `
local indexCount = tonumber(ARGV[1])
local fenceCount = tonumber(ARGV[2])
local dataTtl = tonumber(ARGV[3])
local indexTtl = tonumber(ARGV[4])
local indexExpiry = tonumber(ARGV[5])
local firstFence = 2 + indexCount
for i = firstFence, firstFence + fenceCount - 1 do
  if redis.call("EXISTS", KEYS[i]) == 1 then
    redis.call("DEL", KEYS[1])
    return 0
  end
end
for i = 6, #ARGV, 2 do
  redis.call("HSET", KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call("EXPIRE", KEYS[1], dataTtl)
for i = 2, 1 + indexCount do
  redis.call("ZREMRANGEBYSCORE", KEYS[i], 0, redis.call("TIME")[1] * 1000)
  redis.call("ZADD", KEYS[i], indexExpiry, KEYS[1])
  redis.call("EXPIRE", KEYS[i], indexTtl)
end
return 1
`;

const SET_PRIVACY_FENCES_SCRIPT = `
local ttl = tonumber(ARGV[1])
for i = 1, #KEYS do redis.call("SET", KEYS[i], "1", "EX", ttl) end
return #KEYS
`;

const DELETE_EXACT_INDEXED_CACHE_SCRIPT = `
local dataCount = tonumber(ARGV[1])
local deletedDataCount = 0
local removedIndexMembershipCount = 0
for indexPosition = dataCount + 1, #KEYS do
  for dataPosition = 1, dataCount do
    removedIndexMembershipCount = removedIndexMembershipCount + redis.call("ZREM", KEYS[indexPosition], KEYS[dataPosition])
  end
end
for dataPosition = 1, dataCount do
  deletedDataCount = deletedDataCount + redis.call("DEL", KEYS[dataPosition])
end
return {deletedDataCount, removedIndexMembershipCount}
`;

type CacheKeyPurpose = "checkout" | "store_index" | "customer_index";

interface PrivacyCacheKey {
  keyId: string;
  secret: Uint8Array;
}

function boundedCheckoutCacheTtlSeconds(ttlSeconds: number) {
  if (
    !Number.isFinite(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > DEFAULT_CHECKOUT_TTL_SECONDS
  ) {
    throw new Error(
      "Shopify checkout cache TTL must be positive and no longer than 24 hours.",
    );
  }
  return Math.max(1, Math.trunc(ttlSeconds));
}

export interface ShopifyPrivacyCachePurgeCursor {
  indexPosition?: number;
}

function decodeBase64(value: string) {
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function loadPrivacyCacheKeyring() {
  let configured = process.env.WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS?.trim();
  if (!configured && process.env.NODE_ENV === "test") {
    configured = `test-v1:${btoa(String.fromCharCode(...new Uint8Array(32).fill(0x42)))}`;
  }
  if (!configured) {
    throw new Error(
      "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS is required for Shopify privacy caches.",
    );
  }
  const seen = new Set<string>();
  const keys = configured.split(",").map((entry): PrivacyCacheKey => {
    const separator = entry.indexOf(":");
    const keyId = entry.slice(0, separator).trim();
    const secret = decodeBase64(entry.slice(separator + 1).trim());
    if (
      separator <= 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId) ||
      seen.has(keyId) ||
      secret?.byteLength !== 32
    ) {
      throw new Error(
        "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS contains an invalid cache key.",
      );
    }
    seen.add(keyId);
    return { keyId, secret };
  });
  return { current: keys[0], all: keys };
}

function canonicalCustomerId(value: string | number) {
  const normalized = String(value).normalize("NFKC").trim();
  const customerId =
    normalized.match(/^gid:\/\/shopify\/Customer\/([^/]+)$/i)?.[1] ??
    normalized;
  if (!customerId || customerId.length > 191) {
    throw new Error("Shopify customer id is invalid for cache isolation.");
  }
  return customerId;
}

async function digestCacheIdentity({
  purpose,
  values,
  key,
}: {
  purpose: CacheKeyPurpose;
  values: string[];
  key: PrivacyCacheKey;
}) {
  if (values.some((value) => !value.trim())) {
    throw new Error("Shopify privacy cache identity values must be non-empty.");
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.secret,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encoded = new TextEncoder().encode(
    [CACHE_CONTEXT, purpose, ...values].join("\0"),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoded),
  );
  const digest = Array.from(signature, (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .toUpperCase();
  return `${key.keyId}:${digest}`;
}

async function checkoutKeys(checkoutToken: string) {
  const normalized = checkoutToken.normalize("NFKC").trim();
  if (!normalized) throw new Error("Shopify checkout token is required.");
  const { all } = loadPrivacyCacheKeyring();
  return Promise.all(
    all.map(
      async (key) =>
        `shopify:privacy-cache:v1:checkout:${await digestCacheIdentity({
          purpose: "checkout",
          values: [normalized],
          key,
        })}`,
    ),
  );
}

async function storeIndexKeys(storeId: string) {
  const { all } = loadPrivacyCacheKeyring();
  return Promise.all(
    all.map(
      async (key) =>
        `shopify:privacy-cache:v1:store-index:${await digestCacheIdentity({
          purpose: "store_index",
          values: [storeId],
          key,
        })}`,
    ),
  );
}

async function storeFenceKeys(storeId: string) {
  return (await storeIndexKeys(storeId)).map((key) =>
    key.replace(":store-index:", ":store-fence:"),
  );
}

async function customerIndexKeys({
  storeId,
  customerId,
}: {
  storeId: string;
  customerId: string | number;
}) {
  const canonical = canonicalCustomerId(customerId);
  const { all } = loadPrivacyCacheKeyring();
  return Promise.all(
    all.map(
      async (key) =>
        `shopify:privacy-cache:v1:customer-index:${await digestCacheIdentity({
          purpose: "customer_index",
          values: [storeId, canonical],
          key,
        })}`,
    ),
  );
}

async function customerFenceKeys(input: {
  storeId: string;
  customerId: string | number;
}) {
  return (await customerIndexKeys(input)).map((key) =>
    key.replace(":customer-index:", ":customer-fence:"),
  );
}

async function currentCustomerCacheIdentity({
  storeId,
  customerId,
}: {
  storeId: string;
  customerId: string | number;
}) {
  const { current } = loadPrivacyCacheKeyring();
  return digestCacheIdentity({
    purpose: "customer_index",
    values: [storeId, canonicalCustomerId(customerId)],
    key: current,
  });
}

async function writeIndexedCache({
  cacheKey,
  fields,
  ttlSeconds,
  storeId,
  customerId,
}: {
  cacheKey: string;
  fields: Record<string, unknown>;
  ttlSeconds: number;
  storeId: string;
  customerId?: string | number | null;
}) {
  const storeIndexes = await storeIndexKeys(storeId);
  const customerIndexes = customerId
    ? await customerIndexKeys({ storeId, customerId })
    : [];
  // Only the current-key indexes receive new writes. Previous-key indexes are
  // retained solely so rotation-aware erasure can drain older deployments.
  const indexes = [storeIndexes[0], customerIndexes[0]].filter(
    (value): value is string => Boolean(value),
  );
  const fences = [
    ...(await storeFenceKeys(storeId)),
    ...(customerId ? await customerFenceKeys({ storeId, customerId }) : []),
  ];
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const fieldArgs = Object.entries(fields).flatMap(([field, value]) => [
    field,
    JSON.stringify(value),
  ]);
  return redis.eval(
    WRITE_INDEXED_CACHE_SCRIPT,
    [cacheKey, ...indexes, ...fences],
    [
      indexes.length,
      fences.length,
      ttlSeconds,
      INDEX_TTL_SECONDS,
      expiresAt,
      ...fieldArgs,
    ],
  );
}

async function setPrivacyFences(keys: string[]) {
  await redis.eval(SET_PRIVACY_FENCES_SCRIPT, keys, [INDEX_TTL_SECONDS]);
}

export async function writeShopifyCheckoutCache({
  checkoutToken,
  fields,
  ttlSeconds = DEFAULT_CHECKOUT_TTL_SECONDS,
  storeId,
  customerId,
}: {
  checkoutToken: string;
  fields: Record<string, unknown>;
  ttlSeconds?: number;
  storeId?: string;
  customerId?: string | number | null;
}) {
  const boundedTtlSeconds = boundedCheckoutCacheTtlSeconds(ttlSeconds);
  const [key] = await checkoutKeys(checkoutToken);
  if ("order" in fields && !storeId) {
    throw new Error("Raw Shopify order cache writes require a store fence.");
  }
  if (storeId) {
    await writeIndexedCache({
      cacheKey: key,
      fields,
      ttlSeconds: boundedTtlSeconds,
      storeId,
      customerId,
    });
  } else {
    // Pixel click IDs contain no Shopify order/customer payload and expire even
    // if Shopify never delivers the matching order.
    await redis.hset(key, fields);
    await redis.expire(key, boundedTtlSeconds);
  }
  return key;
}

export async function readShopifyCheckoutCacheField<T>({
  checkoutToken,
  field,
}: {
  checkoutToken: string;
  field: string;
}) {
  const keys = [
    ...(await checkoutKeys(checkoutToken)),
    `shopify:checkout:${checkoutToken}`,
  ];
  for (const key of keys) {
    const value = await redis.hget<T>(key, field);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

export async function deleteShopifyCheckoutCache(checkoutToken: string) {
  const keys = [
    ...(await checkoutKeys(checkoutToken)),
    `shopify:checkout:${checkoutToken}`,
  ];
  return redis.del(...(keys as [string, ...string[]]));
}

/**
 * Delete one checkout cache identity and only its exact ZSET memberships.
 * Unlike store/customer privacy purges, this never enumerates an index or
 * removes another checkout's cache entry, index membership, or privacy fence.
 */
export async function deleteExactIndexedShopifyCheckoutCache({
  checkoutToken,
  storeId,
  customerId,
}: {
  checkoutToken: string;
  storeId: string;
  customerId?: string | number | null;
}): Promise<{
  deletedDataCount: number;
  removedIndexMembershipCount: number;
}> {
  const dataKeys = [
    ...(await checkoutKeys(checkoutToken)),
    `shopify:checkout:${checkoutToken}`,
  ];
  const hasCustomerId = customerId !== null && customerId !== undefined;
  const indexKeys = [
    ...(await storeIndexKeys(storeId)),
    ...(hasCustomerId ? await customerIndexKeys({ storeId, customerId }) : []),
  ];
  const result = await redis.eval(
    DELETE_EXACT_INDEXED_CACHE_SCRIPT,
    [...dataKeys, ...indexKeys],
    [dataKeys.length],
  );
  if (!Array.isArray(result) || result.length !== 2) {
    throw new Error(
      "Exact Shopify checkout cache deletion returned no audit result.",
    );
  }
  const [deletedDataCount, removedIndexMembershipCount] = result.map(Number);
  if (
    !Number.isSafeInteger(deletedDataCount) ||
    deletedDataCount < 0 ||
    !Number.isSafeInteger(removedIndexMembershipCount) ||
    removedIndexMembershipCount < 0
  ) {
    throw new Error(
      "Exact Shopify checkout cache deletion returned an invalid audit result.",
    );
  }
  return { deletedDataCount, removedIndexMembershipCount };
}

/**
 * Audit the exact customer privacy fences without exposing their derived keys
 * or the customer/store identities used to derive them.
 */
export async function auditShopifyCustomerPrivacyFences(input: {
  storeId: string;
  customerId: string | number;
}): Promise<{ fenceCount: number; allTtlValid: boolean }> {
  const fenceTtls = await Promise.all(
    (await customerFenceKeys(input)).map(async (key) =>
      Number(await redis.ttl(key)),
    ),
  );
  return {
    fenceCount: fenceTtls.filter((ttl) => ttl > 0).length,
    allTtlValid:
      fenceTtls.length > 0 &&
      fenceTtls.every(
        (ttl) =>
          Number.isSafeInteger(ttl) && ttl > 0 && ttl <= INDEX_TTL_SECONDS,
      ),
  };
}

export async function expireShopifyCheckoutCache({
  checkoutToken,
  ttlSeconds,
}: {
  checkoutToken: string;
  ttlSeconds: number;
}) {
  const boundedTtlSeconds = boundedCheckoutCacheTtlSeconds(ttlSeconds);
  const keys = [
    ...(await checkoutKeys(checkoutToken)),
    `shopify:checkout:${checkoutToken}`,
  ];
  await Promise.all(keys.map((key) => redis.expire(key, boundedTtlSeconds)));
}

export async function writeShopifyCustomerSegmentCache({
  storeId,
  workspaceId: _workspaceId,
  customerId,
  segmentId,
  member,
}: {
  storeId: string;
  workspaceId: string;
  customerId: string | number;
  segmentId: string;
  member: boolean;
}) {
  const identity = await currentCustomerCacheIdentity({ storeId, customerId });
  const key = `shopify:privacy-cache:v1:segment:${identity}`;
  await writeIndexedCache({
    cacheKey: key,
    fields: { [segmentId]: member ? "1" : "0" },
    ttlSeconds: 5 * 60,
    storeId,
    customerId,
  });
}

async function drainIndexBatch({
  indexKeys,
  cursor,
  batchSize,
}: {
  indexKeys: string[];
  cursor?: ShopifyPrivacyCachePurgeCursor | null;
  batchSize: number;
}) {
  const indexPosition = Math.max(0, cursor?.indexPosition ?? 0);
  const indexKey = indexKeys[indexPosition];
  if (!indexKey) return { completed: true, deleted: 0, cursor: null };

  const members = await redis.zrange<string[]>(indexKey, 0, batchSize - 1);
  if (members.length > 0) {
    await redis.del(...(members as [string, ...string[]]));
    await redis.zrem(indexKey, ...members);
  }
  if (members.length === batchSize) {
    return {
      completed: false,
      deleted: members.length,
      cursor: { indexPosition },
    };
  }

  await redis.del(indexKey);
  const nextPosition = indexPosition + 1;
  return nextPosition < indexKeys.length
    ? {
        completed: false,
        deleted: members.length,
        cursor: { indexPosition: nextPosition },
      }
    : { completed: true, deleted: members.length, cursor: null };
}

export async function purgeShopifyCustomerPrivacyCacheBatch({
  storeId,
  workspaceId,
  customerId,
  cursor,
  batchSize = DEFAULT_PURGE_BATCH_SIZE,
}: {
  storeId: string;
  workspaceId: string;
  customerId: string | number;
  cursor?: ShopifyPrivacyCachePurgeCursor | null;
  batchSize?: number;
}) {
  const canonical = canonicalCustomerId(customerId);
  await setPrivacyFences(
    await customerFenceKeys({ storeId, customerId: canonical }),
  );
  // Explicitly remove the pre-index legacy segment key on every retry.
  await redis.del(`shopify:segment-membership:${workspaceId}:${canonical}`);
  return drainIndexBatch({
    indexKeys: await customerIndexKeys({ storeId, customerId: canonical }),
    cursor,
    batchSize: Math.min(50, Math.max(1, Math.trunc(batchSize))),
  });
}

export async function purgeShopifyLegacyCustomerPrivacyCache({
  storeId,
  workspaceId,
  customerId,
}: {
  storeId: string;
  workspaceId: string;
  customerId: string | number;
}) {
  const canonical = canonicalCustomerId(customerId);
  await setPrivacyFences(
    await customerFenceKeys({ storeId, customerId: canonical }),
  );
  await redis.del(`shopify:segment-membership:${workspaceId}:${canonical}`);
}

export async function purgeShopifyStorePrivacyCacheBatch({
  storeId,
  cursor,
  batchSize = DEFAULT_PURGE_BATCH_SIZE,
}: {
  storeId: string;
  cursor?: ShopifyPrivacyCachePurgeCursor | null;
  batchSize?: number;
}) {
  await setPrivacyFences(await storeFenceKeys(storeId));
  return drainIndexBatch({
    indexKeys: await storeIndexKeys(storeId),
    cursor,
    batchSize: Math.min(50, Math.max(1, Math.trunc(batchSize))),
  });
}
