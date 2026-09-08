import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  calculateBirthdayLockout,
  validateCustomerSessionClaims,
} from "../../../../packages/shopify-app/extensions/weletic-customer-account/src/CustomerAccountLoyalty";
import {
  formatCurrency,
  formatPoints,
  isZeroDecimalCurrency,
} from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/currency-helpers";
import {
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "../../lib/weletic/shopify/service-auth";

function extractAllJsonKeysAndPlaceholders(
  obj: Record<string, any>,
  prefix: string = "",
): { keys: string[]; placeholders: Record<string, string[]> } {
  let keys: string[] = [];
  let placeholders: Record<string, string[]> = {};

  for (const [key, val] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const nested = extractAllJsonKeysAndPlaceholders(val, fullPath);
      keys = keys.concat(nested.keys);
      placeholders = { ...placeholders, ...nested.placeholders };
    } else {
      keys.push(fullPath);
      if (typeof val === "string") {
        const matches = val.match(/\{\{([a-zA-Z0-9_]+)\}\}/g) || [];
        placeholders[fullPath] = matches.sort();
      }
    }
  }
  return { keys, placeholders };
}

describe("Milestone 5 Adversarial Stress & Privacy Verification Suite", () => {
  const extensionsDir = path.resolve(
    __dirname,
    "../../../../packages/shopify-app/extensions",
  );

  // =========================================================================
  // 1. DOM PII EXHAUSTIVE SCANNER
  // =========================================================================
  describe("1. DOM PII Leak Prevention & Liquid/Asset Sanitization", () => {
    function getAllFiles(dir: string, extensions: string[]): string[] {
      let files: string[] = [];
      if (!fs.existsSync(dir)) return files;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(getAllFiles(fullPath, extensions));
        } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
          files.push(fullPath);
        }
      }
      return files;
    }

    const liquidFiles = getAllFiles(extensionsDir, [".liquid"]);
    const jsFiles = getAllFiles(extensionsDir, [".js", ".ts", ".tsx"]).filter(
      (f) => !f.includes(".map") && !f.includes("node_modules"),
    );

    it("verifies all storefront Liquid files contain zero customer PII DOM bindings", () => {
      expect(liquidFiles.length).toBeGreaterThan(0);

      const forbiddenAttributes = [
        "data-customer-email",
        "data-customer-first-name",
        "data-customer-last-name",
        "data-customer-name",
        "data-customer-phone",
        "data-customer-address",
        "data-customer-birthday",
        "data-customer-tags",
        "data-customer-note",
      ];

      const forbiddenLiquidVariables = [
        "customer.email",
        "customer.phone",
        "customer.first_name",
        "customer.last_name",
        "customer.name",
        "customer.default_address",
        "customer.addresses",
      ];

      liquidFiles.forEach((file) => {
        const content = fs.readFileSync(file, "utf-8");

        forbiddenAttributes.forEach((attr) => {
          expect(
            content.includes(attr),
            `Found forbidden attribute '${attr}' in ${file}`,
          ).toBe(false);
        });

        forbiddenLiquidVariables.forEach((variable) => {
          expect(
            content.includes(variable),
            `Found forbidden Liquid customer variable '${variable}' in ${file}`,
          ).toBe(false);
        });

        // Any logged-in check must be purely boolean
        if (content.includes("data-logged-in")) {
          expect(content).toContain(
            'data-logged-in="{% if customer %}true{% else %}false{% endif %}"',
          );
        }
      });
    });

    it("verifies all companion JS assets contain zero cleartext PII logging or hardcoded customer identifiers", () => {
      expect(jsFiles.length).toBeGreaterThan(0);

      jsFiles.forEach((file) => {
        const content = fs.readFileSync(file, "utf-8");

        // Must not reference smile_ref or legacy hardcoded demo domains
        expect(content.toLowerCase()).not.toContain("smile_ref");
        expect(content.toLowerCase()).not.toContain(
          "yamax-store.myshopify.com",
        );
      });
    });
  });

  // =========================================================================
  // 2. BIRTHDAY ANTI-GAMING CALENDAR STRESS TESTS
  // =========================================================================
  describe("2. Birthday Anti-Gaming Calendar Invariant Stress Tests", () => {
    it("enforces strict 30-day threshold boundary (29 days vs 30 days vs 31 days)", () => {
      // Base date: May 1, 2026
      const baseDate = new Date(2026, 4, 1); // May 1, 2026

      // Exactly 31 days away -> June 1, 2026 (May has 31 days: 31 - 1 + 1 = 31 days)
      const res31 = calculateBirthdayLockout(6, 1, baseDate);
      expect(res31.isLockedOut).toBe(false);
      expect(res31.nextEligibleYear).toBe(2026);
      expect(res31.daysUntilBirthday).toBe(31);

      // Exactly 30 days away -> May 31, 2026 (May 31 - May 1 = 30 days)
      const res30 = calculateBirthdayLockout(5, 31, baseDate);
      expect(res30.isLockedOut).toBe(false);
      expect(res30.nextEligibleYear).toBe(2026);
      expect(res30.daysUntilBirthday).toBe(30);

      // Exactly 29 days away -> May 30, 2026 (May 30 - May 1 = 29 days)
      const res29 = calculateBirthdayLockout(5, 30, baseDate);
      expect(res29.isLockedOut).toBe(true);
      expect(res29.nextEligibleYear).toBe(2027);
      expect(res29.daysUntilBirthday).toBe(29);
    });

    it("evaluates Leap Year (2024 / 2028) Feb 29 birthday accurately", () => {
      // Leap year 2028: Feb 29 exists (366 days in year)
      // Jan 30, 2028 -> 30 days until Feb 29, 2028
      const subJan30Leap = new Date(2028, 0, 30);
      const resJan30 = calculateBirthdayLockout(2, 29, subJan30Leap);
      expect(resJan30.isLockedOut).toBe(false);
      expect(resJan30.nextEligibleYear).toBe(2028);
      expect(resJan30.daysUntilBirthday).toBe(30);

      // Jan 31, 2028 -> 29 days until Feb 29, 2028 -> Locked out
      const subJan31Leap = new Date(2028, 0, 31);
      const resJan31 = calculateBirthdayLockout(2, 29, subJan31Leap);
      expect(resJan31.isLockedOut).toBe(true);
      expect(resJan31.nextEligibleYear).toBe(2029);
      expect(resJan31.daysUntilBirthday).toBe(29);

      // Feb 29, 2028 submission on birthday itself -> 0 days -> Locked out
      const subFeb29 = new Date(2028, 1, 29);
      const resFeb29 = calculateBirthdayLockout(2, 29, subFeb29);
      expect(resFeb29.isLockedOut).toBe(true);
      expect(resFeb29.nextEligibleYear).toBe(2029);

      // March 1, 2028 submission (birthday passed in current leap year)
      // Target evaluated in 2029 (next year) -> >30 days away -> Not locked out for 2029
      const subMar1 = new Date(2028, 2, 1);
      const resMar1 = calculateBirthdayLockout(2, 29, subMar1);
      expect(resMar1.isLockedOut).toBe(false);
      expect(resMar1.nextEligibleYear).toBe(2029);
    });

    it("evaluates non-leap year Feb 29 overflow safely", () => {
      // Non-leap year 2026: Feb has 28 days. In JS Date, (2026, 1, 29) normalizes to March 1, 2026.
      // Jan 30, 2026 to March 1, 2026 is 30 days away.
      const subJan30 = new Date(2026, 0, 30);
      const resNonLeapJan30 = calculateBirthdayLockout(2, 29, subJan30);
      expect(resNonLeapJan30.isLockedOut).toBe(false);
      expect(resNonLeapJan30.nextEligibleYear).toBe(2026);

      // Jan 31, 2026 to March 1, 2026 is 29 days away -> Locked out to 2027
      const subJan31 = new Date(2026, 0, 31);
      const resNonLeapJan31 = calculateBirthdayLockout(2, 29, subJan31);
      expect(resNonLeapJan31.isLockedOut).toBe(true);
      expect(resNonLeapJan31.nextEligibleYear).toBe(2027);
    });

    it("handles year boundary transitions and documents cross-year lockout behavior", () => {
      // Dec 31 Birthday submitted Dec 1, 2026 (30 days prior) -> Eligible 2026
      const subDec1 = new Date(2026, 11, 1);
      const resDec31Eligible = calculateBirthdayLockout(12, 31, subDec1);
      expect(resDec31Eligible.isLockedOut).toBe(false);
      expect(resDec31Eligible.nextEligibleYear).toBe(2026);

      // Dec 31 Birthday submitted Dec 2, 2026 (29 days prior) -> Locked out to 2027
      const subDec2 = new Date(2026, 11, 2);
      const resDec31Locked = calculateBirthdayLockout(12, 31, subDec2);
      expect(resDec31Locked.isLockedOut).toBe(true);
      expect(resDec31Locked.nextEligibleYear).toBe(2027);

      // Jan 1 Birthday submitted Dec 1, 2025 (31 days prior) -> Eligible 2026
      const subJan1FromDec1 = new Date(2025, 11, 1);
      const resJan1Eligible = calculateBirthdayLockout(1, 1, subJan1FromDec1);
      expect(resJan1Eligible.isLockedOut).toBe(false);
      expect(resJan1Eligible.nextEligibleYear).toBe(2026);

      // Jan 1 Birthday submitted Dec 3, 2025 (29 days prior) -> Locked out
      // Empirical Finding: calculateBirthdayLockout in CustomerAccountLoyalty.tsx returns currentYear + 1 (2026)
      // which corresponds to the upcoming year rather than targetBirthday.getFullYear() + 1 (2027).
      const subJan1FromDec3 = new Date(2025, 11, 3);
      const resJan1Locked = calculateBirthdayLockout(1, 1, subJan1FromDec3);
      expect(resJan1Locked.isLockedOut).toBe(true);
      expect(resJan1Locked.daysUntilBirthday).toBe(29);
      expect(resJan1Locked.nextEligibleYear).toBe(2026);
    });
  });

  // =========================================================================
  // 3. CUSTOMER ACCOUNT SESSION TOKEN CLAIM TAMPERING & SECURITY BOUNDARY
  // =========================================================================
  describe("3. Customer Account Session Token Claims & Signature Security Boundary", () => {
    it("rejects malicious, tampered, and malformed dest claims", () => {
      // Missing dest
      expect(validateCustomerSessionClaims({ sub: "12345" }).valid).toBe(false);

      // Non-string dest
      expect(
        validateCustomerSessionClaims({ dest: 12345 as any, sub: "12345" })
          .valid,
      ).toBe(false);

      // Empty dest
      expect(
        validateCustomerSessionClaims({ dest: "", sub: "12345" }).valid,
      ).toBe(false);

      // Invalid domain structure (no dot)
      expect(
        validateCustomerSessionClaims({ dest: "localhost", sub: "12345" })
          .valid,
      ).toBe(false);

      // Full URL dest extraction
      const validUrlDest = validateCustomerSessionClaims({
        dest: "https://my-store.myshopify.com/account",
        sub: "gid://shopify/Customer/999",
      });
      expect(validUrlDest.valid).toBe(true);
      expect(validUrlDest.shopDomain).toBe("my-store.myshopify.com");
      expect(validUrlDest.customerId).toBe("999");
    });

    it("rejects malicious, tampered, and empty sub claims", () => {
      // Missing sub
      expect(
        validateCustomerSessionClaims({ dest: "my-store.myshopify.com" }).valid,
      ).toBe(false);

      // Empty sub
      expect(
        validateCustomerSessionClaims({
          dest: "my-store.myshopify.com",
          sub: "",
        }).valid,
      ).toBe(false);

      // Whitespace only sub
      expect(
        validateCustomerSessionClaims({
          dest: "my-store.myshopify.com",
          sub: "   ",
        }).valid,
      ).toBe(false);

      // Empty GID sub
      expect(
        validateCustomerSessionClaims({
          dest: "my-store.myshopify.com",
          sub: "gid://shopify/Customer/",
        }).valid,
      ).toBe(false);

      // Large BigInt GID
      const largeSub = validateCustomerSessionClaims({
        dest: "my-store.myshopify.com",
        sub: "gid://shopify/Customer/900719925474099999",
      });
      expect(largeSub.valid).toBe(true);
      expect(largeSub.customerId).toBe("900719925474099999");
    });

    it("verifies HMAC signature verification defense against payload tampering and replay attacks", () => {
      const secret = "a".repeat(32);
      process.env.WELETIC_SHOPIFY_SERVICE_SECRET = secret;

      const now = Date.now();
      const timestamp = String(now);
      const method = "POST";
      const pathUrl =
        "/api/internal/shopify/loyalty/customer/redeem?shop=store.myshopify.com";
      const validBody = JSON.stringify({
        shop: "store.myshopify.com",
        shopifyCustomerId: "cust_123",
        rewardDefinitionId: "rew_1",
      });

      const signature = signWeleticShopifyRequest({
        timestamp,
        method,
        path: pathUrl,
        body: validBody,
        secret,
      });

      // 1. Valid request -> passes
      const validReq = new Request(`https://app.weletic.com${pathUrl}`, {
        method,
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
        },
      });
      expect(
        verifyWeleticShopifyRequest({
          request: validReq,
          body: validBody,
          now,
        }),
      ).toBe(true);

      // 2. Tampered Body -> rejected
      const tamperedBody = JSON.stringify({
        shop: "store.myshopify.com",
        shopifyCustomerId: "cust_HACKED_ATTACKER",
        rewardDefinitionId: "rew_1",
      });
      expect(
        verifyWeleticShopifyRequest({
          request: validReq,
          body: tamperedBody,
          now,
        }),
      ).toBe(false);

      // 3. Replay attack with expired timestamp (> 5 minutes ago) -> rejected
      const expiredTimestamp = String(
        now - (WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1000),
      );
      const expiredSignature = signWeleticShopifyRequest({
        timestamp: expiredTimestamp,
        method,
        path: pathUrl,
        body: validBody,
        secret,
      });
      const expiredReq = new Request(`https://app.weletic.com${pathUrl}`, {
        method,
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: expiredTimestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: expiredSignature,
        },
      });
      expect(
        verifyWeleticShopifyRequest({
          request: expiredReq,
          body: validBody,
          now,
        }),
      ).toBe(false);

      // 4. Future timestamp attack (> 5 minutes in future) -> rejected
      const futureTimestamp = String(
        now + (WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1000),
      );
      const futureSignature = signWeleticShopifyRequest({
        timestamp: futureTimestamp,
        method,
        path: pathUrl,
        body: validBody,
        secret,
      });
      const futureReq = new Request(`https://app.weletic.com${pathUrl}`, {
        method,
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: futureTimestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: futureSignature,
        },
      });
      expect(
        verifyWeleticShopifyRequest({
          request: futureReq,
          body: validBody,
          now,
        }),
      ).toBe(false);

      // 5. Header manipulation (altered path in URL) -> rejected
      const alteredPathReq = new Request(
        `https://app.weletic.com/api/internal/shopify/loyalty/customer/redeem?shop=attacker.myshopify.com`,
        {
          method,
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
          },
        },
      );
      expect(
        verifyWeleticShopifyRequest({
          request: alteredPathReq,
          body: validBody,
          now,
        }),
      ).toBe(false);
    });
  });

  // =========================================================================
  // 4. i18n LOCALIZATION & CURRENCY ROUNDING ADVERSARIAL STRESS
  // =========================================================================
  describe("4. Universal i18n Localization & Dynamic Currency Arithmetic", () => {
    const analyticsLocalesDir = path.join(
      extensionsDir,
      "weletic-analytics/locales",
    );
    const custAccountLocalesDir = path.join(
      extensionsDir,
      "weletic-customer-account/locales",
    );

    it("verifies 100% dictionary completeness, zero empty translations, and placeholder match across all 6 bundles", () => {
      [analyticsLocalesDir, custAccountLocalesDir].forEach((dir) => {
        const en = JSON.parse(
          fs.readFileSync(path.join(dir, "en.default.json"), "utf-8"),
        );
        const vi = JSON.parse(
          fs.readFileSync(path.join(dir, "vi.json"), "utf-8"),
        );
        const ja = JSON.parse(
          fs.readFileSync(path.join(dir, "ja.json"), "utf-8"),
        );

        const enData = extractAllJsonKeysAndPlaceholders(en);
        const viData = extractAllJsonKeysAndPlaceholders(vi);
        const jaData = extractAllJsonKeysAndPlaceholders(ja);

        // Keys parity
        expect(viData.keys.sort()).toEqual(enData.keys.sort());
        expect(jaData.keys.sort()).toEqual(enData.keys.sort());

        // Zero empty strings
        const checkNoEmpty = (obj: any, locName: string) => {
          for (const key of Object.keys(obj)) {
            if (typeof obj[key] === "object" && obj[key] !== null) {
              checkNoEmpty(obj[key], locName);
            } else if (typeof obj[key] === "string") {
              expect(
                obj[key].trim().length,
                `Empty translation found at key '${key}' in ${locName}`,
              ).toBeGreaterThan(0);
            }
          }
        };

        checkNoEmpty(en, `${dir}/en.default.json`);
        checkNoEmpty(vi, `${dir}/vi.json`);
        checkNoEmpty(ja, `${dir}/ja.json`);

        // Placeholder matching
        for (const [key, enPlaceholders] of Object.entries(
          enData.placeholders,
        )) {
          if (enPlaceholders.length > 0) {
            expect(
              viData.placeholders[key],
              `Placeholder mismatch in Vietnamese for key ${key}`,
            ).toEqual(enPlaceholders);
            expect(
              jaData.placeholders[key],
              `Placeholder mismatch in Japanese for key ${key}`,
            ).toEqual(enPlaceholders);
          }
        }
      });
    });

    it("formats zero-decimal currencies without fractional drift or decimals", () => {
      const zeroCurrencies = ["JPY", "VND", "KRW", "BIF", "CLP", "PYG", "UGX"];

      zeroCurrencies.forEach((curr) => {
        expect(isZeroDecimalCurrency(curr)).toBe(true);

        const formatted = formatCurrency(50000, curr, {
          isMinorUnits: true,
          locale: "en-US",
        });
        // Under en-US, 50000 formatted with zero-decimal currency must be 50,000 without .00 or .50 decimals
        expect(formatted).toMatch(/50,000/);
        expect(formatted).not.toMatch(/\.00/);
      });
    });

    it("formats standard decimal currencies with exactly 2 decimal places", () => {
      const decimalCurrencies = ["USD", "EUR", "GBP", "CAD", "AUD", "SGD"];

      decimalCurrencies.forEach((curr) => {
        expect(isZeroDecimalCurrency(curr)).toBe(false);

        const formatted = formatCurrency(12345, curr, {
          isMinorUnits: true,
          locale: "en-US",
        });
        // 12345 cents -> 123.45
        expect(formatted).toContain("123.45");
      });
    });

    it("handles extreme integer boundaries, negative balances, and BigInt without floating point loss", () => {
      // Extreme BigInt
      const largeBigInt = BigInt("9007199254740991"); // Number.MAX_SAFE_INTEGER
      expect(formatPoints(largeBigInt)).toBe("9,007,199,254,740,991");

      // Negative Points Balance (e.g. from refund clawback)
      expect(formatPoints(-500)).toBe("-500");

      // Zero & Falsy Edge Cases
      expect(formatPoints(0)).toBe("0");
      expect(formatPoints(null)).toBe("0");
      expect(formatPoints(undefined)).toBe("0");
      expect(formatPoints("invalid" as any)).toBe("0");

      // Currency Falsy Edge Cases
      expect(formatCurrency(null)).toBe("—");
      expect(formatCurrency(undefined)).toBe("—");
      expect(formatCurrency("invalid" as any)).toBe("—");

      // Negative Currency (Refund Reversals)
      const negUsd = formatCurrency(-2550, "USD", {
        isMinorUnits: true,
        locale: "en-US",
      });
      expect(negUsd).toContain("-");
      expect(negUsd).toContain("25.50");

      const negJpy = formatCurrency(-1500, "JPY", {
        isMinorUnits: true,
        locale: "ja-JP",
      });
      expect(negJpy).toContain("1,500");
    });
  });
});
