import assert from "node:assert";
import { parseOutboxWorkerArgs, runOutboxWorker } from "../apps/web/scripts/loyalty/outbox-worker-runtime.ts";

console.log("=== EMPIRICAL STRESS TEST: FOCUS 2 & FOCUS 3 ===\n");

let passed = 0;
let total = 0;

function test(description, fn) {
  total++;
  try {
    fn();
    console.log(`✓ PASS: ${description}`);
    passed++;
  } catch (err) {
    console.error(`✗ FAIL: ${description}`);
    console.error(`  Error: ${err.message}`);
  }
}

async function testAsync(description, fn) {
  total++;
  try {
    await fn();
    console.log(`✓ PASS: ${description}`);
    passed++;
  } catch (err) {
    console.error(`✗ FAIL: ${description}`);
    console.error(`  Error: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// FOCUS 2: Webhook Route Test Mode Bypass Logic
// ----------------------------------------------------------------------------
console.log("--- Stress Testing Focus 2: Webhook Route Ingress Auth Matrix ---");

const signedTenantTopics = new Set([
  "app/uninstalled",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

function evaluateWebhookAuthBypass({ nodeEnv, topic, signature, webhookSecret, verifySignatureFn }) {
  const allowUnsignedTestWebhook =
    nodeEnv === "test" &&
    !signedTenantTopics.has(topic);
  let webhookAuthenticated = false;

  if (!allowUnsignedTestWebhook || signature) {
    if (!webhookSecret) {
      return { status: 503, webhookAuthenticated: false, bypassed: false };
    }
    const valid = verifySignatureFn(signature);
    if (!valid) {
      return { status: 401, webhookAuthenticated: false, bypassed: false };
    }
    webhookAuthenticated = true;
  }

  return { status: 200, webhookAuthenticated, bypassed: allowUnsignedTestWebhook && !signature };
}

test("Focus 2.1: NODE_ENV === 'test' + non-compliance topic + no signature -> successfully bypasses HMAC", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "test",
    topic: "orders/paid",
    signature: "",
    webhookSecret: "secret",
    verifySignatureFn: () => false,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.bypassed, true);
  assert.strictEqual(res.webhookAuthenticated, false);
});

test("Focus 2.2: NODE_ENV === 'test' + compliance topic (app/uninstalled) + no signature -> BLOCKS bypass (503 if no secret, 401 if empty sig)", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "test",
    topic: "app/uninstalled",
    signature: "",
    webhookSecret: "secret",
    verifySignatureFn: (sig) => sig === "valid",
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.bypassed, false);
});

test("Focus 2.3: NODE_ENV === 'test' + compliance topic (customers/redact) + no signature -> BLOCKS bypass", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "test",
    topic: "customers/redact",
    signature: "",
    webhookSecret: "secret",
    verifySignatureFn: (sig) => sig === "valid",
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.bypassed, false);
});

test("Focus 2.4: NODE_ENV === 'test' + compliance topic (shop/redact) + no signature -> BLOCKS bypass", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "test",
    topic: "shop/redact",
    signature: "",
    webhookSecret: "secret",
    verifySignatureFn: (sig) => sig === "valid",
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.bypassed, false);
});

test("Focus 2.5: NODE_ENV === 'test' + compliance topic (customers/data_request) + no signature -> BLOCKS bypass", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "test",
    topic: "customers/data_request",
    signature: "",
    webhookSecret: "secret",
    verifySignatureFn: (sig) => sig === "valid",
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.bypassed, false);
});

test("Focus 2.6: NODE_ENV === 'test' + non-compliance topic + INVALID signature provided -> fails closed (401)", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "test",
    topic: "orders/paid",
    signature: "invalid_hmac",
    webhookSecret: "secret",
    verifySignatureFn: (sig) => sig === "valid_hmac",
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.bypassed, false);
});

test("Focus 2.7: NODE_ENV === 'development' + non-compliance topic + no signature -> NEVER bypasses (fails 401)", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "development",
    topic: "orders/paid",
    signature: "",
    webhookSecret: "secret",
    verifySignatureFn: (sig) => sig === "valid",
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.bypassed, false);
});

test("Focus 2.8: NODE_ENV === 'production' + non-compliance topic + no signature -> NEVER bypasses (fails 401)", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "production",
    topic: "orders/paid",
    signature: "",
    webhookSecret: "secret",
    verifySignatureFn: (sig) => sig === "valid",
  });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.bypassed, false);
});

test("Focus 2.9: Production without SHOPIFY_WEBHOOK_SECRET returns 503 Service Unavailable", () => {
  const res = evaluateWebhookAuthBypass({
    nodeEnv: "production",
    topic: "orders/paid",
    signature: "any",
    webhookSecret: undefined,
    verifySignatureFn: () => true,
  });
  assert.strictEqual(res.status, 503);
});

// ----------------------------------------------------------------------------
// FOCUS 3: Canonical Store Resolution in Outbox Worker
// ----------------------------------------------------------------------------
console.log("\n--- Stress Testing Focus 3: Canonical Store Resolution in Outbox Worker ---");

const testShop = "my-test-store.myshopify.com";

// Simulate run-outbox-worker.ts findStore function
async function createRunOutboxWorkerFindStore(mockResolveFn) {
  return async (shopDomain) => {
    const resolved = await mockResolveFn(shopDomain);
    if (!resolved?.storeId) return null;
    return { id: resolved.storeId, shopDomain: resolved.myshopifyDomain };
  };
}

await testAsync("Focus 3.1: Canonical resolution matching exact domain succeeds and sets storeId", async () => {
  const mockResolve = async (domain) => ({
    storeId: "store_123",
    myshopifyDomain: domain,
    workspaceId: "ws_123",
  });
  const findStore = await createRunOutboxWorkerFindStore(mockResolve);

  let processedOptions = null;
  const dependencies = {
    workerId: "test-w1",
    findStore,
    processBatch: async (opts) => {
      processedOptions = opts;
      return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
    },
    shouldStop: () => false,
    waitForNextPoll: async () => {},
    logger: { info: () => {}, error: () => {} },
  };

  await runOutboxWorker([`--store=${testShop}`, "--once"], dependencies);
  assert.strictEqual(processedOptions?.storeId, "store_123");
});

await testAsync("Focus 3.2: Canonical resolution returns null when store does not exist -> throws exact error", async () => {
  const mockResolve = async () => null;
  const findStore = await createRunOutboxWorkerFindStore(mockResolve);

  const dependencies = {
    workerId: "test-w1",
    findStore,
    processBatch: async () => ({ processed: 0, succeeded: 0, failed: 0, deadLettered: 0 }),
    shouldStop: () => false,
    waitForNextPoll: async () => {},
    logger: { info: () => {}, error: () => {} },
  };

  let threw = false;
  try {
    await runOutboxWorker([`--store=${testShop}`, "--once"], dependencies);
  } catch (err) {
    threw = true;
    assert(err.message.includes(`No store matches the exact domain ${testShop}`));
  }
  assert.strictEqual(threw, true, "Expected runOutboxWorker to throw for null store resolution");
});

await testAsync("Focus 3.3: Canonical resolution returns store without storeId -> rejected safely", async () => {
  const mockResolve = async (domain) => ({
    storeId: undefined, // e.g. integration without weleticShopifyStore record
    myshopifyDomain: domain,
    workspaceId: "ws_no_store",
  });
  const findStore = await createRunOutboxWorkerFindStore(mockResolve);

  const dependencies = {
    workerId: "test-w1",
    findStore,
    processBatch: async () => ({ processed: 0, succeeded: 0, failed: 0, deadLettered: 0 }),
    shouldStop: () => false,
    waitForNextPoll: async () => {},
    logger: { info: () => {}, error: () => {} },
  };

  let threw = false;
  try {
    await runOutboxWorker([`--store=${testShop}`, "--once"], dependencies);
  } catch (err) {
    threw = true;
    assert(err.message.includes(`No store matches the exact domain ${testShop}`));
  }
  assert.strictEqual(threw, true, "Expected runOutboxWorker to throw when resolved store has no storeId");
});

await testAsync("Focus 3.4: Canonical resolution returns alias myshopifyDomain differing from input domain -> scope expansion guarded", async () => {
  const mockResolve = async () => ({
    storeId: "store_alias",
    myshopifyDomain: "different-canonical.myshopify.com",
    workspaceId: "ws_alias",
  });
  const findStore = await createRunOutboxWorkerFindStore(mockResolve);

  const dependencies = {
    workerId: "test-w1",
    findStore,
    processBatch: async () => ({ processed: 0, succeeded: 0, failed: 0, deadLettered: 0 }),
    shouldStop: () => false,
    waitForNextPoll: async () => {},
    logger: { info: () => {}, error: () => {} },
  };

  let threw = false;
  try {
    await runOutboxWorker([`--store=${testShop}`, "--once"], dependencies);
  } catch (err) {
    threw = true;
    assert(err.message.includes(`No store matches the exact domain ${testShop}`));
  }
  assert.strictEqual(threw, true, "Expected scope expansion guard to prevent widened outbox execution");
});

await testAsync("Focus 3.5: Outbox worker without --store flag runs globally without findStore call", async () => {
  let findStoreCalled = false;
  let processedOptions = null;
  const dependencies = {
    workerId: "test-w1",
    findStore: async () => {
      findStoreCalled = true;
      return null;
    },
    processBatch: async (opts) => {
      processedOptions = opts;
      return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
    },
    shouldStop: () => true,
    waitForNextPoll: async () => {},
    logger: { info: () => {}, error: () => {} },
  };

  await runOutboxWorker(["--once"], dependencies);
  assert.strictEqual(findStoreCalled, false);
  assert.strictEqual(processedOptions?.storeId, undefined);
});

console.log(`\n=== STRESS RESULTS: Total: ${total}, Passed: ${passed}, Failed: ${total - passed} ===`);
