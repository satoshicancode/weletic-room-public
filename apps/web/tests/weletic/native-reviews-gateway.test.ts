import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewProxyResponse } from "../../../../packages/shopify-app/app/reviews-gateway.server";
import { verifyWeleticInternalRequest } from "../../../../packages/shopify-app/app/weletic-api.server";

const transport = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubEnv("WELETIC_API_URL", "https://backend.example.test");
  vi.stubEnv(
    "WELETIC_SHOPIFY_SERVICE_SECRET",
    "review-fixture-service-secret-32-characters",
  );
  vi.stubGlobal("fetch", transport);
  transport.mockReset().mockResolvedValue(Response.json({ items: [] }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("native review production proxy gateway", () => {
  it("uses the authenticated shop and signs only allowlisted query fields", async () => {
    const response = await reviewProxyResponse(
      new Request(
        "https://shop.example.test/apps/weletic/reviews/list?shop=attacker.myshopify.com&storeId=other&token=secret&productId=123&sort=lowest",
      ),
      "verified.myshopify.com",
      "reviews/list",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0];
    const signed = new Request(String(url), init);
    expect(new URL(signed.url).searchParams.get("shop")).toBe(
      "verified.myshopify.com",
    );
    expect(signed.url).not.toMatch(/attacker|storeId|token=/);
    expect(verifyWeleticInternalRequest({ request: signed })).toBe(true);
    expect(
      verifyWeleticInternalRequest({
        request: new Request(
          signed.url.replace("productId=123", "productId=456"),
          { headers: signed.headers },
        ),
      }),
    ).toBe(false);
  });
  it("binds submitted bytes into the service signature", async () => {
    const body = JSON.stringify({ token: "A".repeat(43), rating: 1 });
    await reviewProxyResponse(
      new Request("https://shop.example.test/apps/weletic/reviews/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
      "verified.myshopify.com",
      "reviews/submit",
    );
    const [url, init] = transport.mock.calls[0];
    const signed = new Request(String(url), init);
    expect(init?.body).toBe(body);
    expect(verifyWeleticInternalRequest({ request: signed, body })).toBe(true);
    expect(
      verifyWeleticInternalRequest({
        request: signed,
        body: body.replace('"rating":1', '"rating":5'),
      }),
    ).toBe(false);
  });
  it.each(["health", "admin", "settings"])(
    "never exposes the %s internal action to a storefront",
    async (action) => {
      const response = await reviewProxyResponse(
        new Request(`https://shop.example.test/apps/weletic/reviews/${action}`),
        "verified.myshopify.com",
        `reviews/${action}`,
      );
      expect(response.status).toBe(404);
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it("rejects oversized streamed bodies before forwarding and rejects non-JSON writes", async () => {
    for (const [type, body, status] of [
      ["application/json", "x".repeat(64 * 1024 + 1), 413],
      ["text/plain", "{}", 415],
    ] as const) {
      const response = await reviewProxyResponse(
        new Request("https://shop.example.test/apps/weletic/reviews/submit", {
          method: "POST",
          headers: { "Content-Type": type },
          body,
        }),
        "verified.myshopify.com",
        "reviews/submit",
      );
      expect(response.status).toBe(status);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("serves a nonce-scoped no-store form without server-side token disclosure", async () => {
    const response = await reviewProxyResponse(
      new Request(
        "https://shop.example.test/apps/weletic/reviews/write#token=secret",
      ),
      "verified.myshopify.com",
      "reviews/write",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'nonce-",
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).not.toContain("token=secret");
    expect(transport).not.toHaveBeenCalled();
  });
});
