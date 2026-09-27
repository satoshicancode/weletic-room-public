import assert from "node:assert/strict";
import test from "node:test";
import { assertCoreBillingEnvironment } from "./billing-policy.mjs";
test("billing role admission requires identity, separate plans and backend-only credentials", () => {
  const web = {
    SHOPIFY_PARTNER_APP_ID: "gid://shopify/App/1",
    SHOPIFY_PARTNER_ORGANIZATION_ID: "123",
    SHOPIFY_PARTNER_API_TOKEN: "synthetic-partner-token",
    WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE: "core-monthly",
    WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE: "company-free",
  };
  assert.doesNotThrow(() => assertCoreBillingEnvironment("web", web));
  for (const key of Object.keys(web))
    assert.throws(() =>
      assertCoreBillingEnvironment("web", { ...web, [key]: undefined }),
    );
  assert.throws(() =>
    assertCoreBillingEnvironment("web", {
      ...web,
      WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE: "core-monthly",
    }),
  );
  assert.throws(() =>
    assertCoreBillingEnvironment("shopify", {
      ...web,
      SHOPIFY_APP_HANDLE: "weletic-room",
      WELETIC_SUPPORT_EMAIL: "support@example.test",
    }),
  );
  assert.throws(() => assertCoreBillingEnvironment("outbox", web));
  assert.doesNotThrow(() =>
    assertCoreBillingEnvironment("outbox", {
      SHOPIFY_PARTNER_APP_ID: web.SHOPIFY_PARTNER_APP_ID,
    }),
  );
});

test("production billing rejects setup-only flags even when malformed or paired with complete configuration", () => {
  for (const role of ["web", "shopify", "outbox"])
    for (const value of ["1", "0", "", "true"])
      assert.throws(() =>
        assertCoreBillingEnvironment(role, {
          SHOPIFY_PARTNER_APP_ID: "gid://shopify/App/1",
          SHOPIFY_PARTNER_ORGANIZATION_ID: "123",
          ...(role === "web"
            ? { SHOPIFY_PARTNER_API_TOKEN: "synthetic-partner-token" }
            : {}),
          WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE: "core-monthly",
          WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE: "company-free",
          SHOPIFY_APP_HANDLE: "weletic-room",
          WELETIC_SUPPORT_EMAIL: "support@example.test",
          WELETIC_SETUP_ONLY: value,
        }),
      );
});
