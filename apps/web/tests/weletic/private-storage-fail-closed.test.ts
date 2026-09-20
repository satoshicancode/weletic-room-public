import { afterEach, describe, expect, it, vi } from "vitest";
import { storage } from "../../lib/storage";

const names = [
  "STORAGE_ENDPOINT",
  "STORAGE_PRIVATE_BUCKET",
  "STORAGE_PUBLIC_BUCKET",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
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
    else process.env[name] = value;
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
