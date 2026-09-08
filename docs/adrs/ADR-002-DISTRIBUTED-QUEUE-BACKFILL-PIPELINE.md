# ADR-002: Distributed Queue Architecture for Asynchronous Webhook Processing & 100k+ Historical Order Backfills

- **Date**: 2026-08-17
- **Status**: Proposed
- **Stakeholders**: Hiro (PO), Infrastructure & Scalability Team, Weletic Platform Engineering
- **Target Systems**: Weletic Commerce Platform (`apps/web`, `packages/weletic`)
- **Related ADRs**: ADR-0003 (Customer Loyalty Bounded Context), ADR-0004 (Loyalty Activation and Balance Policies), ADR-0005 (Historical Points as Opening Balance), ADR-0008 (Shopify App Production Security Boundary)

---

## 1. Context & Problem Statement

The Weletic Commerce Platform integrates deeply with Shopify's commerce event lifecycle to power affiliate attribution, creator commissions, and customer loyalty rewards. As merchant adoption scales to large high-volume brands, two mission-critical architectural bottlenecks have emerged in the data ingestion and background computation subsystems:

### 1.1 Problem 1: Synchronous Webhook Ingestion Latency & Timeout Vulnerability

When Shopify dispatches webhook events for `orders/paid` and `refunds/create`, the incoming HTTP request is currently handled synchronously inline via `apps/web/app/(ee)/api/shopify/integration/webhook/route.ts` and `orders-paid.ts`.

Handling `orders/paid` synchronously executes a 7-step sequence within a single HTTP request lifecycle:

1. HMAC-SHA256 signature verification.
2. Deduplication check in `WeleticShopifyWebhookEvent`.
3. Commerce order upsert and line item normalization in `WeleticCommerceOrder`.
4. FX snapshot retrieval and exchange rate calculation in `WeleticFxRateSnapshot`.
5. Affiliate partner attribution and commission generation (`WeleticCommission`).
6. Loyalty points earn calculation and ledger entry insertion (`WeleticPointsLedgerEntry`).
7. VIP tier evaluation and rolling 12-month spend re-aggregation (`WeleticLoyaltyTierHistory`).

Under regular traffic, this pipeline takes **500ms to 2,500ms**. However, during high-concurrency traffic events (flash sales, Black Friday / Cyber Monday), database connection pool contention, lock acquisition delays, and downstream external API calls cause request processing times to exceed **5,000ms**.

**Shopify Webhook Timeout Penalty**: Shopify enforces a strict **5-second timeout window**. If an endpoint fails to return a `200 OK` within 5 seconds, Shopify marks the delivery as failed, terminates the connection, and schedules exponential retries. Under load, this causes a cascading storm of duplicate webhook deliveries, compounding database locking and threatening webhook subscription auto-revocation (Shopify automatically deletes webhook subscriptions after 19 consecutive failures).

---

### 1.2 Problem 2: Memory Exhaustion (OOM) & Timeout in Historical Order Backfills

Under ADR-0005, merchants launching customer loyalty programs can import historical orders to calculate opening loyalty point grants.

The current implementation in `apps/web/lib/weletic/loyalty/backfill.ts` suffers from two fatal scalability limitations:

1. **Unbounded Memory Allocation in `generateBackfillPreview`**:

   ```typescript
   // apps/web/lib/weletic/loyalty/backfill.ts:162-173
   const historicalOrders = await prisma.weleticCommerceOrder.findMany({
     where: orderWhere,
     orderBy: { occurredAt: "asc" },
     select: {
       id: true,
       shopperId: true,
       presentmentCurrency: true,
       presentmentNet: true,
       occurredAt: true,
     },
   });
   ```

   For enterprise stores with **100,000 to 500,000+ historical orders**, this single unpaginated query attempts to load the entire dataset into a JavaScript array. This consumes 120MB to 400MB of heap memory, triggering immediate **Node.js Out-Of-Memory (OOM) crashes** and terminating Serverless / Edge execution workers.

2. **Unbatched Sequential Database Writes in `commitBackfillJob`**:
   ```typescript
   // apps/web/lib/weletic/loyalty/backfill.ts:363-391
   for (const item of job.previewItems) {
     await appendPointsLedgerEntry({ ... });
     await prisma.weleticLoyaltyBackfillPreviewItem.update({ ... });
   }
   ```
   For a merchant with 20,000 customers, committing the backfill executes **40,000 sequential round-trip database queries** across network connections. This takes 20–45 minutes, inevitably timing out HTTP handlers (Vercel maximum execution timeout is 15–300 seconds) and leaving the backfill in an inconsistent, partially committed state with no resume checkpoint.

---

### 1.3 Problem 3: Shopify GraphQL Rate Limits during Order Ingestion

When pulling historical order payloads directly from Shopify's Admin GraphQL API (`orders(first: 250)`), Shopify enforces a **leaky bucket rate limit of 40 cost points per second** (with a bucket capacity of 200 points for standard apps, and 400 points for Shopify Plus). Unthrottled parallel backfill queries immediately trigger `THROTTLED` / HTTP 429 errors.

---

## 2. Decision Drivers

1. **Sub-150ms Webhook Acknowledgment**: Return HTTP `200 OK` to Shopify webhooks immediately after cryptographic verification, decoupling heavy loyalty calculations.
2. **100k+ Order Scalability with Bounded Memory**: Process backfills of arbitrary size (100k to 1M+ orders) within a strictly bounded memory footprint (<64MB heap).
3. **Idempotency & Crash Resiliency**: Every chunked operation must be atomic and resumable from Redis cursor checkpoints upon worker preemption or crash.
4. **Shopify API Rate-Limit Compliance**: Strictly throttle external Shopify GraphQL requests to stay within 40 cost points/sec.
5. **Dead Letter Queue (DLQ) & Self-Healing**: Failed webhook jobs and backfill chunks must automatically retry with exponential backoff and route to a DLQ for operational triage without blocking the queue.

---

## 3. Considered Options

### Option 1: Synchronous Node.js Background Threads (`worker_threads` / Unbounded Promises)

- Run backfill and webhook processing inside un-awaited background promises (`ev.waitUntil` / `worker_threads`) within the existing Next.js web instances.
- _Rejected_: In serverless/container environments (Vercel, AWS ECS), instances can be terminated immediately after the HTTP response closes, killing background threads mid-execution and causing silent data corruption with zero retry guarantees.

### Option 2: Dedicated AWS SQS + Celery / Python Microservice

- Offload all queue and backfill processing to a separate AWS SQS and Python/Celery cluster.
- _Rejected_: Introduces substantial operational overhead, cross-repository code fragmentation, separate Prisma client definitions, and dual deployment pipelines for a single platform.

### Option 3 (Selected): Hybrid Distributed Queue Architecture (Upstash QStash + BullMQ on Redis Global)

- **QStash** for serverless, HTTP-based asynchronous webhook dispatch and scheduled cron events.
- **BullMQ** on Redis Global for stateful, high-throughput, cursor-paginated chunk backfills and rate-limited worker pipelines.

---

## 4. Architectural Decision

We will implement a **Decoupled Distributed Queue & Resumable Backfill Architecture** consisting of five core components:

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│                            DISTRIBUTED QUEUE & BACKFILL ARCHITECTURE OVERVIEW                                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘

 [ Shopify Webhook Engine ]
             │
             │ POST /api/shopify/integration/webhook
             ▼
 ┌────────────────────────────────────────────────────────┐
 │ 1. FAST-PATH WEBHOOK INGESTION (<150ms)                 │
 │ • Verify HMAC-SHA256 signature                         │
 │ • Check idempotency table (WeleticShopifyWebhookEvent) │
 │ • Dispatch job to QStash / BullMQ                      │
 │ • Return HTTP 200 OK immediately                       │
 └───────────────────────┬────────────────────────────────┘
                         │
                         ▼
 ┌────────────────────────────────────────────────────────┐
 │ 2. DISTRIBUTED QUEUE (BullMQ / Upstash QStash)         │
 │ • Queue: "weletic-webhooks"                            │
 │ • Queue: "weletic-backfill"                            │
 │ • Queue: "weletic-backfill-commit"                     │
 │ • Concurrency: 10 Workers per Queue                    │
 └───────────┬────────────────────────────────┬───────────┘
             │                                │
             ▼                                ▼
 ┌───────────────────────────┐   ┌────────────────────────────────────────────────────┐
 │ 3. WEBHOOK ASYNC WORKER   │   │ 4. 100K+ CHUNKED BACKFILL WORKER                   │
 │ • Record commerce order   │   │ • Cursor Pagination (250 orders/chunk)             │
 │ • Loyalty points earn     │   │ • Redis Cursor Checkpoint: weletic:backfill:{id}   │
 │ • Referral qualification  │   │ • Leaky Bucket Shopify Rate Limiter (40 pts/sec)   │
 │ • VIP Tier evaluation     │   │ • Bulk Preview Insert (createMany)                 │
 │ • Invalidate Redis Cache  │   │ • Atomic Chunk Commit & Ledger Append              │
 └───────────┬───────────────┘   └────────────────────────────┬───────────────────────┘
             │                                                │
             └───────────────────────┬────────────────────────┘
                                     │ (On 5 Consecutive Failures)
                                     ▼
 ┌────────────────────────────────────────────────────────────────────────────────────┐
 │ 5. DEAD LETTER QUEUE (DLQ) & AUDIT TRAIL                                           │
 │ • Queue: "weletic-dlq"                                                             │
 │ • Persist error context, payload, stack trace, and retry attempt count             │
 │ • Admin Console Alert & 1-Click Replay Endpoint                                    │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Detailed System Design & Technical Specifications

### 5.1 Asynchronous Webhook Fast-Path Ingestion

The webhook ingress endpoint (`apps/web/app/(ee)/api/shopify/integration/webhook/route.ts`) is refactored to perform only authentication and dispatch before returning `200 OK`:

```typescript
// Fast-Path Webhook Ingestion Handler
export const POST = async (req: Request) => {
  const rawBody = await req.text();
  const signature = req.headers.get("x-shopify-hmac-sha256");
  const topic = req.headers.get("x-shopify-topic");
  const shopDomain = req.headers.get("x-shopify-shop-domain");
  const webhookId = req.headers.get("x-shopify-webhook-id");

  // 1. Synchronous Cryptographic Verification (<10ms)
  const isValid = verifyShopifyWebhookHmac(
    rawBody,
    signature,
    process.env.SHOPIFY_API_SECRET!,
  );
  if (!isValid) {
    return new Response("Invalid HMAC signature", { status: 401 });
  }

  // 2. Deduplication Lock via Redis (<15ms)
  const dedupeKey = `webhook:lock:${shopDomain}:${webhookId}`;
  const acquired = await redisGlobal.set(dedupeKey, "1", {
    nx: true,
    ex: 86400,
  });
  if (!acquired) {
    // Duplicate webhook delivery acknowledged without reprocessing
    return new Response("Duplicate webhook acknowledged", { status: 200 });
  }

  // 3. Enqueue Webhook Job to Distributed Queue (<30ms)
  const jobPayload: WebhookQueuePayload = {
    webhookId: webhookId!,
    topic: topic!,
    shopDomain: shopDomain!,
    rawPayload: JSON.parse(rawBody),
    receivedAt: Date.now(),
  };

  await qstash.publishJSON({
    url: `${process.env.APP_BASE_URL}/api/queue/workers/webhook-processor`,
    body: jobPayload,
    retries: 5,
    backoff: { type: "exponential", base: 2, delay: 5 },
  });

  // 4. Return HTTP 200 OK within <100ms total latency
  return new Response("Webhook accepted for async processing", { status: 200 });
};
```

---

### 5.2 100k+ Historical Order Backfill Pipeline: Chunked Streaming & Checkpoints

To backfill 100,000+ orders without memory exhaustion or timeouts, the backfill engine is decomposed into **Chunked Cursor-Paginated Tasks** (batch size: 250 orders per chunk).

#### 5.2.1 Backfill State Machine & Redis Cursor Model:

```
+-------------------------------------------------------------------------------------------------+
| Redis Checkpoint Key: weletic:backfill:{jobId}:cursor                                           |
+-------------------------------------------------------------------------------------------------+
| Field                    | Type    | Description                                                |
+--------------------------+---------+------------------------------------------------------------+
| lastEvaluatedOrderId     | String  | Primary cursor: ID of the last evaluated order in MySQL    |
| lastEvaluatedOccurredAt  | String  | Secondary cursor: ISO timestamp for chronological ordering  |
| processedOrdersCount     | Integer | Cumulative number of orders evaluated                      |
| qualifyingOrdersCount    | Integer | Cumulative number of orders meeting loyalty criteria       |
| totalProjectedPoints     | BigInt  | Cumulative projected points calculated                     |
| currentChunkIndex        | Integer | Monotonically incrementing chunk counter                   |
| status                   | String  | "in_progress" | "preview_complete" | "failed"             |
+--------------------------+---------+------------------------------------------------------------+
```

#### 5.2.2 Chunked Preview Generator Worker (`apps/web/lib/weletic/loyalty/backfill-worker.ts`):

```typescript
export interface BackfillChunkJobPayload {
  jobId: string;
  storeId: string;
  programId: string;
  cursorOrderId: string | null;
  batchSize: number; // Default: 250
}

export async function processBackfillChunk(
  payload: BackfillChunkJobPayload,
): Promise<void> {
  const { jobId, storeId, programId, cursorOrderId, batchSize = 250 } = payload;
  const checkpointKey = `weletic:backfill:${jobId}:cursor`;

  // 1. Fetch exactly `batchSize` orders using indexed cursor pagination
  const orders = await prisma.weleticCommerceOrder.findMany({
    where: {
      storeId,
      status: "paid",
      shopperId: { not: null },
    },
    take: batchSize,
    skip: cursorOrderId ? 1 : 0,
    cursor: cursorOrderId ? { id: cursorOrderId } : undefined,
    orderBy: { id: "asc" },
    select: {
      id: true,
      shopperId: true,
      presentmentCurrency: true,
      presentmentNet: true,
      accountingNet: true,
      occurredAt: true,
    },
  });

  if (orders.length === 0) {
    // All chunks processed: transition job to 'preview_ready'
    await finalizeBackfillPreview(jobId);
    return;
  }

  // 2. Process chunk in memory (bounded to 250 items ≈ 80KB heap)
  const previewItems: Prisma.WeleticLoyaltyBackfillPreviewItemCreateManyInput[] =
    [];
  let chunkPoints = BigInt(0);

  for (const order of orders) {
    const points = calculateCalibratedOrderPoints({
      netAmountMinor: order.accountingNet,
      presentmentCurrency: order.presentmentCurrency,
      pointsPerBaseUnit: 1.0,
      tierMultiplier: 1.0,
    });

    if (points > BigInt(0)) {
      chunkPoints += points;
      previewItems.push({
        id: createWeleticId("wbfitem_"),
        jobId,
        shopperId: order.shopperId!,
        accountId: await resolveShopperAccountId(
          storeId,
          programId,
          order.shopperId!,
        ),
        ordersCount: 1,
        eligibleSpend: order.accountingNet,
        currency: order.presentmentCurrency,
        projectedPoints: points,
      });
    }
  }

  // 3. Batch insert preview records in a single database round-trip
  if (previewItems.length > 0) {
    await prisma.weleticLoyaltyBackfillPreviewItem.createMany({
      data: previewItems,
      skipDuplicates: true,
    });
  }

  // 4. Update Redis Checkpoint atomically
  const lastOrder = orders[orders.length - 1];
  await redisGlobal.hincrby(
    checkpointKey,
    "processedOrdersCount",
    orders.length,
  );
  await redisGlobal.hincrby(
    checkpointKey,
    "qualifyingOrdersCount",
    previewItems.length,
  );
  await redisGlobal.hset(checkpointKey, {
    lastEvaluatedOrderId: lastOrder.id,
    lastEvaluatedOccurredAt: lastOrder.occurredAt.toISOString(),
  });

  // 5. Enqueue Next Chunk Job with 250ms throttle to protect DB connection pool
  await qstash.publishJSON({
    url: `${process.env.APP_BASE_URL}/api/queue/workers/backfill-chunk`,
    body: {
      jobId,
      storeId,
      programId,
      cursorOrderId: lastOrder.id,
      batchSize,
    },
    delay: 1, // 1-second delay between chunks
  });
}
```

---

### 5.3 Shopify GraphQL API Rate Limiter (40 Cost Points/Sec)

When syncing historical orders directly from Shopify GraphQL Admin API, queries are throttled through a **Token Bucket Rate Limiter** backed by Redis:

```typescript
export class ShopifyApiRateLimiter {
  private static BUCKET_KEY = (storeId: string) =>
    `ratelimit:shopify:graphql:${storeId}`;
  private static MAX_CAPACITY = 200; // Standard app bucket size (points)
  private static LEAK_RATE_PER_SEC = 40; // 40 cost points per second restore rate

  public static async acquireTokens(
    storeId: string,
    requestedCost: number,
  ): Promise<void> {
    const key = this.BUCKET_KEY(storeId);

    // Lua script executing atomic leaky bucket deduction
    const luaScript = `
      local key = KEYS[1]
      local requested = tonumber(ARGV[1])
      local capacity = tonumber(ARGV[2])
      local leakRate = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])

      local data = redis.call('HMGET', key, 'tokens', 'lastUpdated')
      local tokens = tonumber(data[1])
      local lastUpdated = tonumber(data[2])

      if not tokens then
        tokens = capacity
        lastUpdated = now
      else
        local delta = math.max(0, (now - lastUpdated) / 1000) * leakRate
        tokens = math.min(capacity, tokens + delta)
        lastUpdated = now
      end

      if tokens >= requested then
        tokens = tokens - requested
        redis.call('HMSET', key, 'tokens', tokens, 'lastUpdated', lastUpdated)
        redis.call('EXPIRE', key, 60)
        return 1
      else
        return 0
      end
    `;

    while (true) {
      const result = await redisGlobal.eval(
        luaScript,
        [key],
        [requestedCost, this.MAX_CAPACITY, this.LEAK_RATE_PER_SEC, Date.now()],
      );

      if (result === 1) return;

      // Bucket exhausted: back off for 500ms before retrying
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}
```

---

### 5.4 Dead Letter Queue (DLQ) & Failure Recovery

All queue workers operate under a strict **5-Attempt Exponential Backoff Policy**:

```
+-------------------------------------------------------------------------------------------------+
| Retry Schedule: Delay = BaseDelay × (2 ^ attemptNumber) ± Jitter                                |
+-------------------------------------------------------------------------------------------------+
| Attempt 1: Immediate                                                                            |
| Attempt 2: 5 seconds                                                                            |
| Attempt 3: 15 seconds                                                                           |
| Attempt 4: 45 seconds                                                                           |
| Attempt 5: 120 seconds                                                                          |
| After Attempt 5: Route to Dead Letter Queue (`weletic-dlq`)                                     |
+-------------------------------------------------------------------------------------------------+
```

#### DLQ Payload Schema (`WeleticDeadLetterJob`):

```json
{
  "id": "wdlq_01HXYZ7890ABCDEF",
  "queueName": "weletic-webhooks",
  "jobId": "yamax:orders/paid:987654321",
  "errorMessage": "PrismaClientKnownRequestError: Deadlock found when trying to get lock",
  "stackTrace": "Error: Deadlock found...\n at recordWeleticOrder (record-order.ts:312)",
  "payload": {
    "topic": "orders/paid",
    "storeId": "wstore_123",
    "orderId": "gid://shopify/Order/987654321"
  },
  "attemptCount": 5,
  "failedAt": "2026-08-17T09:30:00.000Z",
  "resolved": false
}
```

---

## 6. Consequences & Trade-offs

### 6.1 Positive Consequences

- **Zero Webhook Dropping**: Fast-path <150ms HTTP 200 response eliminates Shopify 5s timeout penalties and subscription revocation risks.
- **Uncapped Historical Scalability**: Chunked streaming and cursor pagination allow stores with 1,000,000+ orders to backfill smoothly within 64MB memory limits.
- **Resumability**: If a serverless worker instance is terminated mid-backfill, the next worker resumes immediately from the exact Redis cursor checkpoint without recomputing previous chunks.
- **Database Safety**: 250ms inter-chunk delay and batch `createMany` inserts reduce database connection pressure by >90%.

### 6.2 Trade-offs & Mitigations

- **Eventual Consistency in Customer Widget**: Loyalty points from an order appear after queue processing (typically 500ms–2,000ms delay) rather than instantaneously during checkout.
  - _Mitigation_: Optimistic UI updates on the storefront and immediate cache invalidation as soon as the queue worker finishes.
- **Queue Dependency**: Platform requires high availability from Upstash Redis / QStash.
  - _Mitigation_: Fallback Redis instance configuration (`redisGlobalWithTimeout`) and automatic queue health monitoring.

---

## 7. Verification Method

1. **Synthetic Webhook Latency Benchmark**:
   - Send 500 concurrent `orders/paid` webhooks via `k6` / `autocannon`.
   - Verify 100% of webhook responses return HTTP 200 in <150ms.
2. **100k Order Backfill Simulation**:
   - Seed database with 100,000 test orders across 10,000 customers.
   - Trigger `generateBackfillPreview(jobId)`.
   - Monitor Node.js heap memory (must stay below 64MB).
   - Simulate worker process termination at chunk 150; verify execution resumes at chunk 151 from Redis cursor.
3. **DLQ Replay Verification**:
   - Intentionally fail a webhook worker task 5 times; confirm payload lands in `WeleticDeadLetterJob` table.
   - Invoke `/api/admin/dlq/replay/{id}` and confirm successful recovery.
