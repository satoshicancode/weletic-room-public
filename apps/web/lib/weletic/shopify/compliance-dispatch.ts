import { prisma } from "@/lib/prisma";

// Shopify allows five seconds for the entire webhook request. Reserve two
// seconds for durable persistence, route overhead, and the response while
// allowing a normally healthy QStash publish to finish across regions.
export const SHOPIFY_COMPLIANCE_DISPATCH_TIMEOUT_MS = 3_000;

export class ShopifyComplianceDispatchUnavailableError extends Error {
  constructor() {
    super(
      "The durable Shopify compliance request could not be dispatched; retry delivery.",
    );
    this.name = "ShopifyComplianceDispatchUnavailableError";
  }
}

async function markComplianceRequestImmediatelyRetryable(requestId: string) {
  const candidate = await prisma.weleticShopifyComplianceRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      storeId: true,
      status: true,
      phase: true,
      leaseVersion: true,
      lockedAt: true,
      lockedBy: true,
      nextRetryAt: true,
      updatedAt: true,
    },
  });
  if (
    !candidate ||
    candidate.status !== "pending" ||
    candidate.lockedAt !== null ||
    candidate.lockedBy !== null
  ) {
    return false;
  }

  const retryable = await prisma.weleticShopifyComplianceRequest.updateMany({
    where: {
      id: candidate.id,
      storeId: candidate.storeId,
      status: candidate.status,
      phase: candidate.phase,
      leaseVersion: candidate.leaseVersion,
      lockedAt: null,
      lockedBy: null,
      nextRetryAt: candidate.nextRetryAt,
      updatedAt: candidate.updatedAt,
    },
    data: {
      status: "retrying",
      nextRetryAt: new Date(),
      lastError:
        "Compliance worker dispatch unavailable; durable retry is immediately due.",
    },
  });
  return retryable.count === 1;
}

async function markComplianceContinuationDispatchFailure(requestId: string) {
  const candidate = await prisma.weleticShopifyComplianceRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true,
      storeId: true,
      status: true,
      phase: true,
      leaseVersion: true,
      lockedAt: true,
      lockedBy: true,
      nextRetryAt: true,
      updatedAt: true,
    },
  });
  if (
    !candidate ||
    candidate.status !== "pending" ||
    candidate.lockedAt !== null ||
    candidate.lockedBy !== null
  ) {
    return false;
  }

  const marked = await prisma.weleticShopifyComplianceRequest.updateMany({
    where: {
      id: candidate.id,
      storeId: candidate.storeId,
      status: candidate.status,
      phase: candidate.phase,
      leaseVersion: candidate.leaseVersion,
      lockedAt: null,
      lockedBy: null,
      nextRetryAt: candidate.nextRetryAt,
      updatedAt: candidate.updatedAt,
    },
    data: {
      lastError:
        "Compliance continuation dispatch unavailable; the durable recovery sweep remains authoritative.",
    },
  });
  return marked.count === 1;
}

/**
 * Queue transport is bounded so Shopify ingress remains within its response
 * budget. A false, rejected, or timed-out publish makes the durable row due via
 * an exact CAS and then fails the current delivery loudly. Any late/duplicate
 * publish is harmless because compliance request claiming is idempotent.
 */
export async function dispatchDurableShopifyComplianceRequest({
  requestId,
  dispatch,
  failurePolicy,
  timeoutMs = SHOPIFY_COMPLIANCE_DISPATCH_TIMEOUT_MS,
}: {
  requestId: string;
  dispatch: () => Promise<boolean>;
  failurePolicy: "make-immediately-due" | "preserve-retry-deadline";
  timeoutMs?: number;
}) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let dispatched = false;
  try {
    dispatched =
      (await Promise.race([
        dispatch(),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs);
        }),
      ])) === true;
  } catch {
    dispatched = false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (dispatched) return;
  try {
    if (failurePolicy === "make-immediately-due") {
      await markComplianceRequestImmediatelyRetryable(requestId);
    } else {
      await markComplianceContinuationDispatchFailure(requestId);
    }
  } catch {
    // The current delivery must still fail with the dedicated dispatch signal.
    // In particular, a continuation already released its worker lease before
    // reaching this helper, so the worker's generic failure CAS no longer owns
    // the row and must not turn a marker outage into an acknowledged 200.
  }
  throw new ShopifyComplianceDispatchUnavailableError();
}
