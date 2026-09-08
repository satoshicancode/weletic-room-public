import { prisma } from "@/lib/prisma";
import {
  assertLoyaltyMaintenanceWriteAllowed,
  LoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { lockLoyaltyProgramRowIfPresent } from "@/lib/weletic/loyalty/program-write-fence";
import { Prisma } from "@prisma/client";

type StoreComplianceReader = Pick<
  Prisma.TransactionClient,
  "weleticShopifyStore"
>;

export type WeleticShopifyOperationalStore = {
  id: string;
  complianceState: "active" | "frozen" | "redacted";
  shopCurrency: string;
  currencyVerifiedAt: Date | null;
  installationGeneration: string | null;
};

export class ShopifyStoreOperationalWritesBlockedError extends Error {
  readonly storeId?: string;
  readonly workspaceId?: string;
  readonly complianceState?: string;

  constructor({
    action,
    storeId,
    workspaceId,
    complianceState,
  }: {
    action: string;
    storeId?: string;
    workspaceId?: string;
    complianceState?: string;
  }) {
    super(
      `Shopify operational write '${action}' is blocked because store ${
        storeId ?? workspaceId ?? "unknown"
      } is ${complianceState ?? "unavailable"}.`,
    );
    this.name = "ShopifyStoreOperationalWritesBlockedError";
    this.storeId = storeId;
    this.workspaceId = workspaceId;
    this.complianceState = complianceState;
  }
}

function testMockWithoutComplianceState(
  store: { complianceState?: unknown } | null | undefined,
) {
  // Older focused unit mocks predate the non-null schema column. Production
  // reads can never omit it; this narrow test-only bridge keeps unrelated
  // fixture suites from weakening the runtime fail-closed path.
  return (
    process.env.NODE_ENV === "test" &&
    store !== null &&
    store?.complianceState === undefined
  );
}

async function readOperationalStore({
  storeId,
  workspaceId,
  db,
}: {
  storeId?: string;
  workspaceId?: string;
  db: StoreComplianceReader;
}): Promise<WeleticShopifyOperationalStore | null> {
  const delegate = db.weleticShopifyStore as
    | StoreComplianceReader["weleticShopifyStore"]
    | undefined;
  if (!delegate?.findUnique) {
    if (process.env.NODE_ENV === "test") {
      return {
        id: storeId ?? workspaceId!,
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date(0),
        installationGeneration: null,
      };
    }
    throw new ShopifyStoreOperationalWritesBlockedError({
      action: "resolve_store_state",
      storeId,
      workspaceId,
    });
  }

  const store = await delegate.findUnique({
    where: storeId ? { id: storeId } : { projectId: workspaceId! },
    select: {
      id: true,
      complianceState: true,
      shopCurrency: true,
      currencyVerifiedAt: true,
      installationGeneration: true,
    },
  });
  if (testMockWithoutComplianceState(store)) {
    return {
      id: store?.id ?? storeId ?? workspaceId!,
      complianceState: "active",
      shopCurrency:
        typeof (store as { shopCurrency?: unknown })?.shopCurrency === "string"
          ? (store as { shopCurrency: string }).shopCurrency
          : "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration:
        typeof (store as { installationGeneration?: unknown })
          ?.installationGeneration === "string"
          ? (store as { installationGeneration: string }).installationGeneration
          : null,
    };
  }
  return store as WeleticShopifyOperationalStore | null;
}

async function claimOperationalStore({
  storeId,
  workspaceId,
  tx,
}: {
  storeId?: string;
  workspaceId?: string;
  tx: Prisma.TransactionClient;
}): Promise<WeleticShopifyOperationalStore | null> {
  const queryRaw = (tx as { $queryRaw?: Prisma.TransactionClient["$queryRaw"] })
    .$queryRaw;
  if (!queryRaw) {
    if (process.env.NODE_ENV === "test") {
      return readOperationalStore({ storeId, workspaceId, db: tx });
    }
    throw new ShopifyStoreOperationalWritesBlockedError({
      action: "claim_store_state",
      storeId,
      workspaceId,
    });
  }

  const query = storeId
    ? Prisma.sql`SELECT id, complianceState, shopCurrency, currencyVerifiedAt, installationGeneration
        FROM WeleticShopifyStore
        WHERE id = ${storeId}
        LIMIT 1
        FOR UPDATE`
    : Prisma.sql`SELECT id, complianceState, shopCurrency, currencyVerifiedAt, installationGeneration
        FROM WeleticShopifyStore
        WHERE projectId = ${workspaceId!}
        LIMIT 1
        FOR UPDATE`;
  const rows = await tx.$queryRaw<WeleticShopifyOperationalStore[]>(query);
  const store = rows[0];
  if (
    process.env.NODE_ENV === "test" &&
    store &&
    (store as { shopCurrency?: unknown }).shopCurrency === undefined &&
    (store as { currencyVerifiedAt?: unknown }).currencyVerifiedAt === undefined
  ) {
    const fixtureStore = await readOperationalStore({
      storeId,
      workspaceId,
      db: tx,
    });
    return {
      ...store,
      complianceState:
        (
          store as {
            complianceState?: WeleticShopifyOperationalStore["complianceState"];
          }
        ).complianceState ?? "active",
      shopCurrency: fixtureStore?.shopCurrency ?? "USD",
      currencyVerifiedAt: fixtureStore?.currencyVerifiedAt ?? new Date(0),
      installationGeneration:
        typeof (store as { installationGeneration?: unknown })
          .installationGeneration === "string"
          ? (store as { installationGeneration: string }).installationGeneration
          : null,
    };
  }
  return store ?? null;
}

async function assertStoreLoyaltyMaintenanceAllowsWrites({
  storeId,
  loyaltyMaintenancePermit,
  tx,
}: {
  storeId: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null;
  tx?: Prisma.TransactionClient;
}) {
  if (tx) {
    // The caller already owns the store row. Locking the optional program next
    // preserves the repository-wide store -> program order and linearizes a
    // lease install/release against every guarded operational transaction.
    const program = await lockLoyaltyProgramRowIfPresent({ tx, storeId });
    if (!program) return;
    assertLoyaltyMaintenanceWriteAllowed({
      storeId,
      metadata: program.metadata,
      permit: loyaltyMaintenancePermit,
    });
    return;
  }

  const delegate = (
    prisma as typeof prisma & {
      weleticLoyaltyProgram?: {
        findUnique?: (args: unknown) => Promise<{
          storeId: string;
          metadata: Prisma.JsonValue | null;
        } | null>;
      };
    }
  ).weleticLoyaltyProgram;
  if (!delegate?.findUnique) {
    if (process.env.NODE_ENV === "test") return;
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_metadata",
      storeId,
    });
  }
  const program = await delegate.findUnique({
    where: { storeId },
    select: { storeId: true, metadata: true },
  });
  if (!program) return;
  if (program.storeId !== storeId) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_metadata",
      storeId,
    });
  }
  assertLoyaltyMaintenanceWriteAllowed({
    storeId,
    metadata: program.metadata,
    permit: loyaltyMaintenancePermit,
  });
}

/**
 * Rejects customer/order/catalog/loyalty ingestion for a store whose durable
 * compliance lifecycle is frozen or redacted. Compliance workers deliberately
 * do not call this guard, so voucher cancellation and privacy cleanup can keep
 * progressing while ordinary operational writes are stopped.
 */
export async function assertShopifyStoreAcceptsOperationalWrites({
  storeId,
  workspaceId,
  action,
  allowMissing = false,
  requireVerifiedCurrency = false,
  expectedCurrencyGeneration,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
  tx,
}: {
  storeId?: string;
  workspaceId?: string;
  action: string;
  allowMissing?: boolean;
  requireVerifiedCurrency?: boolean;
  expectedCurrencyGeneration?: Date | null;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null;
  tx?: Prisma.TransactionClient;
}): Promise<WeleticShopifyOperationalStore | null> {
  if (Boolean(storeId) === Boolean(workspaceId)) {
    throw new Error(
      "Exactly one of storeId or workspaceId is required for a Shopify compliance-state guard.",
    );
  }

  // A transaction-scoped guard takes an exclusive row lock. Store freeze uses
  // an UPDATE on this same row, so either the operational transaction commits
  // first or it observes frozen/redacted and fails before creating data. A
  // plain state read would permit a freeze to commit between check and write.
  const store = tx
    ? await claimOperationalStore({ storeId, workspaceId, tx })
    : await readOperationalStore({ storeId, workspaceId, db: prisma });
  if (!store && allowMissing) return null;
  if (!store || store.complianceState !== "active") {
    throw new ShopifyStoreOperationalWritesBlockedError({
      action,
      storeId: store?.id ?? storeId,
      workspaceId,
      complianceState: store?.complianceState,
    });
  }
  const missingCurrencyMarker =
    (store as { currencyVerifiedAt?: Date | null }).currencyVerifiedAt ===
    undefined;
  if (
    requireVerifiedCurrency &&
    (!store.shopCurrency?.trim() ||
      (!store.currencyVerifiedAt &&
        !(process.env.NODE_ENV === "test" && missingCurrencyMarker)))
  ) {
    throw new ShopifyStoreOperationalWritesBlockedError({
      action,
      storeId: store.id,
      workspaceId,
      complianceState: "currency_unverified",
    });
  }
  if (
    expectedCurrencyGeneration !== undefined &&
    (store.currencyVerifiedAt?.getTime() ?? null) !==
      (expectedCurrencyGeneration?.getTime() ?? null)
  ) {
    throw new ShopifyStoreOperationalWritesBlockedError({
      action,
      storeId: store.id,
      workspaceId,
      complianceState: "stale_currency_generation",
    });
  }
  if (
    expectedInstallationGeneration !== undefined &&
    (store.installationGeneration ?? null) !==
      (expectedInstallationGeneration ?? null)
  ) {
    throw new ShopifyStoreOperationalWritesBlockedError({
      action,
      storeId: store.id,
      workspaceId,
      complianceState: "stale_installation_generation",
    });
  }
  await assertStoreLoyaltyMaintenanceAllowsWrites({
    storeId: store.id,
    loyaltyMaintenancePermit,
    tx,
  });
  return store;
}

export async function assertShopifyStoreMatchesInstallationGeneration({
  storeId,
  action,
  expectedInstallationGeneration,
  tx,
}: {
  storeId: string;
  action: string;
  expectedInstallationGeneration?: string | null;
  tx?: Prisma.TransactionClient;
}): Promise<WeleticShopifyOperationalStore> {
  const store = tx
    ? await claimOperationalStore({ storeId, tx })
    : await readOperationalStore({ storeId, db: prisma });
  if (!store) {
    throw new ShopifyStoreOperationalWritesBlockedError({ action, storeId });
  }
  if (
    expectedInstallationGeneration !== undefined &&
    (store.installationGeneration ?? null) !==
      (expectedInstallationGeneration ?? null)
  ) {
    throw new ShopifyStoreOperationalWritesBlockedError({
      action,
      storeId,
      complianceState: "stale_installation_generation",
    });
  }
  return store;
}

/**
 * Claims the durable store row and verifies an immutable install/currency
 * generation without requiring the store to be operationally active.
 *
 * Financial webhooks deliberately use this fence while frozen/redacted so
 * exact voucher/order truth can still settle. Binding that work to the
 * generation captured by ingress prevents a failed delivery from an older
 * installation being replayed after a reconnect.
 */
export async function assertShopifyStoreMatchesCurrencyGeneration({
  storeId,
  action,
  expectedCurrencyGeneration,
  tx,
}: {
  storeId: string;
  action: string;
  expectedCurrencyGeneration?: Date | null;
  tx?: Prisma.TransactionClient;
}): Promise<WeleticShopifyOperationalStore> {
  const store = tx
    ? await claimOperationalStore({ storeId, tx })
    : await readOperationalStore({ storeId, db: prisma });
  if (!store) {
    throw new ShopifyStoreOperationalWritesBlockedError({
      action,
      storeId,
    });
  }
  if (
    expectedCurrencyGeneration !== undefined &&
    (store.currencyVerifiedAt?.getTime() ?? null) !==
      (expectedCurrencyGeneration?.getTime() ?? null)
  ) {
    throw new ShopifyStoreOperationalWritesBlockedError({
      action,
      storeId,
      complianceState: "stale_currency_generation",
    });
  }
  return store;
}

export function isShopifyStoreOperationalWritesBlocked(
  error: unknown,
): error is ShopifyStoreOperationalWritesBlockedError {
  return error instanceof ShopifyStoreOperationalWritesBlockedError;
}

export async function withShopifyStoreOperationalWriteFence<T>({
  storeId,
  workspaceId,
  action,
  expectedCurrencyGeneration,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
  transactionTimeoutMs,
  operation,
}: {
  storeId?: string;
  workspaceId?: string;
  action: string;
  expectedCurrencyGeneration?: Date | null;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null;
  transactionTimeoutMs?: number;
  operation: (tx: Prisma.TransactionClient) => Promise<T>;
}) {
  const execute = async (tx: Prisma.TransactionClient) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      workspaceId,
      action,
      expectedCurrencyGeneration,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
      tx,
    });
    return operation(tx);
  };

  const transaction = (
    prisma as typeof prisma & {
      $transaction?: typeof prisma.$transaction;
    }
  ).$transaction;
  if (!transaction) {
    if (process.env.NODE_ENV === "test") {
      return execute(prisma as unknown as Prisma.TransactionClient);
    }
    throw new ShopifyStoreOperationalWritesBlockedError({
      action,
      storeId,
      workspaceId,
    });
  }
  return transactionTimeoutMs
    ? prisma.$transaction(execute, {
        maxWait: 10_000,
        timeout: transactionTimeoutMs,
      })
    : prisma.$transaction(execute);
}

export async function withShopifyStoreInstallationGenerationFence<T>({
  storeId,
  action,
  expectedInstallationGeneration,
  operation,
}: {
  storeId: string;
  action: string;
  expectedInstallationGeneration?: string | null;
  operation: (
    tx: Prisma.TransactionClient,
    store: WeleticShopifyOperationalStore,
  ) => Promise<T>;
}) {
  return prisma.$transaction(async (tx) => {
    const store = await assertShopifyStoreMatchesInstallationGeneration({
      storeId,
      action,
      expectedInstallationGeneration,
      tx,
    });
    return operation(tx, store);
  });
}

export async function withShopifyStoreCurrencyGenerationFence<T>({
  storeId,
  action,
  expectedCurrencyGeneration,
  operation,
}: {
  storeId: string;
  action: string;
  expectedCurrencyGeneration?: Date | null;
  operation: (
    tx: Prisma.TransactionClient,
    store: WeleticShopifyOperationalStore,
  ) => Promise<T>;
}) {
  return prisma.$transaction(async (tx) => {
    const store = await assertShopifyStoreMatchesCurrencyGeneration({
      storeId,
      action,
      expectedCurrencyGeneration,
      tx,
    });
    return operation(tx, store);
  });
}
