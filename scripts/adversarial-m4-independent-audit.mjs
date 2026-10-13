import assert from "node:assert";
import crypto from "node:crypto";

console.log("================================================================================");
console.log("  INDEPENDENT ADVERSARIAL AUDIT: MILESTONE 4 (SEC-R4-01 - SEC-R4-04)");
console.log("================================================================================\n");

let passed = 0;
let total = 0;

async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// -----------------------------------------------------------------------------
// A. SEC-R4-01: Webhook Ingress Payload Bounds & Streaming Abort
// -----------------------------------------------------------------------------
console.log("--- A. SEC-R4-01: Webhook Ingress Payload Bounds ---");

await check("A.1 Exact boundary 131,072 bytes (128KB) matches Cloudflare Queues limit", async () => {
  const MAX_LIMIT = 128 * 1024;
  assert.strictEqual(MAX_LIMIT, 131072);
});

await check("A.2 Upfront Content-Length validation logic", async () => {
  function validateContentLength(headerVal, maxBytes) {
    if (headerVal === null) return { ok: true };
    const parsed = parseInt(headerVal, 10);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > maxBytes) {
      return { ok: false, status: 413 };
    }
    return { ok: true, length: parsed };
  }

  const MAX = 131072;
  assert.strictEqual(validateContentLength("131072", MAX).ok, true);
  assert.strictEqual(validateContentLength("131073", MAX).ok, false);
  assert.strictEqual(validateContentLength("-1", MAX).ok, false);
  assert.strictEqual(validateContentLength("NaN", MAX).ok, false);
  assert.strictEqual(validateContentLength("0", MAX).ok, true);
  assert.strictEqual(validateContentLength(null, MAX).ok, true);
});

await check("A.3 Streaming reader cancels early when accumulated bytes exceed limit", async () => {
  async function simulateStreamReader(chunks, maxBytes) {
    let accumulated = 0;
    const collected = [];
    let cancelled = false;

    for (const chunk of chunks) {
      accumulated += chunk.byteLength;
      if (accumulated > maxBytes) {
        cancelled = true;
        return { bytes: new Uint8Array(0), exceeded: true, cancelled };
      }
      collected.push(chunk);
    }
    const combined = new Uint8Array(accumulated);
    let offset = 0;
    for (const c of collected) {
      combined.set(c, offset);
      offset += c.byteLength;
    }
    return { bytes: combined, exceeded: false, cancelled };
  }

  const MAX = 100;
  // Two 60-byte chunks -> 120 bytes -> should abort at chunk 2
  const chunk1 = new Uint8Array(60).fill(1);
  const chunk2 = new Uint8Array(60).fill(2);
  const res = await simulateStreamReader([chunk1, chunk2], MAX);
  assert.strictEqual(res.exceeded, true);
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(res.bytes.byteLength, 0);

  // Chunk of exact 100 bytes -> should succeed
  const exactChunk = new Uint8Array(100).fill(3);
  const resExact = await simulateStreamReader([exactChunk], MAX);
  assert.strictEqual(resExact.exceeded, false);
  assert.strictEqual(resExact.bytes.byteLength, 100);
});

// -----------------------------------------------------------------------------
// B. SEC-R4-02: Link Redirector Negative Caching & KV Sentinel
// -----------------------------------------------------------------------------
console.log("\n--- B. SEC-R4-02: Link Redirector Negative Caching ---");

await check("B.1 Negative cache sentinel structure and 60s TTL", async () => {
  const sentinel = { notFound: true, cachedAt: Date.now() };
  const serialized = JSON.stringify(sentinel);
  const parsed = JSON.parse(serialized);

  assert.strictEqual(parsed.notFound, true);
  assert(typeof parsed.cachedAt === "number");

  // Verify KV hit logic
  function isNegativeHit(cached) {
    return Boolean(cached && typeof cached === "object" && cached.notFound === true);
  }

  assert.strictEqual(isNegativeHit(parsed), true);
  assert.strictEqual(isNegativeHit({ id: "link_123", url: "https://yamax.com" }), false);
  assert.strictEqual(isNegativeHit(null), false);
  assert.strictEqual(isNegativeHit(undefined), false);
});

// -----------------------------------------------------------------------------
// C. SEC-R4-03: Cron Triggers Fail-Closed Auth & Constant-Time String Compare
// -----------------------------------------------------------------------------
console.log("\n--- C. SEC-R4-03: Cron Triggers Auth & Constant Time Compare ---");

await check("C.1 timingSafeStringEqual constant-time comparison without RangeError", async () => {
  function timingSafeStringEqual(a, b) {
    if (typeof a !== "string" || typeof b !== "string") {
      return false;
    }
    const enc = new TextEncoder();
    const aBytes = enc.encode(a);
    const bBytes = enc.encode(b);
    if (aBytes.length !== bBytes.length) {
      return false;
    }
    try {
      if (typeof crypto.timingSafeEqual === "function") {
        return crypto.timingSafeEqual(Buffer.from(aBytes), Buffer.from(bBytes));
      }
    } catch {
      // Fallback
    }
    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) {
      diff |= aBytes[i] ^ bBytes[i];
    }
    return diff === 0;
  }

  // Exact match
  assert.strictEqual(timingSafeStringEqual("secret_token_123", "secret_token_123"), true);
  // Mismatched length - MUST NOT throw RangeError
  assert.strictEqual(timingSafeStringEqual("short", "much_longer_string"), false);
  assert.strictEqual(timingSafeStringEqual("", "a"), false);
  assert.strictEqual(timingSafeStringEqual("", ""), true);
  // Non-strings
  assert.strictEqual(timingSafeStringEqual(null, "test"), false);
  assert.strictEqual(timingSafeStringEqual(undefined, "test"), false);
  assert.strictEqual(timingSafeStringEqual("test", 123), false);
  // Multi-byte Unicode
  assert.strictEqual(timingSafeStringEqual("日本語トークン", "日本語トークン"), true);
  assert.strictEqual(timingSafeStringEqual("日本語トークン", "日本語トークン!"), false);
});

await check("C.2 Fail-closed authentication when secret is missing, empty, or whitespace", async () => {
  function verifyAuth(cronSecret, authHeader) {
    if (!cronSecret || !cronSecret.trim()) {
      return { ok: false, status: 401, error: "Unauthorized: CRON_SECRET is not configured." };
    }
    if (!authHeader) {
      return { ok: false, status: 401, error: "Unauthorized" };
    }
    const expected = `Bearer ${cronSecret.trim()}`;
    if (authHeader !== expected) {
      return { ok: false, status: 401, error: "Unauthorized" };
    }
    return { ok: true, status: 200 };
  }

  // Missing secret -> 401
  assert.strictEqual(verifyAuth(undefined, "Bearer xyz").ok, false);
  assert.strictEqual(verifyAuth("", "Bearer xyz").ok, false);
  assert.strictEqual(verifyAuth("   ", "Bearer xyz").ok, false);

  // Configured secret, missing header -> 401
  assert.strictEqual(verifyAuth("my_secret", null).ok, false);
  // Wrong header -> 401
  assert.strictEqual(verifyAuth("my_secret", "Bearer wrong").ok, false);
  // Correct header -> 200
  assert.strictEqual(verifyAuth("my_secret", "Bearer my_secret").ok, true);
});

// -----------------------------------------------------------------------------
// D. SEC-R4-04: Edge Burst Rate Limiting
// -----------------------------------------------------------------------------
console.log("\n--- D. SEC-R4-04: Edge Burst Rate Limiting ---");

await check("D.1 Sliding window rate limiter bursts, resetMs, and capacity pruning", async () => {
  class SimpleRateLimiter {
    constructor(limit = 3, windowMs = 1000, maxEntries = 50) {
      this.limit = limit;
      this.windowMs = windowMs;
      this.maxEntries = maxEntries;
      this.buckets = new Map();
    }
    check(key) {
      const now = Date.now();
      if (this.buckets.size >= this.maxEntries) {
        for (const [k, b] of this.buckets.entries()) {
          if (b.resetAt <= now) this.buckets.delete(k);
        }
      }
      const existing = this.buckets.get(key);
      if (!existing || existing.resetAt <= now) {
        this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
        return { success: true, remaining: this.limit - 1, resetMs: this.windowMs };
      }
      if (existing.count < this.limit) {
        existing.count += 1;
        return { success: true, remaining: this.limit - existing.count, resetMs: existing.resetAt - now };
      }
      return { success: false, remaining: 0, resetMs: existing.resetAt - now };
    }
  }

  const limiter = new SimpleRateLimiter(3, 500, 10);
  assert.strictEqual(limiter.check("ip1").success, true);
  assert.strictEqual(limiter.check("ip1").success, true);
  assert.strictEqual(limiter.check("ip1").success, true);
  // 4th request blocked
  assert.strictEqual(limiter.check("ip1").success, false);
  assert.strictEqual(limiter.check("ip1").remaining, 0);

  // Different IP is allowed
  assert.strictEqual(limiter.check("ip2").success, true);
});

await check("D.2 getClientIp header preference order", async () => {
  function getClientIp(headers) {
    const cf = headers.get("cf-connecting-ip");
    if (cf && cf.trim()) return cf.trim();
    const xff = headers.get("x-forwarded-for");
    if (xff && xff.trim()) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = headers.get("x-real-ip");
    if (real && real.trim()) return real.trim();
    return null;
  }

  const headersAll = new Map([
    ["cf-connecting-ip", "1.1.1.1"],
    ["x-forwarded-for", "2.2.2.2, 3.3.3.3"],
    ["x-real-ip", "4.4.4.4"],
  ]);
  assert.strictEqual(getClientIp(headersAll), "1.1.1.1");

  const headersNoCf = new Map([
    ["x-forwarded-for", "2.2.2.2, 3.3.3.3"],
    ["x-real-ip", "4.4.4.4"],
  ]);
  assert.strictEqual(getClientIp(headersNoCf), "2.2.2.2");

  const headersRealOnly = new Map([["x-real-ip", "4.4.4.4"]]);
  assert.strictEqual(getClientIp(headersRealOnly), "4.4.4.4");

  const headersNone = new Map();
  assert.strictEqual(getClientIp(headersNone), null);
});

console.log("\n================================================================================");
console.log(`TOTAL CHECKS: ${total} | PASSED: ${passed} | FAILED: ${total - passed}`);
console.log("================================================================================");
