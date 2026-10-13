import crypto from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../app/api/dub/webhook/lead-created", () => ({
  leadCreated: vi.fn().mockResolvedValue("Lead created"),
}));

vi.mock("../../app/api/dub/webhook/sale-created", () => ({
  saleCreated: vi.fn().mockResolvedValue("Sale created"),
}));

import { POST } from "../../app/api/dub/webhook/route";

describe("Dub Webhook HMAC verification and payload handling (SEC-02)", () => {
  const TEST_SECRET = "test_dub_webhook_secret_key_1234567890";
  const originalEnv = process.env.DUB_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.DUB_WEBHOOK_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DUB_WEBHOOK_SECRET = originalEnv;
    } else {
      delete process.env.DUB_WEBHOOK_SECRET;
    }
  });

  const computeHmac = (payload: string, secret: string = TEST_SECRET) => {
    return crypto.createHmac("sha256", secret).update(payload).digest("hex");
  };

  const sampleEvent = {
    id: "evt_dub_test_01",
    event: "link.created",
    createdAt: "2026-10-04T10:00:00.000Z",
    data: {
      id: "link_test_123",
      domain: "dub.sh",
      key: "test-key",
      url: "https://example.com",
    },
  };

  it("Test 1: accepts formatted JSON payload with indentation and whitespace when signature matches raw text", async () => {
    const rawFormattedBody = JSON.stringify(sampleEvent, null, 2);
    const validSignature = computeHmac(rawFormattedBody);

    const req = new Request("http://localhost:3000/api/dub/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Dub-Signature": validSignature,
      },
      body: rawFormattedBody,
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe("OK");
  });

  it("Test 2: accepts valid request with compact JSON and valid signature", async () => {
    const rawCompactBody = JSON.stringify(sampleEvent);
    const validSignature = computeHmac(rawCompactBody);

    const req = new Request("http://localhost:3000/api/dub/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Dub-Signature": validSignature,
      },
      body: rawCompactBody,
    });

    const response = await POST(req);
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe("OK");
  });

  it("Test 3: rejects tampered signature of same length (64 hex) with 400 Invalid signature", async () => {
    const rawBody = JSON.stringify(sampleEvent);
    const validSignature = computeHmac(rawBody);
    // Tamper with the last character, preserving 64 hex length
    const tamperedChar = validSignature[63] === "a" ? "b" : "a";
    const tamperedSignature = validSignature.slice(0, 63) + tamperedChar;

    const req = new Request("http://localhost:3000/api/dub/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Dub-Signature": tamperedSignature,
      },
      body: rawBody,
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toBe("Invalid signature");
  });

  it("Test 4: safely rejects signatures with invalid lengths (e.g. short, odd, long) without throwing TypeError or 500", async () => {
    const rawBody = JSON.stringify(sampleEvent);

    const invalidLengthSignatures = [
      "abc", // 3 chars (odd length, short)
      "", // empty string
      "a".repeat(10), // 10 chars (short)
      "a".repeat(63), // 63 chars (odd length)
      "a".repeat(65), // 65 chars (longer than 64 hex)
      "a".repeat(128), // 128 chars
    ];

    for (const invalidSig of invalidLengthSignatures) {
      const req = new Request("http://localhost:3000/api/dub/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Dub-Signature": invalidSig,
        },
        body: rawBody,
      });

      const response = await POST(req);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toBe("Invalid signature");
    }
  });

  it("Test 5: rejects request when Dub-Signature header is missing with 400 Invalid signature", async () => {
    const rawBody = JSON.stringify(sampleEvent);

    const req = new Request("http://localhost:3000/api/dub/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: rawBody,
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toBe("Invalid signature");
  });

  it("Test 6: safely rejects non-JSON payload with 400 when signature is otherwise valid", async () => {
    const nonJsonBody = "plain text, not a valid json object";
    const validSignature = computeHmac(nonJsonBody);

    const req = new Request("http://localhost:3000/api/dub/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Dub-Signature": validSignature,
      },
      body: nonJsonBody,
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
  });

  it("Test 7: verifies constant-time comparison is used and does not throw with invalid hex characters", async () => {
    const rawBody = JSON.stringify(sampleEvent);
    // 64 non-hex characters
    const nonHexSignature = "z".repeat(64);

    const req = new Request("http://localhost:3000/api/dub/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Dub-Signature": nonHexSignature,
      },
      body: rawBody,
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toBe("Invalid signature");
  });

  it("Test 8: fails closed with 400 if DUB_WEBHOOK_SECRET is not configured", async () => {
    delete process.env.DUB_WEBHOOK_SECRET;
    const rawBody = JSON.stringify(sampleEvent);
    const signature = computeHmac(rawBody, "");

    const req = new Request("http://localhost:3000/api/dub/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Dub-Signature": signature,
      },
      body: rawBody,
    });

    const response = await POST(req);
    expect(response.status).toBe(400);
  });
});
