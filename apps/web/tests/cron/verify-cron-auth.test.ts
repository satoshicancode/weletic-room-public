import { verifyQstashSignature } from "@/lib/cron/verify-qstash";
import { verifyVercelSignature } from "@/lib/cron/verify-vercel";
import { SignJWT } from "jose";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

const cronSecret = "synthetic-cron-test-secret";
const currentSigningKey = "synthetic-qstash-current-signing-key";
const nextSigningKey = "synthetic-qstash-next-signing-key";
const rawBody = '{"storeId":"synthetic-store"}';
const url = "https://public-development.example.test/api/cron/test";

function request(headers: HeadersInit = {}) {
  return new Request(url, { headers });
}

// Real SDK signature verification with locally generated synthetic JWTs;
// this does not claim delivery from the hosted QStash service.
function signQstash({
  key = currentSigningKey,
  body = rawBody,
  expiresIn = "5m",
}: { key?: string; body?: string; expiresIn?: string } = {}) {
  return new SignJWT({
    body: createHash("sha256").update(body).digest("base64url"),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("Upstash")
    .setSubject(url)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(key));
}

beforeEach(() => {
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", "");
  vi.stubEnv("CRON_SECRET", cronSecret);
  vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", currentSigningKey);
  vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", nextSigningKey);
  vi.stubEnv("QSTASH_REGION", "");
  vi.stubEnv("QSTASH_DEV", "false");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("local development defaults", () => {
  test.each(["", "0"])(
    "retains the bypass when strict mode is %j",
    async (flag) => {
      vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", flag);
      vi.stubEnv("CRON_SECRET", "");
      vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
      vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");

      await expect(verifyVercelSignature(request())).resolves.toBeUndefined();
      await expect(
        verifyQstashSignature({ req: request(), rawBody }),
      ).resolves.toBeUndefined();
    },
  );
});

describe.each([
  { name: "strict development", vercel: "", strict: "1" },
  { name: "Vercel without opt-in", vercel: "1", strict: "" },
  { name: "Vercel with opt-out", vercel: "1", strict: "0" },
])("$name", ({ vercel, strict }) => {
  beforeEach(() => {
    vi.stubEnv("VERCEL", vercel);
    vi.stubEnv("WELETIC_ENFORCE_CRON_AUTH", strict);
  });

  test("rejects missing Vercel authorization despite spoofed local headers", async () => {
    await expect(
      verifyVercelSignature(
        request({
          host: "localhost:8888",
          "x-forwarded-host": "localhost",
          "x-vercel-id": "local",
          "weletic-enforce-cron-auth": "0",
        }),
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("rejects invalid Vercel authorization", async () => {
    await expect(
      verifyVercelSignature(request({ authorization: "Bearer wrong-secret" })),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("fails closed without a configured cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "");
    await expect(
      verifyVercelSignature(request({ authorization: `Bearer ${cronSecret}` })),
    ).rejects.toMatchObject({ code: "internal_server_error" });
  });

  test("accepts the configured Vercel bearer secret", async () => {
    await expect(
      verifyVercelSignature(request({ authorization: `Bearer ${cronSecret}` })),
    ).resolves.toBeUndefined();
  });

  test("rejects a missing QStash signature despite spoofed local headers", async () => {
    await expect(
      verifyQstashSignature({
        req: request({
          host: "localhost:8888",
          "x-forwarded-host": "localhost",
        }),
        rawBody,
      }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  test("rejects an invalid QStash signature", async () => {
    const signature = await signQstash({ key: "untrusted-signing-key" });
    await expect(
      verifyQstashSignature({
        req: request({ "Upstash-Signature": signature }),
        rawBody,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("fails closed without signing keys even when SDK dev mode is enabled", async () => {
    vi.stubEnv("QSTASH_CURRENT_SIGNING_KEY", "");
    vi.stubEnv("QSTASH_NEXT_SIGNING_KEY", "");
    vi.stubEnv("QSTASH_DEV", "true");
    const signature = await signQstash();
    await expect(
      verifyQstashSignature({
        req: request({ "Upstash-Signature": signature }),
        rawBody,
      }),
    ).rejects.toThrow("No signing keys available");
  });

  test.each([currentSigningKey, nextSigningKey])(
    "accepts a locally signed QStash request using %s",
    async (key) => {
      const signature = await signQstash({ key });
      await expect(
        verifyQstashSignature({
          req: request({ "Upstash-Signature": signature }),
          rawBody,
        }),
      ).resolves.toBeUndefined();
    },
  );

  test("rejects QStash body tampering", async () => {
    const signature = await signQstash();
    await expect(
      verifyQstashSignature({
        req: request({ "Upstash-Signature": signature }),
        rawBody: '{"storeId":"different-store"}',
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  test("rejects expired QStash signatures", async () => {
    const signature = await signQstash({ expiresIn: "-1m" });
    await expect(
      verifyQstashSignature({
        req: request({ "Upstash-Signature": signature }),
        rawBody,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});
