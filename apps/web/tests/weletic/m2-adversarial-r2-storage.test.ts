import { afterEach, describe, expect, it, vi } from "vitest";
import { isStored, storage } from "../../lib/storage";

const envVars = [
  "STORAGE_ENDPOINT",
  "STORAGE_PRIVATE_BUCKET",
  "STORAGE_PUBLIC_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_BASE_URL",
  "STORAGE_ALLOW_TEST_ENDPOINT",
  "AWS_ENDPOINT",
  "AWS_S3_PRIVATE_BUCKET",
  "AWS_S3_BUCKET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "NEXT_PUBLIC_CDN_URL",
  "NODE_ENV",
] as const;

const originalEnv = Object.fromEntries(
  envVars.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of envVars) {
    const val = originalEnv[name];
    if (val === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = val;
    }
  }
});

describe("M2 Adversarial Challenge: Fail-Closed Security under NODE_ENV=production", () => {
  function configureValidProductionR2() {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_ENDPOINT = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PRIVATE_BUCKET = "private-vault";
    process.env.STORAGE_ACCESS_KEY_ID = "valid-prod-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "valid-prod-secret";
  }

  const adversarialEndpoints = [
    // Loopback IPv4
    "http://127.0.0.1:9002",
    "http://127.0.0.1",
    "http://127.0.0.1:80",
    "https://127.0.0.1:9002",
    "https://127.0.0.1",
    // Loopback IPv6
    "http://[::1]:9000",
    "http://[::1]",
    "https://[::1]:9000",
    // Localhost hostnames
    "http://localhost",
    "http://localhost:9000",
    "http://localhost:9002",
    "https://localhost",
    "http://app.localhost",
    "http://storage.local",
    // Test hostnames
    "http://test-storage",
    "http://test-storage:9002",
    "https://test-s3.local",
    // Cloud metadata / link-local SSRF
    "http://169.254.169.254",
    "http://169.254.169.254/latest/meta-data/",
    "http://169.254.169.254:80",
    // Unspecified / internal IPs
    "http://0.0.0.0",
    "http://0.0.0.0:9002",
    "http://10.0.0.1",
    "http://192.168.1.1",
    // External attacker hostnames
    "https://attacker.com",
    "http://attacker.com",
    "https://evil-corp.test",
    // Subdomain / domain hijacking attempts
    "https://attacker.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com.attacker.com`,
    `https://attacker-${"a".repeat(32)}.r2.cloudflarestorage.com`,
    `https://${"a".repeat(31)}.r2.cloudflarestorage.com`, // 31 chars (too short)
    `https://${"a".repeat(33)}.r2.cloudflarestorage.com`, // 33 chars (too long)
    `https://${"g".repeat(32)}.r2.cloudflarestorage.com`, // invalid hex
    `https://${"z".repeat(32)}.r2.cloudflarestorage.com`, // invalid hex
    // Protocol downgrade on valid R2 host
    `http://${"a".repeat(32)}.r2.cloudflarestorage.com`,
    // Non-default port on valid R2 host
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com:8443`,
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com:9002`,
    // Path / Query / Hash pollution on valid R2 host
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com/extra/path`,
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com?param=val`,
    `https://${"a".repeat(32)}.r2.cloudflarestorage.com#anchor`,
    // Userinfo credentials injection
    `https://admin:password@${"a".repeat(32)}.r2.cloudflarestorage.com`,
  ];

  it.each(adversarialEndpoints)(
    "strictly rejects adversarial endpoint %s in production without initiating network request",
    async (endpoint) => {
      configureValidProductionR2();
      process.env.STORAGE_ENDPOINT = endpoint;

      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        storage.headPrivateR2Object("reviews/photo.webp"),
      ).rejects.toThrow(
        "Direct private R2 storage is not configured for reconciliation",
      );

      await expect(
        storage.readPrivateR2Object("reviews/photo.webp", 100),
      ).rejects.toThrow(
        "Direct private R2 storage is not configured for reconciliation",
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("cannot bypass production fail-closed security using STORAGE_ALLOW_TEST_ENDPOINT flags", async () => {
    configureValidProductionR2();
    process.env.NODE_ENV = "production";
    process.env.STORAGE_ENDPOINT = "http://127.0.0.1:9002";

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    // Try STORAGE_ALLOW_TEST_ENDPOINT="1"
    process.env.STORAGE_ALLOW_TEST_ENDPOINT = "1";
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).rejects.toThrow("Direct private R2 storage is not configured for reconciliation");

    // Try STORAGE_ALLOW_TEST_ENDPOINT="true"
    process.env.STORAGE_ALLOW_TEST_ENDPOINT = "true";
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).rejects.toThrow("Direct private R2 storage is not configured for reconciliation");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  const adversarialKeys = [
    "../secret.txt",
    "../../etc/passwd",
    "reviews/../photo.webp",
    "reviews/../../photo.webp",
    "reviews/./photo.webp",
    "/leading/slash.webp",
    "reviews//double-slash.webp",
    "",
  ];

  it.each(adversarialKeys)(
    "rejects path traversal or malformed key %s without initiating network request",
    async (key) => {
      configureValidProductionR2();
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await expect(storage.headPrivateR2Object(key)).rejects.toThrow(
        "Direct private R2 storage is not configured for reconciliation",
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  const invalidBuckets = [
    "PrivateBucket", // uppercase
    "private_bucket", // underscore
    "-private", // leading hyphen
    "private-", // trailing hyphen
    "ab", // too short (<3 chars)
    "a".repeat(64), // too long (>63 chars)
    "bucket..name", // double dots
  ];

  it.each(invalidBuckets)(
    "rejects invalid bucket name %s fail-closed",
    async (bucket) => {
      configureValidProductionR2();
      process.env.STORAGE_PRIVATE_BUCKET = bucket;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        storage.headPrivateR2Object("reviews/photo.webp"),
      ).rejects.toThrow(
        "Direct private R2 storage is not configured for reconciliation",
      );

      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});

describe("M2 Adversarial Challenge: Dual-Namespace Resolution (AWS_* only)", () => {
  it("fully and correctly operates when ONLY AWS_* environment variables are provided", async () => {
    // Purge all STORAGE_* and AWS_* variables
    for (const name of envVars) {
      delete process.env[name];
    }

    const testEndpoint = `https://${"d".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.AWS_ACCESS_KEY_ID = "aws-only-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-only-secret-key";
    process.env.AWS_ENDPOINT = testEndpoint;
    process.env.AWS_S3_BUCKET = "aws-public-bucket";
    // AWS_S3_PRIVATE_BUCKET intentionally omitted to test default fallback
    process.env.NEXT_PUBLIC_CDN_URL = "https://media.yamax.co";

    // 1. Check accessors
    expect(storage.accessKeyId).toBe("aws-only-access-key");
    expect(storage.secretAccessKey).toBe("aws-only-secret-key");
    expect(storage.endpoint).toBe(testEndpoint);
    expect(storage.publicBucket).toBe("aws-public-bucket");
    expect(storage.privateBucket).toBe("weletic-prod-private");
    expect(storage.baseUrl).toBe("https://media.yamax.co");

    // 2. Mock fetch and verify public upload
    const fetchSpy = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const uploadResult = await storage.upload({
      key: "products/leggings.webp",
      body: Buffer.from("image-bytes"),
      bucket: "public",
    });

    expect(uploadResult.url).toBe("https://media.yamax.co/products/leggings.webp");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const uploadReq = fetchSpy.mock.calls[0][0] as Request;
    expect(uploadReq.url).toBe(
      `${testEndpoint}/aws-public-bucket/products/leggings.webp`,
    );
    expect(uploadReq.method).toBe("PUT");
    expect(uploadReq.headers.has("authorization")).toBe(true);

    // 3. Verify private upload falls back to default private bucket
    await storage.upload({
      key: "vault/data.enc",
      body: Buffer.from("ciphertext"),
      bucket: "private",
    });
    const privateUploadReq = fetchSpy.mock.calls[1][0] as Request;
    expect(privateUploadReq.url).toBe(
      `${testEndpoint}/weletic-prod-private/vault/data.enc`,
    );

    // 4. Verify public delete
    await storage.delete({ key: "products/old.webp", bucket: "public" });
    const deleteReq = fetchSpy.mock.calls[2][0] as Request;
    expect(deleteReq.url).toBe(
      `${testEndpoint}/aws-public-bucket/products/old.webp`,
    );
    expect(deleteReq.method).toBe("DELETE");

    // 5. Verify private delete
    await storage.delete({ key: "vault/old.enc", bucket: "private" });
    const privateDeleteReq = fetchSpy.mock.calls[3][0] as Request;
    expect(privateDeleteReq.url).toBe(
      `${testEndpoint}/weletic-prod-private/vault/old.enc`,
    );
    expect(privateDeleteReq.method).toBe("DELETE");

    // 6. Verify signed upload URL
    const signedUploadUrl = await storage.getSignedUploadUrl({
      key: "products/new.webp",
      bucket: "public",
      expiresIn: 300,
    });
    expect(signedUploadUrl).toContain(
      `${testEndpoint}/aws-public-bucket/products/new.webp?`,
    );
    expect(signedUploadUrl).toContain("X-Amz-Signature=");

    // 7. Verify signed download URL for private bucket
    const signedDownloadUrl = await storage.getSignedDownloadUrl({
      key: "vault/secure.enc",
      bucket: "private",
      expiresIn: 60,
    });
    expect(signedDownloadUrl).toContain(
      `${testEndpoint}/weletic-prod-private/vault/secure.enc?`,
    );
    expect(signedDownloadUrl).toContain("X-Amz-Signature=");

    // 8. Verify isStored recognizes CDN URL
    expect(isStored("https://media.yamax.co/products/leggings.webp")).toBe(true);
    expect(isStored("https://malicious.com/products/leggings.webp")).toBe(false);
  });

  it("prioritizes STORAGE_* variables over AWS_* variables when both are set", () => {
    process.env.STORAGE_ACCESS_KEY_ID = "storage-key";
    process.env.AWS_ACCESS_KEY_ID = "aws-key";

    process.env.STORAGE_SECRET_ACCESS_KEY = "storage-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";

    process.env.STORAGE_ENDPOINT = "https://storage.r2.cloudflarestorage.com";
    process.env.AWS_ENDPOINT = "https://aws.r2.cloudflarestorage.com";

    process.env.STORAGE_BASE_URL = "https://cdn.storage.co";
    process.env.NEXT_PUBLIC_CDN_URL = "https://cdn.aws.co";

    process.env.STORAGE_PUBLIC_BUCKET = "storage-pub";
    process.env.AWS_S3_BUCKET = "aws-pub";

    process.env.STORAGE_PRIVATE_BUCKET = "storage-priv";
    process.env.AWS_S3_PRIVATE_BUCKET = "aws-priv";

    expect(storage.accessKeyId).toBe("storage-key");
    expect(storage.secretAccessKey).toBe("storage-secret");
    expect(storage.endpoint).toBe("https://storage.r2.cloudflarestorage.com");
    expect(storage.baseUrl).toBe("https://cdn.storage.co");
    expect(storage.publicBucket).toBe("storage-pub");
    expect(storage.privateBucket).toBe("storage-priv");
  });

  it("fails closed when neither STORAGE_* nor AWS_* credentials are provided", async () => {
    for (const name of envVars) {
      delete process.env[name];
    }

    await expect(
      storage.upload({
        key: "test.enc",
        body: Buffer.from("data"),
        bucket: "private",
      }),
    ).rejects.toThrow("Private storage is not fully configured.");

    await expect(
      storage.delete({
        key: "test.enc",
        bucket: "private",
      }),
    ).rejects.toThrow("Private storage is not fully configured.");

    await expect(
      storage.headPrivateR2Object("test.enc"),
    ).rejects.toThrow("Direct private R2 storage is not configured for reconciliation");

    await expect(
      storage.readPrivateR2Object("test.enc", 10),
    ).rejects.toThrow("Direct private R2 storage is not configured for reconciliation");
  });
});

describe("M2 Adversarial Challenge: Zero S3 ACL Injection", () => {
  it("completely strips x-amz-acl and X-Amz-Acl from upload requests", async () => {
    process.env.STORAGE_ENDPOINT = `https://${"e".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PUBLIC_BUCKET = "public-test";
    process.env.STORAGE_ACCESS_KEY_ID = "key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "secret";

    const fetchSpy = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    await storage.upload({
      key: "test.png",
      body: Buffer.from("data"),
      bucket: "public",
      opts: {
        headers: {
          "x-amz-acl": "public-read",
          "X-Amz-Acl": "public-read",
          "Custom-Header": "custom-value",
        },
      },
    });

    const request = fetchSpy.mock.calls[0][0] as Request;
    expect(request.headers.has("x-amz-acl")).toBe(false);
    expect(request.headers.has("X-Amz-Acl")).toBe(false);
    expect(request.headers.get("custom-header")).toBe("custom-value");
  });

  it("never includes x-amz-acl in getSignedUrl or signed query headers", async () => {
    process.env.STORAGE_ENDPOINT = `https://${"f".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PUBLIC_BUCKET = "public-test";
    process.env.STORAGE_ACCESS_KEY_ID = "key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "secret";

    const signedUrl = await storage.getSignedUrl({
      key: "test.png",
      method: "PUT",
      bucket: "public",
      expiresIn: 300,
      headers: {
        "x-amz-acl": "public-read",
        "X-Amz-Acl": "public-read",
        "x-custom-meta": "value",
      },
    });

    const parsedUrl = new URL(signedUrl);
    expect(parsedUrl.searchParams.has("x-amz-acl")).toBe(false);
    expect(parsedUrl.searchParams.has("X-Amz-Acl")).toBe(false);
    expect(signedUrl).not.toContain("public-read");

    const signedHeaders = parsedUrl.searchParams.get("X-Amz-SignedHeaders") || "";
    expect(signedHeaders.toLowerCase()).not.toContain("acl");
  });

  it("never includes x-amz-acl in getSignedUploadUrl or getSignedDownloadUrl", async () => {
    process.env.STORAGE_ENDPOINT = `https://${"f".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PUBLIC_BUCKET = "public-test";
    process.env.STORAGE_PRIVATE_BUCKET = "private-test";
    process.env.STORAGE_ACCESS_KEY_ID = "key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "secret";

    const uploadUrl = await storage.getSignedUploadUrl({
      key: "upload.png",
      bucket: "public",
      contentLength: 1024,
      contentType: "image/png",
    });

    expect(uploadUrl).not.toContain("acl");
    expect(uploadUrl).not.toContain("public-read");

    const downloadUrl = await storage.getSignedDownloadUrl({
      key: "download.enc",
      bucket: "private",
    });

    expect(downloadUrl).not.toContain("acl");
    expect(downloadUrl).not.toContain("public-read");
  });
});
