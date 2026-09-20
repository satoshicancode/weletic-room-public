import {
  buildReviewPrivacyOwnerProjection,
  reviewPrivacyKeySetDigest,
} from "@/lib/weletic/reviews/privacy-owner-contract";
import { deriveAllShopifyCustomerPrivacyIdentities } from "@/lib/weletic/shopify/privacy-identity";
import { describe, expect, it } from "vitest";

const current = { identityKeyId: "current", secret: Buffer.alloc(32, 1) };
const previous = { identityKeyId: "previous", secret: Buffer.alloc(32, 2) };
const keyring = { current, all: [current, previous] };
const owner = {
  storeId: "store-a",
  shopperId: "shopper-a",
  installationGeneration: "g1",
  shopifyCustomerId: "gid://shopify/Customer/123",
  email: " Shopper@Example.test ",
  keyring,
};

describe("private review owner projection contract", () => {
  it("covers customer and persisted email under every retained key with existing tombstone derivation", () => {
    const value = buildReviewPrivacyOwnerProjection(owner);
    expect(value.identities).toHaveLength(4);
    expect(value.identities).toEqual(
      expect.arrayContaining(deriveAllShopifyCustomerPrivacyIdentities(owner)),
    );
    expect(value.keySetDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(value.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(value)).not.toContain("Example.test");
    expect(value).not.toHaveProperty("email");
    expect(value).not.toHaveProperty("shopifyCustomerId");
    expect(value).not.toHaveProperty("secret");
  });

  it("normalizes identity equivalence without depending on current key order", () => {
    const equivalent = buildReviewPrivacyOwnerProjection({
      ...owner,
      shopifyCustomerId: "123",
      email: "shopper@example.test",
      keyring: { current: previous, all: [previous, current] },
    });
    expect(equivalent).toEqual(buildReviewPrivacyOwnerProjection(owner));
  });

  it("distinguishes absent email, changed email, tenant and owner", () => {
    const value = buildReviewPrivacyOwnerProjection(owner);
    for (const change of [
      { email: null },
      { email: "other@example.test" },
      { storeId: "store-b" },
      { shopperId: "shopper-b" },
    ])
      expect(
        buildReviewPrivacyOwnerProjection({ ...owner, ...change }).sourceDigest,
      ).not.toBe(value.sourceDigest);
    expect(
      buildReviewPrivacyOwnerProjection({ ...owner, email: null }).identities,
    ).toHaveLength(2);
  });

  it("invalidates key coverage when any retained key is added, removed or replaced", () => {
    const baseline = reviewPrivacyKeySetDigest(keyring);
    const replacement = { ...previous, secret: Buffer.alloc(32, 3) };
    const next = { identityKeyId: "next", secret: Buffer.alloc(32, 4) };
    for (const all of [
      [current],
      [current, replacement],
      [current, previous, next],
    ])
      expect(reviewPrivacyKeySetDigest({ current, all })).not.toBe(baseline);
  });

  it.each([
    { current, all: [] },
    { current, all: [current, current] },
    { current, all: [previous] },
    { current, all: [{ ...current, secret: Buffer.alloc(31) }] },
  ])("rejects incomplete or ambiguous keyrings", (invalid) => {
    expect(() => reviewPrivacyKeySetDigest(invalid)).toThrow();
  });

  it.each(["redacted:v1:key:ABC", " REDACTED:legacy "])(
    "never treats a privacy pseudonym as a fresh customer identity",
    (shopifyCustomerId) => {
      expect(() =>
        buildReviewPrivacyOwnerProjection({ ...owner, shopifyCustomerId }),
      ).toThrow("Redacted");
    },
  );

  it.each([
    { storeId: "" },
    { shopperId: " shopper-a" },
    { installationGeneration: "" },
    { installationGeneration: "g".repeat(65) },
    { email: "invalid-email" },
  ])("fails closed for invalid source/scope", (change) => {
    expect(() =>
      buildReviewPrivacyOwnerProjection({ ...owner, ...change }),
    ).toThrow();
  });
});
