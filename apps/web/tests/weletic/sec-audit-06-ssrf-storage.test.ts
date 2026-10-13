import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "../../lib/storage";

describe("SEC-AUDIT-06: Storage SSRF Defense & wsrv.nl Proxy Elimination", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.STORAGE_ENDPOINT = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PUBLIC_BUCKET = "public-test";
    process.env.STORAGE_ACCESS_KEY_ID = "test-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "test-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  it("never invokes wsrv.nl proxy even when width/height options are provided", async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("wsrv.nl")) {
        throw new Error(
          "Adversarial violation: external wsrv.nl proxy invoked!",
        );
      }
      return Promise.resolve(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    // Public valid image URL with resizing options
    const result = await storage.upload({
      key: "avatars/user.png",
      body: "https://images.unsplash.com/photo-123456",
      bucket: "public",
      opts: { width: 100, height: 100 },
    });

    expect(result.url).toBeDefined();
    // Verify that wsrv.nl was NEVER called
    for (const call of fetchSpy.mock.calls) {
      const calledUrl = typeof call[0] === "string" ? call[0] : call[0].url;
      expect(calledUrl).not.toContain("wsrv.nl");
    }
  });

  it("strictly rejects loopback IP addresses (127.0.0.1) even with width/height options", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      storage.upload({
        key: "test.png",
        body: "http://127.0.0.1:8000/internal-admin",
        bucket: "public",
        opts: { width: 200, height: 200 },
      }),
    ).rejects.toThrow(/private or internal IP address/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strictly rejects cloud metadata endpoint (169.254.169.254) with dimension options", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      storage.upload({
        key: "test.png",
        body: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        bucket: "public",
        opts: { width: 50 },
      }),
    ).rejects.toThrow(/private or internal IP address/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strictly rejects localhost hostname and .local suffixes", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      storage.upload({
        key: "test.png",
        body: "http://localhost:3000/secret.png",
        bucket: "public",
      }),
    ).rejects.toThrow(/private or internal/);

    await expect(
      storage.upload({
        key: "test.png",
        body: "http://internal-service.local/secret.png",
        bucket: "public",
      }),
    ).rejects.toThrow(/private or internal/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strictly rejects non-http protocols (file://, gopher://, ftp://)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      storage.upload({
        key: "test.png",
        body: "file:///etc/passwd",
        bucket: "public",
      }),
    ).rejects.toThrow(/Only http and https URLs are allowed/);

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
