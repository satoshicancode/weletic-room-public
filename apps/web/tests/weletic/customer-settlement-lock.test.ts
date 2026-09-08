import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withDistributedLock: vi.fn() }));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: mocks.withDistributedLock,
}));

import {
  assertShopifySettlementLockContext,
  shopifyCustomerSettlementLockKeys,
  withShopifySettlementLocks,
} from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  deriveAllShopifyCustomerPrivacyIdentities,
  loadShopifyPrivacyHmacKeyring,
} from "@/lib/weletic/shopify/privacy-identity";
import { WeleticCustomerPrivacyIdentityKind } from "@prisma/client";

const privacyKeys = [
  `current:${Buffer.alloc(32, 0x11).toString("base64")}`,
  `previous:${Buffer.alloc(32, 0x22).toString("base64")}`,
].join(",");

describe("Shopify settlement lock context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS", privacyKeys);
    mocks.withDistributedLock.mockImplementation(async ({ fn }) => fn());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("acquires order then every sorted rotation-aware customer key", async () => {
    const expectedCustomerKeys = shopifyCustomerSettlementLockKeys({
      workspaceId: "workspace_1",
      storeId: "store_1",
      shopifyCustomerId: "customer_1",
    });
    let context: any;
    await withShopifySettlementLocks({
      workspaceId: "workspace_1",
      storeId: "store_1",
      orderExternalId: "order_1",
      shopifyCustomerId: "customer_1",
      fn: async (value) => {
        context = value;
        assertShopifySettlementLockContext({
          context: value,
          workspaceId: "workspace_1",
          storeId: "store_1",
          orderExternalId: "order_1",
          shopifyCustomerId: "customer_1",
        });
      },
    });

    expect(
      mocks.withDistributedLock.mock.calls.map(([input]) => input.key),
    ).toEqual([
      "weletic:shopify:order:workspace_1:order_1",
      ...expectedCustomerKeys,
    ]);
    expect(expectedCustomerKeys).toHaveLength(2);
    expect(expectedCustomerKeys).toEqual([...expectedCustomerKeys].sort());
    expect(expectedCustomerKeys.join("\n")).not.toContain("customer_1");
    expect(() =>
      assertShopifySettlementLockContext({
        context: {
          held: true,
          workspaceId: "workspace_1",
          storeId: "store_1",
          orderExternalId: "order_1",
          shopifyCustomerId: "customer_1",
        } as any,
        workspaceId: "workspace_1",
        storeId: "store_1",
        orderExternalId: "order_1",
        shopifyCustomerId: "customer_1",
      }),
    ).toThrow("does not match");
    expect(Reflect.ownKeys(context)).toContainEqual(expect.any(Symbol));
    expect(() =>
      assertShopifySettlementLockContext({
        context,
        workspaceId: "workspace_1",
        storeId: "store_1",
        orderExternalId: "order_1",
        shopifyCustomerId: "customer_1",
      }),
    ).toThrow("does not match");
  });

  it("maps a retained previous-key pseudonym to one of the raw-ID locks", () => {
    const identities = deriveAllShopifyCustomerPrivacyIdentities({
      storeId: "store_1",
      shopifyCustomerId: "gid://shopify/Customer/501",
      keyring: loadShopifyPrivacyHmacKeyring(),
    }).filter(
      (identity) =>
        identity.identityKind ===
        WeleticCustomerPrivacyIdentityKind.customer_id,
    );
    const previousIdentity = identities.find(
      ({ identityKeyId }) => identityKeyId === "previous",
    )!;
    const previousPseudonym = `redacted:v1:${previousIdentity.identityKeyId}:${previousIdentity.customerDigest}`;

    const rawKeys = shopifyCustomerSettlementLockKeys({
      workspaceId: "workspace_1",
      storeId: "store_1",
      shopifyCustomerId: "501",
    });
    const retainedKeys = shopifyCustomerSettlementLockKeys({
      workspaceId: "workspace_1",
      storeId: "store_1",
      shopifyCustomerId: previousPseudonym,
    });

    expect(retainedKeys).toHaveLength(1);
    expect(rawKeys).toContain(retainedKeys[0]);
  });

  it("fails closed for missing tenant scope or an unconfigured pseudonym key", () => {
    expect(() =>
      shopifyCustomerSettlementLockKeys({
        workspaceId: "workspace_1",
        storeId: "store_1",
        shopifyCustomerId: `redacted:v1:retired:${"A".repeat(64)}`,
      }),
    ).toThrow("is not configured");

    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      shopifyCustomerSettlementLockKeys({
        workspaceId: "workspace_1",
        shopifyCustomerId: "501",
      }),
    ).toThrow("store id is required");
  });
});
