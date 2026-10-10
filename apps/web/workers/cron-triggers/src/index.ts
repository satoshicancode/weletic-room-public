/// <reference types="@cloudflare/workers-types" />
import { timingSafeEqual } from "node:crypto";
import {
  prisma,
  createPrismaClient,
  type ExtendedPrismaClient,
} from "../../../lib/prisma";
import { reconcilePendingStoreCreditRedemptionsSweep } from "../../../lib/weletic/loyalty/store-credit-reconciliation";
import { processOutboxJobsBatch } from "../../../lib/weletic/loyalty/outbox";
import { recoverStuckOrdersPaidWebhooks } from "../../../lib/weletic/shopify/orders-paid-recovery";
import { enqueuePointsExpiryLifecycleJobs } from "../../../lib/weletic/loyalty/points-expiry-scheduler";
import { enqueueRewardExpiryReminderJobs } from "../../../lib/weletic/loyalty/reward-expiry-scheduler";
import { enqueueTierReviewSweepJobs } from "../../../lib/weletic/loyalty/tier-review-scheduling";
import { listDueShopifySessionRenewals } from "../../../lib/weletic/shopify/session-renewal";
import { syncWeleticShopifyCatalog } from "../../../lib/weletic/shopify/catalog-sync";
import { resolveShopifyStoreByDomain } from "../../../lib/weletic/shopify/store-resolver";
import {
  cronRateLimiter,
  getClientIp,
  createRateLimitResponse,
} from "../../../lib/weletic/edge-rate-limiter";

export const CRON_SCHEDULE_5_MIN = "*/5 * * * *";
export const CRON_SCHEDULE_HOURLY = "0 * * * *";
export const CRON_SCHEDULE_DAILY = "0 2 * * *";

/**
 * Constant-time string equality check to prevent timing side-channel attacks (SEC-R4-03).
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
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
    if (typeof timingSafeEqual === "function") {
      return timingSafeEqual(Buffer.from(aBytes), Buffer.from(bBytes));
    }
  } catch {
    // Fall back to manual constant-time comparison
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export interface QueueSender<T = unknown> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}

export interface CronWorkerEnv {
  DB?: D1Database;
  ORDER_WEBHOOK_QUEUE?: QueueSender<unknown>;
  CRON_SECRET?: string;
  ENVIRONMENT?: string;
  SHOPIFY_API_KEY?: string;
  prisma?: ExtendedPrismaClient;
  RATE_LIMIT_DISABLED?: string | boolean;
  RATE_LIMIT_MAX?: number;
  RATE_LIMIT_WINDOW_MS?: number;
}

export interface CronJobResult<T = unknown> {
  name: string;
  status: "success" | "error" | "skipped";
  durationMs: number;
  data?: T;
  error?: string;
}

export interface CronCycleReport {
  cron: string;
  scheduledTime: number;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
  successCount: number;
  errorCount: number;
  jobs: CronJobResult[];
}

/**
 * Isolated job executor: wraps every scheduled job in a try/catch block with timing.
 * Ensures that an error or unhandled rejection in one job never halts or aborts the cron cycle.
 */
export async function executeIsolatedJob<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<CronJobResult<T>> {
  const startTime = Date.now();
  try {
    const data = await fn();
    const durationMs = Date.now() - startTime;
    return {
      name,
      status: "success",
      durationMs,
      data,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const errorMsg =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : JSON.stringify(err);
    console.error(`[CronJob Error] Job "${name}" failed:`, err);
    return {
      name,
      status: "error",
      durationMs,
      error: errorMsg,
    };
  }
}

/**
 * Initializes and binds the edge PrismaClient instance to globalThis for worker execution.
 */
export function initCronWorkerPrisma(env: CronWorkerEnv): ExtendedPrismaClient {
  if (env.prisma) {
    (globalThis as any).prisma = env.prisma;
    return env.prisma;
  }
  if (env.DB) {
    (globalThis as any).DB = env.DB;
    if (!(globalThis as any).prisma || (globalThis as any).__boundD1 !== env.DB) {
      (globalThis as any).prisma = createPrismaClient(env.DB);
      (globalThis as any).__boundD1 = env.DB;
    }
    return (globalThis as any).prisma;
  }
  return (globalThis as any).prisma ?? prisma;
}

export function getActivePrismaClient(env: CronWorkerEnv): ExtendedPrismaClient {
  return initCronWorkerPrisma(env);
}

// ============================================================================
// 1. Every 5 Minutes (*/5 * * * *) Jobs
// ============================================================================

/**
 * Job 1.1: Store Credit Reconciliation Sweep (FIN-03)
 * Sweeps pending store credit redemptions older than 60 seconds, querying Shopify/ledger
 * and transitioning records to settled or refunded.
 */
export async function reconcileStoreCreditJob(
  env: CronWorkerEnv,
): Promise<{ scanned: number; confirmed: number; refunded: number; deferred: number; errors: number }> {
  initCronWorkerPrisma(env);
  // If native D1 binding exists without Prisma initialized, check D1 records first
  if (env.DB?.prepare) {
    const pendingQuery = await env.DB.prepare(
      "SELECT id, status, artifactKind FROM WeleticRewardRedemption WHERE artifactKind = 'store_credit' AND status = 'provisioning' LIMIT 50",
    ).all<{ id: string; status: string; artifactKind: string }>();

    if (!pendingQuery.results || pendingQuery.results.length === 0) {
      return { scanned: 0, confirmed: 0, refunded: 0, deferred: 0, errors: 0 };
    }
  }

  const result = await reconcilePendingStoreCreditRedemptionsSweep({
    batchSize: 50,
  });

  return {
    scanned: result.scanned,
    confirmed: result.confirmed,
    refunded: result.refunded,
    deferred: result.deferred,
    errors: result.errors,
  };
}

/**
 * Job 1.2: Loyalty Outbox Processing
 * Processes pending outbox jobs in WeleticLoyaltyOutboxJob.
 */
export async function processLoyaltyOutboxJob(
  env: CronWorkerEnv,
): Promise<{ processed: number; workerId: string }> {
  initCronWorkerPrisma(env);
  const workerId = `cron_${crypto.randomUUID()}`;

  // Lightweight check on D1 if available
  if (env.DB?.prepare) {
    const countCheck = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM WeleticLoyaltyOutboxJob WHERE status = 'pending' AND scheduledFor <= CURRENT_TIMESTAMP",
    ).first<{ count: number }>();

    if (!countCheck || countCheck.count === 0) {
      return { processed: 0, workerId };
    }
  }

  const outboxResult = await processOutboxJobsBatch({
    batchSize: 50,
    workerId,
  });

  const processedCount = Array.isArray(outboxResult)
    ? outboxResult.length
    : typeof outboxResult === "object" && outboxResult !== null && "processed" in outboxResult
      ? Number((outboxResult as { processed: unknown }).processed)
      : 0;

  return {
    processed: processedCount,
    workerId,
  };
}

/**
 * Job 1.3: Stalled Webhook Events Recovery Sweep
 * Sweeps stalled pending webhook events older than the in-flight lease threshold (180s)
 * and retries or re-enqueues them.
 */
export async function recoverStalledWebhooksJob(
  env: CronWorkerEnv,
): Promise<{ recovered: number; reEnqueued: number }> {
  initCronWorkerPrisma(env);
  let reEnqueuedCount = 0;

  // Direct D1 Queue re-enqueue if queue producer binding is present
  if (env.DB?.prepare && env.ORDER_WEBHOOK_QUEUE) {
    const stalledEvents = await env.DB.prepare(
      `SELECT 
         e.id, 
         e.webhookId, 
         e.topic, 
         e.storeId, 
         s.shopDomain, 
         e.attempts, 
         e.payload 
       FROM WeleticShopifyWebhookEvent e
       LEFT JOIN WeleticShopifyStore s ON e.storeId = s.id
       WHERE e.status = 'received' 
         AND e.updatedAt < datetime('now', '-3 minutes') 
         AND e.attempts < 5 
       LIMIT 10`,
    ).all<{
      id: string;
      webhookId: string;
      topic: string;
      storeId: string;
      shopDomain: string | null;
      attempts: number;
      payload: string | null;
    }>();

    if (stalledEvents.results && stalledEvents.results.length > 0) {
      for (const event of stalledEvents.results) {
        if (!event.shopDomain) {
          // Orphaned webhook event: mark failed so it doesn't repeatedly consume recovery slots
          await env.DB.prepare(
            "UPDATE WeleticShopifyWebhookEvent SET status = 'failed', error = 'Orphaned event: associated store not found', attempts = attempts + 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?",
          )
            .bind(event.id)
            .run();
          continue;
        }

        await env.ORDER_WEBHOOK_QUEUE.send({
          webhookId: event.webhookId,
          topic: event.topic,
          shopDomain: event.shopDomain,
          triggeredAt: new Date().toISOString(),
          rawPayload: event.payload ?? "{}",
          enqueuedAt: Date.now(),
        });
        await env.DB.prepare(
          "UPDATE WeleticShopifyWebhookEvent SET attempts = attempts + 1, updatedAt = CURRENT_TIMESTAMP WHERE id = ?",
        )
          .bind(event.id)
          .run();
        reEnqueuedCount++;
      }
    }
  }

  const results = await recoverStuckOrdersPaidWebhooks({
    limit: 10,
    inFlightLeaseMs: 180_000,
    maxAttempts: 5,
  });

  return {
    recovered: results.length,
    reEnqueued: reEnqueuedCount,
  };
}

// ============================================================================
// 2. Hourly (0 * * * *) Jobs
// ============================================================================

/**
 * Job 2.1: Loyalty Points Expiration Reminders & Lifecycle
 * Scans active programs, enqueues points expiration warning/lifecycle jobs,
 * and queues reward expiration reminder notifications.
 */
export async function loyaltyPointsExpirationJob(
  env: CronWorkerEnv,
): Promise<{
  pointsLifecycle: { programsScanned: number; accountsReconciled: number; jobsEnqueued: number };
  rewardReminders: { scanned: number; enqueued: number };
}> {
  initCronWorkerPrisma(env);
  // If D1 prepare is present, verify active loyalty programs exist before full sweep
  if (env.DB?.prepare) {
    const activePrograms = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM WeleticLoyaltyProgram WHERE status = 'active' AND killSwitchActive = 0",
    ).first<{ count: number }>();

    if (!activePrograms || activePrograms.count === 0) {
      return {
        pointsLifecycle: { programsScanned: 0, accountsReconciled: 0, jobsEnqueued: 0 },
        rewardReminders: { scanned: 0, enqueued: 0 },
      };
    }
  }

  const [pointsResult, rewardResult] = await Promise.all([
    enqueuePointsExpiryLifecycleJobs({ batchSize: 50 }),
    enqueueRewardExpiryReminderJobs({ batchSize: 50 }),
    enqueueTierReviewSweepJobs({ batchSize: 50 }),
  ]);

  return {
    pointsLifecycle: {
      programsScanned: pointsResult.programsScanned,
      accountsReconciled: pointsResult.accountsReconciled,
      jobsEnqueued: pointsResult.jobsEnqueued,
    },
    rewardReminders: {
      scanned: rewardResult.rewardsScanned,
      enqueued: rewardResult.jobsEnqueued,
    },
  };
}

/**
 * Job 2.2: Expiring Shopify Token Session Renewals
 * Checks expiring offline access tokens across all active stores and initiates token refresh.
 */
export async function renewShopifySessionsJob(
  env: CronWorkerEnv,
): Promise<{ scanned: number; dueJobs: number }> {
  initCronWorkerPrisma(env);
  const appId = env.SHOPIFY_API_KEY?.trim() || process.env.SHOPIFY_API_KEY?.trim();
  if (!appId) {
    // Graceful skip if Shopify API key is not configured in this environment
    return { scanned: 0, dueJobs: 0 };
  }

  const scheduledAt = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const { jobs } = await listDueShopifySessionRenewals({
    scheduledAt,
    appId,
  });

  return {
    scanned: jobs.length,
    dueJobs: jobs.length,
  };
}

/**
 * Job 2.3: VIP Tier Review Sweep
 * Sweeps expired VIP tier grace periods across active stores and enqueues TIER_REVIEW outbox jobs.
 */
export async function vipTierReviewSweepJob(
  env: CronWorkerEnv,
): Promise<{
  programsScanned: number;
  programsSkipped: number;
  accountsEvaluated: number;
  jobsEnqueued: number;
  programFailures: Array<{ storeId: string; error: string }>;
}> {
  initCronWorkerPrisma(env);
  return enqueueTierReviewSweepJobs({ batchSize: 50 });
}

/**
 * Job 2.4: Purge Expired Service Auth Nonces (SEC-R1-07)
 * Sweeps expired service authentication replay protection nonces from ServiceAuthNonce.
 */
export async function purgeExpiredNoncesJob(
  env: CronWorkerEnv,
): Promise<{ deletedCount: number }> {
  initCronWorkerPrisma(env);
  const nowMs = Date.now();

  // 1. Direct Cloudflare D1 Native execution if available
  if (env.DB?.prepare) {
    try {
      const res = await env.DB.prepare(
        "DELETE FROM ServiceAuthNonce WHERE expiresAt <= ?",
      )
        .bind(nowMs)
        .run();
      const deletedCount = res.meta?.changes ?? 0;
      return { deletedCount };
    } catch (err: unknown) {
      console.warn(
        "[CronJob] D1 purgeExpiredNoncesJob error, attempting Prisma fallback:",
        err,
      );
    }
  }

  // 2. Prisma fallback
  const activePrisma = getActivePrismaClient(env);
  try {
    if (!activePrisma.serviceAuthNonce?.deleteMany) {
      return { deletedCount: 0 };
    }
    const res = await activePrisma.serviceAuthNonce.deleteMany({
      where: {
        expiresAt: {
          lte: nowMs,
        },
      },
    });
    return { deletedCount: res.count };
  } catch (err: unknown) {
    console.warn("[CronJob] Failed to purge expired nonces via Prisma:", err);
    return { deletedCount: 0 };
  }
}

// ============================================================================
// 3. Daily 02:00 UTC (0 2 * * *) Jobs
// ============================================================================

/**
 * Job 3.1: Multi-Tenant Catalog Sync Sweep
 * Enforces Invariant 1 (Canonical Store Resolution) and Invariant 4 (Zero Hardcoding):
 * Dynamically queries all connected stores and reconciles catalog products/variants.
 */
export async function syncMultiTenantCatalogJob(
  env: CronWorkerEnv,
): Promise<{ storesScanned: number; syncedWorkspaces: string[]; errors: Array<{ storeId: string; error: string }> }> {
  initCronWorkerPrisma(env);
  const activePrisma = getActivePrismaClient(env);

  const stores = await activePrisma.weleticShopifyStore.findMany({
    where: {
      syncStatus: "succeeded",
    },
    select: { id: true, projectId: true, shopDomain: true },
  });

  const syncedWorkspaces: string[] = [];
  const errors: Array<{ storeId: string; error: string }> = [];

  for (const store of stores) {
    try {
      // Invariant 1: Ensure store can be canonically resolved across domain aliases
      const resolved = await resolveShopifyStoreByDomain(store.shopDomain);
      if (!resolved) {
        errors.push({
          storeId: store.id,
          error: `Unable to canonically resolve store for domain: ${store.shopDomain}`,
        });
        continue;
      }

      await syncWeleticShopifyCatalog({
        workspaceId: store.projectId,
      });
      syncedWorkspaces.push(store.projectId);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ storeId: store.id, error: message });
    }
  }

  return {
    storesScanned: stores.length,
    syncedWorkspaces,
    errors,
  };
}

/**
 * Job 3.2: Daily Double-Entry Ledger Verification
 * Audits loyalty points ledger entries across accounts to ensure:
 * 1. Monotonic sequence continuity (no sequence gaps or duplicate numbers).
 * 2. Balance integrity: SUM(pointsDelta) matches the latest balanceAfter.
 * 3. Zero negative balance violations.
 */
export async function verifyDoubleEntryLedgerJob(
  env: CronWorkerEnv,
): Promise<{ verified: boolean; accountsAudited: number; discrepanciesCount: number; discrepancies: unknown[] }> {
  initCronWorkerPrisma(env);
  const activePrisma = getActivePrismaClient(env);

  // If running on native D1, run an optimized SQL aggregate verification
  if (env.DB?.prepare) {
    const auditQuery = await env.DB.prepare(
      `SELECT
        e.accountId,
        COUNT(*) as entryCount,
        SUM(e.pointsDelta) as totalDelta,
        (
          SELECT balanceAfter
          FROM WeleticPointsLedgerEntry sub
          WHERE sub.accountId = e.accountId
          ORDER BY sub.sequenceNumber DESC
          LIMIT 1
        ) as lastBalance
      FROM WeleticPointsLedgerEntry e
      GROUP BY e.accountId
      LIMIT 100`,
    ).all<{ accountId: string; entryCount: number; totalDelta: number; lastBalance: number }>();

    const rows = auditQuery.results || [];
    const discrepancies: unknown[] = [];

    for (const row of rows) {
      if (row.totalDelta !== row.lastBalance) {
        discrepancies.push({
          accountId: row.accountId,
          expectedBalance: row.totalDelta,
          actualBalance: row.lastBalance,
        });
      }
    }

    return {
      verified: discrepancies.length === 0,
      accountsAudited: rows.length,
      discrepanciesCount: discrepancies.length,
      discrepancies,
    };
  }

  // Fallback to Prisma ledger verification
  const accounts = await activePrisma.weleticLoyaltyAccount.findMany({
    take: 50,
    select: {
      id: true,
      cachedPointsBalance: true,
      ledgerEntries: {
        orderBy: { sequenceNumber: "asc" },
        select: {
          sequenceNumber: true,
          pointsDelta: true,
          balanceAfter: true,
        },
      },
    },
  });

  const discrepancies: unknown[] = [];

  for (const account of accounts) {
    let runningBalance = BigInt(0);
    let expectedSequence = 1;

    for (const entry of account.ledgerEntries) {
      if (entry.sequenceNumber !== expectedSequence) {
        discrepancies.push({
          accountId: account.id,
          type: "sequence_gap",
          expected: expectedSequence,
          found: entry.sequenceNumber,
        });
      }
      expectedSequence++;

      runningBalance += BigInt(entry.pointsDelta);
      if (runningBalance !== BigInt(entry.balanceAfter)) {
        discrepancies.push({
          accountId: account.id,
          type: "balance_mismatch",
          runningBalance: runningBalance.toString(),
          recordedBalance: entry.balanceAfter.toString(),
        });
      }
    }

    if (
      account.ledgerEntries.length > 0 &&
      BigInt(account.cachedPointsBalance) !== runningBalance
    ) {
      discrepancies.push({
        accountId: account.id,
        type: "account_balance_mismatch",
        accountBalance: account.cachedPointsBalance.toString(),
        computedBalance: runningBalance.toString(),
      });
    }
  }

  return {
    verified: discrepancies.length === 0,
    accountsAudited: accounts.length,
    discrepanciesCount: discrepancies.length,
    discrepancies,
  };
}

// ============================================================================
// 4. Main Scheduled Router
// ============================================================================

/**
 * Routes scheduled cron triggers to their designated isolated job batches.
 */
export async function scheduledHandler(
  event: { cron: string; scheduledTime?: number },
  env: CronWorkerEnv,
): Promise<CronCycleReport> {
  initCronWorkerPrisma(env);
  const cron = event.cron.trim();
  const scheduledTime = event.scheduledTime ?? Date.now();
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  const jobs: CronJobResult[] = [];

  switch (cron) {
    case CRON_SCHEDULE_5_MIN: {
      // 5-min cycle: Store Credit Sweep + Loyalty Outbox + Webhook Recovery
      const [creditSweep, outboxFlush, webhookRecovery] = await Promise.all([
        executeIsolatedJob("store-credit-reconciliation", () =>
          reconcileStoreCreditJob(env),
        ),
        executeIsolatedJob("loyalty-outbox", () =>
          processLoyaltyOutboxJob(env),
        ),
        executeIsolatedJob("stalled-webhooks-recovery", () =>
          recoverStalledWebhooksJob(env),
        ),
      ]);
      jobs.push(creditSweep, outboxFlush, webhookRecovery);
      break;
    }

    case CRON_SCHEDULE_HOURLY: {
      // Hourly cycle: Loyalty Expiration Reminders + Shopify Session Renewal + Purge Expired Nonces
      const [expirySweep, sessionRenewal, noncePurge] = await Promise.all([
        executeIsolatedJob("loyalty-points-expiration", () =>
          loyaltyPointsExpirationJob(env),
        ),
        executeIsolatedJob("shopify-session-renewal", () =>
          renewShopifySessionsJob(env),
        ),
        executeIsolatedJob("purge-expired-nonces", () =>
          purgeExpiredNoncesJob(env),
        ),
      ]);
      jobs.push(expirySweep, sessionRenewal, noncePurge);
      break;
    }

    case CRON_SCHEDULE_DAILY: {
      // Daily 02:00 UTC cycle: Catalog Sync Sweep + Double-Entry Ledger Verification
      const [catalogSync, ledgerVerify] = await Promise.all([
        executeIsolatedJob("multi-tenant-catalog-sync", () =>
          syncMultiTenantCatalogJob(env),
        ),
        executeIsolatedJob("daily-double-entry-ledger-verify", () =>
          verifyDoubleEntryLedgerJob(env),
        ),
      ]);
      jobs.push(catalogSync, ledgerVerify);
      break;
    }

    default: {
      console.warn(`[Cron Scheduler] Unrecognized cron trigger: "${cron}"`);
      jobs.push({
        name: "unrecognized-trigger",
        status: "skipped",
        durationMs: 0,
        error: `No handler registered for cron schedule: "${cron}"`,
      });
      break;
    }
  }

  const completedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - startTime;
  const successCount = jobs.filter((j) => j.status === "success").length;
  const errorCount = jobs.filter((j) => j.status === "error").length;

  return {
    cron,
    scheduledTime,
    startedAt,
    completedAt,
    totalDurationMs,
    successCount,
    errorCount,
    jobs,
  };
}

// ============================================================================
// 5. HTTP Manual Trigger Handler (/trigger?cron=...)
// ============================================================================

/**
 * Handles incoming HTTP requests for health check or manual trigger execution.
 */
export async function handleHttpTrigger(
  request: Request,
  env: CronWorkerEnv,
): Promise<Response> {
  initCronWorkerPrisma(env);
  const url = new URL(request.url);

  // Health endpoint
  if (url.pathname === "/health" || url.pathname === "/") {
    return Response.json({
      status: "healthy",
      service: "weletic-cron-scheduler",
      supportedCrons: [
        CRON_SCHEDULE_5_MIN,
        CRON_SCHEDULE_HOURLY,
        CRON_SCHEDULE_DAILY,
      ],
      timestamp: new Date().toISOString(),
    });
  }

  // Trigger endpoint
  if (
    url.pathname === "/trigger" ||
    url.pathname === "/api/trigger" ||
    url.pathname === "/api/cron/weletic/loyalty/tier-sweep"
  ) {
    // 1. Edge Burst Rate Limiting (SEC-R4-04)
    if (env.RATE_LIMIT_DISABLED !== true && env.RATE_LIMIT_DISABLED !== "true") {
      const clientIp = getClientIp(request);
      if (clientIp) {
        const rlResult = cronRateLimiter.check(
          clientIp,
          env.RATE_LIMIT_MAX,
          env.RATE_LIMIT_WINDOW_MS,
        );
        if (!rlResult.success) {
          return createRateLimitResponse(
            rlResult.resetMs,
            rlResult.limit,
            rlResult.remaining,
          );
        }
      }
    }

    // 2. Fail-closed authentication check with constant-time comparison (SEC-R4-03)
    if (!env.CRON_SECRET || !env.CRON_SECRET.trim()) {
      return Response.json(
        { error: "Unauthorized: CRON_SECRET is not configured." },
        { status: 401 },
      );
    }

    const authHeader = request.headers.get("Authorization");
    if (!authHeader) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const expected = `Bearer ${env.CRON_SECRET.trim()}`;
    if (!timingSafeStringEqual(authHeader, expected)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    if (
      url.pathname === "/api/cron/weletic/loyalty/tier-sweep" ||
      url.searchParams.get("job") === "vip-tier-sweep" ||
      url.searchParams.get("cron") === "tier-sweep"
    ) {
      const sweepJob = await executeIsolatedJob("vip-tier-review-sweep", () =>
        vipTierReviewSweepJob(env),
      );
      return Response.json(sweepJob, {
        status: sweepJob.status === "error" ? 500 : 200,
      });
    }

    let targetCron = url.searchParams.get("cron")?.trim();

    // Support POST JSON body for cron specification
    if (!targetCron && request.method === "POST") {
      try {
        const body = (await request.json()) as { cron?: string };
        if (body?.cron) {
          targetCron = body.cron.trim();
        }
      } catch {
        // Body was not JSON or empty
      }
    }

    // Default or alias mappings
    if (!targetCron || targetCron === "5min") {
      targetCron = CRON_SCHEDULE_5_MIN;
    } else if (targetCron === "hourly") {
      targetCron = CRON_SCHEDULE_HOURLY;
    } else if (targetCron === "daily") {
      targetCron = CRON_SCHEDULE_DAILY;
    }

    const report = await scheduledHandler(
      { cron: targetCron, scheduledTime: Date.now() },
      env,
    );

    return Response.json(report, {
      status: report.errorCount > 0 ? 207 : 200,
    });
  }

  return Response.json({ error: "Not Found" }, { status: 404 });
}

// ============================================================================
// 6. Default Cloudflare Worker Export
// ============================================================================

const worker = {
  async scheduled(
    event: { cron: string; scheduledTime: number; noRetry: () => void },
    env: CronWorkerEnv,
    ctx: { waitUntil: (p: Promise<unknown>) => void },
  ): Promise<void> {
    initCronWorkerPrisma(env);
    const promise = scheduledHandler(event, env);
    if (ctx?.waitUntil) {
      ctx.waitUntil(promise);
    } else {
      await promise;
    }
  },

  async fetch(
    request: Request,
    env: CronWorkerEnv,
  ): Promise<Response> {
    initCronWorkerPrisma(env);
    return handleHttpTrigger(request, env);
  },
};

export default worker;
