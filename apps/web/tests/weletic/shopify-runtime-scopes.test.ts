import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getShopifyRequestedScopes } from "../../../../packages/shopify-app/app/shopify-scopes";
import { DEVELOPMENT_SHOPIFY_SCOPES } from "../../lib/weletic/shopify/development-preflight";

describe("Shopify runtime requested scopes", () => {
  it("matches the checked-in manifest and isolated development preflight", () => {
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
    expect([...runtime].sort()).toEqual([...DEVELOPMENT_SHOPIFY_SCOPES].sort());
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
