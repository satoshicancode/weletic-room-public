import { fetchActiveAppSubscription } from "@/lib/weletic/shopify/app-pricing-client";
import {
  hasFreshSubscription,
  interpretActiveSubscription,
  SUBSCRIPTION_VERIFICATION_MS,
} from "@/lib/weletic/shopify/app-pricing-contract";
import { describe, expect, it, vi } from "vitest";
const now = new Date("2026-09-26T00:00:00Z");
const identity = {
  appId: "public-client",
  partnerAppId: "gid://shopify/App/1",
  shopId: "gid://shopify/Shop/2",
  installationGeneration: "generation-1",
};
const plans = { publicHandle: "core-monthly", privateHandle: "company-free" };
const response = () => ({
  data: {
    activeSubscription: {
      app: { id: identity.partnerAppId },
      shop: { id: identity.shopId },
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: false,
      trialEndsAt: null,
      currentBillingCycle: {
        startTime: "2026-09-01T00:00:00Z",
        endTime: "2026-10-01T00:00:00Z",
      },
      items: [
        {
          handle: plans.publicHandle,
          price: {
            __typename: "FlatRatePrice",
            active: true,
            currency: "USD",
            amount: "500.00",
          },
        },
      ],
    },
  },
});
describe("Shopify-hosted core pricing authority", () => {
  it("accepts only the configured public monthly or private free plan", () => {
    expect(
      interpretActiveSubscription(response(), identity, plans, now).status,
    ).toBe("paid");
    const free = response();
    free.data.activeSubscription.items[0].handle = plans.privateHandle;
    free.data.activeSubscription.items[0].price.amount = "0.00";
    expect(interpretActiveSubscription(free, identity, plans, now).status).toBe(
      "private_free",
    );
    free.data.activeSubscription.items[0].handle = "unknown-free";
    expect(interpretActiveSubscription(free, identity, plans, now).status).toBe(
      "inactive",
    );
  });
  it("allows public zero pricing only for an authenticated development store", () => {
    const value = response();
    value.data.activeSubscription.items[0].price.amount = "0.00";
    expect(
      interpretActiveSubscription(value, identity, plans, now).status,
    ).toBe("inactive");
    expect(
      interpretActiveSubscription(
        value,
        identity,
        { ...plans, verifiedDevelopmentStore: true },
        now,
      ).status,
    ).toBe("development");
  });
  it("rejects annual, trial and usage pricing", () => {
    const annual = response();
    annual.data.activeSubscription.billingPeriod = "ANNUAL";
    expect(
      interpretActiveSubscription(annual, identity, plans, now).status,
    ).toBe("inactive");
    const usage = response();
    usage.data.activeSubscription.items[0].price.__typename = "UsagePrice";
    expect(
      interpretActiveSubscription(usage, identity, plans, now).status,
    ).toBe("inactive");
    const trial = response();
    expect(
      interpretActiveSubscription(
        {
          data: {
            activeSubscription: {
              ...trial.data.activeSubscription,
              trialEndsAt: "2026-10-01T00:00:00Z",
            },
          },
        },
        identity,
        plans,
        now,
      ).status,
    ).toBe("inactive");
  });
  it("rejects forged returns, cross-store data, errors and missing subscription", () => {
    expect(
      interpretActiveSubscription(
        { plan_handle: plans.publicHandle },
        identity,
        plans,
        now,
      ).status,
    ).toBe("unavailable");
    const other = response();
    other.data.activeSubscription.shop.id = "gid://shopify/Shop/3";
    expect(
      interpretActiveSubscription(other, identity, plans, now).status,
    ).toBe("unavailable");
    expect(
      interpretActiveSubscription(
        { ...response(), errors: [{ message: "redacted" }] },
        identity,
        plans,
        now,
      ).status,
    ).toBe("unavailable");
    expect(
      interpretActiveSubscription(
        { data: { activeSubscription: null } },
        identity,
        plans,
        now,
      ).status,
    ).toBe("inactive");
  });
  it("expires access after five minutes or cycle end and fences reinstall", () => {
    const snapshot = {
      ...identity,
      ...interpretActiveSubscription(response(), identity, plans, now),
      verifiedAt: now,
      validUntil: new Date(now.getTime() + SUBSCRIPTION_VERIFICATION_MS),
    };
    expect(hasFreshSubscription(snapshot, identity, now)).toBe(true);
    expect(hasFreshSubscription(snapshot, identity, snapshot.validUntil)).toBe(
      false,
    );
    expect(
      hasFreshSubscription(
        snapshot,
        { ...identity, installationGeneration: "generation-2" },
        now,
      ),
    ).toBe(false);
    expect(
      hasFreshSubscription({ ...snapshot, cycleEndsAt: now }, identity, now),
    ).toBe(false);
  });
  it("retains verified current-cycle access after scheduled cancellation", () => {
    const value = response();
    value.data.activeSubscription.cancelAtEndOfCycle = true;
    expect(
      interpretActiveSubscription(value, identity, plans, now),
    ).toMatchObject({ status: "paid", cancelAtEndOfCycle: true });
    expect(
      interpretActiveSubscription(
        value,
        identity,
        plans,
        new Date("2026-10-01T00:00:00Z"),
      ).status,
    ).toBe("inactive");
  });
  it("uses the organization Partner endpoint and fails closed on unavailable service", async () => {
    const env = {
      NODE_ENV: "test" as const,
      SHOPIFY_API_KEY: identity.appId,
      SHOPIFY_PARTNER_APP_ID: identity.partnerAppId,
      SHOPIFY_PARTNER_ORGANIZATION_ID: "123",
      SHOPIFY_PARTNER_API_TOKEN: "synthetic-partner-token",
      WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE: plans.publicHandle,
      WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE: plans.privateHandle,
    };
    const customFetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response())));
    expect(
      (await fetchActiveAppSubscription(identity, { env, customFetch, now }))
        .status,
    ).toBe("paid");
    expect(customFetch).toHaveBeenCalledWith(
      "https://partners.shopify.com/123/api/2026-07/graphql.json",
      expect.objectContaining({ redirect: "error", cache: "no-store" }),
    );
    customFetch.mockRejectedValue(new Error("private provider detail"));
    expect(
      (await fetchActiveAppSubscription(identity, { env, customFetch, now }))
        .status,
    ).toBe("unavailable");
  });
});
