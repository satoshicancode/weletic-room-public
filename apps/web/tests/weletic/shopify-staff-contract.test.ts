import {
  isFreshShopifyMerchantActor,
  shopifyMerchantActorEnvelopeSchema,
  shopifyStaffGrantPermissionsSchema,
  shopifyStaffUserIdSchema,
  staffGrantAllows,
} from "@/lib/weletic/shopify/staff-contract";
import { describe, expect, it } from "vitest";

const actor = {
  version: 1 as const,
  appId: "test-app",
  shop: "staff-fixture.myshopify.com",
  storeId: "store-fixture",
  installationGeneration: "generation-fixture",
  userId: "123",
  sessionId: "staff-fixture.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: 1_000_000,
  requestId: "b".repeat(64),
};

describe("Shopify merchant actor wire contract", () => {
  it("preserves the maximum safe user ID without rounding", () => {
    const userId = String(Number.MAX_SAFE_INTEGER);
    expect(
      shopifyMerchantActorEnvelopeSchema.parse({
        ...actor,
        userId,
        sessionId: `${actor.shop}_${userId}`,
      }).userId,
    ).toBe(userId);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 8640000000000001])(
    "rejects malformed authentication time %s",
    (authenticatedAt) =>
      expect(
        shopifyMerchantActorEnvelopeSchema.safeParse({
          ...actor,
          authenticatedAt,
        }).success,
      ).toBe(false),
  );

  it("rejects unknown versions and malformed binding fields", () => {
    for (const changed of [
      { version: 2 },
      { appId: "" },
      { storeId: "" },
      { installationGeneration: "" },
      { installationGeneration: "a/b" },
      { installationGeneration: "a".repeat(65) },
    ])
      expect(
        shopifyMerchantActorEnvelopeSchema.safeParse({ ...actor, ...changed })
          .success,
      ).toBe(false);
  });

  it("accepts only the canonical online identity tuple", () => {
    expect(shopifyMerchantActorEnvelopeSchema.parse(actor)).toEqual(actor);
    for (const sessionId of [
      "offline_staff-fixture.myshopify.com",
      "other.myshopify.com_123",
      "staff-fixture.myshopify.com_456",
    ])
      expect(
        shopifyMerchantActorEnvelopeSchema.safeParse({ ...actor, sessionId })
          .success,
      ).toBe(false);
  });

  it.each(["0", "-1", "01", "1.0", "1e2", " 1", "9007199254740992"])(
    "rejects noncanonical or unsafe user ID %s",
    (value) =>
      expect(shopifyStaffUserIdSchema.safeParse(value).success).toBe(false),
  );

  it.each([
    "accountOwner",
    "collaborator",
    "permissions",
    "workspaceId",
    "accessToken",
  ])("rejects caller-provided %s rather than treating it as authority", (key) =>
    expect(
      shopifyMerchantActorEnvelopeSchema.safeParse({ ...actor, [key]: true })
        .success,
    ).toBe(false),
  );

  it("requires a bounded original authentication time", () => {
    expect(isFreshShopifyMerchantActor(actor, actor.authenticatedAt)).toBe(
      true,
    );
    expect(
      isFreshShopifyMerchantActor(actor, actor.authenticatedAt + 59_999),
    ).toBe(true);
    for (const now of [
      actor.authenticatedAt - 1,
      actor.authenticatedAt + 60_000,
      NaN,
      Infinity,
    ])
      expect(isFreshShopifyMerchantActor(actor, now)).toBe(false);
  });

  it.each(["sessionDigest", "requestId"] as const)(
    "rejects malformed %s",
    (key) => {
      for (const value of ["", "a".repeat(63), "A".repeat(64), "x".repeat(64)])
        expect(
          shopifyMerchantActorEnvelopeSchema.safeParse({
            ...actor,
            [key]: value,
          }).success,
        ).toBe(false);
    },
  );
});

describe("explicit store-scoped staff permissions", () => {
  it("grants only the exact recorded operation", () => {
    expect(
      staffGrantAllows(
        ["reviews.read", "reviews.moderate"],
        "reviews.moderate",
      ),
    ).toBe(true);
    for (const required of [
      "loyalty.adjust",
      "analytics.export",
      "reviews.configure",
      "staff.manage",
      "affiliate.read",
      "billing.manage",
      "workspace.owner",
      "release.deploy",
      "*",
    ])
      expect(
        staffGrantAllows(["reviews.read", "reviews.moderate"], required),
      ).toBe(false);
  });

  it.each(
    [
      null,
      undefined,
      {},
      [],
      ["*"],
      ["reviews.read", "unknown"],
      ["reviews.read", "reviews.read"],
      "reviews.read",
    ].map((permissions) => ({ permissions })),
  )(
    "denies absent, revoked or malformed stored grants: $permissions",
    ({ permissions }) =>
      expect(staffGrantAllows(permissions, "reviews.read")).toBe(false),
  );

  it("does not make access administration delegable", () => {
    expect(
      shopifyStaffGrantPermissionsSchema.safeParse(["staff.manage"]).success,
    ).toBe(false);
    expect(shopifyStaffGrantPermissionsSchema.parse([])).toEqual([]);
  });
});
