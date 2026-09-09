import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReferralPrivacySnapshot,
  readReferralPrivacySnapshot,
} from "../../lib/weletic/loyalty/referral-privacy-snapshot";
import {
  createShopifyDerivedPrivacyDigest,
  deriveAllShopifyCustomerPrivacyIdentities,
} from "../../lib/weletic/shopify/privacy-identity";

const now = new Date("2026-09-09T00:00:00.000Z");
const email = "friend@example.test";
function fixture() {
  const scope = {
    storeId: "store_a",
    referralId: "referral_a",
    friendEmailDigest: createShopifyDerivedPrivacyDigest({
      purpose: "referral_email",
      values: ["store_a", email],
    }),
  };
  return {
    ...scope,
    value: createReferralPrivacySnapshot({ ...scope, email, now }),
    now,
  };
}
afterEach(() => vi.unstubAllEnvs());

describe("referral privacy identity snapshot", () => {
  it("retains only versioned tombstone-compatible HMACs, not raw email", () => {
    const input = fixture();
    expect(JSON.stringify(input.value)).not.toContain(email);
    expect(readReferralPrivacySnapshot(input)).toEqual(
      deriveAllShopifyCustomerPrivacyIdentities({
        storeId: input.storeId,
        email,
      }),
    );
  });
  it("cannot bind a different email or store to an existing referral digest", () => {
    const input = fixture();
    for (const override of [
      { email: "other@example.test" },
      { storeId: "store_b" },
    ]) {
      expect(() =>
        createReferralPrivacySnapshot({ ...input, email, ...override }),
      ).toThrow("identity mismatch");
    }
  });
  it.each(["storeId", "referralId", "friendEmailDigest"] as const)(
    "rejects a mismatched %s",
    (field) => {
      const input = fixture();
      expect(
        readReferralPrivacySnapshot({ ...input, [field]: "different" }),
      ).toBeNull();
    },
  );
  it("rejects legacy, erased and malformed snapshots", () => {
    const input = fixture();
    for (const value of [
      undefined,
      null,
      {},
      { ...input.value, version: 2 },
      { ...input.value, email },
    ]) {
      expect(readReferralPrivacySnapshot({ ...input, value })).toBeNull();
    }
    expect(
      readReferralPrivacySnapshot({ ...input, friendEmailDigest: null }),
    ).toBeNull();
  });
  it("limits retention to the shorter configured privacy/financial period", () => {
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "30");
    vi.stubEnv("WELETIC_SHOPIFY_CUSTOMER_TOMBSTONE_RETENTION_DAYS", "10");
    const input = fixture();
    expect(input.value.retainUntil).toBe("2026-09-19T00:00:00.000Z");
    expect(
      readReferralPrivacySnapshot({
        ...input,
        now: new Date(input.value.retainUntil),
      }),
    ).toBeNull();
    expect(
      readReferralPrivacySnapshot({
        ...input,
        now: new Date(now.getTime() - 1),
      }),
    ).toBeNull();
  });
  it("captures rotation keys and fails closed when a referenced key is retired", () => {
    const oldKey = `old:${Buffer.alloc(32, 1).toString("base64")}`;
    const newKey = `new:${Buffer.alloc(32, 2).toString("base64")}`;
    vi.stubEnv("WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS", `${newKey},${oldKey}`);
    const input = fixture();
    expect(
      readReferralPrivacySnapshot(input)?.map(
        (identity) => identity.identityKeyId,
      ),
    ).toEqual(["new", "old"]);
    vi.stubEnv("WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS", newKey);
    expect(readReferralPrivacySnapshot(input)).toBeNull();
  });
  it("rejects duplicate key identities", () => {
    const input = fixture();
    input.value.customerEmailIdentities.push(
      input.value.customerEmailIdentities[0],
    );
    expect(readReferralPrivacySnapshot(input)).toBeNull();
  });

  it("does not trust an overlong stored expiry", () => {
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "10");
    const input = fixture();
    input.value.retainUntil = "2099-01-01T00:00:00.000Z";
    expect(
      readReferralPrivacySnapshot({
        ...input,
        now: new Date("2026-09-19T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("honors a shortened retention policy for an existing snapshot", () => {
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "30");
    const input = fixture();
    vi.stubEnv("WELETIC_SHOPIFY_FINANCIAL_RETENTION_DAYS", "5");
    expect(
      readReferralPrivacySnapshot({
        ...input,
        now: new Date("2026-09-14T00:00:00.000Z"),
      }),
    ).toBeNull();
  });
});
