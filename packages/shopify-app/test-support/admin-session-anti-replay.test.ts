import type { Session } from "@shopify/shopify-api";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminSessionResponse } from "../app/admin-session-response.server";
import {
  clearInternalNonceCacheForTest,
  verifyWeleticInternalRequest,
  WELETIC_INTERNAL_SIGNATURE_HEADER,
  WELETIC_INTERNAL_TIMESTAMP_HEADER,
  WELETIC_REQUEST_ID_HEADER,
} from "../app/weletic-api.server";

describe("SEC-R1-01: Shopify App Internal Admin Session Anti-Replay", () => {
  const secret = "a".repeat(32);
  const shop = "test-store.myshopify.com";

  beforeEach(() => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    clearInternalNonceCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createSignedRequest({
    path = `/api/internal/admin-session?shop=${shop}`,
    method = "GET",
    body = "",
    timestamp = String(Date.now()),
    requestId = crypto.randomUUID(),
  }: {
    path?: string;
    method?: string;
    body?: string;
    timestamp?: string;
    requestId?: string;
  } = {}) {
    const canonical = `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}\n${requestId}`;
    const signature = crypto
      .createHmac("sha256", secret)
      .update(canonical)
      .digest("hex");

    const headers = new Headers();
    headers.set(WELETIC_INTERNAL_TIMESTAMP_HEADER, timestamp);
    headers.set(WELETIC_INTERNAL_SIGNATURE_HEADER, signature);
    headers.set(WELETIC_REQUEST_ID_HEADER, requestId);

    return new Request(`https://shopify.weletic.com${path}`, {
      method,
      headers,
    });
  }

  it("accepts a first-time valid internal request with requestId", () => {
    const req = createSignedRequest();
    const isValid = verifyWeleticInternalRequest({
      request: req,
      requireRequestId: true,
      secret,
    });
    expect(isValid).toBe(true);
  });

  it("detects and rejects duplicate replay of the exact same request within 720s TTL", () => {
    const requestId = crypto.randomUUID();
    const timestamp = String(Date.now());
    const req1 = createSignedRequest({ requestId, timestamp });
    const req2 = createSignedRequest({ requestId, timestamp });

    // First request must succeed
    const firstAttempt = verifyWeleticInternalRequest({
      request: req1,
      requireRequestId: true,
      secret,
    });
    expect(firstAttempt).toBe(true);

    // Second request (replaying same requestId) must be rejected
    const secondAttempt = verifyWeleticInternalRequest({
      request: req2,
      requireRequestId: true,
      secret,
    });
    expect(secondAttempt).toBe(false);
  });

  it("adminSessionResponse rejects replayed request with 401 Unauthorized", async () => {
    const mockSession: Session = {
      id: "offline_test-store.myshopify.com",
      shop,
      state: "active",
      isOnline: false,
      accessToken: "shpat_test_token_12345",
      scope: "read_products,write_products",
      expires: new Date(Date.now() + 86400000),
      isActive: () => true,
    } as unknown as Session;

    const loader = adminSessionResponse(async () => ({ session: mockSession }));

    const requestId = crypto.randomUUID();
    const timestamp = String(Date.now());
    const req1 = createSignedRequest({ requestId, timestamp });
    const req2 = createSignedRequest({ requestId, timestamp });

    // First request succeeds and returns 200 with session
    const res1 = await loader({ request: req1, params: {}, context: {} });
    expect(res1.status).toBe(200);
    const data1 = (await res1.json()) as any;
    expect(data1.accessToken).toBe("shpat_test_token_12345");

    // Second request with same requestId (replay attack) is rejected with 401
    const res2 = await loader({ request: req2, params: {}, context: {} });
    expect(res2.status).toBe(401);
    const data2 = (await res2.json()) as any;
    expect(data2.error).toBe("Unauthorized");
  });

  it("rejects internal request missing x-weletic-request-id when requireRequestId is enabled", () => {
    const timestamp = String(Date.now());
    const path = `/api/internal/admin-session?shop=${shop}`;
    const canonical = `${timestamp}\nGET\n${path}\n`;
    const signature = crypto
      .createHmac("sha256", secret)
      .update(canonical)
      .digest("hex");

    const headers = new Headers();
    headers.set(WELETIC_INTERNAL_TIMESTAMP_HEADER, timestamp);
    headers.set(WELETIC_INTERNAL_SIGNATURE_HEADER, signature);
    // x-weletic-request-id is omitted

    const req = new Request(`https://shopify.weletic.com${path}`, {
      method: "GET",
      headers,
    });

    const isValid = verifyWeleticInternalRequest({
      request: req,
      requireRequestId: true,
      secret,
    });
    expect(isValid).toBe(false);
  });
});
