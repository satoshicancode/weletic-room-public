import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deserializeShopifySession,
  serializeShopifySession,
} from "../../../../packages/shopify-app/app/session-properties.server";
import { WeleticSessionStorage } from "../../../../packages/shopify-app/app/weletic-session-storage.server";
import type { ShopifySessionProperty } from "../../lib/weletic/shopify/session-contract";
import {
  shopifySessionPropertiesSchema,
  shopifySessionWritePropertiesSchema,
} from "../../lib/weletic/shopify/session-contract-validation";

function onlineProperties(): ShopifySessionProperty[] {
  return [
    ["id", "staff-fixture.myshopify.com_123"],
    ["shop", "staff-fixture.myshopify.com"],
    ["state", "synthetic"],
    ["isOnline", true],
    ["accessToken", "synthetic-online-token"],
    ["scope", "read_products,write_discounts"],
    ["expires", Date.now() + 60_000],
    ["userId", 123],
    ["accountOwner", false],
    ["collaborator", false],
    ["associatedUserScope", "read_products"],
  ];
}

describe("online session persistence evidence (no merchant authorization)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("preserves narrower user scopes through the actual SDK serialization gap", () => {
    const session = deserializeShopifySession(onlineProperties())!;
    expect(
      session
        .toPropertyArray(true)
        .some(([key]) => key === "associatedUserScope"),
    ).toBe(false);
    const properties = serializeShopifySession(session);
    expect(shopifySessionWritePropertiesSchema.parse(properties)).toEqual(
      properties,
    );
    const restored = deserializeShopifySession(properties)!;
    expect(restored.scope).toBe("read_products,write_discounts");
    expect(restored.onlineAccessInfo?.associated_user_scope).toBe(
      "read_products",
    );
    expect(restored.onlineAccessInfo?.associated_user.account_owner).toBe(
      false,
    );
  });

  it.each(["associatedUserScope", "userId", "accountOwner", "collaborator"])(
    "requires reauthentication for a legacy online session missing %s",
    (missing) => {
      const properties = onlineProperties().filter(([key]) => key !== missing);
      expect(shopifySessionPropertiesSchema.safeParse(properties).success).toBe(
        true,
      );
      expect(deserializeShopifySession(properties)).toBeUndefined();
    },
  );

  it.each([
    ["accountOwner", "false"],
    ["collaborator", "false"],
    ["accountOwner", 1],
    ["isOnline", "true"],
    ["userId", "123"],
    ["userId", 9007199254740992],
    ["userId", 0],
    ["userId", -1],
    ["userId", 1.5],
    ["associatedUserScope", false],
    ["associatedUserScope", "read_products,,write_discounts"],
    ["associatedUserScope", "read_products\nwrite_discounts"],
  ] satisfies ShopifySessionProperty[])(
    "rejects coercive or malformed %s=%s",
    (field, value) => {
      const properties = onlineProperties().map(
        ([key, old]): ShopifySessionProperty => [
          key,
          key === field ? value : old,
        ],
      );
      expect(deserializeShopifySession(properties)).toBeUndefined();
      expect(
        shopifySessionWritePropertiesSchema.safeParse(properties).success,
      ).toBe(false);
    },
  );

  it("rejects duplicate identity keys before Object.fromEntries or SDK hydration", () => {
    const properties = [
      ...onlineProperties(),
      ["accountOwner", true] satisfies ShopifySessionProperty,
    ];
    expect(deserializeShopifySession(properties)).toBeUndefined();
    expect(
      shopifySessionWritePropertiesSchema.safeParse(properties).success,
    ).toBe(false);
  });

  it.each(["AccountOwner", "accountowner", "USERID", "unexpected"])(
    "rejects SDK key aliases and unknown fields: %s",
    (key) => {
      const properties = [
        ...onlineProperties(),
        [key, true] satisfies ShopifySessionProperty,
      ];
      expect(deserializeShopifySession(properties)).toBeUndefined();
      expect(
        shopifySessionWritePropertiesSchema.safeParse(properties).success,
      ).toBe(false);
    },
  );

  it("retains an explicitly empty user scope without elevating it to app scope", () => {
    const properties = onlineProperties().map(
      ([key, value]): ShopifySessionProperty => [
        key,
        key === "associatedUserScope" ? "" : value,
      ],
    );
    const session = deserializeShopifySession(properties)!;
    expect(
      deserializeShopifySession(serializeShopifySession(session))
        ?.onlineAccessInfo?.associated_user_scope,
    ).toBe("");
  });

  it("refuses to save an online session whose user-scope evidence was lost", () => {
    const session = deserializeShopifySession(onlineProperties())!;
    Reflect.deleteProperty(session.onlineAccessInfo!, "associated_user_scope");
    expect(() => serializeShopifySession(session)).toThrow(
      "permission evidence is missing",
    );
  });

  it("retains the offline property and refresh-token contract", () => {
    const properties: ShopifySessionProperty[] = [
      ["id", "offline_staff-fixture.myshopify.com"],
      ["shop", "staff-fixture.myshopify.com"],
      ["state", ""],
      ["isOnline", false],
      ["scope", "read_products,write_discounts"],
      ["refreshToken", "synthetic-refresh"],
    ];
    const session = deserializeShopifySession(properties)!;
    expect(Object.fromEntries(serializeShopifySession(session))).toEqual(
      Object.fromEntries(properties),
    );
    expect(session.onlineAccessInfo).toBeUndefined();
  });

  it("uses the production signed storage client and omits unsafe cached online records", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://staff-gateway.invalid");
    vi.stubEnv(
      "WELETIC_SHOPIFY_SERVICE_SECRET",
      "synthetic-online-service-secret-32-characters",
    );
    let persisted: ShopifySessionProperty[] = [];
    const legacy = onlineProperties().filter(
      ([key]) => key !== "associatedUserScope",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        expect(new URL(request.url).host).toBe("staff-gateway.invalid");
        expect(request.headers.get("x-weletic-signature")).toMatch(
          /^[a-f0-9]{64}$/,
        );
        if (request.method === "POST") {
          const body = JSON.parse(await request.text());
          persisted = shopifySessionWritePropertiesSchema.parse(
            body.properties,
          );
          return Response.json({ stored: true });
        }
        return Response.json({
          sessions: [{ properties: persisted }, { properties: legacy }],
        });
      }),
    );
    const storage = new WeleticSessionStorage();
    const session = deserializeShopifySession(onlineProperties())!;
    await storage.storeSession(session);
    expect(
      (await storage.loadSession(session.id))?.onlineAccessInfo
        ?.associated_user_scope,
    ).toBe("read_products");
    const sessions = await storage.findSessionsByShop(session.shop);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].onlineAccessInfo?.associated_user.account_owner).toBe(
      false,
    );
  });
});
