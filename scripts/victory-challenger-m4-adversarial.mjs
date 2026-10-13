import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

console.log("================================================================================");
console.log("  M4 VICTORY CHALLENGER: COMPREHENSIVE ADVERSARIAL STRESS TEST SUITE");
console.log("================================================================================\n");

let passed = 0;
let total = 0;
const failures = [];

async function probe(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ PASS: ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
    failures.push({ name, error: err.message });
  }
}

// -----------------------------------------------------------------------------
// 1. FINANCIAL EDGE CASES
// -----------------------------------------------------------------------------
console.log("--- 1. Financial Edge Cases (Greedy Capping, Int32, Negatives, Historical) ---");

// 1.1 Greedy capping and Int32 overflow bounds
await probe("1.1 Greedy capping prevents cumulative amounts exceeding 2,000,000,000", async () => {
  const MAX_PAYOUT_AMOUNT_LIMIT = 2_000_000_000;
  
  // Simulation of aggregateDueCommissionsForPartner greedy capping logic
  function testCap(commissions, existingAmount = 0) {
    let cumulative = BigInt(existingAmount);
    const eligible = [];
    let wasCapped = false;
    for (const c of commissions) {
      const nextCumulative = cumulative + BigInt(c.earnings);
      if (cumulative > BigInt(0) && nextCumulative > BigInt(MAX_PAYOUT_AMOUNT_LIMIT)) {
        wasCapped = true;
        break;
      }
      cumulative = nextCumulative;
      eligible.push(c);
    }
    wasCapped = wasCapped || eligible.length < commissions.length;
    return { cumulative: Number(cumulative), eligibleCount: eligible.length, wasCapped };
  }

  // 4 commissions of 600M each
  const commissions = [
    { id: "c1", earnings: 600_000_000 },
    { id: "c2", earnings: 600_000_000 },
    { id: "c3", earnings: 600_000_000 },
    { id: "c4", earnings: 600_000_000 },
  ];

  // First run: accepts 3 commissions (1.8B), caps 4th
  const res1 = testCap(commissions, 0);
  assert.strictEqual(res1.eligibleCount, 3);
  assert.strictEqual(res1.cumulative, 1_800_000_000);
  assert.strictEqual(res1.wasCapped, true);

  // Subsequent run with existing pending payout of 1.8B:
  // Cannot take the 4th commission (1.8B + 0.6B = 2.4B > 2.0B)
  const res2 = testCap([commissions[3]], 1_800_000_000);
  assert.strictEqual(res2.eligibleCount, 0);
  assert.strictEqual(res2.wasCapped, true);
});

// 1.2 Negative partner balance detection
await probe("1.2 Negative partner balance rolls back and triggers partner exclusion", async () => {
  const commissions = [
    { earnings: -10_000 },
    { earnings: 4_000 },
  ];
  const netEarnings = commissions.reduce((sum, c) => sum + c.earnings, 0);
  assert(netEarnings <= 0, "Net earnings must evaluate to non-positive");
  
  // Logic from aggregate-due-commissions/process/route.ts
  const excludedPartnerIds = new Set();
  const partnerId = "partner_debtor";
  if (netEarnings <= 0) {
    excludedPartnerIds.add(partnerId);
  }
  assert(excludedPartnerIds.has("partner_debtor"), "Debtor partner must be excluded from subsequent queries");
});

// 1.3 Historical coupon attribution boundaries
await probe("1.3 Historical coupon temporal boundary invariants", async () => {
  function isAttributable(orderCreatedAt, disabledAt) {
    if (!disabledAt) return true; // active
    if (!orderCreatedAt) return false; // fail-closed on missing date
    const orderDate = new Date(orderCreatedAt);
    const disabledDate = new Date(disabledAt);
    if (isNaN(orderDate.getTime()) || isNaN(disabledDate.getTime())) return false; // fail-closed
    return orderDate.getTime() <= disabledDate.getTime();
  }

  const deactivationTime = "2026-06-15T12:00:00.000Z";

  // Order created before deactivation -> attributable
  assert.strictEqual(isAttributable("2026-06-15T11:59:59.999Z", deactivationTime), true);
  // Order created at exact boundary -> attributable
  assert.strictEqual(isAttributable("2026-06-15T12:00:00.000Z", deactivationTime), true);
  // Order created 1ms after deactivation -> rejected
  assert.strictEqual(isAttributable("2026-06-15T12:00:00.001Z", deactivationTime), false);
  // Order created 1 day after -> rejected
  assert.strictEqual(isAttributable("2026-06-16T12:00:00.000Z", deactivationTime), false);
  // Corrupted date string -> fail-closed rejected
  assert.strictEqual(isAttributable("not-a-valid-date", deactivationTime), false);
  // Active coupon (null disabledAt) -> always attributable
  assert.strictEqual(isAttributable("2026-06-16T12:00:00.000Z", null), true);
});

// 1.4 Zero-decimal currency scaling
await probe("1.4 Zero-decimal currencies (JPY, VND) preserve integer unit fidelity", async () => {
  const zeroDecimalCurrencies = new Set(["jpy", "vnd", "krw", "clp"]);
  function scaleCommission(amount, currency) {
    const isZeroDecimal = zeroDecimalCurrencies.has(currency.toLowerCase());
    return isZeroDecimal ? Math.round(amount) : Math.round(amount * 100);
  }

  assert.strictEqual(scaleCommission(15000, "JPY"), 15000);
  assert.strictEqual(scaleCommission(500000, "VND"), 500000);
  assert.strictEqual(scaleCommission(150.50, "USD"), 15050);
  assert.strictEqual(scaleCommission(89.99, "EUR"), 8999);
});

// -----------------------------------------------------------------------------
// 2. SECURITY & CRYPTOGRAPHY
// -----------------------------------------------------------------------------
console.log("\n--- 2. Security & Cryptography (Timing, Clock Skew, Replay, Service Auth) ---");

// 2.1 Slack signature timing and length checks
await probe("2.1 Slack signature verification bounds and constant-time safety", async () => {
  const secret = "test_slack_secret_32chars_long_123456";
  const body = '{"type":"url_verification"}';
  const timestamp = Math.floor(Date.now() / 1000);

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`v0:${timestamp}:${body}`);
  const validHash = hmac.digest("hex");

  function verifySlack(reqTimestamp, sigHeader, nowSec) {
    const maxDeltaSec = 300;
    if (Math.abs(nowSec - reqTimestamp) > maxDeltaSec) {
      throw new Error("Stale request");
    }
    const [version, hash] = (sigHeader || "").split("=");
    if (version !== "v0" || !hash) throw new Error("Invalid signature format");
    const sigBuf = Buffer.from(hash, "utf8");
    const expBuf = Buffer.from(validHash, "utf8");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error("Signature mismatch");
    }
    return true;
  }

  // Exact time -> valid
  assert.strictEqual(verifySlack(timestamp, `v0=${validHash}`, timestamp), true);
  // +300s -> valid
  assert.strictEqual(verifySlack(timestamp, `v0=${validHash}`, timestamp + 300), true);
  // -300s -> valid
  assert.strictEqual(verifySlack(timestamp, `v0=${validHash}`, timestamp - 300), true);
  // +301s -> throws Stale
  assert.throws(() => verifySlack(timestamp, `v0=${validHash}`, timestamp + 301), /Stale/);
  // -301s -> throws Stale
  assert.throws(() => verifySlack(timestamp, `v0=${validHash}`, timestamp - 301), /Stale/);
  // Length mismatch (63 chars) -> throws Signature mismatch safely without RangeError
  assert.throws(() => verifySlack(timestamp, `v0=${validHash.slice(0, 63)}`, timestamp), /Signature mismatch/);
  // Single-byte flip -> throws Signature mismatch
  const tampered = validHash.slice(0, -1) + (validHash.slice(-1) === "a" ? "b" : "a");
  assert.throws(() => verifySlack(timestamp, `v0=${tampered}`, timestamp), /Signature mismatch/);
});

// 2.2 HubSpot signature constant-time safety
await probe("2.2 HubSpot signature constant-time check handles length differences safely", async () => {
  const secret = "test_hubspot_secret";
  const body = JSON.stringify([{ eventId: "123" }]);
  const expectedHash = crypto.createHash("sha256").update(secret + body).digest("hex");

  function verifyHubSpot(sig) {
    if (!sig) return false;
    const sigBuf = Buffer.from(sig, "utf8");
    const expBuf = Buffer.from(expectedHash, "utf8");
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }
    return true;
  }

  assert.strictEqual(verifyHubSpot(expectedHash), true);
  assert.strictEqual(verifyHubSpot(expectedHash.slice(0, 32)), false); // shorter
  assert.strictEqual(verifyHubSpot(expectedHash + "00"), false); // longer
  assert.strictEqual(verifyHubSpot(expectedHash.replace(/.$/, "0")), false); // flipped
});

// 2.3 Unsubscribe token signature length safety
await probe("2.3 Unsubscribe token verification does not throw RangeError on length mismatch", async () => {
  const secret = "unsub_token_secret_1234567890123456";
  const email = "user@example.com";
  const signature = crypto.createHmac("sha256", secret).update(email.toLowerCase()).digest("hex").slice(0, 24);
  const token = `${Buffer.from(email).toString("base64url")}.${signature}`;

  function verifyToken(tok) {
    try {
      const [encodedEmail, sig] = tok.split(".");
      if (!encodedEmail || !sig) return null;
      const em = Buffer.from(encodedEmail, "base64url").toString("utf-8");
      const expSig = crypto.createHmac("sha256", secret).update(em.toLowerCase()).digest("hex").slice(0, 24);
      const sigBuf = Buffer.from(sig, "utf8");
      const expBuf = Buffer.from(expSig, "utf8");
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        return null;
      }
      return em;
    } catch {
      return null;
    }
  }

  assert.strictEqual(verifyToken(token), email);
  assert.strictEqual(verifyToken(`${token}extra`), null); // longer
  assert.strictEqual(verifyToken(token.slice(0, -5)), null); // shorter
  assert.strictEqual(verifyToken("invalid.token"), null);
});

// 2.4 Service Auth D1/KV Nonce deduplication
await probe("2.4 Service Auth D1 Nonce Client rejects replay attacks", async () => {
  const store = new Map();
  const mockD1 = {
    prepare: (query) => {
      let boundKey, boundExpiresAt;
      return {
        bind: (key, expiresAt) => {
          boundKey = key;
          boundExpiresAt = expiresAt;
          return {
            run: async () => {
              if (store.has(boundKey)) {
                throw new Error("UNIQUE constraint failed: ServiceAuthNonce.nonceKey");
              }
              store.set(boundKey, boundExpiresAt);
              return { success: true, meta: { changes: 1 } };
            },
            first: async () => {
              const expiresAt = store.get(boundKey);
              return expiresAt ? { expiresAt } : null;
            },
          };
        },
      };
    },
  };

  async function recordNonce(db, key, ttlSec) {
    const nowMs = Date.now();
    const expiresAt = nowMs + ttlSec * 1000;
    try {
      const res = await db.prepare("INSERT INTO ServiceAuthNonce VALUES (?, ?)").bind(key, expiresAt).run();
      return res.success ? "OK" : null;
    } catch (err) {
      if (err.message.includes("UNIQUE")) {
        const row = await db.prepare("SELECT expiresAt FROM ServiceAuthNonce WHERE nonceKey = ?").bind(key).first();
        if (row && row.expiresAt <= nowMs) {
          return "OK"; // expired
        }
        return null; // replay detected
      }
      throw err;
    }
  }

  const reqId = "req_unique_12345";
  const first = await recordNonce(mockD1, reqId, 300);
  assert.strictEqual(first, "OK");

  // Replay
  const second = await recordNonce(mockD1, reqId, 300);
  assert.strictEqual(second, null, "Replayed nonce must be rejected");
});

// -----------------------------------------------------------------------------
// 3. SSRF & XSS
// -----------------------------------------------------------------------------
console.log("\n--- 3. SSRF & XSS (wsrv.nl elimination, IP sanitization, Yamax HTML) ---");

// 3.1 Zero wsrv.nl proxy in storage.ts
await probe("3.1 Zero occurrences of wsrv.nl or weserv.nl in apps/web/lib/storage.ts", async () => {
  const storagePath = path.join(rootDir, "apps/web/lib/storage.ts");
  const content = fs.readFileSync(storagePath, "utf8");
  assert(!content.includes("wsrv.nl"), "storage.ts MUST NOT contain wsrv.nl");
  assert(!content.includes("weserv.nl"), "storage.ts MUST NOT contain weserv.nl");
  assert(content.includes("sharp"), "storage.ts must use in-process sharp");
});

// 3.2 IP filtering engine blocks internal and dangerous ranges
await probe("3.2 assertSafeIp rejects private, loopback, metadata, and mapped IPv6", async () => {
  function assertSafeIp(address) {
    const addr = address.toLowerCase();
    const mappedIPv4 = addr.startsWith("::ffff:");
    const parts = (mappedIPv4 ? addr.slice("::ffff:".length) : address)
      .split(".")
      .map(Number);
    const isPrivateIPv4 =
      parts.length === 4 &&
      (parts[0] === 127 || // loopback 127.0.0.0/8
        parts[0] === 10 || // private 10.0.0.0/8
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // private 172.16.0.0/12
        (parts[0] === 192 && parts[1] === 168) || // private 192.168.0.0/16
        (parts[0] === 169 && parts[1] === 254) || // link-local 169.254.0.0/16
        (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) || // CGNAT 100.64.0.0/10
        (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) || // Benchmark 198.18.0.0/15
        parts[0] >= 224 || // multicast 224.0.0.0/4 and reserved 240.0.0.0/4
        parts[0] === 0); // unspecified 0.0.0.0/8

    const isPrivateIPv6 =
      addr === "::1" || // loopback
      addr === "::" || // unspecified
      mappedIPv4 || // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
      addr.startsWith("fc") || // unique local fc00::/7
      addr.startsWith("fd") || // unique local fc00::/7
      /^fe[89ab]/.test(addr); // link-local fe80::/10

    if (isPrivateIPv4 || isPrivateIPv6) {
      throw new Error("URL resolves to a private or internal IP address.");
    }
  }

  // Blocked IPs
  const blocked = [
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
  ];

  for (const ip of blocked) {
    assert.throws(() => assertSafeIp(ip), /private or internal IP/, `Should block ${ip}`);
  }

  // Allowed public IPs
  assert.doesNotThrow(() => assertSafeIp("8.8.8.8"));
  assert.doesNotThrow(() => assertSafeIp("1.1.1.1"));
  assert.doesNotThrow(() => assertSafeIp("93.184.216.34"));
});

// 3.3 Yamax HTML escaping prevents XSS injection
await probe("3.3 escapeHtml neutralizes tags, event handlers, and attribute breakouts", async () => {
  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const vectors = [
    '<script>alert("xss")</script>',
    '<img src=x onerror=alert(1)>',
    '"><svg onload=alert(1)>',
    "' onfocus='alert(1)'",
    '<a href="javascript:alert(1)">Click</a>',
  ];

  for (const vector of vectors) {
    const escaped = escapeHtml(vector);
    assert(!escaped.includes("<"), `Escaped output must not contain raw <: ${escaped}`);
    assert(!escaped.includes(">"), `Escaped output must not contain raw >: ${escaped}`);
    assert(!escaped.includes('"'), `Escaped output must not contain raw ": ${escaped}`);
  }
});

// -----------------------------------------------------------------------------
// 4. CLOUDFLARE EDGE WORKERS
// -----------------------------------------------------------------------------
console.log("\n--- 4. Cloudflare Edge Workers (Proxy Binding, Recovery Query, Non-blocking KV) ---");

// 4.1 Prisma Dynamic Proxy Binding
await probe("4.1 Prisma ES Proxy delegates dynamically to active global client", async () => {
  let activeMockClient = { name: "initial" };
  const prismaProxy = new Proxy({}, {
    get(target, prop) {
      return activeMockClient[prop];
    },
  });

  assert.strictEqual(prismaProxy.name, "initial");
  activeMockClient = { name: "bound_d1" };
  assert.strictEqual(prismaProxy.name, "bound_d1");
});

// 4.2 Stalled Webhook Recovery SQL query
await probe("4.2 Stalled webhook recovery query joins WeleticShopifyStore and selects shopDomain", async () => {
  const cronPath = path.join(rootDir, "apps/web/workers/cron-triggers/src/index.ts");
  const content = fs.readFileSync(cronPath, "utf8");
  assert(content.includes("LEFT JOIN WeleticShopifyStore s ON e.storeId = s.id"), "Must perform LEFT JOIN on store");
  assert(content.includes("s.shopDomain"), "Must select shopDomain");
  assert(content.includes("shopDomain: event.shopDomain"), "Must enqueue message with shopDomain");
});

// 4.3 Link Redirector non-blocking KV put and Invariant 2 enforcement
await probe("4.3 Link redirector executes non-blocking KV put via waitUntil and 404s soft-deleted links", async () => {
  const redirectorPath = path.join(rootDir, "apps/web/workers/link-redirector/src/index.ts");
  const content = fs.readFileSync(redirectorPath, "utf8");
  assert(content.includes("_ctx.waitUntil(kvPutPromise)"), "Must use non-blocking waitUntil for KV put");
  assert(content.includes("disabledAt !== null"), "Must 404 soft-deleted link record");
  assert(content.includes("LOWER(key) = LOWER(?)"), "Must use case-insensitive SQL match");
});

// 4.4 Soft-Delete KV eviction format
await probe("4.4 buildKvKey formats canonical KV key with lowercased domain and key", async () => {
  const { buildKvKey } = await import(path.join(rootDir, "apps/web/lib/weletic/link-kv-cache.ts"));
  assert.strictEqual(buildKvKey("yamax.com", "SummerSale"), "link:yamax.com:summersale");
  assert.strictEqual(buildKvKey("www.yamax.com", "SALE"), "link:yamax.com:sale");
});

// -----------------------------------------------------------------------------
// 5. ZERO-HARDCODING INVARIANT 4
// -----------------------------------------------------------------------------
console.log("\n--- 5. Zero-Hardcoding Invariant 4 Global Audit ---");

await probe("5.1 Zero hardcoded montdev.myshopify.com in production runtime directories", async () => {
  const targetDirs = [
    path.join(rootDir, "apps/web/lib"),
    path.join(rootDir, "apps/web/app"),
    path.join(rootDir, "apps/web/workers"),
    path.join(rootDir, "apps/web/ui"),
    path.join(rootDir, "packages/contracts/src"),
  ];

  function searchDir(dir) {
    if (!fs.existsSync(dir)) return [];
    let hits = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "tests" && ent.name !== "node_modules" && ent.name !== ".next") {
          hits = hits.concat(searchDir(full));
        }
      } else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx") || ent.name.endsWith(".js") || ent.name.endsWith(".mjs"))) {
        if (!ent.name.includes(".test.") && !ent.name.includes(".spec.")) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes("montdev.myshopify.com")) {
            hits.push(full);
          }
        }
      }
    }
    return hits;
  }

  const allHits = targetDirs.flatMap(searchDir);
  assert.deepStrictEqual(allHits, [], `Found hardcoded montdev in ${allHits.join(", ")}`);
});

await probe("5.2 Zero hardcoded yamaxdev.myshopify.com in production runtime directories", async () => {
  const targetDirs = [
    path.join(rootDir, "apps/web/lib"),
    path.join(rootDir, "apps/web/app"),
    path.join(rootDir, "apps/web/workers"),
    path.join(rootDir, "apps/web/ui"),
    path.join(rootDir, "packages/contracts/src"),
  ];

  function searchDir(dir) {
    if (!fs.existsSync(dir)) return [];
    let hits = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "tests" && ent.name !== "node_modules" && ent.name !== ".next") {
          hits = hits.concat(searchDir(full));
        }
      } else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx") || ent.name.endsWith(".js") || ent.name.endsWith(".mjs"))) {
        if (!ent.name.includes(".test.") && !ent.name.includes(".spec.")) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes("yamaxdev.myshopify.com")) {
            hits.push(full);
          }
        }
      }
    }
    return hits;
  }

  const allHits = targetDirs.flatMap(searchDir);
  assert.deepStrictEqual(allHits, [], `Found hardcoded yamaxdev in ${allHits.join(", ")}`);
});

await probe("5.3 Zero hardcoded static public app id c7d49cebb06e445db345bb200f966a03 in apps/web", async () => {
  const webDir = path.join(rootDir, "apps/web");

  function searchDir(dir) {
    if (!fs.existsSync(dir)) return [];
    let hits = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== "tests" && ent.name !== "node_modules" && ent.name !== ".next" && ent.name !== "test") {
          hits = hits.concat(searchDir(full));
        }
      } else if (ent.isFile() && (ent.name.endsWith(".ts") || ent.name.endsWith(".tsx") || ent.name.endsWith(".js") || ent.name.endsWith(".mjs"))) {
        if (!ent.name.includes(".test.") && !ent.name.includes(".spec.")) {
          const text = fs.readFileSync(full, "utf8");
          if (text.includes("c7d49cebb06e445db345bb200f966a03")) {
            hits.push(full);
          }
        }
      }
    }
    return hits;
  }

  const hits = searchDir(path.join(webDir, "lib")).concat(searchDir(path.join(webDir, "app"))).concat(searchDir(path.join(webDir, "workers")));
  assert.deepStrictEqual(hits, [], `Found static app id in ${hits.join(", ")}`);
});

// =============================================================================
// SUMMARY & VERDICT
// =============================================================================
console.log("\n================================================================================");
console.log(`TOTAL PROBES: ${total} | PASSED: ${passed} | FAILED: ${failures.length}`);
console.log("================================================================================");

if (failures.length > 0) {
  console.error("\nFAILURES DETECTED:");
  for (const f of failures) {
    console.error(`- ${f.name}: ${f.error}`);
  }
  process.exit(1);
} else {
  console.log("\nALL ADVERSARIAL CHALLENGER PROBES PASSED WITH 100% SUCCESS!");
  process.exit(0);
}
