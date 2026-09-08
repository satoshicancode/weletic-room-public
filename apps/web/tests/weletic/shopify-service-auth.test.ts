import {
  SHOPIFY_ADMIN_API_VERSION,
  getShopifyAdminGraphqlUrl,
} from "@/lib/integrations/shopify/admin-graphql";
import {
  WELETIC_SHOPIFY_MAX_BODY_BYTES,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
  createWeleticShopifyCanonicalRequest,
  readWeleticShopifyRequestBody,
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_WELETIC_API_TIMEOUT_MS,
  weleticApiRequest,
} from "../../../../packages/shopify-app/app/weletic-api.server";
import {
  WeleticSessionStorage,
  fetchCurrentAppInstallationScopes,
} from "../../../../packages/shopify-app/app/weletic-session-storage.server";

const secret = "test-shopify-service-secret-with-32-characters";
const now = Date.parse("2026-08-17T00:00:00.000Z");
const timestamp = String(now);
const path = "/api/internal/shopify/catalog?shop=store.myshopify.com";
const body = "{}";

function createSignedRequest({
  requestBody = body,
  signedBody = requestBody,
  requestTimestamp = timestamp,
  requestPath = path,
}: {
  requestBody?: string;
  signedBody?: string;
  requestTimestamp?: string;
  requestPath?: string;
} = {}) {
  const signature = signWeleticShopifyRequest({
    timestamp: requestTimestamp,
    method: "POST",
    path: requestPath,
    body: signedBody,
    secret,
  });

  return {
    request: new Request(`https://app.weletic.com${requestPath}`, {
      method: "POST",
      headers: {
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: requestTimestamp,
        [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
      },
      body: requestBody,
    }),
    body: requestBody,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Weletic Shopify service authentication", () => {
  test("uses the documented canonical request format", () => {
    expect(
      createWeleticShopifyCanonicalRequest({
        timestamp,
        method: "post",
        path,
        body,
      }),
    ).toBe(`${timestamp}\nPOST\n${path}\n{}`);
  });

  test("accepts an intact request inside the clock window", () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const input = createSignedRequest();
    expect(verifyWeleticShopifyRequest({ ...input, now })).toBe(true);
  });

  test("rejects a body changed after signing", () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const input = createSignedRequest({
      requestBody: '{"operation":"delete"}',
      signedBody: body,
    });
    expect(verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("rejects a path or query changed after signing", () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const input = createSignedRequest({
      requestPath:
        "/api/internal/shopify/catalog?shop=other-store.myshopify.com",
    });
    input.request.headers.set(
      WELETIC_SHOPIFY_SIGNATURE_HEADER,
      signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body,
        secret,
      }),
    );
    expect(verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("rejects stale requests", () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const staleTimestamp = String(now - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - 1);
    const input = createSignedRequest({ requestTimestamp: staleTimestamp });
    expect(verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("rejects requests without a valid signature", () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const request = new Request(`https://app.weletic.com${path}`, {
      method: "POST",
      headers: { [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp },
      body,
    });
    expect(verifyWeleticShopifyRequest({ request, body, now })).toBe(false);
  });

  test("fails closed when the dedicated service secret is missing", () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", "");
    vi.stubEnv(
      "ENCRYPTION_KEY",
      "test-encryption-key-that-must-not-sign-requests",
    );
    const input = createSignedRequest();

    expect(() => verifyWeleticShopifyRequest({ ...input, now })).toThrow(
      "WELETIC_SHOPIFY_SERVICE_SECRET must be at least 32 characters",
    );
  });

  test("bounds request bodies before signature verification", async () => {
    const validRequest = new Request("https://app.weletic.com/internal", {
      method: "POST",
      body,
    });
    await expect(readWeleticShopifyRequestBody(validRequest)).resolves.toBe(
      body,
    );

    const oversizedRequest = new Request("https://app.weletic.com/internal", {
      method: "POST",
      body: "x".repeat(WELETIC_SHOPIFY_MAX_BODY_BYTES + 1),
    });
    await expect(readWeleticShopifyRequestBody(oversizedRequest)).resolves.toBe(
      null,
    );
  });

  test("accepts the standalone Shopify app signer", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        const requestBody = String(init?.body ?? "");
        const requestTime = Number(
          request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER),
        );
        expect(
          verifyWeleticShopifyRequest({
            request,
            body: requestBody,
            now: requestTime,
          }),
        ).toBe(true);
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await weleticApiRequest(path, { method: "POST", body });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("rejects normalized paths outside the Shopify internal API", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      weleticApiRequest("/api/internal/shopify/../../external"),
    ).rejects.toThrow("Normalized path must stay inside");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("aborts a stalled core request with a bounded gateway error", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_API_TIMEOUT_MS", "100");
    const fetchMock = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = weleticApiRequest(path);
    const rejection = expect(pending).rejects.toMatchObject({
      status: 504,
      message: "Weletic service took too long to respond",
    });
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(DEFAULT_WELETIC_API_TIMEOUT_MS).toBe(8_000);
  });

  test("keeps the read deadline active while the response body is streaming", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_API_TIMEOUT_MS", "100");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const pending = weleticApiRequest(path);
    const rejection = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });

  test("does not impose a read timeout on mutation outcomes", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_API_TIMEOUT_MS", "100");
    let requestSignal: AbortSignal | null | undefined;
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            requestSignal = init?.signal;
            resolveFetch = resolve;
          }),
      ),
    );

    const pending = weleticApiRequest(path, { method: "POST", body });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(requestSignal?.aborted).toBe(false);
    resolveFetch(Response.json({ ok: true }));
    await expect(pending).resolves.toBeInstanceOf(Response);
  });

  test("sets Shopify iframe protection on document responses", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
    vi.stubEnv("SHOPIFY_API_SECRET", "test-api-secret");
    vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.weletic.com");
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    const { setDocumentResponseHeaders } = await import(
      "../../../../packages/shopify-app/app/entry.server"
    );
    const headers = new Headers();
    setDocumentResponseHeaders(
      new Request(
        "https://shopify.weletic.com/?shop=store.myshopify.com&host=test",
      ),
      headers,
    );

    expect(headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://store.myshopify.com https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;",
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");

    const missingShopHeaders = new Headers();
    setDocumentResponseHeaders(
      new Request("https://shopify.weletic.com/"),
      missingShopHeaders,
    );
    expect(missingShopHeaders.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none';",
    );
  });

  test("round-trips expiring offline token fields through remote storage", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    const expires = Date.parse("2026-08-18T00:00:00.000Z");
    const refreshTokenExpires = Date.parse("2026-09-17T00:00:00.000Z");
    const properties: [string, string | number | boolean][] = [
      ["id", "offline_store.myshopify.com"],
      ["shop", "store.myshopify.com"],
      ["state", "oauth-state"],
      ["isOnline", false],
      ["scope", "read_products"],
      ["accessToken", "access-token"],
      ["expires", expires],
      ["refreshToken", "refresh-token"],
      ["refreshTokenExpires", refreshTokenExpires],
    ];
    let persistedProperties: typeof properties | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "store.myshopify.com") {
          expect(request.headers.get("X-Shopify-Access-Token")).toBe(
            "access-token",
          );
          return Response.json({
            data: {
              currentAppInstallation: {
                accessScopes: [
                  { handle: "read_products" },
                  { handle: "read_store_credit_accounts" },
                ],
              },
            },
          });
        }
        const requestBody = String(init?.body ?? "");
        const requestTime = Number(
          request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER),
        );
        expect(
          verifyWeleticShopifyRequest({
            request,
            body: requestBody,
            now: requestTime,
          }),
        ).toBe(true);

        if (request.method === "POST") {
          persistedProperties = JSON.parse(requestBody).properties;
          return Response.json({ stored: true });
        }

        return Response.json({
          sessions: persistedProperties
            ? [{ properties: persistedProperties }]
            : [],
        });
      }),
    );

    const storage = new WeleticSessionStorage();
    const sessionToStore = {
      shop: "store.myshopify.com",
      isOnline: false,
      accessToken: "access-token",
      toPropertyArray: () => properties,
    } as Parameters<WeleticSessionStorage["storeSession"]>[0];

    await storage.storeSession(sessionToStore);
    const restored = await storage.loadSession("offline_store.myshopify.com");

    expect(restored).toMatchObject({
      refreshToken: "refresh-token",
      shop: "store.myshopify.com",
      scope: "read_products,read_store_credit_accounts",
    });
    expect(restored?.expires?.getTime()).toBe(expires);
    expect(restored?.refreshTokenExpires?.getTime()).toBe(refreshTokenExpires);
  });

  test("sends the exact prior offline token digest for refresh CAS", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const sessionId = "offline_store.myshopify.com";
    const previousToken = "previous-offline-token";
    const nextToken = "next-offline-token";
    const previousProperties: [string, string | number | boolean][] = [
      ["id", sessionId],
      ["shop", "store.myshopify.com"],
      ["state", "oauth-state"],
      ["isOnline", false],
      ["scope", "read_products"],
      ["accessToken", previousToken],
    ];
    let postedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "store.myshopify.com") {
          return Response.json({
            data: {
              currentAppInstallation: {
                accessScopes: [
                  { handle: "read_products" },
                  { handle: "read_store_credit_accounts" },
                ],
              },
            },
          });
        }
        if (request.method === "GET") {
          return Response.json({
            sessions: [{ properties: previousProperties }],
          });
        }
        postedBody = JSON.parse(String(init?.body || "{}"));
        return Response.json({ stored: true });
      }),
    );
    const nextProperties = previousProperties.map(([key, value]) =>
      key === "accessToken"
        ? ([key, nextToken] as const)
        : ([key, value] as const),
    );
    const storage = new WeleticSessionStorage();

    await storage.storeSession({
      id: sessionId,
      shop: "store.myshopify.com",
      isOnline: false,
      accessToken: nextToken,
      toPropertyArray: () => nextProperties,
    } as Parameters<WeleticSessionStorage["storeSession"]>[0]);

    expect(postedBody).toEqual(
      expect.objectContaining({
        expectedCredentialTokenHash: createHash("sha256")
          .update(previousToken)
          .digest("hex"),
        properties: expect.arrayContaining([
          ["accessToken", nextToken],
          ["scope", "read_products,read_store_credit_accounts"],
        ]),
      }),
    );
  });

  test("normalizes Shopify's authoritative app installation scopes", async () => {
    const customFetch = vi.fn(async () =>
      Response.json({
        data: {
          currentAppInstallation: {
            accessScopes: [
              { handle: "write_gift_cards" },
              { handle: "read_store_credit_accounts" },
              { handle: "write_gift_cards" },
            ],
          },
        },
      }),
    );

    await expect(
      fetchCurrentAppInstallationScopes({
        shop: "Store.myshopify.com",
        accessToken: "access-token",
        customFetch: customFetch as typeof fetch,
      }),
    ).resolves.toEqual(["read_store_credit_accounts", "write_gift_cards"]);
  });
});

describe("Shopify Admin GraphQL destination", () => {
  test("uses the validated Shopify shop and stable API version", () => {
    expect(getShopifyAdminGraphqlUrl("Store.myshopify.com")).toBe(
      `https://store.myshopify.com/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    );
  });

  test("rejects non-Shopify destinations", () => {
    expect(() => getShopifyAdminGraphqlUrl("169.254.169.254")).toThrow(
      "valid myshopify.com hostname",
    );
    expect(() =>
      getShopifyAdminGraphqlUrl("shop.myshopify.com.evil.test"),
    ).toThrow("valid myshopify.com hostname");
  });

  test("uses an explicit proxy only in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv(
      "SHOPIFY_ADMIN_GRAPHQL_PROXY_URL",
      "http://127.0.0.1:3457/graphiql/graphql.json?key=test",
    );
    expect(getShopifyAdminGraphqlUrl("store.myshopify.com")).toBe(
      `http://127.0.0.1:3457/graphiql/graphql.json?key=test&api_version=${SHOPIFY_ADMIN_API_VERSION}`,
    );

    vi.stubEnv("NODE_ENV", "production");
    expect(getShopifyAdminGraphqlUrl("store.myshopify.com")).toBe(
      `https://store.myshopify.com/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    );
  });
});
