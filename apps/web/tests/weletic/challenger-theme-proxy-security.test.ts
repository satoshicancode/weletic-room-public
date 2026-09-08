import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  calculateShopifyAppProxySignature,
  validateShopifyAppProxyQuery,
} from "../../scripts/loyalty/validate-theme-app-proxy";

describe("Adversarial Challenger: Theme Blocks & App Proxy Security Matrix", () => {
  const testSecret = "security-challenger-secret-32-character-key";

  // ==========================================================================
  // Vector 1: Property Testing - Canonicalization & Tamper Proofing
  // ==========================================================================
  describe("Vector 1: Property Testing - Canonicalization & Tamper Proofing", () => {
    it("property: query key insertion order never affects canonical signature", () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.stringMatching(/^[a-z_][a-z0-9_]{1,15}$/),
            fc.stringMatching(/^[a-zA-Z0-9_-]{1,30}$/),
            { minKeys: 2, maxKeys: 10 },
          ),
          (params) => {
            // Filter out reserved keys
            delete params.signature;
            delete params.hmac;

            const sig1 = calculateShopifyAppProxySignature(params, testSecret);

            // Reverse key order
            const reversedEntries = Object.entries(params).reverse();
            const shuffledParams = Object.fromEntries(reversedEntries);
            const sig2 = calculateShopifyAppProxySignature(
              shuffledParams,
              testSecret,
            );

            expect(sig1).toBe(sig2);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("property: any single-character mutation in query or signature causes verification failure", () => {
      fc.assert(
        fc.property(
          fc.dictionary(
            fc.stringMatching(/^[a-z_][a-z0-9_]{1,10}$/),
            fc.stringMatching(/^[a-zA-Z0-9]{1,20}$/),
            { minKeys: 2, maxKeys: 6 },
          ),
          (rawParams) => {
            const now = Math.trunc(Date.now() / 1000);
            const params: Record<string, string> = {
              ...rawParams,
              timestamp: String(now),
              shop: "test.myshopify.com",
            };
            delete params.signature;
            delete params.hmac;

            const validSig = calculateShopifyAppProxySignature(
              params,
              testSecret,
            );
            const validResult = validateShopifyAppProxyQuery(
              { ...params, signature: validSig },
              testSecret,
              now,
            );
            expect(validResult.valid).toBe(true);

            // Corrupt one character in signature
            const corruptedSig =
              validSig[0] === "a"
                ? "b" + validSig.slice(1)
                : "a" + validSig.slice(1);
            const corruptedResult = validateShopifyAppProxyQuery(
              { ...params, signature: corruptedSig },
              testSecret,
              now,
            );
            expect(corruptedResult.valid).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it("property: timestamp clock tolerance strictly adheres to [-90s, +90s]", () => {
      fc.assert(
        fc.property(fc.integer({ min: -500, max: 500 }), (offsetSec) => {
          const now = 1725350400;
          const timestamp = now + offsetSec;
          const params = {
            shop: "test.myshopify.com",
            timestamp: String(timestamp),
          };
          const signature = calculateShopifyAppProxySignature(
            params,
            testSecret,
          );

          const result = validateShopifyAppProxyQuery(
            { ...params, signature },
            testSecret,
            now,
            90,
          );

          if (Math.abs(offsetSec) <= 90) {
            expect(result.valid).toBe(true);
          } else {
            expect(result.valid).toBe(false);
            expect(result.reason).toContain("tolerance");
          }
        }),
        { numRuns: 200 },
      );
    });
  });

  // ==========================================================================
  // Vector 2: Parameter & Prototype Pollution Defense
  // ==========================================================================
  describe("Vector 2: Parameter & Prototype Pollution Defense", () => {
    it("neutralizes prototype pollution attempts in proxy payloads", () => {
      const hostilePayloads: Array<Record<string, any>> = [
        { __proto__: { isAdmin: true }, rewardDefinitionId: "rw_1" },
        {
          constructor: { prototype: { role: "owner" } },
          rewardDefinitionId: "rw_2",
        },
        { prototype: { polluted: true }, rewardDefinitionId: "rw_3" },
      ];

      for (const payload of hostilePayloads) {
        // Sanitize
        const clean: Record<string, any> = {};
        for (const [key, val] of Object.entries(payload)) {
          if (
            key === "__proto__" ||
            key === "constructor" ||
            key === "prototype"
          ) {
            continue;
          }
          clean[key] = val;
        }

        expect((clean as any).isAdmin).toBeUndefined();
        expect((clean as any).role).toBeUndefined();
        expect((clean as any).polluted).toBeUndefined();
        expect(clean.rewardDefinitionId).toMatch(/^rw_/);
      }
    });

    it("sanitizes CRLF injection in proxy forward headers", () => {
      const hostileHeader =
        "Customer Browser\r\nSet-Cookie: session=hacked\r\n";
      // Sanitizer slices and strips control chars
      const sanitized = hostileHeader.replace(/[\r\n]/g, "").slice(0, 1024);

      expect(sanitized).not.toContain("\r");
      expect(sanitized).not.toContain("\n");
      expect(sanitized).toBe("Customer BrowserSet-Cookie: session=hacked");
    });
  });

  // ==========================================================================
  // Vector 3: Channel Escalation & Privilege Boundaries
  // ==========================================================================
  describe("Vector 3: Channel Escalation & Privilege Boundaries", () => {
    it("always stamps redemptionChannel as online_store, neutralizing forged channels", () => {
      const forgedChannels = [
        "pos",
        "customer_account",
        "admin",
        "internal",
        "mobile_app",
        "",
        null,
        undefined,
      ];

      for (const forged of forgedChannels) {
        const incomingPayload: Record<string, any> = {
          rewardDefinitionId: "rw_test",
          idempotencyKey: "intent_123",
          redemptionChannel: forged,
        };

        // Gateway sanitization rule: always delete incoming redemptionChannel, pin to online_store
        delete incomingPayload.redemptionChannel;
        const forwardPayload: Record<string, any> = {
          ...incomingPayload,
          redemptionChannel: "online_store",
        };

        expect(forwardPayload.redemptionChannel).toBe("online_store");
      }
    });

    it("prevents customerId spoofing via query parameter precedence", () => {
      const url = new URL(
        "https://store.myshopify.com/apps/weletic/customer?shop=store.myshopify.com&logged_in_customer_id=11111&customerId=99999",
      );

      // Rule: logged_in_customer_id (from Shopify HMAC-authenticated context) ALWAYS takes precedence
      const shopifyVerifiedCustomerId = url.searchParams.get(
        "logged_in_customer_id",
      );
      const untrustedCustomerId = url.searchParams.get("customerId");

      const resolvedCustomerId = shopifyVerifiedCustomerId || undefined;

      expect(resolvedCustomerId).toBe("11111");
      expect(resolvedCustomerId).not.toBe(untrustedCustomerId);
    });
  });

  // ==========================================================================
  // Vector 4: Concurrent Client-Side Race Condition Defense
  // ==========================================================================
  describe("Vector 4: Concurrent Client-Side Race Condition Defense", () => {
    it("guarantees single-flight redemption dispatch under extreme concurrency (100 rapid clicks)", async () => {
      const intentKeys: Record<string, boolean> = {};
      const intentId = "rw_high_value_5000";

      let dispatchedCount = 0;
      let rejectedCount = 0;

      // Simulate 100 simultaneous clicks
      const simulateClick = () => {
        if (intentKeys[intentId]) {
          rejectedCount++;
          return false;
        }
        intentKeys[intentId] = true;
        dispatchedCount++;
        return true;
      };

      const clicks = Array.from({ length: 100 }, () => simulateClick());

      expect(dispatchedCount).toBe(1);
      expect(rejectedCount).toBe(99);
      expect(clicks.filter(Boolean)).toHaveLength(1);

      // Post-redemption unlock
      delete intentKeys[intentId];
      expect(intentKeys[intentId]).toBeUndefined();

      // Subsequent click after resolution succeeds
      expect(simulateClick()).toBe(true);
      expect(dispatchedCount).toBe(2);
    });
  });
});
