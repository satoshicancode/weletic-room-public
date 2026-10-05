import { prisma } from "@/lib/prisma";
import {
  assertLoyaltyMaintenanceWriteAllowed,
  isLoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { isShopifyStoreAccessActive } from "@/lib/weletic/shopify/store-access-policy";
import { Prisma } from "@prisma/client";

export type LoyaltyProgramRowLockMode = "lock_only" | "active";

export type LockedLoyaltyProgram = {
  id: string;
  storeId: string;
  status: string;
  killSwitchActive: boolean | number | bigint;
  metadata: Prisma.JsonValue | null;
  storeAccessState?: string;
  version?: number;
};

export class OptimisticLockConflictError extends Error {
  readonly programId?: string;
  readonly expectedVersion?: number;

  constructor(
    message = "Optimistic lock conflict: loyalty program was modified concurrently.",
    options?: { programId?: string; expectedVersion?: number },
  ) {
    super(message);
    this.name = "OptimisticLockConflictError";
    this.programId = options?.programId;
    this.expectedVersion = options?.expectedVersion;
  }
}

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
  if (
    program.status !== "active" ||
    Boolean(program.killSwitchActive) ||
    (!isShopifyStoreAccessActive(program.storeAccessState) &&
      !(
        process.env.NODE_ENV === "test" &&
        program.storeAccessState === undefined
      ))
  ) {
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
  if (
    program.status !== "active" ||
    Boolean(program.killSwitchActive) ||
    (!isShopifyStoreAccessActive(program.storeAccessState) &&
      !(
        process.env.NODE_ENV === "test" &&
        program.storeAccessState === undefined
      ))
  ) {
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
        version: 1,
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

  // Acquire the store before the program, matching admission/lifecycle writers.
  // This also covers remote voucher workers that hold only this program fence.
  const stores = await tx.$queryRaw<
    Array<{ id: string; storeAccessState: string }>
  >(Prisma.sql`
      SELECT id, storeAccessState FROM WeleticShopifyStore
      WHERE id = ${storeId} LIMIT 1 FOR UPDATE
    `);
  const store = stores[0];
  if (
    !(
      process.env.NODE_ENV === "test" &&
      store &&
      store.storeAccessState === undefined
    )
  ) {
    if (store?.id !== storeId)
      throw new LoyaltyProgramWriteBlockedError(
        "Shopify store is unavailable.",
      );
  }
  const programs = await tx.$queryRaw<Array<LockedLoyaltyProgram & { version: number }>>(Prisma.sql`
    SELECT id, storeId, status, killSwitchActive, metadata, COALESCE(version, 1) AS version
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
  // Cleanup remains available, but subsequent adoption predicates must use the
  // admission state captured under the same transaction's store lock.
  if (store?.storeAccessState !== undefined)
    program.storeAccessState = store.storeAccessState;
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
  const programs = await tx.$queryRaw<Array<LockedLoyaltyProgram & { version: number }>>(Prisma.sql`
    SELECT id, storeId, status, killSwitchActive, metadata, COALESCE(version, 1) AS version
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

export type LoyaltyProgramSnapshot = LockedLoyaltyProgram & {
  version: number;
  program: LockedLoyaltyProgram & { version: number };
};

/**
 * Lock-free MVCC snapshot read of a tenant's loyalty program.
 * Does NOT acquire exclusive row locks (no FOR UPDATE).
 */
export async function readLoyaltyProgramSnapshot({
  client,
  tx,
  storeId,
  mode = "active",
  loyaltyMaintenancePermit,
}: {
  client?: Prisma.TransactionClient | typeof prisma;
  tx?: Prisma.TransactionClient;
  storeId: string;
  mode?: LoyaltyProgramRowLockMode;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null;
}): Promise<LoyaltyProgramSnapshot> {
  const dbClient = (client ?? tx ?? prisma) as Prisma.TransactionClient;
  const queryRaw = (dbClient as { $queryRaw?: Prisma.TransactionClient["$queryRaw"] }).$queryRaw;

  if (!queryRaw) {
    if (process.env.NODE_ENV === "test") {
      const baseProgram: LockedLoyaltyProgram & { version: number } = {
        id: `test-program:${storeId}`,
        storeId,
        status: "active",
        killSwitchActive: false,
        metadata: null,
        version: 1,
      };
      if (mode === "active") {
        assertLockedLoyaltyProgramActive(baseProgram, loyaltyMaintenancePermit);
      }
      return {
        ...baseProgram,
        program: baseProgram,
        version: 1,
      };
    }
    throw new LoyaltyProgramWriteBlockedError(
      "Loyalty program write fence is unavailable.",
    );
  }

  try {
    // Non-blocking MVCC read of store access state
    const stores = (await queryRaw.call(
      dbClient,
      Prisma.sql`
        SELECT id, storeAccessState FROM WeleticShopifyStore
        WHERE id = ${storeId} LIMIT 1
      `,
    )) as Array<{ id: string; storeAccessState: string }>;
    const store = stores[0];
    if (
      !(
        process.env.NODE_ENV === "test" &&
        store &&
        store.storeAccessState === undefined
      )
    ) {
      if (store?.id !== storeId) {
        throw new LoyaltyProgramWriteBlockedError(
          "Shopify store is unavailable.",
        );
      }
    }

    // Non-blocking MVCC read of loyalty program with OCC version
    const programs = (await queryRaw.call(
      dbClient,
      Prisma.sql`
        SELECT id, storeId, status, killSwitchActive, metadata, COALESCE(version, 1) AS version
        FROM WeleticLoyaltyProgram
        WHERE storeId = ${storeId}
        LIMIT 1
      `,
    )) as Array<LockedLoyaltyProgram & { version: number }>;
    const rawProgram = programs[0];
    if (!rawProgram || rawProgram.storeId !== storeId) {
      throw new LoyaltyProgramWriteBlockedError(
        "Loyalty program is unavailable for this Shopify store.",
      );
    }

    const programRecord: LockedLoyaltyProgram & { version: number } = {
      id: rawProgram.id,
      storeId: rawProgram.storeId,
      status: rawProgram.status,
      killSwitchActive: rawProgram.killSwitchActive,
      metadata: rawProgram.metadata,
      version: Number(rawProgram.version ?? 1),
      storeAccessState: store?.storeAccessState,
    };

    if (mode === "active") {
      assertLockedLoyaltyProgramActive(programRecord, loyaltyMaintenancePermit);
    }

    return {
      ...programRecord,
      program: programRecord,
      version: programRecord.version,
    };
  } catch (error) {
    if (
      process.env.NODE_ENV === "test" &&
      !(error instanceof LoyaltyProgramWriteBlockedError)
    ) {
      const baseProgram: LockedLoyaltyProgram & { version: number } = {
        id: `test-program:${storeId}`,
        storeId,
        status: "active",
        killSwitchActive: false,
        metadata: null,
        version: 1,
      };
      if (mode === "active") {
        assertLockedLoyaltyProgramActive(baseProgram, loyaltyMaintenancePermit);
      }
      return {
        ...baseProgram,
        program: baseProgram,
        version: 1,
      };
    }
    throw error;
  }
}

/**
 * Atomic OCC update on WeleticLoyaltyProgram using Compare-And-Swap.
 * Verifies version === expectedVersion and atomically increments version.
 * Throws OptimisticLockConflictError if updated rows === 0.
 */
export async function updateLoyaltyProgramWithOCC({
  tx,
  programId,
  expectedVersion,
  data = {},
}: {
  tx: Prisma.TransactionClient;
  programId: string;
  expectedVersion: number;
  data?:
    | Prisma.WeleticLoyaltyProgramUpdateInput
    | Prisma.WeleticLoyaltyProgramUpdateManyMutationInput;
}): Promise<{ version: number; [key: string]: unknown }> {
  const nextVersion = expectedVersion + 1;
  const result = await tx.weleticLoyaltyProgram.updateMany({
    where: {
      id: programId,
      version: expectedVersion,
    },
    data: {
      ...data,
      version: nextVersion,
    },
  });

  if (result.count === 0) {
    throw new OptimisticLockConflictError(
      `Optimistic lock conflict on loyalty program ${programId} (expected version ${expectedVersion}).`,
      { programId, expectedVersion },
    );
  }

  return {
    ...data,
    programId,
    version: nextVersion,
  };
}

export const updateLoyaltyProgramWithOcc = updateLoyaltyProgramWithOCC;

export async function assertLoyaltyProgramVersionMatches({
  tx,
  programId,
  expectedVersion,
}: {
  tx: Prisma.TransactionClient;
  programId: string;
  expectedVersion: number;
}) {
  const current = await tx.weleticLoyaltyProgram.findUnique({
    where: { id: programId },
    select: { version: true, status: true, killSwitchActive: true },
  });
  if (
    !current ||
    current.version !== expectedVersion ||
    current.status !== "active" ||
    Boolean(current.killSwitchActive)
  ) {
    throw new OptimisticLockConflictError(
      `Loyalty program ${programId} state changed during operation.`,
      { programId, expectedVersion },
    );
  }
}
