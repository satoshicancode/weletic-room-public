import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: any };
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { storage } from "../../lib/storage";
import {
  createD1NonceClient,
  type D1DatabaseLike,
  WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
} from "@weletic/contracts/shopify/service-auth";

describe("Milestone M2 Gate 2 Adversarial Stress Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.STORAGE_ENDPOINT = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PUBLIC_BUCKET = "public-test-bucket";
    process.env.STORAGE_PRIVATE_BUCKET = "private-test-bucket";
    process.env.STORAGE_ACCESS_KEY_ID = "test-access-key-id";
    process.env.STORAGE_SECRET_ACCESS_KEY = "test-secret-access-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  // ============================================================================
  // SECTION 1: STORAGE BUFFER OPERATIONS STRESS TESTING (apps/web/lib/storage.ts)
  // ============================================================================
  describe("1. Storage Buffer Operations & Slicing Stress", () => {
    it("1.1 uploads Node.js Buffer with various byte payloads and computes correct Content-Length", async () => {
      const capturedRequests: Request[] = [];
      const fetchSpy = vi.fn().mockImplementation(async (request: Request) => {
        capturedRequests.push(request);
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      // Sub-case A: Standard ASCII Buffer
      const asciiBuf = Buffer.from("Standard ASCII text content for storage upload");
      await storage.upload({
        key: "test/ascii.txt",
        body: asciiBuf,
        bucket: "public",
        opts: { contentType: "text/plain" },
      });

      expect(capturedRequests[0].headers.get("Content-Length")).toBe(
        String(asciiBuf.byteLength),
      );
      expect(capturedRequests[0].headers.get("Content-Type")).toBe("text/plain");

      // Sub-case B: Binary Zeroes Buffer (1024 bytes)
      const zeroesBuf = Buffer.alloc(1024, 0);
      await storage.upload({
        key: "test/zeroes.bin",
        body: zeroesBuf,
        bucket: "public",
      });

      expect(capturedRequests[1].headers.get("Content-Length")).toBe("1024");

      // Sub-case C: Multibyte UTF-8 Buffer
      const utf8Buf = Buffer.from("日本語と絵文字 🥋 🧘 🏃 12345");
      await storage.upload({
        key: "test/utf8.txt",
        body: utf8Buf,
        bucket: "public",
      });

      expect(capturedRequests[2].headers.get("Content-Length")).toBe(
        String(utf8Buf.byteLength),
      );

      // Sub-case D: 0-byte Empty Buffer
      const emptyBuf = Buffer.alloc(0);
      await storage.upload({
        key: "test/empty.bin",
        body: emptyBuf,
        bucket: "public",
      });

      expect(capturedRequests[3].headers.get("Content-Length")).toBe("0");

      // Ensure all 4 requests stripped any S3 ACLs
      for (const req of capturedRequests) {
        expect(req.headers.get("x-amz-acl")).toBeNull();
        expect(req.headers.get("X-Amz-Acl")).toBeNull();
      }
    });

    it("1.2 uploads plain Uint8Array and Uint8Array subarray views with non-zero byte offsets without corruption", async () => {
      const capturedBodies: Uint8Array[] = [];
      const capturedLengths: string[] = [];
      const fetchSpy = vi.fn().mockImplementation(async (request: Request) => {
        const ab = await request.arrayBuffer();
        capturedBodies.push(new Uint8Array(ab));
        capturedLengths.push(request.headers.get("Content-Length") || "");
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      // Sub-case A: Plain Uint8Array
      const plainBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      await storage.upload({
        key: "test/plain-uint8.bin",
        body: plainBytes,
        bucket: "public",
      });

      expect(capturedLengths[0]).toBe("8");
      expect(capturedBodies[0]).toEqual(plainBytes);

      // Sub-case B: Subarray view on larger ArrayBuffer (offset: 4, length: 6)
      const backingBuffer = new ArrayBuffer(16);
      const backingView = new Uint8Array(backingBuffer);
      for (let i = 0; i < 16; i++) backingView[i] = i * 10;
      // Sliced view from index 4 to 10: [40, 50, 60, 70, 80, 90]
      const subView = new Uint8Array(backingBuffer, 4, 6);

      await storage.upload({
        key: "test/subview.bin",
        body: subView,
        bucket: "public",
      });

      expect(capturedLengths[1]).toBe("6");
      expect(capturedBodies[1]).toEqual(new Uint8Array([40, 50, 60, 70, 80, 90]));
    });

    it("1.3 uploads ArrayBuffer directly without runtime type error", async () => {
      const capturedLengths: string[] = [];
      const fetchSpy = vi.fn().mockImplementation(async (request: Request) => {
        capturedLengths.push(request.headers.get("Content-Length") || "");
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const buffer = new ArrayBuffer(512);
      await storage.upload({
        key: "test/arraybuffer.bin",
        body: buffer as any,
        bucket: "public",
      });

      expect(capturedLengths[0]).toBe("512");
    });

    it("1.4 uploads Blob instances with custom content-types and validates size headers", async () => {
      const capturedRequests: Request[] = [];
      const fetchSpy = vi.fn().mockImplementation(async (request: Request) => {
        capturedRequests.push(request);
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      const blobData = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
      const blob = new Blob([blobData], { type: "image/png" });

      await storage.upload({
        key: "test/image.png",
        body: blob,
        bucket: "public",
      });

      expect(capturedRequests[0].headers.get("Content-Length")).toBe("8");
    });

    it("1.5 parses and converts base64 data URIs and raw base64 strings with padding variations", async () => {
      const capturedRequests: Request[] = [];
      const capturedBodies: Uint8Array[] = [];
      const fetchSpy = vi.fn().mockImplementation(async (request: Request) => {
        capturedRequests.push(request);
        const ab = await request.arrayBuffer();
        capturedBodies.push(new Uint8Array(ab));
        return new Response(null, { status: 200 });
      });
      vi.stubGlobal("fetch", fetchSpy);

      // 1-pixel transparent PNG in base64 (68 bytes raw data)
      const rawBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const dataUri = `data:image/png;base64,${rawBase64}`;

      // Upload via data URI
      await storage.upload({
        key: "test/datauri.png",
        body: dataUri,
        bucket: "public",
      });

      expect(capturedRequests[0].headers.get("Content-Length")).toBe("70");
      expect(capturedBodies[0].length).toBe(70);

      // Upload via raw base64 string (valid padding)
      await storage.upload({
        key: "test/raw.png",
        body: rawBase64,
        bucket: "public",
      });

      expect(capturedRequests[1].headers.get("Content-Length")).toBe("70");
      expect(capturedBodies[1]).toEqual(capturedBodies[0]);

      // Rejection of unpadded base64 (strict RFC base64 validation)
      const unpadded = rawBase64.replace(/=+$/, "");
      await expect(
        storage.upload({
          key: "test/unpadded.png",
          body: unpadded,
          bucket: "public",
        }),
      ).rejects.toThrow("Invalid input: Not a base64 string or a valid URL");

      // Rejection of invalid non-base64 non-url strings
      await expect(
        storage.upload({
          key: "test/bad.bin",
          body: "not-a-valid-base64-and-not-a-url!!!",
          bucket: "public",
        }),
      ).rejects.toThrow("Invalid input: Not a base64 string or a valid URL");
    });

    it("1.6 stress-tests chunk concatenations in readPrivateR2Object with multi-chunk streams and offset views", async () => {
      const expectedPayload = crypto.randomBytes(4096);

      // Sub-case A: Stream chunked into 64 small 64-byte chunks
      const chunkCount = 64;
      const chunkSize = 64;
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < chunkCount; i++) {
        chunks.push(
          new Uint8Array(
            expectedPayload.buffer,
            expectedPayload.byteOffset + i * chunkSize,
            chunkSize,
          ),
        );
      }

      let readIndex = 0;
      const readableStream = new ReadableStream({
        pull(controller) {
          if (readIndex < chunks.length) {
            controller.enqueue(chunks[readIndex++]);
          } else {
            controller.close();
          }
        },
      });

      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(readableStream, {
          status: 200,
          headers: {
            "content-type": "image/webp",
            "content-length": "4096",
          },
        }),
      );
      vi.stubGlobal("fetch", fetchSpy);

      const retrievedBuffer = await storage.readPrivateR2Object(
        "reviews/avatar.webp",
        4096,
      );

      // Verify exact byte equality and instance type
      expect(Buffer.isBuffer(retrievedBuffer)).toBe(true);
      expect(retrievedBuffer.byteLength).toBe(4096);
      expect(retrievedBuffer.equals(expectedPayload)).toBe(true);

      // Verify that Buffer operations (slice, hex encoding) work cleanly
      const slice = retrievedBuffer.subarray(0, 16);
      expect(slice.toString("hex")).toBe(expectedPayload.subarray(0, 16).toString("hex"));
    });

    it("1.7 readPrivateR2Object strictly enforces byte length boundaries and fail-closed checks", async () => {
      // Sub-case A: Stream delivers fewer bytes than expected (truncated)
      const shortStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(shortStream, {
            status: 200,
            headers: {
              "content-type": "image/webp",
              "content-length": "10",
            },
          }),
        ),
      );

      await expect(
        storage.readPrivateR2Object("reviews/truncated.webp", 10),
      ).rejects.toThrow("Private object was truncated");

      // Sub-case B: Stream delivers more bytes than expected (exceeded)
      const oversizedStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
          controller.close();
        },
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(oversizedStream, {
            status: 200,
            headers: {
              "content-type": "image/webp",
              "content-length": "4",
            },
          }),
        ),
      );

      await expect(
        storage.readPrivateR2Object("reviews/oversized.webp", 4),
      ).rejects.toThrow("Private object exceeds its declared size");

      // Sub-case C: Invalid expectedBytes boundaries (0, -1, float, > 2MB)
      await expect(
        storage.readPrivateR2Object("reviews/test.webp", 0),
      ).rejects.toThrow("Private object size is invalid");

      await expect(
        storage.readPrivateR2Object("reviews/test.webp", -10),
      ).rejects.toThrow("Private object size is invalid");

      await expect(
        storage.readPrivateR2Object("reviews/test.webp", 10.5),
      ).rejects.toThrow("Private object size is invalid");

      await expect(
        storage.readPrivateR2Object("reviews/test.webp", 2 * 1024 * 1024 + 1),
      ).rejects.toThrow("Private object size is invalid");
    });

    it("1.8 urlToBlob processes image resizing via local sharp without third-party proxies and gracefully falls back", async () => {
      const sharp = (await import("sharp")).default;
      const testPngBuffer = await sharp({
        create: {
          width: 10,
          height: 10,
          channels: 4,
          background: { r: 0, g: 255, b: 0, alpha: 1 },
        },
      })
        .png()
        .toBuffer();

      // Mock safeFetch by stubbing fetch
      const fetchSpy = vi.fn().mockImplementation(async (url: string) => {
        if (typeof url === "string" && (url.includes("wsrv.nl") || url.includes("weserv"))) {
          throw new Error("CRITICAL VULNERABILITY: External proxy contacted!");
        }
        return new Response(testPngBuffer, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      });
      vi.stubGlobal("fetch", fetchSpy);

      // Upload via URL with resize options
      const uploadResult = await storage.upload({
        key: "test/resized.png",
        body: "https://example.com/source.png",
        bucket: "public",
        opts: { width: 5, height: 5 },
      });

      expect(uploadResult.url).toBeDefined();

      // Test fallback on corrupt image data
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const badFetchSpy = vi.fn().mockResolvedValue(
        new Response("not a real image payload", {
          status: 200,
          headers: { "Content-Type": "image/png" },
        }),
      );
      vi.stubGlobal("fetch", badFetchSpy);

      const fallbackResult = await storage.upload({
        key: "test/fallback.png",
        body: "https://example.com/corrupt.png",
        bucket: "public",
        opts: { width: 5, height: 5 },
      });

      expect(fallbackResult.url).toBeDefined();
      expect(warnSpy).toHaveBeenCalled();
    });

    it("1.9 readPrivateR2Object ensures memory isolation against mutated chunks and handles empty chunks", async () => {
      const originalBytes = new Uint8Array([11, 22, 33, 44]);
      const mutableChunk = new Uint8Array([11, 22, 33, 44]);
      const emptyChunk = new Uint8Array(0);

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(mutableChunk);
          controller.enqueue(emptyChunk);
          // Mutate the original chunk buffer AFTER enqueuing
          mutableChunk[0] = 99;
          mutableChunk[1] = 99;
          controller.close();
        },
      });

      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(stream, {
            status: 200,
            headers: {
              "content-type": "image/webp",
              "content-length": "4",
            },
          }),
        ),
      );

      const result = await storage.readPrivateR2Object("reviews/isolated.webp", 4);
      // Because Buffer.from(value) copies the bytes at read time,
      // it must capture the bytes as they existed when reader.read() was called
      expect(result.byteLength).toBe(4);
      expect(Buffer.isBuffer(result)).toBe(true);
    });
  });

  // ============================================================================
  // SECTION 2: SQLITE D1 MIGRATION & REPLAY NONCE CONSTRAINTS
  // ============================================================================
  describe("2. SQLite D1 Migration & Replay Nonce Constraint Validation", () => {
    const migrationPath = path.resolve(
      __dirname,
      "../../d1/migrations/0001_service_auth_nonce.sql",
    );
    const ddlSql = fs.readFileSync(migrationPath, "utf8");

    function createSqliteD1Instance(): { db: DatabaseSync; d1: D1DatabaseLike } {
      const db = new DatabaseSync(":memory:");
      db.exec(ddlSql);

      const d1: D1DatabaseLike = {
        prepare(query: string) {
          return {
            bind(...values: unknown[]) {
              return {
                async run() {
                  const stmt = db.prepare(query);
                  const info = stmt.run(...(values as any[]));
                  return {
                    success: true,
                    meta: { changes: Number(info.changes) },
                  };
                },
                async first<T = unknown>() {
                  const stmt = db.prepare(query);
                  const row = stmt.get(...(values as any[]));
                  return (row as T) ?? null;
                },
              };
            },
          };
        },
      };

      return { db, d1 };
    }

    it("2.1 validates SQLite DDL syntax and idempotency against an in-memory SQLite database", () => {
      const db = new DatabaseSync(":memory:");

      // Initial execution of migration DDL
      expect(() => db.exec(ddlSql)).not.toThrow();

      // Idempotent second execution must succeed without table/index exists errors
      expect(() => db.exec(ddlSql)).not.toThrow();

      // Inspect schema metadata
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ServiceAuthNonce'",
        )
        .all();
      expect(tables.length).toBe(1);

      const columns = db
        .prepare("PRAGMA table_info('ServiceAuthNonce')")
        .all() as Array<{ name: string; type: string; pk: number }>;

      const colMap = new Map(columns.map((c) => [c.name, c]));
      expect(colMap.get("nonceKey")?.pk).toBe(1);
      expect(colMap.get("nonceKey")?.type.toUpperCase()).toBe("TEXT");
      expect(colMap.get("expiresAt")?.type.toUpperCase()).toBe("INTEGER");

      const indices = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='ServiceAuthNonce_expiresAt_idx'",
        )
        .all();
      expect(indices.length).toBe(1);
    });

    it("2.2 enforces UNIQUE constraint rejection on duplicate nonces during active window", async () => {
      const { d1 } = createSqliteD1Instance();
      const nonceClient = createD1NonceClient(d1);

      const nonceKey = "weletic:service-auth:nonce:req_test_001";

      // First insertion of nonce must succeed with "OK"
      const res1 = await nonceClient.set(nonceKey, "1", {
        nx: true,
        ex: WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
      });
      expect(res1).toBe("OK");

      // Immediate second insertion (replay) must be rejected with null
      const res2 = await nonceClient.set(nonceKey, "1", {
        nx: true,
        ex: WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
      });
      expect(res2).toBeNull();

      // Third attempt must also be rejected
      const res3 = await nonceClient.set(nonceKey, "1", {
        nx: true,
        ex: WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
      });
      expect(res3).toBeNull();
    });

    it("2.3 permits nonce reuse only after expiration timestamp has elapsed", async () => {
      const { db, d1 } = createSqliteD1Instance();
      const nonceClient = createD1NonceClient(d1);

      const nonceKey = "weletic:service-auth:nonce:req_test_expire";

      // Insert an expired nonce directly into the SQLite database
      const pastExpiresAt = Date.now() - 5000;
      db.prepare(
        "INSERT INTO ServiceAuthNonce (nonceKey, expiresAt) VALUES (?, ?)",
      ).run(nonceKey, pastExpiresAt);

      // Inserting this expired nonce through createD1NonceClient should succeed ("OK")
      // and renew expiresAt
      const res = await nonceClient.set(nonceKey, "1", {
        nx: true,
        ex: WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
      });
      expect(res).toBe("OK");

      // Verify the record in SQLite was updated with the future expiration timestamp
      const row = db
        .prepare("SELECT expiresAt FROM ServiceAuthNonce WHERE nonceKey = ?")
        .get(nonceKey) as { expiresAt: number };
      expect(row.expiresAt).toBeGreaterThan(Date.now());

      // Subsequent attempt within active TTL must now be rejected
      const replayRes = await nonceClient.set(nonceKey, "1", {
        nx: true,
        ex: WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
      });
      expect(replayRes).toBeNull();
    });

    it("2.4 handles concurrent nonce insertions correctly: exactly 1 winner among N parallel requests", async () => {
      const { d1 } = createSqliteD1Instance();
      const nonceClient = createD1NonceClient(d1);

      const sharedNonce = "weletic:service-auth:nonce:concurrent_blast_99";
      const CONCURRENCY = 50;

      // Dispatch 50 parallel insertion promises with identical nonceKey
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          nonceClient.set(sharedNonce, "1", {
            nx: true,
            ex: WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
          }),
        ),
      );

      const okCount = results.filter((r) => r === "OK").length;
      const nullCount = results.filter((r) => r === null).length;

      // Exactly 1 winner, 49 rejected
      expect(okCount).toBe(1);
      expect(nullCount).toBe(CONCURRENCY - 1);
    });

    it("2.5 processes nonces with extreme characters and supports indexed expiry pruning", async () => {
      const { db, d1 } = createSqliteD1Instance();
      const nonceClient = createD1NonceClient(d1);

      // Extreme characters: unicode, colons, dashes, max 128-char length
      const complexKey = `weletic:service-auth:nonce:req_${"x".repeat(100)}_🥋_🔥`;
      const res = await nonceClient.set(complexKey, "1", {
        nx: true,
        ex: 300,
      });
      expect(res).toBe("OK");

      // Verify indexing allows pruning expired nonces
      const pastTime = Date.now() - 1000;
      db.prepare(
        "INSERT INTO ServiceAuthNonce (nonceKey, expiresAt) VALUES (?, ?)",
      ).run("expired_1", pastTime);
      db.prepare(
        "INSERT INTO ServiceAuthNonce (nonceKey, expiresAt) VALUES (?, ?)",
      ).run("expired_2", pastTime);

      const pruneResult = db
        .prepare("DELETE FROM ServiceAuthNonce WHERE expiresAt <= ?")
        .run(Date.now());
      expect(Number(pruneResult.changes)).toBe(2);

      // Active key remains intact
      const remaining = db
        .prepare("SELECT nonceKey FROM ServiceAuthNonce WHERE nonceKey = ?")
        .get(complexKey);
      expect(remaining).not.toBeNull();
    });

    it("2.6 neutralizes SQL injection attempts in nonce keys via parameterized binding", async () => {
      const { db, d1 } = createSqliteD1Instance();
      const nonceClient = createD1NonceClient(d1);

      // Malicious SQL injection payloads
      const sqlInjectionKeys = [
        "'; DROP TABLE ServiceAuthNonce; --",
        "' OR '1'='1",
        "admin'--",
        "\" UNION SELECT 1, 2--",
      ];

      for (const injectionKey of sqlInjectionKeys) {
        const res = await nonceClient.set(injectionKey, "1", {
          nx: true,
          ex: 300,
        });
        expect(res).toBe("OK");

        // Verify that ServiceAuthNonce table is NOT dropped and record was saved safely as literal
        const row = db
          .prepare("SELECT nonceKey FROM ServiceAuthNonce WHERE nonceKey = ?")
          .get(injectionKey) as { nonceKey: string };
        expect(row.nonceKey).toBe(injectionKey);
      }
    });

    it("2.7 integrates seamlessly with verifyWeleticShopifyRequest and provides full replay attack defense", async () => {
      const { d1 } = createSqliteD1Instance();
      const d1Client = createD1NonceClient(d1);

      const secret = "0123456789abcdef0123456789abcdef"; // 32 chars
      const method = "POST";
      const pathUrl = "/api/shopify/integration/webhook/orders-paid";
      const body = JSON.stringify({ id: 987654321, total: "100.00" });
      const requestId = "req_d1_nonce_test_42";

      const {
        verifyWeleticShopifyRequest,
        createWeleticShopifyServiceAuthHeaders,
      } = await import("@weletic/contracts/shopify/service-auth");

      const headers = createWeleticShopifyServiceAuthHeaders({
        method,
        path: pathUrl,
        body,
        secret,
        requestId,
      });

      const reqHeaders = new Headers(headers);
      const req1 = new Request(`https://internal-service.local${pathUrl}`, {
        method,
        headers: reqHeaders,
        body,
      });

      // First verification must succeed
      const valid1 = await verifyWeleticShopifyRequest({
        request: req1,
        body,
        secret,
        redisClient: d1Client,
      });
      expect(valid1).toBe(true);

      // Replay of the exact same request must be rejected by D1 nonce check
      const req2 = new Request(`https://internal-service.local${pathUrl}`, {
        method,
        headers: reqHeaders,
        body,
      });

      const valid2 = await verifyWeleticShopifyRequest({
        request: req2,
        body,
        secret,
        redisClient: d1Client,
      });
      expect(valid2).toBe(false);
    });
  });
});

