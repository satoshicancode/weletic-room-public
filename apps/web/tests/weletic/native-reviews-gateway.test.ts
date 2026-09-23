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
  it("does not expose account-only store submission to the app proxy", async () => {
    const response = await reviewProxyResponse(
      new Request(
        "https://shop.example.test/apps/weletic/reviews/store-submit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ),
      "verified.myshopify.com",
      "reviews/store-submit",
      "123",
    );
    expect(response.status).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  });
  it("forwards only bounded store-summary inputs with the verified shop", async () => {
    await reviewProxyResponse(
      new Request(
        "https://shop.example.test/apps/weletic/reviews/store-list?shop=attacker.myshopify.com&storeId=attacker&rating=5&limit=10",
      ),
      "verified.myshopify.com",
      "reviews/store-list",
    );
    const [url, init] = transport.mock.calls[0];
    const signed = new Request(String(url), init);
    const forwarded = new URL(signed.url);
    expect(forwarded.searchParams.get("shop")).toBe("verified.myshopify.com");
    expect(forwarded.searchParams.get("storeId")).toBeNull();
    expect(forwarded.searchParams.get("rating")).toBe("5");
    expect(verifyWeleticInternalRequest({ request: signed, body: "" })).toBe(
      true,
    );
  });
  it.each([
    ["open-upload", 400, "invalid_open_photo", "invalid_open_photo"],
    ["open-upload", 400, "bad_request", "review_error"],
    ["open-upload", 503, "invalid_open_photo", "review_error"],
    ["open-prepare", 400, "invalid_open_photo", "review_error"],
  ])(
    "only forwards the exact photo validation signal for %s/%s/%s",
    async (action, status, upstreamCode, expectedCode) => {
      transport.mockResolvedValue(
        Response.json(
          { error: { code: upstreamCode } },
          { status: Number(status) },
        ),
      );
      const result = await reviewProxyResponse(
        new Request("https://shop.example.test/reviews/" + action, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
        "verified.myshopify.com",
        "reviews/" + action,
        "123",
      );
      expect(await result.json()).toMatchObject({
        error: { code: expectedCode },
      });
    },
  );
  it("marks only its own pre-dispatch validation rejection as safe to correct", async () => {
    const result = await reviewProxyResponse(
      new Request(
        "https://shop.example.test/apps/weletic/reviews/open-submit",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      ),
      "verified.myshopify.com",
      "reviews/open-submit",
      "123",
    );
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({
      error: { code: "invalid_review_input" },
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it("signs open-submit identity only from verified gateway context", async () => {
    const body = JSON.stringify({
      rating: 1,
      title: "Honest review",
      body: "This product did not meet expectations.",
      displayName: "Reviewer",
      mediaIds: [],
      publishConsent: true,
      submissionId: "12345678-1234-4123-8123-123456789012",
      productId: "gid://shopify/Product/456",
      expectedInstallationGeneration: "g1",
      expectedSettingsRevision: 1,
      disclosureRevision: "open_unverified_unrewarded_v1",
      locale: "en",
      authorBinding: "a".repeat(64),
    });
    await reviewProxyResponse(
      new Request(
        "https://shop.example.test/apps/weletic/reviews/open-submit?customerId=999&source=customer_account",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      ),
      "verified.myshopify.com",
      "reviews/open-submit",
      "123",
    );
    const [url, init] = transport.mock.calls[0];
    const signed = new Request(String(url), init);
    expect(new URL(signed.url).searchParams.get("customerId")).toBe("123");
    expect(new URL(signed.url).searchParams.get("source")).toBe("app_proxy");
    expect(verifyWeleticInternalRequest({ request: signed, body })).toBe(true);
  });
  it.each([undefined, "", "0", "01", "gid://shopify/Customer/123"])(
    "rejects open-submit without canonical authenticated customer: %s",
    async (customerId) => {
      const result = await reviewProxyResponse(
        new Request(
          "https://shop.example.test/apps/weletic/reviews/open-submit?logged_in_customer_id=123",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        ),
        "verified.myshopify.com",
        "reviews/open-submit",
        customerId,
      );
      expect(result.status).toBe(401);
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it.each(["en", "ja", "vi"])(
    "signs and forwards the %s storefront locale",
    async (locale) => {
      await reviewProxyResponse(
        new Request(
          "https://shop.example.test/apps/weletic/reviews/list?productId=123&locale=" +
            locale,
        ),
        "verified.myshopify.com",
        "reviews/list",
      );
      const [url, init] = transport.mock.calls[0];
      const signed = new Request(String(url), init);
      expect(new URL(signed.url).searchParams.get("locale")).toBe(locale);
      expect(verifyWeleticInternalRequest({ request: signed })).toBe(true);
      const changed = new URL(signed.url);
      changed.searchParams.set("locale", "other");
      expect(
        verifyWeleticInternalRequest({
          request: new Request(changed, { headers: signed.headers }),
        }),
      ).toBe(false);
    },
  );
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
  it.each(["en", "ja", "vi"])(
    "serves the allowlisted %s form locale without forwarding a request",
    async (locale) => {
      const response = await reviewProxyResponse(
        new Request(
          `https://shop.example.test/apps/weletic/reviews/write?locale=${locale}`,
        ),
        "verified.myshopify.com",
        "reviews/write",
      );
      expect(await response.text()).toContain(`<html lang="${locale}">`);
      expect(transport).not.toHaveBeenCalled();
    },
  );
});
