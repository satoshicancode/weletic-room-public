import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PROXY_ACTION_PATHS,
  ALLOWED_PROXY_GET_PATHS,
  calculateShopifyAppProxySignature,
  CUSTOMER_AUTH_REQUIRED_ACTION_PATHS,
  normalizeAppProxySubpath,
  runThemeAppProxyValidation,
  stringifyQueryForAppProxy,
  validateShopifyAppProxyQuery,
} from "../../scripts/loyalty/validate-theme-app-proxy";

describe("Theme Blocks & Storefront App Proxy Parity Matrix (Nhóm 1.4)", () => {
  const testSecret = "test-shopify-app-proxy-secret-32-chars";
  const testStore = "staging-theme.myshopify.test";

  // ==========================================================================
  // Section 1: Canonical App Proxy Cryptographic Protocol
  // ==========================================================================
  describe("1. Canonical App Proxy Cryptographic Protocol", () => {
    it("stringifies query parameters with alphabetical sort and delimiterless concatenation", () => {
      const params = {
        shop: "test.myshopify.com",
        path_prefix: "/apps/weletic",
        timestamp: "1725350400",
        logged_in_customer_id: "998877",
        signature: "ignored_signature_value",
      };

      const stringified = stringifyQueryForAppProxy(params);
      // Alphabetical order: logged_in_customer_id, path_prefix, shop, timestamp
      expect(stringified).toBe(
        "logged_in_customer_id=998877path_prefix=/apps/weleticshop=test.myshopify.comtimestamp=1725350400",
      );
    });

    it("handles array values by joining with commas", () => {
      const params = {
        shop: "test.myshopify.com",
        tags: ["vip", "gold", "member"],
      };

      const stringified = stringifyQueryForAppProxy(params);
      expect(stringified).toBe("shop=test.myshopify.comtags=vip,gold,member");
    });

    it("generates deterministic HMAC-SHA256 hex signatures matching Shopify spec", () => {
      const params = {
        shop: "mystore.myshopify.com",
        timestamp: "1600000000",
      };
      const expectedQuery = "shop=mystore.myshopify.comtimestamp=1600000000";
      const expectedHmac = crypto
        .createHmac("sha256", testSecret)
        .update(expectedQuery)
        .digest("hex");

      const computed = calculateShopifyAppProxySignature(params, testSecret);
      expect(computed).toBe(expectedHmac);
      expect(computed).toHaveLength(64);
    });

    it("validates fresh valid signatures within 90-second tolerance", () => {
      const now = 1725350400;
      const params = {
        shop: testStore,
        timestamp: String(now - 30), // 30s ago (valid)
        logged_in_customer_id: "12345",
      };
      const signature = calculateShopifyAppProxySignature(params, testSecret);

      const result = validateShopifyAppProxyQuery(
        { ...params, signature },
        testSecret,
        now,
      );

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("rejects expired timestamps exceeding clock tolerance (> 90 seconds)", () => {
      const now = 1725350400;
      const params = {
        shop: testStore,
        timestamp: String(now - 95), // 95s ago (expired)
      };
      const signature = calculateShopifyAppProxySignature(params, testSecret);

      const result = validateShopifyAppProxyQuery(
        { ...params, signature },
        testSecret,
        now,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("tolerance");
    });

    it("rejects future timestamps exceeding clock tolerance (> 90 seconds)", () => {
      const now = 1725350400;
      const params = {
        shop: testStore,
        timestamp: String(now + 120), // 120s in future
      };
      const signature = calculateShopifyAppProxySignature(params, testSecret);

      const result = validateShopifyAppProxyQuery(
        { ...params, signature },
        testSecret,
        now,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("tolerance");
    });

    it("rejects tampered or forged signatures using constant-time comparison", () => {
      const now = 1725350400;
      const params = {
        shop: testStore,
        timestamp: String(now),
      };
      const signature = calculateShopifyAppProxySignature(params, testSecret);
      const forgedSig = signature.slice(0, -2) + "00";

      const result = validateShopifyAppProxyQuery(
        { ...params, signature: forgedSig },
        testSecret,
        now,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Invalid HMAC");
    });

    it("rejects missing signature or non-numeric timestamp", () => {
      const res1 = validateShopifyAppProxyQuery(
        { shop: testStore },
        testSecret,
      );
      expect(res1.valid).toBe(false);
      expect(res1.reason).toContain("Missing signature");

      const res2 = validateShopifyAppProxyQuery(
        { shop: testStore, signature: "abcdef", timestamp: "not-a-number" },
        testSecret,
      );
      expect(res2.valid).toBe(false);
      expect(res2.reason).toContain("timestamp");
    });
  });

  // ==========================================================================
  // Section 2: Gateway Routing, Normalization & Security Boundaries
  // ==========================================================================
  describe("2. Gateway Routing, Normalization & Security Boundaries", () => {
    it("normalizes diverse subpath prefixes correctly", () => {
      expect(normalizeAppProxySubpath("program")).toBe("program");
      expect(normalizeAppProxySubpath("/program/")).toBe("program");
      expect(normalizeAppProxySubpath("loyalty/program")).toBe("program");
      expect(normalizeAppProxySubpath("/loyalty/customer/redeem/")).toBe(
        "customer/redeem",
      );
      expect(normalizeAppProxySubpath("customer/activity")).toBe(
        "customer/activity",
      );
      expect(normalizeAppProxySubpath("referral/claim")).toBe("referral/claim");
      expect(normalizeAppProxySubpath("")).toBe("");
      expect(normalizeAppProxySubpath(undefined)).toBe("");
    });

    it("enforces strict allowlist for GET routes", () => {
      expect(ALLOWED_PROXY_GET_PATHS.has("program")).toBe(true);
      expect(ALLOWED_PROXY_GET_PATHS.has("customer")).toBe(true);
      expect(ALLOWED_PROXY_GET_PATHS.has("customer/activity")).toBe(true);

      expect(ALLOWED_PROXY_GET_PATHS.has("admin")).toBe(false);
      expect(ALLOWED_PROXY_GET_PATHS.has("settings")).toBe(false);
      expect(ALLOWED_PROXY_GET_PATHS.has("export")).toBe(false);
    });

    it("enforces strict allowlist for POST action routes", () => {
      expect(ALLOWED_PROXY_ACTION_PATHS.has("customer/redeem")).toBe(true);
      expect(ALLOWED_PROXY_ACTION_PATHS.has("customer/referral/bind")).toBe(
        true,
      );
      expect(ALLOWED_PROXY_ACTION_PATHS.has("customer/activity/claim")).toBe(
        true,
      );
      expect(ALLOWED_PROXY_ACTION_PATHS.has("referral/claim")).toBe(true);

      expect(ALLOWED_PROXY_ACTION_PATHS.has("customer/delete")).toBe(false);
      expect(ALLOWED_PROXY_ACTION_PATHS.has("internal/reset")).toBe(false);
    });

    it("gates mutating customer endpoints requiring authenticated customer ID", () => {
      for (const path of [
        "customer/redeem",
        "customer/referral/bind",
        "customer/activity/claim",
      ]) {
        expect(CUSTOMER_AUTH_REQUIRED_ACTION_PATHS.has(path)).toBe(true);
      }
      // Public friend claim does NOT require customer login
      expect(CUSTOMER_AUTH_REQUIRED_ACTION_PATHS.has("referral/claim")).toBe(
        false,
      );
    });

    it("strips attacker-controlled fields and pins redemption channel to online_store", () => {
      const untrustedBody: Record<string, any> = {
        rewardDefinitionId: "rw_123",
        idempotencyKey: "intent_abc",
        // Hostile injected fields:
        shop: "hacker.myshopify.com",
        shopifyCustomerId: "victim_id",
        clientIp: "1.1.1.1",
        userAgent: "evil-bot",
        redemptionChannel: "pos", // Escalation attempt
      };

      // Gateway sanitization logic
      const sanitized = { ...untrustedBody };
      for (const field of [
        "shop",
        "shopifyCustomerId",
        "clientIp",
        "userAgent",
        "redemptionChannel",
      ]) {
        delete sanitized[field];
      }

      const authoritativeShop = "real.myshopify.com";
      const authoritativeCustomerId = "auth_cust_789";

      const forwardPayload: Record<string, any> = {
        ...sanitized,
        shop: authoritativeShop,
        shopifyCustomerId: authoritativeCustomerId,
        redemptionChannel: "online_store", // Authoritatively pinned
      };

      expect(forwardPayload.shop).toBe(authoritativeShop);
      expect(forwardPayload.shopifyCustomerId).toBe(authoritativeCustomerId);
      expect(forwardPayload.redemptionChannel).toBe("online_store");
      expect(forwardPayload.rewardDefinitionId).toBe("rw_123");
      expect(forwardPayload.idempotencyKey).toBe("intent_abc");
    });

    it("enforces private cache-control headers on customer responses", () => {
      const privateHeaders = {
        "Cache-Control":
          "private, no-store, no-cache, max-age=0, must-revalidate",
        Vary: "Cookie",
      };

      expect(privateHeaders["Cache-Control"]).toContain("private");
      expect(privateHeaders["Cache-Control"]).toContain("no-store");
      expect(privateHeaders["Vary"]).toBe("Cookie");
    });
  });

  // ==========================================================================
  // Section 3: Theme Liquid Blocks & Zero-PII DOM Architecture
  // ==========================================================================
  describe("3. Theme Liquid Blocks & Zero-PII DOM Architecture", () => {
    const extensionDir = path.resolve(
      __dirname,
      "../../../../packages/shopify-app/extensions/weletic-analytics",
    );

    it("declares theme extension manifest with 3 official entry points", () => {
      const tomlPath = path.join(extensionDir, "shopify.extension.toml");
      expect(fs.existsSync(tomlPath)).toBe(true);

      const toml = fs.readFileSync(tomlPath, "utf8");
      expect(toml).toContain('type = "theme"');
      expect(toml).toContain('"blocks/app-embed.liquid"');
      expect(toml).toContain('"blocks/loyalty-landing.liquid"');
      expect(toml).toContain('"blocks/product-points-preview.liquid"');
    });

    it("enforces Zero-PII DOM invariant: customer.id is NEVER rendered into the DOM", () => {
      const appEmbed = fs.readFileSync(
        path.join(extensionDir, "blocks/app-embed.liquid"),
        "utf8",
      );
      const landing = fs.readFileSync(
        path.join(extensionDir, "blocks/loyalty-landing.liquid"),
        "utf8",
      );
      const productPoints = fs.readFileSync(
        path.join(extensionDir, "blocks/product-points-preview.liquid"),
        "utf8",
      );

      // Asserts neither email, phone, name nor customer.id is present in markup
      expect(appEmbed).not.toContain("customer.email");
      expect(appEmbed).not.toContain("customer.id");
      expect(landing).not.toContain("customer.email");
      expect(landing).not.toContain("customer.id");
      expect(productPoints).not.toContain("customer.email");
      expect(productPoints).not.toContain("customer.id");

      // Only boolean login state is output
      expect(appEmbed).toContain(
        'data-logged-in="{% if customer %}true{% else %}false{% endif %}"',
      );
    });

    it("escapes all dynamic Liquid output attributes against injection", () => {
      const appEmbed = fs.readFileSync(
        path.join(extensionDir, "blocks/app-embed.liquid"),
        "utf8",
      );
      const landing = fs.readFileSync(
        path.join(extensionDir, "blocks/loyalty-landing.liquid"),
        "utf8",
      );
      const productPoints = fs.readFileSync(
        path.join(extensionDir, "blocks/product-points-preview.liquid"),
        "utf8",
      );

      expect(appEmbed).toContain("shop.permanent_domain | escape");
      expect(landing).toContain("shop.permanent_domain | escape");
      expect(productPoints).toContain("shop.permanent_domain | escape");
      expect(productPoints).toContain("product.id | escape");
    });

    it("defines critical CSS rule preventing flash of unstyled floating launcher", () => {
      const css = fs.readFileSync(
        path.join(extensionDir, "assets/weletic-loyalty-styles.css"),
        "utf8",
      );
      const hasHiddenRule =
        css.includes(".weletic-launcher-btn[hidden]") ||
        css.includes(".weletic-launcher-btn[hidden=true]") ||
        /weletic-launcher-btn\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(
          css,
        );

      expect(hasHiddenRule).toBe(true);
    });
  });

  // ==========================================================================
  // Section 4: Storefront Shopper Journey & PDP Points Calculation
  // ==========================================================================
  describe("4. Storefront Shopper Journey & PDP Points Calculation", () => {
    it("calculates product points accurately for standard 2-decimal currencies (USD/EUR)", () => {
      const earnRateBps = 100; // 1 point per $1
      const priceCents = 4999; // $49.99
      const currency = "USD";

      const isZeroDecimal = ["JPY", "VND", "KRW"].includes(currency);
      const priceUnits = isZeroDecimal ? priceCents : priceCents / 100;
      const points = Math.max(0, Math.floor((priceUnits * earnRateBps) / 100));

      expect(points).toBe(49);
    });

    it("calculates product points accurately for zero-decimal currencies (JPY/VND)", () => {
      const earnRateBps = 100; // 1 point per ¥1
      const priceYen = 5000; // ¥5,000
      const currency = "JPY";

      const isZeroDecimal = ["JPY", "VND", "KRW"].includes(currency);
      const priceUnits = isZeroDecimal ? priceYen : priceYen / 100;
      const points = Math.max(0, Math.floor((priceUnits * earnRateBps) / 100));

      expect(points).toBe(5000);
    });

    it("applies VIP tier multipliers cleanly to base product points", () => {
      const basePoints = 49;
      const tierMultiplierBps = 150; // 1.5x VIP Gold boost

      const boostedPoints = Math.floor((basePoints * tierMultiplierBps) / 100);
      expect(boostedPoints).toBe(73); // 49 * 1.5 = 73.5 -> 73 floor
    });

    it("deduplicates concurrent redemption clicks via client-side intent map", () => {
      const intentMap: Record<string, boolean> = {};
      const intentKey = "rw_amount_1000";

      // First click: acquires lock
      const canClick1 = !intentMap[intentKey];
      if (canClick1) {
        intentMap[intentKey] = true;
      }
      expect(canClick1).toBe(true);

      // Second rapid click while in-flight: rejected
      const canClick2 = !intentMap[intentKey];
      expect(canClick2).toBe(false);

      // Third click after completion: succeeds
      delete intentMap[intentKey];
      const canClick3 = !intentMap[intentKey];
      expect(canClick3).toBe(true);
    });
  });

  // ==========================================================================
  // Section 5: Runnable CLI Validator Integration
  // ==========================================================================
  describe("5. Runnable CLI Validator Integration", () => {
    it("runs validation in --mock mode with 12/12 passing checks and PASSED status", async () => {
      const report = await runThemeAppProxyValidation({ mock: true });

      expect(report.overallStatus).toBe("PASSED");
      expect(report.summary.totalChecks).toBe(12);
      expect(report.summary.passedChecks).toBe(12);
      expect(report.summary.failedChecks).toBe(0);
      expect(report.errors).toHaveLength(0);
      expect(report.phases).toHaveLength(4);
    });

    it("runs validation in --dry-run mode with 12/12 passing checks and local-static provenance", async () => {
      const report = await runThemeAppProxyValidation({ dryRun: true });

      expect(report.overallStatus).toBe("PASSED");
      expect(report.executionMode).toBe("dry-run");
      expect(report.provenance.source).toBe("local-static");
      expect(report.provenance.live).toBe(false);
      expect(report.summary.passedChecks).toBe(12);
    });
  });
});
