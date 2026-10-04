import { captureWebhookLog } from "@/lib/api-logs/capture-webhook-log";
import { prisma } from "@/lib/prisma";
import {
  isLoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration,
} from "@/lib/weletic/shopify/store-compliance-state";
import { log } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { ordersPaid } from "app/(ee)/api/shopify/integration/webhook/orders-paid";

export const IN_FLIGHT_LEASE_THRESHOLD_MS = 180_000;
export const MAX_RETRY_ATTEMPTS = 5;
export const DEFAULT_BATCH_LIMIT = 10;
export const CRON_DEADLINE_MS = 40_000;

function sameInstallationGeneration(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return (left ?? null) === (right ?? null);
}

export function getFailedRetryBackoffMs(attempts: number): number {
  const safeAttempts = Math.max(1, attempts);
  // Exponential backoff: attempt 1: 60s, attempt 2: 120s, attempt 3: 240s, attempt 4: 480s, max 30 min
  return Math.min(1800_000, 60_000 * Math.pow(2, safeAttempts - 1));
}

export async function assertOrdersPaidStoreAcceptsWrite({
  storeId,
  action,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
  tx,
}: {
  storeId: string;
  action: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}) {
  const financialStore =
    await assertShopifyStoreMatchesInstallationGeneration({
      storeId,
      action,
      expectedInstallationGeneration,
      tx,
    });
  if (financialStore.complianceState !== "active") return financialStore;
  return assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
    tx,
  });
}

export interface ClaimedOrdersPaidExecutionInput {
  claim: {
    id: string;
    storeId: string;
    attempt: number;
    storeInstallationGeneration: string | null;
    dispatchInstallationGeneration: string | null;
    privacyMinimizedFinancialSettlement: boolean;
  };
  event: any;
  workspace: {
    id: string;
    defaultProgramId: string | null;
    webhookEnabled: boolean;
  };
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  startTime?: number;
  requestLog?: {
    workspaceId: string;
    method: string;
    path: Parameters<typeof captureWebhookLog>[0]["path"];
    requestBody: any;
    userAgent?: string | null;
  };
}

export async function executeClaimedOrdersPaidEvent({
  claim,
  event,
  workspace,
  loyaltyMaintenancePermit,
  startTime = Date.now(),
  requestLog,
}: ClaimedOrdersPaidExecutionInput): Promise<{
  status: "processed" | "failed" | "conflict";
  response?: string;
  error?: string;
}> {
  try {
    // 1. Dispatch Gate: Assert store accepts operational write
    await assertOrdersPaidStoreAcceptsWrite({
      storeId: claim.storeId,
      action: "webhook_dispatch:orders/paid",
      expectedInstallationGeneration: claim.dispatchInstallationGeneration,
      loyaltyMaintenancePermit,
    });

    // 2. Main downstream commerce execution
    const response = await ordersPaid({
      event,
      workspace,
      storeId: claim.storeId,
      expectedInstallationGeneration: claim.dispatchInstallationGeneration,
      privacyMinimizedFinancialSettlement:
        claim.privacyMinimizedFinancialSettlement,
      loyaltyMaintenancePermit,
    });

    // 3. Completion Transaction: Write fence check + monotonic state commit
    const completed = await prisma.$transaction(async (tx) => {
      await assertOrdersPaidStoreAcceptsWrite({
        storeId: claim.storeId,
        action: "webhook_complete:orders/paid",
        expectedInstallationGeneration: claim.dispatchInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
      return tx.weleticShopifyWebhookEvent.updateMany({
        where: {
          id: claim.id,
          storeId: claim.storeId,
          topic: "orders/paid",
          status: "received",
          attempts: claim.attempt,
          storeInstallationGeneration: claim.storeInstallationGeneration,
        },
        data: {
          status: "processed",
          processedAt: new Date(),
        },
      });
    });

    if (completed.count !== 1) {
      return {
        status: "conflict",
        error:
          "[Shopify] Webhook lease was reclaimed; stale completion was discarded.",
      };
    }

    if (requestLog) {
      waitUntil(
        captureWebhookLog({
          ...requestLog,
          userAgent: requestLog.userAgent ?? null,
          statusCode: 200,
          duration: Date.now() - startTime,
          responseBody: response,
        }),
      );
    }

    return { status: "processed", response };
  } catch (error: any) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const failed = await prisma.weleticShopifyWebhookEvent.updateMany({
      where: {
        id: claim.id,
        storeId: claim.storeId,
        topic: "orders/paid",
        status: "received",
        attempts: claim.attempt,
        storeInstallationGeneration: claim.storeInstallationGeneration,
      },
      data: {
        status: "failed",
        error: errorMessage,
      },
    });

    if (failed.count !== 1) {
      return {
        status: "conflict",
        error:
          "[Shopify] Webhook lease was reclaimed; stale failure was discarded.",
      };
    }

    await log({
      message: `Shopify orders/paid processing failed. Error: ${errorMessage}`,
      type: "errors",
    }).catch(() => {});

    if (requestLog) {
      waitUntil(
        captureWebhookLog({
          ...requestLog,
          userAgent: requestLog.userAgent ?? null,
          statusCode: 500,
          duration: Date.now() - startTime,
          responseBody: `[Shopify] Webhook handler failed. Error: ${errorMessage}`,
        }),
      );
    }

    return { status: "failed", error: errorMessage };
  }
}

export async function recoverStuckOrdersPaidWebhooks({
  workspaceId,
  storeId,
  limit = DEFAULT_BATCH_LIMIT,
  inFlightLeaseMs = IN_FLIGHT_LEASE_THRESHOLD_MS,
  maxAttempts = MAX_RETRY_ATTEMPTS,
  deadlineMs = CRON_DEADLINE_MS,
}: {
  workspaceId?: string;
  storeId?: string;
  limit?: number;
  inFlightLeaseMs?: number;
  maxAttempts?: number;
  deadlineMs?: number;
} = {}) {
  const now = Date.now();
  const startTime = Date.now();
  const cutoffInFlight = new Date(now - inFlightLeaseMs);
  const minFailedCutoff = new Date(now - 60_000); // Earliest possible retry is 60s

  // Fix 5: Filter target store IDs before claiming
  let targetStoreIds: string[] | undefined;
  if (storeId) {
    targetStoreIds = [storeId];
  } else if (workspaceId) {
    const stores = await prisma.weleticShopifyStore.findMany({
      where: { projectId: workspaceId },
      select: { id: true },
    });
    targetStoreIds = stores.map((s) => s.id);
    if (targetStoreIds.length === 0) {
      return [];
    }
  }

  // Find candidate events that might be eligible
  const candidates = await prisma.weleticShopifyWebhookEvent.findMany({
    where: {
      topic: "orders/paid",
      ...(targetStoreIds ? { storeId: { in: targetStoreIds } } : {}),
      attempts: { lt: maxAttempts },
      OR: [
        { status: "received", updatedAt: { lt: cutoffInFlight } },
        { status: "failed", updatedAt: { lt: minFailedCutoff } },
      ],
    },
    take: limit * 2, // Fetch a small buffer to account for backoff filtering
    orderBy: { updatedAt: "asc" },
  });

  // Fix 4: Backoff filter based on attempts
  const eligible = candidates
    .filter((c) => {
      if (!c.payload) return false;
      if (c.status === "received") {
        return c.updatedAt.getTime() < now - inFlightLeaseMs;
      }
      if (c.status === "failed") {
        return (
          c.updatedAt.getTime() < now - getFailedRetryBackoffMs(c.attempts)
        );
      }
      return false;
    })
    .slice(0, limit);

  const results: Array<{
    id: string;
    webhookId: string;
    status: string;
    error?: string;
    isTerminal?: boolean;
  }> = [];

  for (const candidate of eligible) {
    // Fix 7: Graceful deadline break to ensure 60s cron budget is never exceeded
    if (Date.now() - startTime > deadlineMs) {
      break;
    }

    const nextAttempt = candidate.attempts + 1;
    const claim = await prisma.weleticShopifyWebhookEvent.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        attempts: candidate.attempts,
      },
      data: {
        status: "received",
        attempts: { increment: 1 },
        updatedAt: new Date(),
        error: null,
      },
    });

    if (claim.count === 0) continue;

    try {
      const store = await prisma.weleticShopifyStore.findUnique({
        where: { id: candidate.storeId },
        select: {
          id: true,
          projectId: true,
          installationGeneration: true,
          complianceState: true,
        },
      });
      if (!store) {
        throw new Error(`Store ${candidate.storeId} not found`);
      }

      const workspace = await prisma.project.findUnique({
        where: { id: store.projectId },
        select: { id: true, defaultProgramId: true, webhookEnabled: true },
      });
      if (!workspace) {
        throw new Error(`Workspace ${store.projectId} not found`);
      }

      const currentGeneration = store.installationGeneration ?? null;
      const generationMatches = sameInstallationGeneration(
        candidate.storeInstallationGeneration,
        currentGeneration,
      );
      const privacyMinimized =
        !generationMatches || store.complianceState !== "active";

      // Fix 1: Unified execution with identical gates and completion asserts
      const executionResult = await executeClaimedOrdersPaidEvent({
        claim: {
          id: candidate.id,
          storeId: candidate.storeId,
          attempt: nextAttempt,
          storeInstallationGeneration: candidate.storeInstallationGeneration,
          dispatchInstallationGeneration: currentGeneration,
          privacyMinimizedFinancialSettlement: privacyMinimized,
        },
        event: candidate.payload,
        workspace,
        startTime: now,
      });

      if (executionResult.status === "processed") {
        results.push({
          id: candidate.id,
          webhookId: candidate.webhookId,
          status: "processed",
        });
      } else {
        const errorMsg = executionResult.error ?? "Execution failed";
        const isTerminal = nextAttempt >= maxAttempts;
        const finalError = isTerminal
          ? `[TERMINAL_ERROR_AUDIT] Exceeded maximum retry attempts (${maxAttempts}). Manual intervention required. Last error: ${errorMsg}`
          : errorMsg;

        if (isTerminal) {
          await prisma.weleticShopifyWebhookEvent
            .updateMany({
              where: {
                id: candidate.id,
                status: "failed",
                attempts: nextAttempt,
              },
              data: {
                error: finalError,
              },
            })
            .catch(() => {});

          await log({
            message: `[Shopify Webhook Terminal Failure] Webhook ${candidate.webhookId} exceeded ${maxAttempts} attempts. Error: ${errorMsg}`,
            type: "errors",
          }).catch(() => {});
        }

        results.push({
          id: candidate.id,
          webhookId: candidate.webhookId,
          status: "failed",
          error: finalError,
          isTerminal,
        });
      }
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTerminal = nextAttempt >= maxAttempts;
      const finalError = isTerminal
        ? `[TERMINAL_ERROR_AUDIT] Exceeded maximum retry attempts (${maxAttempts}). Manual intervention required. Last error: ${errorMsg}`
        : errorMsg;

      await prisma.weleticShopifyWebhookEvent
        .updateMany({
          where: {
            id: candidate.id,
            status: "received",
            attempts: nextAttempt,
          },
          data: {
            status: "failed",
            error: finalError,
          },
        })
        .catch(() => {});

      if (isTerminal) {
        await log({
          message: `[Shopify Webhook Terminal Failure] Webhook ${candidate.webhookId} exceeded ${maxAttempts} attempts. Error: ${errorMsg}`,
          type: "errors",
        }).catch(() => {});
      }

      results.push({
        id: candidate.id,
        webhookId: candidate.webhookId,
        status: "failed",
        error: finalError,
        isTerminal,
      });
    }
  }

  return results;
}

export async function auditTerminalFailedOrdersPaidWebhooks({
  limit = 50,
  storeId,
}: {
  limit?: number;
  storeId?: string;
} = {}) {
  return prisma.weleticShopifyWebhookEvent.findMany({
    where: {
      topic: "orders/paid",
      status: "failed",
      attempts: { gte: MAX_RETRY_ATTEMPTS },
      ...(storeId ? { storeId } : {}),
    },
    take: limit,
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      storeId: true,
      webhookId: true,
      topic: true,
      status: true,
      attempts: true,
      error: true,
      payload: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}
