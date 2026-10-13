import { afterEach, describe, expect, it, vi } from "vitest";
import { storage } from "../../lib/storage";

const names = [
  "STORAGE_ENDPOINT",
  "STORAGE_PRIVATE_BUCKET",
  "STORAGE_PUBLIC_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_BASE_URL",
  "AWS_ENDPOINT",
  "AWS_S3_PRIVATE_BUCKET",
  "AWS_S3_BUCKET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "NEXT_PUBLIC_CDN_URL",
  "NODE_ENV",
] as const;
const original = Object.fromEntries(
  names.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else (process.env as any)[name] = value;
  }
});

describe("private storage configuration", () => {
  function configureR2() {
    process.env.STORAGE_ENDPOINT = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PRIVATE_BUCKET = "private-fixture";
    process.env.STORAGE_ACCESS_KEY_ID = "fixture-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "fixture-secret";
  }
  it("reads only bounded private metadata using direct signed uncached R2 HEAD", async () => {
    configureR2();
    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "content-length": "12",
          "content-type": "image/webp",
          "x-amz-meta-weletic-upload-proof": "ab".repeat(32),
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await storage.headPrivateR2Object("reviews/photo.webp")).toEqual({
      sizeBytes: 12,
      contentType: "image/webp",
      uploadProof: "ab".repeat(32),
    });
    const request = fetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("HEAD");
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    expect(request.url).toBe(
      `${process.env.STORAGE_ENDPOINT}/private-fixture/reviews/photo.webp`,
    );
    expect(request.headers.has("authorization")).toBe(true);
  });
  it("reads bounded private bytes without issuing a storage bearer URL", async () => {
    configureR2();
    const fetch = vi.fn().mockResolvedValue(
      new Response("photo", {
        headers: { "content-length": "5", "content-type": "image/webp" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await storage.readPrivateR2Object("reviews/photo.webp", 5)).toEqual(
      Buffer.from("photo"),
    );
    const request = fetch.mock.calls[0][0] as Request;
    expect(request.method).toBe("GET");
    expect(request.redirect).toBe("error");
    expect(request.cache).toBe("no-store");
    expect(request.headers.has("authorization")).toBe(true);
    expect(new URL(request.url).search).toBe("");
  });
  it.each([0, -1, 1.5, 2 * 1024 * 1024 + 1, NaN])(
    "rejects invalid read bound %s before network",
    async (size) => {
      configureR2();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        storage.readPrivateR2Object("reviews/photo.webp", size),
      ).rejects.toThrow("size is invalid");
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it.each([403, 404, 307, 503])(
    "fails a private read closed at HTTP %s without retry",
    async (status) => {
      configureR2();
      const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal("fetch", fetch);
      await expect(
        storage.readPrivateR2Object("reviews/photo.webp", 5),
      ).rejects.toThrow("response is invalid");
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["tiny", "toolong"])(
    "rejects streamed length mismatch: %s",
    async (body) => {
      configureR2();
      const fetch = vi.fn().mockResolvedValue(
        new Response(body, {
          headers: { "content-length": "5", "content-type": "image/webp" },
        }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        storage.readPrivateR2Object("reviews/photo.webp", 5),
      ).rejects.toThrow(/truncated|exceeds/);
    },
  );
  it("rejects content-type mismatch without releasing bytes", async () => {
    configureR2();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("photo", {
          headers: { "content-length": "5", "content-type": "text/html" },
        }),
      ),
    );
    await expect(
      storage.readPrivateR2Object("reviews/photo.webp", 5),
    ).rejects.toThrow("response is invalid");
  });
  it.each([
    "https://cdn.example.test",
    "http://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com",
    "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com/path",
    "https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com?query=1",
  ])("rejects non-direct R2 endpoint %s without network", async (endpoint) => {
    configureR2();
    process.env.STORAGE_ENDPOINT = endpoint;
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).rejects.toThrow("not configured");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not turn 403/503 into absence, retry, or follow a redirect", async () => {
    configureR2();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    for (const status of [403, 503, 307]) {
      fetch.mockResolvedValue(new Response(null, { status }));
      await expect(
        storage.headPrivateR2Object("reviews/photo.webp"),
      ).rejects.toThrow("unavailable");
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    fetch.mockResolvedValue(new Response(null, { status: 404 }));
    expect(await storage.headPrivateR2Object("reviews/photo.webp")).toBeNull();
  });
  it("rejects malformed metadata and path traversal; legacy objects have no proof", async () => {
    configureR2();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      storage.headPrivateR2Object("reviews/../photo.webp"),
    ).rejects.toThrow("not configured");
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockResolvedValue(
      new Response(null, {
        headers: { "content-length": "-1", "content-type": "image/webp" },
      }),
    );
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).rejects.toThrow("invalid");
    fetch.mockResolvedValue(
      new Response(null, {
        headers: { "content-length": "12", "content-type": "image/webp" },
      }),
    );
    expect(await storage.headPrivateR2Object("reviews/photo.webp")).toEqual({
      sizeBytes: 12,
      contentType: "image/webp",
      uploadProof: null,
    });
  });
  it.each([429, 500, 503])(
    "does not retry a single-attempt PUT after HTTP %s",
    async (status) => {
      process.env.STORAGE_ENDPOINT = "https://storage.example.test";
      process.env.STORAGE_PRIVATE_BUCKET = "private-fixture";
      process.env.STORAGE_ACCESS_KEY_ID = "fixture-key";
      process.env.STORAGE_SECRET_ACCESS_KEY = "fixture-secret";
      const fetch = vi.fn().mockResolvedValue(new Response("", { status }));
      vi.stubGlobal("fetch", fetch);
      vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        storage.upload({
          key: "reviews/fixture.webp",
          body: Buffer.from("fixture"),
          bucket: "private",
          opts: { singleAttempt: true, contentType: "image/webp" },
        }),
      ).rejects.toThrow("Failed to upload file");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][0].method).toBe("PUT");
      expect(fetch.mock.calls[0][0].redirect).toBe("error");
    },
  );

  it("preserves SDK retry behavior for callers without singleAttempt", async () => {
    process.env.STORAGE_ENDPOINT = "https://storage.example.test";
    process.env.STORAGE_PRIVATE_BUCKET = "private-fixture";
    process.env.STORAGE_ACCESS_KEY_ID = "fixture-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "fixture-secret";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    await storage.upload({
      key: "reviews/fixture.webp",
      body: Buffer.from("fixture"),
      bucket: "private",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0].redirect).toBe("follow");
  });

  it("never uses the public development fallback for private uploads or deletes", async () => {
    for (const name of names) delete process.env[name];
    await expect(
      storage.upload({
        key: "compliance/private.enc",
        body: Buffer.from("ciphertext"),
        bucket: "private",
      }),
    ).rejects.toThrow("Private storage is not fully configured");
    await expect(
      storage.delete({ key: "compliance/private.enc", bucket: "private" }),
    ).rejects.toThrow("Private storage is not fully configured");
  });
});

describe("dual-namespace environment variable resolution", () => {
  it("resolves storage configuration transparently from AWS_* environment variables", async () => {
    for (const name of names) delete process.env[name];
    process.env.AWS_ENDPOINT = `https://${"b".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.AWS_S3_PRIVATE_BUCKET = "aws-private-bucket";
    process.env.AWS_S3_BUCKET = "aws-public-bucket";
    process.env.AWS_ACCESS_KEY_ID = "aws-access-key";
    process.env.AWS_SECRET_ACCESS_KEY = "aws-secret-key";
    process.env.NEXT_PUBLIC_CDN_URL = "https://media.yamax.co";

    expect(storage.endpoint).toBe(process.env.AWS_ENDPOINT);
    expect(storage.accessKeyId).toBe("aws-access-key");
    expect(storage.secretAccessKey).toBe("aws-secret-key");
    expect(storage.privateBucket).toBe("aws-private-bucket");
    expect(storage.publicBucket).toBe("aws-public-bucket");
    expect(storage.baseUrl).toBe("https://media.yamax.co");

    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "content-length": "10",
          "content-type": "image/webp",
          "x-amz-meta-weletic-upload-proof": "cd".repeat(32),
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const headResult = await storage.headPrivateR2Object("reviews/photo.webp");
    expect(headResult).toEqual({
      sizeBytes: 10,
      contentType: "image/webp",
      uploadProof: "cd".repeat(32),
    });
    const request = fetch.mock.calls[0][0] as Request;
    expect(request.url).toBe(
      `${process.env.AWS_ENDPOINT}/aws-private-bucket/reviews/photo.webp`,
    );

    // Upload with AWS_* fallback and NEXT_PUBLIC_CDN_URL
    fetch.mockResolvedValue(new Response("", { status: 200 }));
    const uploadResult = await storage.upload({
      key: "logos/brand.png",
      body: Buffer.from("data"),
      bucket: "public",
    });
    expect(uploadResult.url).toBe("https://media.yamax.co/logos/brand.png");
    expect(fetch.mock.calls[1][0].url).toBe(
      `${process.env.AWS_ENDPOINT}/aws-public-bucket/logos/brand.png`,
    );

    // Delete with AWS_* fallback
    await storage.delete({ key: "logos/brand.png", bucket: "public" });
    expect(fetch.mock.calls[2][0].url).toBe(
      `${process.env.AWS_ENDPOINT}/aws-public-bucket/logos/brand.png`,
    );
    expect(fetch.mock.calls[2][0].method).toBe("DELETE");

    // Signed upload URL with AWS_* fallback
    const signedUrl = await storage.getSignedUploadUrl({
      key: "logos/brand.png",
      bucket: "public",
    });
    expect(signedUrl).toContain(
      `${process.env.AWS_ENDPOINT}/aws-public-bucket/logos/brand.png?`,
    );
  });

  it("falls back to default public and private bucket names when not set in env", () => {
    for (const name of names) delete process.env[name];
    expect(storage.publicBucket).toBe("weletic-prod-public");
    expect(storage.privateBucket).toBe("weletic-prod-private");
  });
});

describe("local development and custom test endpoint validation", () => {
  it("permits localhost, 127.0.0.1, and custom test endpoints in non-production", async () => {
    (process.env as any).NODE_ENV = "development";
    process.env.STORAGE_PRIVATE_BUCKET = "private-fixture";
    process.env.STORAGE_ACCESS_KEY_ID = "fixture-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "fixture-secret";

    const fetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "content-length": "12",
          "content-type": "image/webp",
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    // 127.0.0.1:9002 (local SeaweedFS/S3 port)
    process.env.STORAGE_ENDPOINT = "http://127.0.0.1:9002";
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).resolves.not.toThrow();
    expect(fetch.mock.calls[0][0].url).toBe(
      "http://127.0.0.1:9002/private-fixture/reviews/photo.webp",
    );

    // localhost:9000
    process.env.STORAGE_ENDPOINT = "http://localhost:9000";
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).resolves.not.toThrow();
    expect(fetch.mock.calls[1][0].url).toBe(
      "http://localhost:9000/private-fixture/reviews/photo.webp",
    );

    // custom test endpoint test-storage
    process.env.STORAGE_ENDPOINT = "http://test-storage:9002";
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).resolves.not.toThrow();
    expect(fetch.mock.calls[2][0].url).toBe(
      "http://test-storage:9002/private-fixture/reviews/photo.webp",
    );
  });

  it("strictly enforces Cloudflare R2 endpoint regex and rejects local endpoints in production", async () => {
    (process.env as any).NODE_ENV = "production";
    process.env.STORAGE_PRIVATE_BUCKET = "private-fixture";
    process.env.STORAGE_ACCESS_KEY_ID = "fixture-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "fixture-secret";

    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    // In production, loopback/localhost must be rejected
    process.env.STORAGE_ENDPOINT = "http://127.0.0.1:9002";
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).rejects.toThrow(
      "Direct private R2 storage is not configured for reconciliation",
    );

    process.env.STORAGE_ENDPOINT = "http://localhost:9000";
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).rejects.toThrow(
      "Direct private R2 storage is not configured for reconciliation",
    );

    // In production, direct R2 endpoint is accepted
    process.env.STORAGE_ENDPOINT = `https://${"c".repeat(32)}.r2.cloudflarestorage.com`;
    fetch.mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "content-length": "12",
          "content-type": "image/webp",
        },
      }),
    );
    await expect(
      storage.headPrivateR2Object("reviews/photo.webp"),
    ).resolves.not.toThrow();
  });
});

describe("zero S3 ACL invariant enforcement", () => {
  it("never injects x-amz-acl headers or query params into uploads or signed URLs", async () => {
    process.env.STORAGE_ENDPOINT = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PUBLIC_BUCKET = "public-fixture";
    process.env.STORAGE_ACCESS_KEY_ID = "fixture-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "fixture-secret";

    const fetch = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    // Test upload strips any supplied x-amz-acl
    await storage.upload({
      key: "assets/image.png",
      body: Buffer.from("image"),
      bucket: "public",
      opts: {
        headers: {
          "x-amz-acl": "public-read",
          "X-Amz-Acl": "public-read",
        },
      },
    });

    const sentRequest = fetch.mock.calls[0][0] as Request;
    expect(sentRequest.headers.has("x-amz-acl")).toBe(false);
    expect(sentRequest.headers.has("X-Amz-Acl")).toBe(false);

    // Test getSignedUploadUrl does not include x-amz-acl
    const signedUploadUrl = await storage.getSignedUploadUrl({
      key: "assets/upload.png",
      bucket: "public",
      contentType: "image/png",
    });
    expect(signedUploadUrl).not.toContain("x-amz-acl");
    expect(signedUploadUrl).not.toContain("public-read");

    // Test getSignedUrl strips any supplied x-amz-acl header
    const signedUrlWithHeaders = await storage.getSignedUrl({
      key: "assets/custom.png",
      method: "PUT",
      bucket: "public",
      expiresIn: 300,
      headers: {
        "x-amz-acl": "public-read",
      },
    });
    expect(signedUrlWithHeaders).not.toContain("x-amz-acl");
    expect(signedUrlWithHeaders).not.toContain("public-read");
  });
});
