import crypto from "crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "../../app/(ee)/api/hubspot/webhook/route";

vi.mock("server-only", () => ({}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((cb) => {
      try {
        if (typeof cb === "function") cb();
      } catch {}
    }),
  };
});

vi.mock("@/lib/axiom/server", () => ({
  withAxiom: (fn: any) => fn,
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn().mockResolvedValue([]),
}));

describe("HubSpot Webhook Verification (SEC-AUDIT-02)", () => {
  const clientSecret = "hubspot-secret-token-xyz";
  const payload = JSON.stringify([
    { eventId: 101, subscriptionType: "deal.creation" },
  ]);

  function computeHubSpotSignature(secret: string, body: string) {
    return crypto
      .createHash("sha256")
      .update(secret + body)
      .digest("hex");
  }

  function makeRequest({
    signature,
    body = payload,
  }: {
    signature?: string;
    body?: string;
  }) {
    const headers = new Headers({
      "Content-Type": "application/json",
    });
    if (signature !== undefined) {
      headers.set("X-HubSpot-Signature", signature);
    }
    return new NextRequest("https://app.dub.co/api/hubspot/webhook", {
      method: "POST",
      headers,
      body,
    });
  }

  beforeEach(() => {
    vi.stubEnv("HUBSPOT_CLIENT_SECRET", clientSecret);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("accepts valid signature and returns 200", async () => {
    const validSig = computeHubSpotSignature(clientSecret, payload);
    const req = makeRequest({ signature: validSig });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(200);
  });

  it("returns 400 when X-HubSpot-Signature header is missing", async () => {
    const req = makeRequest({});
    const res = await POST(req, {} as any);
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error.code).toBe("bad_request");
  });

  it("returns 500 when HUBSPOT_CLIENT_SECRET is missing", async () => {
    vi.stubEnv("HUBSPOT_CLIENT_SECRET", "");
    const req = makeRequest({ signature: "any-sig" });
    const res = await POST(req, {} as any);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error.code).toBe("internal_server_error");
  });

  it("returns 401 when signature length matches but bytes differ", async () => {
    const validSig = computeHubSpotSignature(clientSecret, payload);
    const corruptedSig =
      validSig.slice(0, 63) + (validSig[63] === "0" ? "1" : "0");
    const req = makeRequest({ signature: corruptedSig });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe("unauthorized");
  });

  it("returns 401 safely when signature length does not match (no RangeError)", async () => {
    const req = makeRequest({ signature: "short-signature" });
    const res = await POST(req, {} as any);
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error.code).toBe("unauthorized");
  });

  it("returns 401 when request body is tampered", async () => {
    const validSig = computeHubSpotSignature(clientSecret, payload);
    const req = makeRequest({ signature: validSig, body: payload + " " });

    const res = await POST(req, {} as any);
    expect(res.status).toBe(401);
  });

  it("rejects signatures with single-byte flips across various positions", async () => {
    const validSig = computeHubSpotSignature(clientSecret, payload);

    for (const pos of [0, 16, 32, 48, 63]) {
      const corruptedSig =
        validSig.slice(0, pos) +
        (validSig[pos] === "0" ? "1" : "0") +
        validSig.slice(pos + 1);
      const req = makeRequest({ signature: corruptedSig });

      const res = await POST(req, {} as any);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe("unauthorized");
    }
  });
});
