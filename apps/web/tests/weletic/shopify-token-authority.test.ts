import {
  signWeleticShopifyRequest,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import { fetchShopifyTokenAuthorityCredential } from "@/lib/weletic/shopify/token-authority";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  verifyWeleticInternalRequest,
  WELETIC_INTERNAL_SIGNATURE_HEADER,
  WELETIC_INTERNAL_TIMESTAMP_HEADER,
} from "../../../../packages/shopify-app/app/weletic-api.server";

const unauthenticatedAdmin = vi.fn();
const installedAdmin = vi.fn();

vi.mock("../../../../packages/shopify-app/app/shopify.server", () => ({
  unauthenticated: { admin: unauthenticatedAdmin },
  installedUnauthenticated: { admin: installedAdmin },
}));

const secret = "test-shopify-service-secret-with-32-characters";
const shop = "store.myshopify.com";

function signedAuthorityRequest(
  targetShop = shop,
  generation?: string,
  installed = false,
) {
  const path = `/api/internal/${installed ? "installed-admin-session" : "admin-session"}?shop=${encodeURIComponent(targetShop)}${generation === undefined ? "" : `&generation=${encodeURIComponent(generation)}`}`;
  const timestamp = String(Date.now());
  return new Request(`https://shopify.weletic.com${path}`, {
    headers: {
      [WELETIC_INTERNAL_TIMESTAMP_HEADER]: timestamp,
      [WELETIC_INTERNAL_SIGNATURE_HEADER]: signWeleticShopifyRequest({
        timestamp,
        method: "GET",
        path,
        body: "",
        secret,
      }),
    },
  });
}

describe("Shopify offline-token authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects unsigned requests before loading a Shopify session", async () => {
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.internal.admin-session"
    );
    const response = await loader({
      request: new Request(
        `https://shopify.weletic.com/api/internal/admin-session?shop=${shop}`,
      ),
      params: {},
      context: {},
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(unauthenticatedAdmin).not.toHaveBeenCalled();
  });

  it("returns only the refreshed offline access-token projection", async () => {
    const expires = new Date(Date.now() + 55 * 60 * 1000);
    unauthenticatedAdmin.mockResolvedValue({
      session: {
        isOnline: false,
        shop,
        accessToken: "fresh-offline-access-token",
        refreshToken: "must-never-leave-shopify-app",
        scope: "read_discounts,write_discounts",
        expires,
      },
    });
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.internal.admin-session"
    );

    const response = await loader({
      request: signedAuthorityRequest(),
      params: {},
      context: {},
    });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(unauthenticatedAdmin).toHaveBeenCalledWith(shop);
    expect(payload).toEqual({
      shop,
      accessToken: "fresh-offline-access-token",
      scope: "read_discounts,write_discounts",
      expiresAt: expires.toISOString(),
    });
    expect(JSON.stringify(payload)).not.toContain("refreshToken");
  });

  it("fails closed for an invalid or mismatched tenant session", async () => {
    unauthenticatedAdmin.mockResolvedValue({
      session: {
        isOnline: false,
        shop: "other.myshopify.com",
        accessToken: "wrong-tenant-token",
      },
    });
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.internal.admin-session"
    );

    const invalidShopResponse = await loader({
      request: signedAuthorityRequest("shop.myshopify.com.evil.test"),
      params: {},
      context: {},
    });
    const mismatchResponse = await loader({
      request: signedAuthorityRequest(),
      params: {},
      context: {},
    });

    expect(invalidShopResponse.status).toBe(400);
    expect(mismatchResponse.status).toBe(503);
  });

  it("does not expose an expired or imminently expiring session", async () => {
    unauthenticatedAdmin.mockResolvedValue({
      session: {
        isOnline: false,
        shop,
        accessToken: "stale-offline-access-token",
        expires: new Date(Date.now() + 30_000),
      },
    });
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.internal.admin-session"
    );

    const response = await loader({
      request: signedAuthorityRequest(),
      params: {},
      context: {},
    });

    expect(response.status).toBe(503);
  });

  it("keeps transient refresh/lease failures retryable without exposing exception text", async () => {
    unauthenticatedAdmin.mockRejectedValue(
      new Error("sensitive-provider-detail"),
    );
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.internal.admin-session"
    );
    const response = await loader({
      request: signedAuthorityRequest(),
      params: {},
      context: {},
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sensitive-provider-detail");
  });

  it("signs the exact tenant request and validates the authority response", async () => {
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        const requestTime = Number(
          request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER),
        );
        expect(
          request.headers.get(WELETIC_SHOPIFY_SIGNATURE_HEADER),
        ).toBeTruthy();
        expect(
          verifyWeleticInternalRequest({
            request,
            now: requestTime,
            secret,
          }),
        ).toBe(true);
        return Response.json({
          shop,
          accessToken: "fresh-offline-access-token",
          scope: "write_discounts",
          expiresAt,
        });
      },
    );

    const credential = await fetchShopifyTokenAuthorityCredential({
      shopDomain: shop,
      customFetch: fetchMock as typeof fetch,
    });

    expect(credential).toEqual({
      shopDomain: shop,
      accessToken: "fresh-offline-access-token",
      scope: "write_discounts",
      expiresAt: new Date(expiresAt),
    });
  });

  it("rejects credentials returned for another tenant", async () => {
    await expect(
      fetchShopifyTokenAuthorityCredential({
        shopDomain: shop,
        customFetch: vi.fn().mockResolvedValue(
          Response.json({
            shop: "other.myshopify.com",
            accessToken: "wrong-tenant-token",
            scope: "write_discounts",
            expiresAt: null,
          }),
        ) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects an expired credential projection", async () => {
    await expect(
      fetchShopifyTokenAuthorityCredential({
        shopDomain: shop,
        customFetch: vi.fn().mockResolvedValue(
          Response.json({
            shop,
            accessToken: "stale-offline-access-token",
            scope: "write_discounts",
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
          }),
        ) as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "NETWORK_ERROR",
    });
  });

  it.each([400, 404, 408, 409, 422, 429, 500, 503])(
    "does not turn HTTP %i into a reconnect alert",
    async (status) => {
      await expect(
        fetchShopifyTokenAuthorityCredential({
          shopDomain: shop,
          customFetch: vi
            .fn()
            .mockResolvedValue(
              Response.json({ error: "service failure" }, { status }),
            ),
        }),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    },
  );

  it.each([401, 403])(
    "keeps HTTP %i service-auth failures separate from merchant expiry",
    async (status) => {
      await expect(
        fetchShopifyTokenAuthorityCredential({
          shopDomain: shop,
          customFetch: vi
            .fn()
            .mockResolvedValue(new Response(null, { status })),
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    },
  );

  it("accepts the explicit missing-session error without leaking its provider text", async () => {
    await expect(
      fetchShopifyTokenAuthorityCredential({
        shopDomain: shop,
        customFetch: vi
          .fn()
          .mockResolvedValue(
            Response.json(
              { code: "SESSION_MISSING", error: "sensitive" },
              { status: 404 },
            ),
          ),
      }),
    ).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      message: `No active Shopify offline session found for ${shop}.`,
    });
  });

  it.each([null, [], false, "token", 42])(
    "handles malformed top-level payload %j safely",
    async (payload) => {
      await expect(
        fetchShopifyTokenAuthorityCredential({
          shopDomain: shop,
          customFetch: vi.fn().mockResolvedValue(Response.json(payload)),
        }),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    },
  );

  it.each([undefined, 42, true, {}, "not-a-date"])(
    "rejects invalid expiry metadata %j",
    async (expiresAt) => {
      await expect(
        fetchShopifyTokenAuthorityCredential({
          shopDomain: shop,
          customFetch: vi.fn().mockResolvedValue(
            Response.json({
              shop,
              accessToken: "synthetic-token",
              scope: "read_products",
              expiresAt,
            }),
          ),
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    },
  );

  it("bounds response bytes including an oversized error envelope", async () => {
    for (const status of [200, 404]) {
      await expect(
        fetchShopifyTokenAuthorityCredential({
          shopDomain: shop,
          customFetch: vi
            .fn()
            .mockResolvedValue(
              Response.json(
                { code: "SESSION_MISSING", detail: "x".repeat(33 * 1024) },
                { status },
              ),
            ),
        }),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    }
  });

  it("requires the installed endpoint's signed original generation", async () => {
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.internal.installed-admin-session"
    );
    const unsigned = await loader({
      request: new Request(
        `https://shopify.weletic.com/api/internal/installed-admin-session?shop=${shop}&generation=generation-1`,
      ),
      params: {},
      context: {},
    });
    expect(unsigned.status).toBe(401);
    expect(unsigned.headers.get("Cache-Control")).toBe("private, no-store");
    for (const generation of [undefined, "", " ", "x".repeat(65)]) {
      const response = await loader({
        request: signedAuthorityRequest(shop, generation, true),
        params: {},
        context: {},
      });
      expect(response.status).toBe(400);
    }
    expect(installedAdmin).not.toHaveBeenCalled();
    installedAdmin.mockResolvedValue({
      session: {
        shop,
        isOnline: false,
        accessToken: "synthetic",
        scope: "read_products",
      },
    });
    const response = await loader({
      request: signedAuthorityRequest(shop, "generation-1", true),
      params: {},
      context: {},
    });
    expect(response.status).toBe(200);
    expect(installedAdmin).toHaveBeenCalledWith(shop, "generation-1");
    expect(await response.json()).toMatchObject({
      installationGeneration: "generation-1",
    });
  });

  it("does not accept a missing-session result scoped to a different installation", async () => {
    await expect(
      fetchShopifyTokenAuthorityCredential({
        shopDomain: shop,
        installationGeneration: "generation-1",
        customFetch: vi.fn().mockResolvedValue(
          Response.json(
            {
              code: "SESSION_MISSING",
              shop,
              installationGeneration: "generation-2",
            },
            { status: 404 },
          ),
        ),
      }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("rejects an array credential envelope", async () => {
    await expect(
      fetchShopifyTokenAuthorityCredential({
        shopDomain: shop,
        customFetch: vi.fn().mockResolvedValue(Response.json([])),
      }),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("cannot silently send a generation fence to the legacy endpoint", async () => {
    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.internal.admin-session"
    );
    expect(
      (
        await loader({
          request: signedAuthorityRequest(shop, "generation-1"),
          params: {},
          context: {},
        })
      ).status,
    ).toBe(400);
    expect(unauthenticatedAdmin).not.toHaveBeenCalled();
  });

  it("signs the distinct fenced endpoint and refuses a missing or mismatched generation acknowledgement", async () => {
    for (const generation of [undefined, "generation-2", "generation-1"]) {
      const customFetch = vi.fn(
        async (input: URL | RequestInfo, init?: RequestInit) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          expect(url.pathname).toBe("/api/internal/installed-admin-session");
          expect(url.searchParams.get("generation")).toBe("generation-1");
          expect(verifyWeleticInternalRequest({ request, secret })).toBe(true);
          return Response.json({
            shop,
            accessToken: "synthetic",
            scope: "read_products",
            expiresAt: null,
            installationGeneration: generation,
          });
        },
      );
      const pending = fetchShopifyTokenAuthorityCredential({
        shopDomain: shop,
        installationGeneration: "generation-1",
        customFetch,
      });
      if (generation === "generation-1")
        await expect(pending).resolves.toMatchObject({ shopDomain: shop });
      else
        await expect(pending).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
  });
});
