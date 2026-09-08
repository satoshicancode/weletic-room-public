import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  acquireShopifySessionLease,
  shopifySessionCoordinationId,
} from "../../lib/weletic/shopify/session-coordination";

const scope = { appId: "app-id", shop: "fixture.myshopify.com" };

describe("Shopify session coordination input boundary", () => {
  it("separates canonical app/shop scopes with fixed opaque identifiers", () => {
    const id = shopifySessionCoordinationId(scope);
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(shopifySessionCoordinationId({ ...scope })).toBe(id);
    expect(
      shopifySessionCoordinationId({ ...scope, appId: "other-app" }),
    ).not.toBe(id);
    expect(
      shopifySessionCoordinationId({ ...scope, shop: "other.myshopify.com" }),
    ).not.toBe(id);
  });

  it.each([
    { ...scope, appId: "App-ID" },
    { ...scope, appId: "a\nb" },
    { ...scope, appId: "a".repeat(192) },
    { ...scope, shop: "Fixture.myshopify.com" },
    { ...scope, shop: "fixture.myshopify.com.evil.test" },
    { ...scope, shop: "https://fixture.myshopify.com" },
    { ...scope, shop: "" },
  ])("rejects noncanonical scope %#", (value) => {
    expect(() => shopifySessionCoordinationId(value)).toThrow("invalid_scope");
  });

  it.each([
    { token: "bad", epoch: "0", revision: "0" },
    { token: "a".repeat(64), epoch: "-1", revision: "0" },
    { token: "a".repeat(64), epoch: "01", revision: "0" },
    { token: "a".repeat(64), epoch: "0", revision: "1e3" },
    { token: "a".repeat(64), epoch: "0", revision: "9223372036854775807" },
  ])(
    "rejects invalid acquisition proof before issuing SQL %#",
    async ({ token, epoch, revision }) => {
      const execute = vi.fn();
      const tx = {
        $executeRaw: execute,
      } as unknown as Prisma.TransactionClient;
      await expect(
        acquireShopifySessionLease(tx, scope, token, { epoch, revision }),
      ).rejects.toMatchObject({ code: "invalid_scope" });
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
