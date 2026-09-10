import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicShopifyRuntime,
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
  PUBLIC_LOYALTY_SCOPES,
} from "../../../../packages/shopify-app/app/public-runtime-policy.mjs";
import { weleticApiRequest } from "../../../../packages/shopify-app/app/weletic-api.server";

function fixture(): Record<string, string> {
  return {
    SHOPIFY_API_KEY: PUBLIC_LOYALTY_CLIENT_ID,
    SHOPIFY_API_SECRET: "synthetic-app-secret-".repeat(3),
    WELETIC_SHOPIFY_SERVICE_SECRET: "synthetic-service-secret-".repeat(3),
    SHOPIFY_APP_DISTRIBUTION: "app_store",
    SCOPES: PUBLIC_LOYALTY_SCOPES.join(","),
    SHOPIFY_APP_URL: PUBLIC_LOYALTY_APP_ORIGIN,
    WELETIC_API_URL: PUBLIC_LOYALTY_API_ORIGIN,
    NODE_ENV: "production",
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("public Shopify runtime configuration", () => {
  it("accepts exact reviewed HTTPS configuration without mutating it", () => {
    const env = Object.freeze(fixture());
    expect(() => assertPublicShopifyRuntime(env)).not.toThrow();
  });

  it("accepts only explicitly isolated loopback development", () => {
    const env = {
      ...fixture(),
      SHOPIFY_APP_URL: "http://127.0.0.1:3002",
      WELETIC_API_URL: "http://app.localhost:8890",
      WELETIC_ISOLATED_DEVELOPMENT: "1",
      NODE_ENV: "development",
      PORT: "3002",
    };
    expect(() => assertPublicShopifyRuntime(env)).not.toThrow();
    for (const changes of [
      { NODE_ENV: "production" },
      { WELETIC_ISOLATED_DEVELOPMENT: "0" },
      { PORT: "3000" },
      { SHOPIFY_APP_URL: "http://localhost:3002" },
      { WELETIC_API_URL: "http://app.localhost:8888" },
    ])
      expect(() =>
        assertPublicShopifyRuntime({ ...env, ...changes }),
      ).toThrow();
  });

  it.each([
    ["SHOPIFY_API_KEY", ""],
    ["SHOPIFY_API_KEY", "legacy-app"],
    ["SHOPIFY_API_KEY", ` ${PUBLIC_LOYALTY_CLIENT_ID}`],
    ["SHOPIFY_APP_DISTRIBUTION", ""],
    ["SHOPIFY_APP_DISTRIBUTION", "single_merchant"],
    ["SCOPES", ""],
    ["SCOPES", "read_orders"],
    ["SCOPES", PUBLIC_LOYALTY_SCOPES.join(", ")],
    ["SCOPES", `${PUBLIC_LOYALTY_SCOPES.join(",")},read_orders`],
    ["SCOPES", `${PUBLIC_LOYALTY_SCOPES.join(",")},write_gift_cards`],
    ["SCOPES", `${PUBLIC_LOYALTY_SCOPES.join(",")},write_products`],
    ["SHOPIFY_APP_URL", "https://shopify.weletic.com"],
    ["SHOPIFY_APP_URL", `${PUBLIC_LOYALTY_APP_ORIGIN}/auth`],
    ["SHOPIFY_APP_URL", `${PUBLIC_LOYALTY_APP_ORIGIN}?bypass=1`],
    ["SHOPIFY_APP_URL", `https://user:secret@loyalty-shopify-dev.weletic.com`],
    ["WELETIC_API_URL", "https://app.weletic.com"],
    ["WELETIC_API_URL", `${PUBLIC_LOYALTY_API_ORIGIN}/wrong`],
    ["WELETIC_API_URL", "http://localhost:8888"],
    ["WELETIC_API_URL", ""],
    ["WELETIC_ISOLATED_DEVELOPMENT", "1"],
    ["WELETIC_ISOLATED_DEVELOPMENT", "true"],
    ["SHOPIFY_API_SECRET", ""],
    ["SHOPIFY_API_SECRET", " ".repeat(32)],
    ["WELETIC_SHOPIFY_SERVICE_SECRET", " ".repeat(32)],
    ["WELETIC_SHOPIFY_SERVICE_SECRET", "too-short"],
  ])("rejects unsafe %s without disclosing values", (key, value) => {
    expect(() =>
      assertPublicShopifyRuntime({ ...fixture(), [key]: value }),
    ).toThrowError(/^Unsafe public Shopify runtime configuration$/);
  });

  it("rejects reused app/service credentials", () => {
    const env = fixture();
    env.WELETIC_SHOPIFY_SERVICE_SECRET = env.SHOPIFY_API_SECRET;
    expect(() => assertPublicShopifyRuntime(env)).toThrow();
    env.WELETIC_SHOPIFY_SERVICE_SECRET = ` ${env.SHOPIFY_API_SECRET} `;
    expect(() => assertPublicShopifyRuntime(env)).toThrow();
  });

  it("cannot escape policy by changing the client ID while retaining a public endpoint", () => {
    for (const key of ["SHOPIFY_APP_URL", "WELETIC_API_URL"]) {
      const env = { [key]: fixture()[key], SHOPIFY_API_KEY: "legacy" };
      expect(() => assertPublicShopifyRuntime(env)).toThrow();
    }
  });

  it("does not change custom-app runtime semantics", () => {
    expect(() =>
      assertPublicShopifyRuntime({
        SHOPIFY_API_KEY: "2ddb3295b5911813add84c763b4111d3",
        SHOPIFY_APP_URL: "https://shopify.weletic.com",
        WELETIC_API_URL: "https://app.weletic.com",
      }),
    ).not.toThrow();
  });

  it("validates before coordinated storage or SDK initialization", () => {
    const source = readFileSync(
      new URL(
        "../../../../packages/shopify-app/app/shopify.server.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const guard = source.indexOf("assertPublicShopifyRuntime(process.env);");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(
      source.indexOf("new CoordinatedWeleticSessionStorage()"),
    );
    expect(guard).toBeLessThan(source.indexOf("shopifyApp({"));
  });

  it("blocks real gateway code before fetch on a mismatched public backend", async () => {
    for (const [key, value] of Object.entries(fixture()))
      vi.stubEnv(key, value);
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      weleticApiRequest("/api/internal/shopify/sessions"),
    ).rejects.toThrow("Unsafe public Shopify runtime configuration");
    expect(fetch).not.toHaveBeenCalled();
  });
});
