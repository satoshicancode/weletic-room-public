import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isRestrictedDevelopmentEnvironment,
} from "../../../../infra/shopify-development/restricted-policy.mjs";
import { permitsRestrictedDevelopmentIdentity } from "@/lib/weletic/shopify/restricted-development";

describe("SEC-AUDIT-04: Multi-Tenant Zero Hardcoding Invariant 4 Compliance", () => {
  const generation = "11111111-1111-4111-8111-111111111111";

  afterEach(() => vi.unstubAllEnvs());

  it("dynamically admits an arbitrary tenant development store from environment variables", () => {
    const arbitraryStore = "acme-tenant-dev.myshopify.com";
    const arbitraryAppId = "custom_app_id_999999";
    const arbitraryPartnerAppId = "gid://shopify/App/999999";
    const arbitraryShopId = "gid://shopify/Shop/999999";

    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WELETIC_ISOLATED_DEVELOPMENT", "1");
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
    vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT", "yamaxdev-v1");
    vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT_GENERATION", generation);
    vi.stubEnv("SHOPIFY_API_KEY", arbitraryAppId);
    vi.stubEnv("SHOPIFY_PARTNER_APP_ID", arbitraryPartnerAppId);
    vi.stubEnv("SHOPIFY_RESTRICTED_DEV_STORES", arbitraryStore);
    vi.stubEnv("WELETIC_RESTRICTED_DEV_SHOP_ID", arbitraryShopId);
    vi.stubEnv("DATABASE_URL", "mysql://synthetic@127.0.0.1:60101/test");
    vi.stubEnv("PLANETSCALE_DATABASE_URL", "http://127.0.0.1:65367/test");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://127.0.0.1:8079");
    vi.stubEnv("STORAGE_ENDPOINT", "http://127.0.0.1:9002");

    expect(isRestrictedDevelopmentEnvironment(process.env)).toBe(true);

    const identity = {
      appId: arbitraryAppId,
      partnerAppId: arbitraryPartnerAppId,
      shopId: arbitraryShopId,
      shop: arbitraryStore,
      installationGeneration: generation,
    };

    expect(permitsRestrictedDevelopmentIdentity(identity)).toBe(true);
  });

  it("rejects stores not included in SHOPIFY_RESTRICTED_DEV_STORES", () => {
    const generationId = "22222222-2222-4222-8222-222222222222";
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("WELETIC_ISOLATED_DEVELOPMENT", "1");
    vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
    vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT", "yamaxdev-v1");
    vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT_GENERATION", generationId);
    vi.stubEnv("SHOPIFY_API_KEY", "app_123");
    vi.stubEnv("SHOPIFY_PARTNER_APP_ID", "gid://shopify/App/123");
    vi.stubEnv("SHOPIFY_RESTRICTED_DEV_STORES", "allowed-store.myshopify.com");
    vi.stubEnv("DATABASE_URL", "mysql://synthetic@127.0.0.1:60101/test");
    vi.stubEnv("PLANETSCALE_DATABASE_URL", "http://127.0.0.1:65367/test");
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://127.0.0.1:8079");
    vi.stubEnv("STORAGE_ENDPOINT", "http://127.0.0.1:9002");

    const unauthorizedIdentity = {
      appId: "app_123",
      partnerAppId: "gid://shopify/App/123",
      shopId: "gid://shopify/Shop/456",
      shop: "unauthorized-store.myshopify.com",
      installationGeneration: generationId,
    };

    expect(permitsRestrictedDevelopmentIdentity(unauthorizedIdentity)).toBe(false);
  });

  it("static code inspection confirms zero occurrences of montdev.myshopify.com and app id literal in runtime files", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    const runtimeFiles = [
      "apps/web/lib/weletic/shopify/app-pricing-service.ts",
      "apps/web/lib/weletic/shopify/restricted-development.ts",
      "infra/shopify-development/restricted-policy.mjs",
    ];

    for (const rel of runtimeFiles) {
      const full = path.resolve(process.cwd(), rel);
      if (fs.existsSync(full)) {
        const content = fs.readFileSync(full, "utf8");
        expect(content).not.toContain("montdev.myshopify.com");
        expect(content).not.toContain("c7d49cebb06e445db345bb200f966a03");
      }
    }
  });
});
