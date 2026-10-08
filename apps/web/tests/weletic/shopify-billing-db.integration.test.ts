import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
const db = new PrismaClient();
vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("server-only", () => ({}));
const appId = `billing-${randomUUID()}`;
const shops: string[] = [];
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL || "invalid:");
  const databaseName =
    process.env.CORE_BILLING_DATABASE_NAME || "core_billing_test";
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== (process.env.CORE_BILLING_DATABASE_PORT || "65366") ||
    !/^core_billing_test(?:_[a-z0-9]+)?$/.test(databaseName) ||
    url.pathname !== `/${databaseName}` ||
    process.env.CORE_BILLING_DATABASE_TEST !== "1"
  )
    throw new Error("Isolated local billing database required");
  const [identity] = await db.$queryRaw<
    Array<{ name: string }>
  >`SELECT DATABASE() AS name`;
  expect(identity.name).toBe(databaseName);
  vi.stubEnv("SHOPIFY_API_KEY", appId);
  vi.stubEnv("SHOPIFY_PARTNER_APP_ID", "gid://shopify/App/1");
  vi.stubEnv("SHOPIFY_PARTNER_ORGANIZATION_ID", "123");
  vi.stubEnv("SHOPIFY_PARTNER_API_TOKEN", "synthetic-partner-token");
  vi.stubEnv("WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE", "core-monthly");
  vi.stubEnv("WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE", "company-free");
  vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
  vi.stubEnv("ENCRYPTION_KEY", "12".repeat(32));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected live network");
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.$disconnect();
});
async function fixture(
  options: {
    amount?: string;
    handle?: string;
    development?: boolean;
    restricted?: boolean;
  } = {},
) {
  const billing = {
    amount: "500.00",
    handle: "core-monthly",
    development: false,
    ...options,
  };
  const fixtureAppId = options.restricted
    ? "c7d49cebb06e445db345bb200f966a03"
    : appId;
  const shopId = options.restricted
    ? "gid://shopify/Shop/73236414690"
    : "gid://shopify/Shop/2";
  const shop = options.restricted
    ? "montdev.myshopify.com"
    : `billing-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  const { ensureShopifySessionCoordination } = await import(
    "@/lib/weletic/shopify/session-coordination"
  );
  const { ensurePendingInstallationAfterAuthentication } = await import(
    "@/lib/weletic/shopify/installation-admission"
  );
  const { encrypt } = await import("@/lib/encryption");
  const pending = await db.$transaction(async (tx) => {
    await ensureShopifySessionCoordination(tx, { appId: fixtureAppId, shop });
    await tx.weleticShopifySessionCoordination.updateMany({
      where: { appId: fixtureAppId, shop },
      data: { leaseEpoch: BigInt(1), revision: BigInt(1) },
    });
    await tx.weleticShopifyAppSession.create({
      data: {
        id: `offline_${shop}`,
        shop,
        isOnline: false,
        payload: encrypt(
          JSON.stringify([
            ["id", `offline_${shop}`],
            ["shop", shop],
            ["isOnline", false],
            ["accessToken", "synthetic-billing-token"],
          ]),
        ),
      },
    });
    return ensurePendingInstallationAfterAuthentication(
      tx,
      { appId: fixtureAppId, shop },
      new Date(Date.now() - 1000),
    );
  });
  const transport: typeof fetch = async (url) =>
    new Response(
      JSON.stringify(
        String(url).startsWith("https://partners.")
          ? {
              data: {
                activeSubscription: {
                  app: { id: "gid://shopify/App/1" },
                  shop: { id: "gid://shopify/Shop/2" },
                  billingPeriod: "EVERY_30_DAYS",
                  cancelAtEndOfCycle: false,
                  trialEndsAt: null,
                  currentBillingCycle: {
                    startTime: new Date(Date.now() - 60000).toISOString(),
                    endTime: new Date(Date.now() + 86400000).toISOString(),
                  },
                  items: [
                    {
                      handle: billing.handle,
                      price: {
                        __typename: "FlatRatePrice",
                        active: true,
                        currency: "USD",
                        amount: billing.amount,
                      },
                    },
                  ],
                },
              },
            }
          : {
              data: {
                shop: {
                  id: shopId,
                  myshopifyDomain: shop,
                  currencyCode: "JPY",
                  plan: { partnerDevelopment: billing.development },
                },
              },
            },
      ),
    );
  return { shop, pending, transport, billing };
}
it("paid bootstrap requires credential publication, then mapped refresh works and suspension survives", async () => {
  const f = await fixture();
  const {
    reconcileSubscribedInstallation,
    refreshAppPricingForShop,
    assertStoreSubscriptionForNewBenefit,
  } = await import("@/lib/weletic/shopify/app-pricing-service");
  expect(
    await reconcileSubscribedInstallation(f.shop, f.transport),
  ).toMatchObject({ status: "paid", credentialsChanged: true });
  const store = await db.weleticShopifyStore.findUniqueOrThrow({
    where: { shopDomain: f.shop },
  });
  expect(store.storeAccessState).toBe("active");
  await expect(refreshAppPricingForShop(f.shop, f.transport)).rejects.toThrow();
  const { publishStoreOwnedShopifyCredential } = await import(
    "@/lib/weletic/shopify/store-owned-credential"
  );
  await db.$transaction((tx) =>
    publishStoreOwnedShopifyCredential(tx, {
      identity: {
        storeId: store.id,
        workspaceId: store.projectId,
        appId,
        shop: f.shop,
        installationGeneration: store.installationGeneration,
      },
      expectedRevision: null,
      material: { accessToken: "synthetic-billing-token", scope: "" },
    }),
  );
  expect(await refreshAppPricingForShop(f.shop, f.transport)).toMatchObject({
    status: "paid",
    storeId: store.id,
  });
  await db.$transaction((tx) =>
    assertStoreSubscriptionForNewBenefit(tx, store.id),
  );
  vi.stubEnv("WELETIC_SETUP_ONLY", "1");
  try {
    // The paid snapshot is still valid; setup must not depend on expiry.
    await expect(
      db.$transaction((tx) =>
        assertStoreSubscriptionForNewBenefit(tx, store.id),
      ),
    ).rejects.toThrow("verification");
    const { assertFreshInstallationSubscription } = await import(
      "@/lib/weletic/shopify/app-pricing-service"
    );
    await expect(
      db.$transaction((tx) =>
        assertFreshInstallationSubscription(
          tx,
          f.pending.id,
          store.installationGeneration!,
          new Date(),
        ),
      ),
    ).rejects.toThrow("verification");
    expect(await refreshAppPricingForShop(f.shop, f.transport)).toMatchObject({
      status: "unavailable",
      storeId: store.id,
    });
    expect(
      (
        await db.weleticShopifyStore.findUniqueOrThrow({
          where: { id: store.id },
        })
      ).storeAccessState,
    ).toBe("active");
  } finally {
    vi.stubEnv("WELETIC_SETUP_ONLY", undefined);
  }
  // Leaving setup does not resurrect its unavailable snapshot without refresh.
  await expect(
    db.$transaction((tx) => assertStoreSubscriptionForNewBenefit(tx, store.id)),
  ).rejects.toThrow("verification");
  expect(await refreshAppPricingForShop(f.shop, f.transport)).toMatchObject({
    status: "paid",
  });
  await db.weleticShopifyStore.update({
    where: { id: store.id },
    data: { storeAccessState: "suspended" },
  });
  await reconcileSubscribedInstallation(f.shop, f.transport);
  expect(
    (
      await db.weleticShopifyStore.findUniqueOrThrow({
        where: { id: store.id },
      })
    ).storeAccessState,
  ).toBe("suspended");
  await db.weleticShopifySubscriptionSnapshot.updateMany({
    where: { appId, pendingInstallationId: f.pending.id },
    data: { validUntil: new Date(0) },
  });
  await expect(
    db.$transaction((tx) => assertStoreSubscriptionForNewBenefit(tx, store.id)),
  ).rejects.toThrow("verification");
});
it("a delayed failure cannot overwrite a newer verified refresh", async () => {
  const f = await fixture();
  const { refreshAppPricingForShop } = await import(
    "@/lib/weletic/shopify/app-pricing-service"
  );
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://partners.")) {
      reached();
      await gate;
      throw new Error("Synthetic unavailable");
    }
    return f.transport(url, init);
  };
  const first = refreshAppPricingForShop(f.shop, slow);
  const rejected = expect(first).rejects.toThrow("verification");
  await waiting;
  expect((await refreshAppPricingForShop(f.shop, f.transport)).status).toBe(
    "paid",
  );
  release();
  await rejected;
  expect(
    (
      await db.weleticShopifySubscriptionSnapshot.findFirstOrThrow({
        where: { pendingInstallationId: f.pending.id },
      })
    ).status,
  ).toBe("paid");
});
it("reinstall during provider HTTP and an old scheduled generation cannot grant access", async () => {
  const f = await fixture();
  const { refreshAppPricingForShop } = await import(
    "@/lib/weletic/shopify/app-pricing-service"
  );
  const changed: typeof fetch = async (url, init) => {
    if (String(url).startsWith("https://partners."))
      await db.weleticShopifyPendingInstallation.update({
        where: { id: f.pending.id },
        data: {
          installationGeneration: randomUUID(),
          revision: { increment: 1 },
        },
      });
    return f.transport(url, init);
  };
  await expect(refreshAppPricingForShop(f.shop, changed)).rejects.toThrow();
  const untouched = vi.fn(f.transport);
  await expect(
    refreshAppPricingForShop(
      f.shop,
      untouched,
      f.pending.installationGeneration!,
    ),
  ).rejects.toThrow();
  expect(untouched).not.toHaveBeenCalled();
  expect(
    (
      await db.weleticShopifySubscriptionSnapshot.findFirstOrThrow({
        where: { pendingInstallationId: f.pending.id },
      })
    ).status,
  ).toBe("unavailable");
});

it("does not provision a production store from a zero-dollar public contract", async () => {
  const f = await fixture({ amount: "0.00" });
  const { reconcileSubscribedInstallation } = await import(
    "@/lib/weletic/shopify/app-pricing-service"
  );
  expect(
    await reconcileSubscribedInstallation(f.shop, f.transport),
  ).toMatchObject({ status: "inactive" });
  expect(
    await db.weleticShopifyStore.findUnique({ where: { shopDomain: f.shop } }),
  ).toBeNull();
  expect(
    (
      await db.weleticShopifyPendingInstallation.findUniqueOrThrow({
        where: { id: f.pending.id },
      })
    ).mappedStoreId,
  ).toBeNull();
});

it.each([
  { name: "development", handle: "core-monthly", development: true },
  { name: "private_free", handle: "company-free", development: false },
])(
  "$name zero-dollar admission is revalidated before new benefits",
  async ({ name, handle, development }) => {
    const f = await fixture({ amount: "0.00", handle, development });
    const {
      reconcileSubscribedInstallation,
      refreshAppPricingForShop,
      assertStoreSubscriptionForNewBenefit,
    } = await import("@/lib/weletic/shopify/app-pricing-service");
    expect(
      await reconcileSubscribedInstallation(f.shop, f.transport),
    ).toMatchObject({ status: name, credentialsChanged: true });
    const store = await db.weleticShopifyStore.findUniqueOrThrow({
      where: { shopDomain: f.shop },
    });
    expect(store.storeAccessState).toBe("active");
    const { publishStoreOwnedShopifyCredential } = await import(
      "@/lib/weletic/shopify/store-owned-credential"
    );
    await db.$transaction((tx) =>
      publishStoreOwnedShopifyCredential(tx, {
        identity: {
          storeId: store.id,
          workspaceId: store.projectId,
          appId,
          shop: f.shop,
          installationGeneration: store.installationGeneration,
        },
        expectedRevision: null,
        material: { accessToken: "synthetic-billing-token", scope: "" },
      }),
    );
    await db.$transaction((tx) =>
      assertStoreSubscriptionForNewBenefit(tx, store.id),
    );

    // Authenticated development status must be checked again, never cached as a bypass.
    if (development) f.billing.development = false;
    else f.billing.handle = "unknown-free";
    expect(await refreshAppPricingForShop(f.shop, f.transport)).toMatchObject({
      status: "inactive",
      storeId: store.id,
    });
    await expect(
      db.$transaction((tx) =>
        assertStoreSubscriptionForNewBenefit(tx, store.id),
      ),
    ).rejects.toThrow("verification");
    f.billing.development = development;
    f.billing.handle = handle;
    expect(await refreshAppPricingForShop(f.shop, f.transport)).toMatchObject({
      status: name,
    });
    await db.$transaction((tx) =>
      assertStoreSubscriptionForNewBenefit(tx, store.id),
    );

    const unavailable: typeof fetch = async (url, init) => {
      if (String(url).startsWith("https://partners."))
        throw new Error("Synthetic Partner outage");
      return f.transport(url, init);
    };
    expect(await refreshAppPricingForShop(f.shop, unavailable)).toMatchObject({
      status: "unavailable",
      storeId: store.id,
    });
    await expect(
      db.$transaction((tx) =>
        assertStoreSubscriptionForNewBenefit(tx, store.id),
      ),
    ).rejects.toThrow("verification");
    const snapshot =
      await db.weleticShopifySubscriptionSnapshot.findFirstOrThrow({
        where: { pendingInstallationId: f.pending.id },
      });
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.installationGeneration).toBe(store.installationGeneration);
    expect(snapshot.shopId).toBe("gid://shopify/Shop/2");
    const retained = await db.weleticShopifyStore.findUniqueOrThrow({
      where: { id: store.id },
    });
    expect(retained.installationGeneration).toBe(store.installationGeneration);
    expect(retained.projectId).toBe(store.projectId);
    expect(retained.storeAccessState).toBe("active");
  },
);

it("setup refresh verifies identity without admitting a paid installation", async () => {
  const f = await fixture();
  const { reconcileSubscribedInstallation } = await import(
    "@/lib/weletic/shopify/app-pricing-service"
  );
  const handles = {
    WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE:
      process.env.WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE,
    WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE:
      process.env.WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE,
  };
  for (const key of Object.keys(handles)) vi.stubEnv(key, undefined);
  vi.stubEnv("WELETIC_SETUP_ONLY", "1");
  try {
    expect(
      await reconcileSubscribedInstallation(f.shop, f.transport),
    ).toMatchObject({
      status: "unavailable",
      storeId: null,
      credentialsChanged: false,
    });
    expect(
      await db.weleticShopifyStore.findUnique({
        where: { shopDomain: f.shop },
      }),
    ).toBeNull();
    const snapshot =
      await db.weleticShopifySubscriptionSnapshot.findFirstOrThrow({
        where: { pendingInstallationId: f.pending.id },
      });
    expect(snapshot).toMatchObject({
      status: "unavailable",
      shopId: "gid://shopify/Shop/2",
      installationGeneration: f.pending.installationGeneration,
    });
    expect(snapshot.validUntil!.getTime()).toBeLessThanOrEqual(Date.now());
    const { bootstrapCompanyStore } = await import(
      "@/lib/weletic/shopify/company-store-bootstrap"
    );
    await expect(bootstrapCompanyStore({}, f.transport)).rejects.toThrow(
      "verification",
    );
  } finally {
    vi.stubEnv("WELETIC_SETUP_ONLY", undefined);
    for (const [key, value] of Object.entries(handles)) vi.stubEnv(key, value);
  }
});

it("restricted development admits only fresh pinned identity and preserves suspension and privacy", async () => {
  const original = { ...process.env };
  const app = "c7d49cebb06e445db345bb200f966a03";
  const values = {
    NODE_ENV: "development",
    WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS: `restricted-test:${Buffer.alloc(32, 0x43).toString("base64")}`,
    SHOPIFY_API_KEY: app,
    SHOPIFY_PARTNER_APP_ID: "gid://shopify/App/419628580865",
    WELETIC_ISOLATED_DEVELOPMENT: "1",
    WELETIC_RESTRICTED_DEVELOPMENT: "yamaxdev-v1",
    PLANETSCALE_DATABASE_URL: "http://127.0.0.1:65367/test",
    UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079",
    STORAGE_ENDPOINT: "http://127.0.0.1:9002",
  };
  for (const [key, value] of Object.entries(values)) vi.stubEnv(key, value);
  vi.stubEnv("WELETIC_SETUP_ONLY", undefined);
  vi.stubEnv("WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE", undefined);
  vi.stubEnv("WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE", undefined);
  const {
    reconcileSubscribedInstallation,
    refreshAppPricingForShop,
    assertStoreSubscriptionForNewBenefit,
    assertFreshInstallationSubscription,
    assertReviewAwardTestingAuthority,
  } = await import("@/lib/weletic/shopify/app-pricing-service");
  try {
    const f = await fixture({ restricted: true, development: true });
    vi.stubEnv(
      "WELETIC_RESTRICTED_DEVELOPMENT_GENERATION",
      f.pending.installationGeneration!,
    );
    let restrictedPartnerCalls = 0;
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith("https://partners.")) {
        if (process.env.WELETIC_RESTRICTED_DEVELOPMENT !== undefined)
          restrictedPartnerCalls++;
        throw new Error("Synthetic Partner outage; billing is not tested");
      }
      return f.transport(url, init);
    });
    expect(
      await reconcileSubscribedInstallation(f.shop, transport),
    ).toMatchObject({
      status: "restricted_development",
      credentialsChanged: true,
    });
    const store = await db.weleticShopifyStore.findUniqueOrThrow({
      where: { shopDomain: f.shop },
    });
    const { publishStoreOwnedShopifyCredential } = await import(
      "@/lib/weletic/shopify/store-owned-credential"
    );
    await db.$transaction((tx) =>
      publishStoreOwnedShopifyCredential(tx, {
        identity: {
          storeId: store.id,
          workspaceId: store.projectId,
          appId: app,
          shop: f.shop,
          installationGeneration: store.installationGeneration,
        },
        expectedRevision: null,
        material: { accessToken: "synthetic-billing-token", scope: "" },
      }),
    );
    await refreshAppPricingForShop(f.shop, transport);
    const allow = () =>
      db.$transaction((tx) =>
        assertStoreSubscriptionForNewBenefit(tx, store.id),
      );
    await allow();
    const reviewAllow = () =>
      db.$transaction((tx) => assertReviewAwardTestingAuthority(tx, store.id));
    await reviewAllow();
    const row = await db.weleticShopifySubscriptionSnapshot.findFirstOrThrow({
      where: { pendingInstallationId: f.pending.id },
    });
    expect(row).toMatchObject({
      status: "restricted_development",
      planHandle: null,
      shopId: "gid://shopify/Shop/73236414690",
    });
    expect(
      await db.weleticShopifyPendingInstallationChange.findFirst({
        where: { mappedStoreId: store.id },
      }),
    ).toMatchObject({ operator: "restricted-yamaxdev-testing" });
    const { bootstrapCompanyStore } = await import(
      "@/lib/weletic/shopify/company-store-bootstrap"
    );
    await expect(bootstrapCompanyStore({}, transport)).rejects.toThrow();
    await db.weleticShopifySubscriptionSnapshot.update({
      where: { id: row.id },
      data: { validUntil: new Date(0) },
    });
    await expect(allow()).rejects.toThrow();
    await refreshAppPricingForShop(f.shop, transport);
    vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT", undefined);
    vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT_GENERATION", undefined);
    await expect(allow()).rejects.toThrow();
    await expect(reviewAllow()).rejects.toThrow();
    expect(await refreshAppPricingForShop(f.shop, transport)).toMatchObject({
      status: "unavailable",
    });
    await expect(reviewAllow()).rejects.toThrow();
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "legacy");
    await expect(reviewAllow()).rejects.toThrow();
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
    vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT", "yamaxdev-v1");
    vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT_GENERATION", randomUUID());
    await expect(allow()).rejects.toThrow();
    vi.stubEnv(
      "WELETIC_RESTRICTED_DEVELOPMENT_GENERATION",
      f.pending.installationGeneration!,
    );
    await refreshAppPricingForShop(f.shop, transport);
    await expect(
      db.$transaction((tx) =>
        assertFreshInstallationSubscription(
          tx,
          "foreign-pending",
          f.pending.installationGeneration!,
          new Date(),
        ),
      ),
    ).rejects.toThrow();
    vi.stubEnv("NODE_ENV", "production");
    await expect(allow()).rejects.toThrow();
    vi.stubEnv("NODE_ENV", "development");
    await db.weleticShopifyStore.update({
      where: { id: store.id },
      data: { storeAccessState: "suspended" },
    });
    await expect(
      reconcileSubscribedInstallation(f.shop, transport),
    ).rejects.toThrow();
    expect(
      (
        await db.weleticShopifyStore.findUniqueOrThrow({
          where: { id: store.id },
        })
      ).storeAccessState,
    ).toBe("suspended");
    await db.weleticShopifyStore.update({
      where: { id: store.id },
      data: { storeAccessState: "active" },
    });
    f.billing.development = false;
    expect(await refreshAppPricingForShop(f.shop, transport)).toMatchObject({
      status: "unavailable",
    });
    await expect(allow()).rejects.toThrow();
    f.billing.development = true;
    await refreshAppPricingForShop(f.shop, transport);
    await db.weleticShopifyPendingInstallation.update({
      where: { id: f.pending.id },
      data: { redactedAt: new Date() },
    });
    await expect(allow()).rejects.toThrow();
    await expect(refreshAppPricingForShop(f.shop, transport)).rejects.toThrow();
    expect(restrictedPartnerCalls).toBe(0);
  } finally {
    for (const key of [
      ...Object.keys(values),
      "WELETIC_SETUP_ONLY",
      "WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE",
      "WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE",
      "WELETIC_RESTRICTED_DEVELOPMENT_GENERATION",
    ])
      vi.stubEnv(key, original[key]);
  }
});
