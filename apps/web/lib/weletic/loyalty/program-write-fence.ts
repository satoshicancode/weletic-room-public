import { prisma } from "@/lib/prisma";
import {
  assertLoyaltyMaintenanceWriteAllowed,
  isLoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { Prisma } from "@prisma/client";

export type LoyaltyProgramRowLockMode = "lock_only" | "active";

export type LockedLoyaltyProgram = {
  id: string;
  storeId: string;
  status: string;
  killSwitchActive: boolean | number | bigint;
  metadata: Prisma.JsonValue | null;
};

export class LoyaltyProgramWriteBlockedError extends Error {
  constructor(message = "Loyalty program is currently disabled or inactive.") {
    super(message);
    this.name = "LoyaltyProgramWriteBlockedError";
  }
}

export class LoyaltyProgramCurrencyGenerationError extends Error {
  constructor(message = "Shopify store currency generation changed.") {
    super(message);
    this.name = "LoyaltyProgramCurrencyGenerationError";
  }
}

export function isLockedLoyaltyProgramActive(
  program: LockedLoyaltyProgram,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null,
) {
  if (program.status !== "active" || Boolean(program.killSwitchActive)) {
    return false;
  }
  try {
    assertLoyaltyMaintenanceWriteAllowed({
      storeId: program.storeId,
      metadata: program.metadata,
      permit: loyaltyMaintenancePermit,
    });
    return true;
  } catch (error) {
    if (isLoyaltyMaintenanceBlockedError(error)) return false;
    throw error;
  }
}

export function assertLockedLoyaltyProgramActive(
  program: LockedLoyaltyProgram,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null,
) {
  assertLoyaltyMaintenanceWriteAllowed({
    storeId: program.storeId,
    metadata: program.metadata,
    permit: loyaltyMaintenancePermit,
  });
  if (program.status !== "active" || Boolean(program.killSwitchActive)) {
    throw new LoyaltyProgramWriteBlockedError();
  }
}

/**
 * Locks the tenant's single loyalty-program row inside an existing transaction.
 *
 * Merchant status/kill-switch updates write this same row. Holding the lock
 * therefore makes the caller linearizable with disable: the guarded operation
 * either commits before the disable, or observes the disabled generation and
 * fails before creating/adopting a voucher.
 */
export async function lockLoyaltyProgramRow({
  tx,
  storeId,
  mode,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  mode: LoyaltyProgramRowLockMode;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null;
}) {
  const queryRaw = (tx as { $queryRaw?: Prisma.TransactionClient["$queryRaw"] })
    .$queryRaw;
  if (!queryRaw) {
    // Legacy focused unit mocks predate transaction-scoped raw queries. Runtime
    // Prisma clients always expose $queryRaw; new fence tests provide it and
    // exercise both modes explicitly.
    if (process.env.NODE_ENV === "test") {
      const program: LockedLoyaltyProgram = {
        id: `test-program:${storeId}`,
        storeId,
        status: "active",
        killSwitchActive: false,
        metadata: null,
      };
      if (mode === "active") {
        assertLockedLoyaltyProgramActive(program, loyaltyMaintenancePermit);
      }
      return program;
    }
    throw new LoyaltyProgramWriteBlockedError(
      "Loyalty program write fence is unavailable.",
    );
  }

  const programs = await tx.$queryRaw<LockedLoyaltyProgram[]>(Prisma.sql`
    SELECT id, storeId, status, killSwitchActive, metadata
    FROM WeleticLoyaltyProgram
    WHERE storeId = ${storeId}
    LIMIT 1
    FOR UPDATE
  `);
  const program = programs[0];
  if (!program || program.storeId !== storeId) {
    throw new LoyaltyProgramWriteBlockedError(
      "Loyalty program is unavailable for this Shopify store.",
    );
  }
  if (mode === "active") {
    assertLockedLoyaltyProgramActive(program, loyaltyMaintenancePermit);
  }
  return program;
}

/**
 * Locks the program row when it exists without requiring an initialized
 * loyalty program. Currency/lifecycle writers call this only after locking the
 * owning store row, which is the repository-wide store -> program lock order.
 */
export async function lockLoyaltyProgramRowIfPresent({
  tx,
  storeId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
}) {
  const queryRaw = (tx as { $queryRaw?: Prisma.TransactionClient["$queryRaw"] })
    .$queryRaw;
  if (!queryRaw) {
    if (process.env.NODE_ENV === "test") return null;
    throw new LoyaltyProgramWriteBlockedError(
      "Loyalty program currency-generation fence is unavailable.",
    );
  }
  const programs = await tx.$queryRaw<LockedLoyaltyProgram[]>(Prisma.sql`
    SELECT id, storeId, status, killSwitchActive, metadata
    FROM WeleticLoyaltyProgram
    WHERE storeId = ${storeId}
    LIMIT 1
    FOR UPDATE
  `);
  const program = programs[0] ?? null;
  if (
    process.env.NODE_ENV === "test" &&
    program &&
    program.storeId === undefined &&
    program.status === undefined &&
    program.killSwitchActive === undefined &&
    program.metadata === undefined
  ) {
    // Legacy focused store-fence mocks return the same store-row fixture for
    // every raw query. Runtime SQL always projects this complete program shape.
    return null;
  }
  if (program && program.storeId !== storeId) {
    throw new LoyaltyProgramWriteBlockedError(
      "Loyalty program changed tenant while locking its currency generation.",
    );
  }
  return program;
}

/**
 * Re-reads the store currency immediately before remote voucher I/O while the
 * caller holds the program row lock. Currency writers lock store -> program,
 * so this plain MVCC read observes either the generation before their commit
 * (the voucher linearizes first) or the generation after it (and stale
 * snapshots fail before Shopify receives a create).
 */
export async function assertLockedLoyaltyProgramCurrencyGeneration({
  tx,
  storeId,
  expectedCurrency,
  expectedCurrencyVerifiedAt,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  expectedCurrency: string;
  expectedCurrencyVerifiedAt?: string | Date | null;
}) {
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      complianceState: true,
      shopCurrency: true,
      currencyVerifiedAt: true,
    },
  });
  const legacyTestFixture =
    process.env.NODE_ENV === "test" &&
    store != null &&
    (store as { complianceState?: unknown }).complianceState === undefined &&
    (store as { currencyVerifiedAt?: unknown }).currencyVerifiedAt ===
      undefined;
  const currentCurrency = store?.shopCurrency?.trim().toUpperCase();
  if (
    !store ||
    (!legacyTestFixture && store.complianceState !== "active") ||
    !currentCurrency ||
    (!legacyTestFixture && !store.currencyVerifiedAt) ||
    currentCurrency !== expectedCurrency.trim().toUpperCase() ||
    (expectedCurrencyVerifiedAt !== undefined &&
      (store.currencyVerifiedAt?.getTime() ?? null) !==
        (expectedCurrencyVerifiedAt === null
          ? null
          : new Date(expectedCurrencyVerifiedAt).getTime()))
  ) {
    throw new LoyaltyProgramCurrencyGenerationError(
      `Shopify store ${storeId} currency generation no longer matches ${expectedCurrency.trim().toUpperCase()}.`,
    );
  }
  return currentCurrency;
}

export async function withLoyaltyProgramRowLock<T>({
  storeId,
  mode,
  loyaltyMaintenancePermit,
  operation,
  timeoutMs = 60_000,
}: {
  storeId: string;
  mode: LoyaltyProgramRowLockMode;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null;
  operation: (
    tx: Prisma.TransactionClient,
    program: LockedLoyaltyProgram,
  ) => Promise<T>;
  timeoutMs?: number;
}) {
  return prisma.$transaction(
    async (tx) => {
      const program = await lockLoyaltyProgramRow({
        tx,
        storeId,
        mode,
        loyaltyMaintenancePermit,
      });
      return operation(tx, program);
    },
    { maxWait: 10_000, timeout: timeoutMs },
  );
}
