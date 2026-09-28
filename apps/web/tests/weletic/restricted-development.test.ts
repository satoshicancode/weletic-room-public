import { hasFreshSubscription } from "@/lib/weletic/shopify/app-pricing-contract";
import {
  hasFreshRestrictedDevelopmentAccess,
  permitsRestrictedDevelopmentIdentity,
} from "@/lib/weletic/shopify/restricted-development";
import { assertNewBenefitsEnabled } from "@/lib/weletic/shopify/setup-only";
import { afterEach, expect, it, vi } from "vitest";
const generation = "11111111-1111-4111-8111-111111111111";
const identity = {
  appId: "c7d49cebb06e445db345bb200f966a03",
  partnerAppId: "gid://shopify/App/419628580865",
  shopId: "gid://shopify/Shop/73236414690",
  shop: "montdev.myshopify.com",
  installationGeneration: generation,
};
const environment = {
  NODE_ENV: "development",
  WELETIC_ISOLATED_DEVELOPMENT: "1",
  WELETIC_FEATURE_PROFILE: "core-v1",
  WELETIC_RESTRICTED_DEVELOPMENT: "yamaxdev-v1",
  WELETIC_RESTRICTED_DEVELOPMENT_GENERATION: generation,
  SHOPIFY_API_KEY: identity.appId,
  SHOPIFY_PARTNER_APP_ID: identity.partnerAppId,
  DATABASE_URL: "mysql://synthetic@127.0.0.1:60101/test",
  PLANETSCALE_DATABASE_URL: "http://127.0.0.1:65367/test",
  UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079",
  STORAGE_ENDPOINT: "http://127.0.0.1:9002",
};
const now = new Date("2026-09-28T00:00:00Z");
function setup() {
  for (const [key, value] of Object.entries(environment))
    vi.stubEnv(key, value);
  vi.stubEnv("WELETIC_SETUP_ONLY", undefined);
}
function receipt() {
  return {
    ...identity,
    status: "restricted_development" as const,
    planHandle: null,
    cancelAtEndOfCycle: false,
    cycleEndsAt: null,
    verifiedAt: now,
    validUntil: new Date(now.getTime() + 300000),
  };
}
afterEach(() => vi.unstubAllEnvs());
it("accepts only the pinned local development identity and never represents a subscription", () => {
  setup();
  expect(permitsRestrictedDevelopmentIdentity(identity)).toBe(true);
  expect(
    hasFreshRestrictedDevelopmentAccess(
      receipt(),
      identity.shop,
      generation,
      now,
    ),
  ).toBe(true);
  expect(hasFreshSubscription(receipt(), identity, now)).toBe(false);
  expect(() => assertNewBenefitsEnabled()).not.toThrow();
  for (const key of [
    "appId",
    "partnerAppId",
    "shopId",
    "shop",
    "installationGeneration",
  ] as const)
    expect(
      permitsRestrictedDevelopmentIdentity({ ...identity, [key]: "wrong" }),
    ).toBe(false);
});
it("rejects stale, future, oversized, cross-generation and mislabeled receipts", () => {
  setup();
  for (const change of [
    { validUntil: now },
    { verifiedAt: new Date(now.getTime() + 1) },
    { validUntil: new Date(now.getTime() + 300001) },
    { status: "paid" },
    { planHandle: "company-free" },
    { cancelAtEndOfCycle: true },
    { cycleEndsAt: new Date(now.getTime() + 1000) },
    { shopId: "gid://shopify/Shop/1" },
  ])
    expect(
      hasFreshRestrictedDevelopmentAccess(
        { ...receipt(), ...change },
        identity.shop,
        generation,
        now,
      ),
    ).toBe(false);
  expect(
    hasFreshRestrictedDevelopmentAccess(
      receipt(),
      identity.shop,
      "another-generation",
      now,
    ),
  ).toBe(false);
});
it.each(Object.keys(environment))(
  "removing %s revokes retained testing access",
  (key) => {
    setup();
    vi.stubEnv(key, undefined);
    expect(
      hasFreshRestrictedDevelopmentAccess(
        receipt(),
        identity.shop,
        generation,
        now,
      ),
    ).toBe(false);
  },
);
it.each([
  ["NODE_ENV", "production"],
  ["WELETIC_FEATURE_PROFILE", "legacy"],
  ["WELETIC_SETUP_ONLY", "1"],
  ["WELETIC_RESTRICTED_DEVELOPMENT", "0"],
  ["WELETIC_RESTRICTED_DEVELOPMENT_GENERATION", "invalid"],
  ["DATABASE_URL", "mysql://synthetic@db.example.test/test"],
  ["PLANETSCALE_DATABASE_URL", "https://db.example.test"],
  ["UPSTASH_REDIS_REST_URL", "https://cache.example.test"],
  ["STORAGE_ENDPOINT", "https://media.example.test"],
])("rejects unsafe runtime %s", (key, value) => {
  setup();
  vi.stubEnv(key, value);
  expect(
    hasFreshRestrictedDevelopmentAccess(
      receipt(),
      identity.shop,
      generation,
      now,
    ),
  ).toBe(false);
  expect(() => assertNewBenefitsEnabled()).toThrow("verification");
});
