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
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "65366" ||
    url.pathname !== "/core_billing_test" ||
    process.env.CORE_BILLING_DATABASE_TEST !== "1"
  )
    throw new Error("Isolated local billing database required");
  const [identity] = await db.$queryRaw<
    Array<{ name: string }>
  >`SELECT DATABASE() AS name`;
  expect(identity.name).toBe("core_billing_test");
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
async function fixture() {
  const shop = `billing-${randomUUID()}.myshopify.com`;
  shops.push(shop);
  const { ensureShopifySessionCoordination } = await import(
    "@/lib/weletic/shopify/session-coordination"
  );
  const { ensurePendingInstallationAfterAuthentication } = await import(
    "@/lib/weletic/shopify/installation-admission"
  );
  const { encrypt } = await import("@/lib/encryption");
  const pending = await db.$transaction(async (tx) => {
    await ensureShopifySessionCoordination(tx, { appId, shop });
    await tx.weleticShopifySessionCoordination.updateMany({
      where: { appId, shop },
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
      { appId, shop },
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
                      handle: "core-monthly",
                      price: {
                        __typename: "FlatRatePrice",
                        active: true,
                        currency: "USD",
                        amount: "500.00",
                      },
                    },
                  ],
                },
              },
            }
          : {
              data: {
                shop: {
                  id: "gid://shopify/Shop/2",
                  myshopifyDomain: shop,
                  currencyCode: "JPY",
                  plan: { partnerDevelopment: false },
                },
              },
            },
      ),
    );
  return { shop, pending, transport };
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
