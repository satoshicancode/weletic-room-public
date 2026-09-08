import { describe, expect, it } from "vitest";
import type { ShopifySessionProperty } from "../../lib/weletic/shopify/session-contract";
import {
  bindShopifyOnlineSession,
  readShopifySessionPayload,
} from "../../lib/weletic/shopify/session-online-binding";

const binding = {
  appId: "test-app",
  shop: "fixture.myshopify.com",
  storeId: "store-fixture",
  installationGeneration: "generation-1",
};
const properties: ShopifySessionProperty[] = [
  ["id", `${binding.shop}_123`],
  ["shop", binding.shop],
  ["state", ""],
  ["isOnline", true],
  ["userId", 123],
  ["accountOwner", false],
  ["collaborator", false],
  ["associatedUserScope", "read_products"],
  ["accessToken", "synthetic-token"],
  ["expires", 2000000000000],
];

describe("versioned online installation payload", () => {
  it("retains the original binding without inventing it for legacy payloads", () => {
    const envelope = bindShopifyOnlineSession(properties, binding);
    expect(
      readShopifySessionPayload(JSON.parse(JSON.stringify(envelope))),
    ).toEqual({ properties, onlineBinding: binding });
    expect(readShopifySessionPayload(properties)).toEqual({ properties });
  });
  it.each([
    ["id", "fixture.myshopify.com_999"],
    ["shop", "other.myshopify.com"],
    ["isOnline", false],
    ["accountOwner", "false"],
    ["userId", "123"],
    ["expires", 0],
    ["expires", 8640000000000001],
    ["expires", 1.1],
    ["accessToken", ""],
  ] as ShopifySessionProperty[])(
    "rejects inconsistent %s identity",
    (key, value) => {
      const changed = properties.map(
        ([name, original]): ShopifySessionProperty => [
          name,
          name === key ? value : original,
        ],
      );
      expect(() => bindShopifyOnlineSession(changed, binding)).toThrow();
      expect(() =>
        readShopifySessionPayload({
          version: 1,
          properties: changed,
          onlineBinding: binding,
        }),
      ).toThrow();
    },
  );
  it("rejects missing expiry, unknown versions and injected envelope fields", () => {
    expect(() =>
      bindShopifyOnlineSession(
        properties.filter(([key]) => key !== "expires"),
        binding,
      ),
    ).toThrow();
    expect(() =>
      readShopifySessionPayload({
        version: 2,
        properties,
        onlineBinding: binding,
      }),
    ).toThrow();
    expect(() =>
      readShopifySessionPayload({
        version: 1,
        properties,
        onlineBinding: binding,
        owner: true,
      }),
    ).toThrow();
  });
});
