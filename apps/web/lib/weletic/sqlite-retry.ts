import { OptimisticConcurrencyError } from "@/lib/weletic/loyalty/ledger";
import { Prisma } from "@prisma/client";

export interface TransactionRetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  actionName?: string;
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_RETRY_CONFIG: Required<
  Omit<TransactionRetryConfig, "isRetryable">
> & {
  isRetryable?: (error: unknown) => boolean;
} = {
  maxRetries: 4, // 5 total attempts
  baseDelayMs: 50, // 50ms base delay
  maxDelayMs: 800, // 800ms cap
  jitter: true,
  actionName: "financial_transaction",
};

/**
 * Accurately determines if a database error is a transient concurrency collision
 * on SQLite / Cloudflare D1 or Prisma Client (FIN-AUDIT-10).
 */
export function isRetriableSqliteError(error: unknown): boolean {
  if (!error) return false;

  // 1. Optimistic Concurrency Control from Weletic ledger, programs and referrals
  if (
    error instanceof OptimisticConcurrencyError ||
    (error as any)?.name === "OptimisticLockConflictError" ||
    (error as any)?.name === "ReferralTransactionConflictError"
  ) {
    return true;
  }

  // 2. Prisma Known Request Errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034: Transaction failed due to a write conflict or a deadlock.
    // P2028: Transaction API error (transaction already closed / timeout during wait).
    // P2024: Timed out waiting for connection / transaction lock.
    if (["P2034", "P2028", "P2024"].includes(error.code)) {
      return true;
    }

    // P2010: Raw query error containing SQLite lock metadata
    if (error.code === "P2010") {
      const msg = String(error.message || "").toLowerCase();
      const metaMsg = String((error.meta as any)?.message || "").toLowerCase();
      if (
        msg.includes("sqlite_busy") ||
        msg.includes("database is locked") ||
        msg.includes("sqlite_locked") ||
        metaMsg.includes("sqlite_busy") ||
        metaMsg.includes("database is locked") ||
        (error.meta as any)?.code === "1213" // MySQL deadlock fallback
      ) {
        return true;
      }
    }

    return false;
  }

  // 3. Driver-level errors, Unknown Request errors, or D1 stepping errors
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();

  return (
    message.includes("sqlite_busy") ||
    message.includes("database is locked") ||
    message.includes("sqlite_locked") ||
    message.includes("d1_error") ||
    message.includes("stepping, database is locked") ||
    message.includes("write conflict") ||
    message.includes("timed out waiting for transaction lock")
  );
}

/**
 * Wraps an async database transaction with jittered exponential backoff
 * designed specifically for SQLite / Cloudflare D1 single-writer concurrency (FIN-AUDIT-10).
 */
export async function withFinancialTransactionRetry<T>(
  operation: () => Promise<T>,
  configOverride?: TransactionRetryConfig,
): Promise<T> {
  const config = { ...DEFAULT_RETRY_CONFIG, ...configOverride };

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retriable =
        (config.isRetryable ? config.isRetryable(error) : false) ||
        isRetriableSqliteError(error);
      if (attempt >= config.maxRetries || !retriable) {
        throw error;
      }

      // Calculate jittered exponential backoff
      const expDelay = config.baseDelayMs * Math.pow(2, attempt);
      const jitterMs = config.jitter ? Math.floor(Math.random() * expDelay) : 0;
      const delay = Math.min(config.maxDelayMs, expDelay + jitterMs);

      console.warn(
        `[${config.actionName}] SQLite write contention encountered (attempt ${attempt + 1}/${config.maxRetries + 1}), retrying in ${delay}ms:`,
        error instanceof Error ? error.message : String(error),
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw new Error(`[${config.actionName}] Retry budget exhausted.`);
}
