import { shopifyOrderSettlementLockKey } from "@/lib/weletic/commerce/order-attribution";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import {
  deriveAllShopifyCustomerPrivacyIdentities,
  loadShopifyPrivacyHmacKeyring,
  SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN,
} from "@/lib/weletic/shopify/privacy-identity";
import { WeleticCustomerPrivacyIdentityKind } from "@prisma/client";

export const SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS = 1_800;

const SHOPIFY_SETTLEMENT_LOCK_CONTEXT_BRAND = Symbol(
  "ShopifySettlementLockContext",
);
const activeSettlementLockContexts = new WeakSet<object>();

export type ShopifySettlementLockContext = {
  readonly [SHOPIFY_SETTLEMENT_LOCK_CONTEXT_BRAND]: true;
  workspaceId: string;
  storeId: string;
  orderExternalId: string;
  shopifyCustomerId: string | null;
};

function customerPrivacyLockKey({
  workspaceId,
  identityKeyId,
  customerDigest,
}: {
  workspaceId: string;
  identityKeyId: string;
  customerDigest: string;
}) {
  return `weletic:shopify:settlement:${workspaceId}:customer:hmac:v1:${identityKeyId}:${customerDigest}`;
}

/**
 * Returns every lock identity that can represent one Shopify customer under
 * the configured current + previous privacy keys. Incoming raw IDs acquire
 * the complete sorted set, while a retained pseudonym acquires its exact key.
 * This bridges privacy-key rotation without putting raw customer IDs in Redis.
 */
export function shopifyCustomerSettlementLockKeys({
  workspaceId,
  storeId,
  shopifyCustomerId,
}: {
  workspaceId: string;
  storeId?: string;
  shopifyCustomerId: string | number;
}) {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new Error("Shopify settlement lock workspace id is required.");
  }

  const normalizedCustomerId = String(shopifyCustomerId).trim();
  if (!normalizedCustomerId) {
    throw new Error("Shopify settlement lock customer id is required.");
  }
  const normalizedStoreId = storeId?.trim();
  if (!normalizedStoreId && process.env.NODE_ENV !== "test") {
    throw new Error(
      "Shopify settlement lock store id is required for customer-scoped locking.",
    );
  }

  const keyring = loadShopifyPrivacyHmacKeyring();
  const pseudonym = normalizedCustomerId.match(
    SHOPIFY_CUSTOMER_PRIVACY_PSEUDONYM_PATTERN,
  );
  let identities: Array<{
    identityKeyId: string;
    customerDigest: string;
  }>;
  if (pseudonym) {
    const identityKeyId = pseudonym[1];
    if (!keyring.all.some((key) => key.identityKeyId === identityKeyId)) {
      throw new Error(
        `Shopify settlement lock pseudonym key ${identityKeyId} is not configured.`,
      );
    }
    identities = [{ identityKeyId, customerDigest: pseudonym[2] }];
  } else {
    if (normalizedCustomerId.startsWith("redacted:")) {
      throw new Error("Shopify settlement lock pseudonym is invalid.");
    }
    identities = deriveAllShopifyCustomerPrivacyIdentities({
      // A narrow compatibility bridge keeps old isolated unit fixtures working
      // without weakening production. Production always requires the real
      // store ID so raw and retained pseudonymous identities converge.
      storeId: normalizedStoreId ?? `test-fixture:${normalizedWorkspaceId}`,
      shopifyCustomerId: normalizedCustomerId,
      keyring,
    })
      .filter(
        (identity) =>
          identity.identityKind ===
          WeleticCustomerPrivacyIdentityKind.customer_id,
      )
      .map(({ identityKeyId, customerDigest }) => ({
        identityKeyId,
        customerDigest,
      }));
  }

  return Array.from(
    new Set(
      identities.map((identity) =>
        customerPrivacyLockKey({
          workspaceId: normalizedWorkspaceId,
          ...identity,
        }),
      ),
    ),
  ).sort();
}

export async function withShopifyCustomerSettlementLocks<T>({
  workspaceId,
  storeId,
  shopifyCustomerId,
  fn,
}: {
  workspaceId: string;
  storeId?: string;
  shopifyCustomerId: string | number;
  fn: () => Promise<T>;
}): Promise<T> {
  const lockKeys = shopifyCustomerSettlementLockKeys({
    workspaceId,
    storeId,
    shopifyCustomerId,
  });
  const runWithLock = (index: number): Promise<T> =>
    index >= lockKeys.length
      ? fn()
      : withDistributedLock({
          key: lockKeys[index],
          ttlSeconds: SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS,
          fn: () => runWithLock(index + 1),
        });
  return runWithLock(0);
}

export function assertShopifySettlementLockContext({
  context,
  workspaceId,
  storeId,
  orderExternalId,
  shopifyCustomerId,
}: {
  context: ShopifySettlementLockContext;
  workspaceId: string;
  storeId?: string;
  orderExternalId: string | number;
  shopifyCustomerId?: string | number | null;
}) {
  const expectedCustomerId =
    shopifyCustomerId === undefined || shopifyCustomerId === null
      ? null
      : String(shopifyCustomerId);
  if (
    context[SHOPIFY_SETTLEMENT_LOCK_CONTEXT_BRAND] !== true ||
    !activeSettlementLockContexts.has(context) ||
    context.workspaceId !== workspaceId ||
    (storeId !== undefined && context.storeId !== storeId) ||
    context.orderExternalId !== String(orderExternalId) ||
    context.shopifyCustomerId !== expectedCustomerId
  ) {
    throw new Error(
      "Shopify settlement lock context does not match the order.",
    );
  }
}

/**
 * All Shopify order/customer settlement paths acquire locks in one order:
 * order first, customer second. Keeping the complete webhook/affiliate pipeline
 * inside this scope prevents both redaction races and order/customer lock cycles.
 */
export async function withShopifySettlementLocks<T>({
  workspaceId,
  storeId,
  orderExternalId,
  shopifyCustomerId,
  fn,
}: {
  workspaceId: string;
  storeId?: string;
  orderExternalId: string | number;
  shopifyCustomerId?: string | number | null;
  fn: (context: ShopifySettlementLockContext) => Promise<T>;
}): Promise<T> {
  const normalizedOrderId = String(orderExternalId);
  const normalizedCustomerId =
    shopifyCustomerId === undefined || shopifyCustomerId === null
      ? null
      : String(shopifyCustomerId);
  const normalizedStoreId = storeId?.trim();
  if (
    normalizedCustomerId &&
    !normalizedStoreId &&
    process.env.NODE_ENV !== "test"
  ) {
    throw new Error(
      "Shopify settlement lock store id is required for customer-scoped locking.",
    );
  }
  const context: ShopifySettlementLockContext = {
    [SHOPIFY_SETTLEMENT_LOCK_CONTEXT_BRAND]: true,
    workspaceId,
    storeId: normalizedStoreId ?? `test-fixture:${workspaceId}`,
    orderExternalId: normalizedOrderId,
    shopifyCustomerId: normalizedCustomerId,
  };
  const runWithActiveContext = async () => {
    activeSettlementLockContexts.add(context);
    try {
      return await fn(context);
    } finally {
      activeSettlementLockContexts.delete(context);
    }
  };

  return withDistributedLock({
    key: shopifyOrderSettlementLockKey(workspaceId, normalizedOrderId),
    ttlSeconds: SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS,
    fn: () =>
      normalizedCustomerId
        ? withShopifyCustomerSettlementLocks({
            workspaceId,
            storeId: normalizedStoreId,
            shopifyCustomerId: normalizedCustomerId,
            fn: runWithActiveContext,
          })
        : runWithActiveContext(),
  });
}
