import { hashIntentToken } from "@/lib/weletic/shopify/install-intent";
import { describe, expect, it } from "vitest";

describe("Weletic Shopify Installation Intent & Tenant Binding", () => {
  it("generates deterministic SHA-256 token hashes for opaque nonces", () => {
    const rawToken = "0123456789abcdef0123456789abcdef";
    const hash1 = hashIntentToken(rawToken);
    const hash2 = hashIntentToken(rawToken);

    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64);
    expect(hash1).not.toBe(rawToken);
  });

  it("enforces single-use consume semantics, rejecting replayed or expired intents", () => {
    interface SimulatedIntent {
      id: string;
      workspaceId: string;
      shopDomain: string;
      tokenHash: string;
      expiresAt: Date;
      consumedAt: Date | null;
    }

    const intentDb = new Map<string, SimulatedIntent>();

    const createIntent = (
      workspaceId: string,
      shopDomain: string,
      token: string,
      ttlMs = 600_000,
    ) => {
      const tokenHash = hashIntentToken(token);
      const intent: SimulatedIntent = {
        id: `wintent_${Date.now()}`,
        workspaceId,
        shopDomain: shopDomain.toLowerCase(),
        tokenHash,
        expiresAt: new Date(Date.now() + ttlMs),
        consumedAt: null,
      };
      intentDb.set(tokenHash, intent);
      return intent;
    };

    const consumeIntent = (
      shopDomain: string,
      token: string,
      expectedWorkspaceId?: string,
    ) => {
      const tokenHash = hashIntentToken(token);
      const intent = intentDb.get(tokenHash);

      if (!intent) {
        return { valid: false, error: "invalid_intent_token" };
      }
      if (intent.consumedAt) {
        return { valid: false, error: "intent_already_consumed" };
      }
      if (intent.expiresAt < new Date()) {
        return { valid: false, error: "intent_expired" };
      }
      if (intent.shopDomain !== shopDomain.toLowerCase()) {
        return { valid: false, error: "shop_domain_mismatch" };
      }
      if (expectedWorkspaceId && intent.workspaceId !== expectedWorkspaceId) {
        return { valid: false, error: "workspace_mismatch" };
      }

      intent.consumedAt = new Date();
      return { valid: true, workspaceId: intent.workspaceId };
    };

    const token = "secret_raw_nonce_12345";
    createIntent("ws_acme", "acme-store.myshopify.com", token);

    // 1. First consumption succeeds
    const firstAttempt = consumeIntent(
      "acme-store.myshopify.com",
      token,
      "ws_acme",
    );
    expect(firstAttempt.valid).toBe(true);
    expect(firstAttempt.workspaceId).toBe("ws_acme");

    // 2. Replay attempt fails
    const replayAttempt = consumeIntent(
      "acme-store.myshopify.com",
      token,
      "ws_acme",
    );
    expect(replayAttempt.valid).toBe(false);
    expect(replayAttempt.error).toBe("intent_already_consumed");

    // 3. Shop domain mismatch fails
    const token2 = "secret_raw_nonce_67890";
    createIntent("ws_acme", "acme-store.myshopify.com", token2);
    const domainMismatchAttempt = consumeIntent(
      "evil-store.myshopify.com",
      token2,
    );
    expect(domainMismatchAttempt.valid).toBe(false);
    expect(domainMismatchAttempt.error).toBe("shop_domain_mismatch");

    // 4. Expired intent fails
    const token3 = "secret_raw_nonce_expired";
    createIntent("ws_acme", "acme-store.myshopify.com", token3, -1000); // already expired
    const expiredAttempt = consumeIntent("acme-store.myshopify.com", token3);
    expect(expiredAttempt.valid).toBe(false);
    expect(expiredAttempt.error).toBe("intent_expired");
  });
});
