import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getShopifyRequestedScopes } from "../../../../packages/shopify-app/app/shopify-scopes";
import { DEVELOPMENT_SHOPIFY_SCOPES } from "../../lib/weletic/shopify/development-preflight";

describe("Shopify runtime requested scopes", () => {
  const publicManifest = readFileSync(
    resolve(
      process.cwd(),
      "../../packages/shopify-app/shopify.app.loyalty-public.toml",
    ),
    "utf8",
  );

  it("keeps the public installation loyalty-only and optional permissions separate", () => {
    const required = publicManifest.match(/^scopes = "([^"]+)"/m)?.[1];
    expect(required).toBeDefined();
    expect(getShopifyRequestedScopes(required)).toEqual([
      "read_products",
      "read_markets",
      "read_orders",
      "read_translations",
      "write_discounts",
      "write_customers",
      "write_app_proxy",
    ]);
    expect(required!.split(",")).toEqual([...DEVELOPMENT_SHOPIFY_SCOPES]);
    const optional = JSON.parse(
      publicManifest.match(/^optional_scopes = (\[.*\])/m)![1],
    );
    expect(optional).toEqual([
      "write_gift_cards",
      "read_store_credit_accounts",
      "write_store_credit_account_transactions",
    ]);
    expect(
      optional.every((scope: string) => !required!.split(",").includes(scope)),
    ).toBe(true);
    expect(publicManifest).not.toMatch(
      /read_price_rules|write_price_rules|write_products/,
    );
  });

  it("isolates public identity, endpoints, managed installation and extension discovery", () => {
    expect(publicManifest).toContain(
      'client_id = "c7d49cebb06e445db345bb200f966a03"',
    );
    expect(publicManifest).toMatch(/^extension_directories = \[\]$/m);
    expect(publicManifest).toMatch(
      /^automatically_update_urls_on_dev = false$/m,
    );
    expect(publicManifest).toMatch(/^use_legacy_install_flow = false$/m);
    const urls = [...publicManifest.matchAll(/https:\/\/[^"\s]+/g)].map(
      ([url]) => new URL(url),
    );
    expect(urls.map((url) => url.href)).toEqual([
      "https://loyalty-shopify-dev.weletic.com/",
      "https://loyalty-shopify-dev.weletic.com/auth/callback",
      "https://loyalty-api-dev.weletic.com/api/shopify/integration/webhook",
      "https://loyalty-api-dev.weletic.com/api/shopify/integration/webhook",
      "https://loyalty-shopify-dev.weletic.com/apps/proxy",
    ]);
    expect(publicManifest).toContain(
      'compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]',
    );
  });

  it("preserves the custom-app fallback and its original manifest", () => {
    const manifest = readFileSync(
      resolve(process.cwd(), "../../packages/shopify-app/shopify.app.toml"),
      "utf8",
    );
    const accessScopes = manifest.match(
      /^\[access_scopes\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m,
    )?.[1];
    expect(accessScopes).toBeDefined();
    const declared = accessScopes?.match(/^scopes\s*=\s*"([^"]+)"/m)?.[1];
    expect(declared).toBeDefined();
    const runtime = getShopifyRequestedScopes(undefined);
    expect(runtime).toContain("write_app_proxy");
    expect(new Set(runtime).size).toBe(runtime.length);
    expect([...runtime].sort()).toEqual(declared!.split(",").sort());
  });

  it.each(["read_orders", "read_orders,read_products", ""])(
    "preserves an explicit override without adding permissions: %j",
    (configured) => {
      expect(getShopifyRequestedScopes(configured)).toEqual(
        configured.split(","),
      );
    },
  );

  it("returns an independent default array for each SDK configuration", () => {
    const scopes = getShopifyRequestedScopes(undefined);
    scopes.push("read_all_orders");
    expect(getShopifyRequestedScopes(undefined)).not.toContain(
      "read_all_orders",
    );
  });

  it("wires the offline app configuration to the resolver without changing online scopes", () => {
    const server = readFileSync(
      resolve(
        process.cwd(),
        "../../packages/shopify-app/app/shopify.server.ts",
      ),
      "utf8",
    );
    expect(server).toContain(
      "scopes: getShopifyRequestedScopes(process.env.SCOPES)",
    );
    expect(server).toContain("scopes: []");
  });
});
