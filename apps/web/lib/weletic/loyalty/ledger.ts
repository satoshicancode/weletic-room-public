import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { getLifetimeEarnedPointsDelta } from "@/lib/weletic/loyalty/ledger-entry-policy";
import { calculateNextPointsExpiryDate } from "@/lib/weletic/loyalty/points-expiry-policy";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";

export class OptimisticConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimisticConcurrencyError";
  }
}

export interface AppendPointsLedgerEntryParams {
  storeId: string;
  accountId: string;
  entryType: WeleticPointsLedgerEntryType;
  pointsDelta: bigint | number;
  pendingDelta?: bigint | number;
  grantId?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  idempotencyKey: string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  expectedLedgerVersion?: number;
  tx?: Prisma.TransactionClient;
}

function assertLedgerIdempotencyMatch({
  existing,
  storeId,
  accountId,
  entryType,
  pointsDelta,
  pendingDelta,
  grantId,
  referenceType,
  referenceId,
  idempotencyKey,
}: {
  existing: {
    storeId: string;
    accountId: string;
    entryType?: WeleticPointsLedgerEntryType;
    pointsDelta?: bigint | number | string;
    pendingDelta?: bigint | number | string | null;
    grantId?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
  };
  storeId: string;
  accountId: string;
  entryType: WeleticPointsLedgerEntryType;
  pointsDelta: bigint;
  pendingDelta: bigint;
  grantId: string | null;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
}) {
  const existingPointsDelta =
    existing.pointsDelta !== undefined
      ? BigInt(existing.pointsDelta)
      : undefined;
  const existingPendingDelta =
    existing.pendingDelta !== undefined && existing.pendingDelta !== null
      ? BigInt(existing.pendingDelta)
      : undefined;

  const pointsMismatch =
    existingPointsDelta !== undefined && existingPointsDelta !== pointsDelta;
  const pendingMismatch =
    existingPendingDelta !== undefined && existingPendingDelta !== pendingDelta;
  const entryTypeMismatch =
    existing.entryType !== undefined && existing.entryType !== entryType;
  const grantMismatch =
    existing.grantId !== undefined && (existing.grantId ?? null) !== grantId;
  const refTypeMismatch =
    existing.referenceType !== undefined &&
    (existing.referenceType ?? null) !== referenceType;
  const refIdMismatch =
    existing.referenceId !== undefined &&
    (existing.referenceId ?? null) !== referenceId;

  if (
    existing.storeId !== storeId ||
    existing.accountId !== accountId ||
    entryTypeMismatch ||
    pointsMismatch ||
    pendingMismatch ||
    grantMismatch ||
    refTypeMismatch ||
    refIdMismatch
  ) {
    throw new Error(
      `Ledger idempotency conflict for Shopify store ${storeId} and key ${idempotencyKey}.`,
    );
  }
}

type LedgerCacheClient = Prisma.TransactionClient | typeof prisma;

const EXPIRY_POLICY_SELECT = {
  status: true,
  killSwitchActive: true,
  pointsExpiryDays: true,
  pointsExpiryMonths: true,
  pointsExpiryPolicyAnchorAt: true,
  pointsExpiryPolicyVersion: true,
  activatedAt: true,
  createdAt: true,
} as const;

/**
 * D1 invariant: the account balance columns are a *materialized cache* of the
 * append-only ledger. An entry insert (serialized by the unique
 * `(accountId, sequenceNumber)` / `(storeId, idempotencyKey)` constraints) and
 * the cache update are separate statements, so a crash/conflict between them
 * leaves `ledgerVersion` behind the ledger head. This function folds every
 * entry with `sequenceNumber > ledgerVersion` into the cache, one
 * compare-and-set step per entry (`WHERE ledgerVersion = seq - 1`). It is
 * idempotent and safe to run concurrently: a lost CAS just means someone else
 * already applied that entry.
 *
 * Returns the refreshed account row, or `null` when the client cannot perform
 * the healing queries (partial test doubles).
 */
export async function healLedgerCache(
  client: LedgerCacheClient,
  accountId: string,
  storeId: string,
  knownAccount?: { ledgerVersion?: number | null } | null,
) {
  const entryDelegate = (client as any).weleticPointsLedgerEntry;
  const accountDelegate = (client as any).weleticLoyaltyAccount;
  if (
    typeof entryDelegate?.findFirst !== "function" ||
    typeof entryDelegate?.findMany !== "function" ||
    typeof accountDelegate?.findUnique !== "function" ||
    typeof accountDelegate?.updateMany !== "function"
  ) {
    return null;
  }

  const head = await entryDelegate.findFirst({
    where: { accountId },
    orderBy: { sequenceNumber: "desc" },
    select: { sequenceNumber: true },
  });
  const knownVersion = knownAccount?.ledgerVersion;
  if (
    knownAccount &&
    (!head ||
      (typeof knownVersion === "number" && head.sequenceNumber <= knownVersion))
  ) {
    return knownAccount as any;
  }

  let account = await accountDelegate.findUnique({ where: { id: accountId } });
  if (
    !account ||
    !head ||
    head.sequenceNumber <= (account.ledgerVersion ?? 0)
  ) {
    return account ?? null;
  }
  if (account.storeId !== storeId) return account;

  const pending = await entryDelegate.findMany({
    where: {
      accountId,
      sequenceNumber: { gt: account.ledgerVersion ?? 0 },
    },
    orderBy: { sequenceNumber: "asc" },
  });
  if (!Array.isArray(pending)) return account;
  const expiryPolicy =
    typeof (client as any).weleticLoyaltyProgram?.findUnique === "function"
      ? await (client as any).weleticLoyaltyProgram.findUnique({
          where: { storeId },
          select: EXPIRY_POLICY_SELECT,
        })
      : null;

  for (const entry of pending) {
    account = await accountDelegate.findUnique({ where: { id: accountId } });
    if (!account) return null;
    const version = account.ledgerVersion ?? 0;
    if (version >= entry.sequenceNumber) continue; // already applied
    if (version !== entry.sequenceNumber - 1) break; // gap: leave to reconcile

    const delta = BigInt(entry.pointsDelta);
    const data: Prisma.WeleticLoyaltyAccountUpdateManyMutationInput = {
      cachedPointsBalance: BigInt(entry.balanceAfter),
      lifetimePointsEarned:
        BigInt(account.lifetimePointsEarned ?? 0) +
        getLifetimeEarnedPointsDelta(
          entry.entryType,
          delta,
          entry.referenceType,
        ),
      lifetimePointsRedeemed:
        entry.entryType === WeleticPointsLedgerEntryType.REDEEM_REWARD &&
        delta < BigInt(0)
          ? BigInt(account.lifetimePointsRedeemed ?? 0) + -delta
          : BigInt(account.lifetimePointsRedeemed ?? 0),
      ledgerVersion: entry.sequenceNumber,
    };
    const pendingDelta = BigInt(entry.pendingDelta ?? 0);
    if (pendingDelta !== BigInt(0)) {
      data.cachedPendingPoints =
        BigInt(account.cachedPendingPoints ?? 0) + pendingDelta;
    }
    if (
      entry.entryType !== WeleticPointsLedgerEntryType.EXPIRATION &&
      delta !== BigInt(0)
    ) {
      const activityAt: Date = entry.createdAt;
      data.lastQualifyingActivityAt = activityAt;
      if (expiryPolicy) {
        data.nextExpiryDate =
          BigInt(entry.balanceAfter) > BigInt(0)
            ? calculateNextPointsExpiryDate({
                policy: expiryPolicy,
                lastActivityAt: activityAt,
                fallbackAt: activityAt,
              })
            : null;
        data.pointsExpiryPolicyVersion = expiryPolicy.pointsExpiryPolicyVersion;
        data.pointsExpiryJobsScheduledAt = null;
      }
    }
    await accountDelegate.updateMany({
      where: { id: accountId, storeId, ledgerVersion: version },
      data,
    });
  }
  return accountDelegate.findUnique({ where: { id: accountId } });
}

/** Read-repair entry point for callers that only hold an account id. */
export async function healAccountLedgerCache(accountId: string) {
  const account = await prisma.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
    select: { storeId: true },
  });
  if (!account) return null;
  return healLedgerCache(prisma, accountId, account.storeId);
}

export async function appendPointsLedgerEntry(
  params: AppendPointsLedgerEntryParams,
) {
  return (await appendPointsLedgerEntryWithReceipt(params)).entry;
}

/** Internal creation evidence for transactional event producers. A replay or
 * recovered duplicate is never a new earn. With a supplied tx, the caller must
 * retain this receipt inside that transaction until its outbox work commits. */
export async function appendPointsLedgerEntryWithReceipt(
  params: AppendPointsLedgerEntryParams,
) {
  const {
    storeId,
    accountId,
    entryType,
    pointsDelta,
    pendingDelta = BigInt(0),
    grantId,
    referenceType,
    referenceId,
    idempotencyKey,
    reason,
    metadata,
    tx,
  } = params;

  const deltaBigInt = BigInt(pointsDelta);
  const pendingDeltaBigInt = BigInt(pendingDelta);

  // Smile treats every non-expiration balance change as qualifying activity:
  // earning, redemption, refunds, imports, and manual adjustments all reset
  // the single rolling account-level expiry clock.
  const isQualifying =
    entryType !== WeleticPointsLedgerEntryType.EXPIRATION &&
    deltaBigInt !== BigInt(0);
  const activityAt = new Date();

  const maxRetries = 10;
  const baseDelayMs = 25;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const executeTransaction = async (client: Prisma.TransactionClient) => {
        // 1. Idempotency Check
        const existing = await client.weleticPointsLedgerEntry.findUnique({
          where: {
            storeId_idempotencyKey: {
              storeId,
              idempotencyKey,
            },
          },
        });

        if (existing) {
          assertLedgerIdempotencyMatch({
            existing,
            storeId,
            accountId,
            entryType,
            pointsDelta: deltaBigInt,
            pendingDelta: pendingDeltaBigInt,
            grantId: grantId ?? null,
            referenceType: referenceType ?? null,
            referenceId: referenceId ?? null,
            idempotencyKey,
          });
          // On D1 the entry insert and the cache update are separate
          // statements: a previous attempt may have crashed in between.
          await healLedgerCache(client, accountId, storeId);
          return { entry: existing, created: false as const };
        }

        // 2. Load account state
        const loadedAccount = await client.weleticLoyaltyAccount.findUnique({
          where: { id: accountId },
        });

        if (!loadedAccount) {
          throw new Error(`Loyalty account ${accountId} not found.`);
        }

        // The append-only ledger is the source of truth; the account row is a
        // materialized cache. Apply any entries a crashed attempt inserted but
        // never folded into the cache so the next sequence/balance is correct.
        const account =
          (await healLedgerCache(client, accountId, storeId, loadedAccount)) ??
          loadedAccount;

        // Account IDs are globally unique, but the ledger is a tenant boundary.
        // Keep the explicit store assertion so a malformed caller can never
        // post a cross-store entry or mutate another store's cached balance.
        if (
          typeof account.storeId === "string" &&
          account.storeId !== storeId
        ) {
          throw new Error(
            `Loyalty account ${accountId} does not belong to Shopify store ${storeId}.`,
          );
        }

        if (account.status === "suspended") {
          const meta = (
            account.metadata &&
            typeof account.metadata === "object" &&
            !Array.isArray(account.metadata)
              ? account.metadata
              : null
          ) as Record<string, unknown> | null;
          if (
            meta?.quarantine &&
            (meta.quarantine as Record<string, unknown>).isQuarantined
          ) {
            throw new Error(
              `Loyalty account ${accountId} is quarantined due to ledger integrity violation.`,
            );
          }
        }

        const currentBalance =
          typeof account.cachedPointsBalance === "bigint"
            ? account.cachedPointsBalance
            : BigInt(account.cachedPointsBalance ?? 0);
        const currentPending =
          typeof account.cachedPendingPoints === "bigint"
            ? account.cachedPendingPoints
            : BigInt(account.cachedPendingPoints ?? 0);
        const currentLifetimeEarned =
          typeof account.lifetimePointsEarned === "bigint"
            ? account.lifetimePointsEarned
            : BigInt(account.lifetimePointsEarned ?? 0);
        const currentLifetimeRedeemed =
          typeof account.lifetimePointsRedeemed === "bigint"
            ? account.lifetimePointsRedeemed
            : BigInt(account.lifetimePointsRedeemed ?? 0);

        const currentVersion = account.ledgerVersion ?? 0;
        const sequenceNumber = currentVersion + 1;

        const balanceAfter = currentBalance + deltaBigInt;
        const pendingAfter = currentPending + pendingDeltaBigInt;

        if (pendingAfter < BigInt(0)) {
          throw new OptimisticConcurrencyError(
            `Pending-points invariant failed for loyalty account ${accountId}: ${currentPending} + (${pendingDeltaBigInt}) would be negative`,
          );
        }

        if (
          entryType === WeleticPointsLedgerEntryType.REDEEM_REWARD &&
          balanceAfter < BigInt(0)
        ) {
          throw new OptimisticConcurrencyError(
            `Available points invariant failed for loyalty account ${accountId}: redemption of ${-deltaBigInt} exceeds available balance ${currentBalance}`,
          );
        }

        const lifetimeEarned =
          currentLifetimeEarned +
          getLifetimeEarnedPointsDelta(entryType, deltaBigInt, referenceType);

        if (lifetimeEarned < BigInt(0)) {
          throw new Error(
            `Lifetime-earned invariant failed for loyalty account ${accountId}: correction would make the total negative.`,
          );
        }

        const lifetimeRedeemed =
          entryType === WeleticPointsLedgerEntryType.REDEEM_REWARD &&
          deltaBigInt < BigInt(0)
            ? currentLifetimeRedeemed + -deltaBigInt
            : currentLifetimeRedeemed;

        const loyaltyProgramDelegate = (
          client as Prisma.TransactionClient & {
            weleticLoyaltyProgram?: Prisma.TransactionClient["weleticLoyaltyProgram"];
          }
        ).weleticLoyaltyProgram;
        const expiryPolicy = loyaltyProgramDelegate?.findUnique
          ? await loyaltyProgramDelegate.findUnique({
              where: { storeId },
              select: {
                status: true,
                killSwitchActive: true,
                pointsExpiryDays: true,
                pointsExpiryMonths: true,
                pointsExpiryPolicyAnchorAt: true,
                pointsExpiryPolicyVersion: true,
                activatedAt: true,
                createdAt: true,
              },
            })
          : null;

        // 3. Create immutable ledger entry
        const ledgerEntry = await client.weleticPointsLedgerEntry.create({
          data: {
            id: createWeleticId("wledger_"),
            storeId,
            accountId,
            sequenceNumber,
            entryType,
            pointsDelta: deltaBigInt,
            pendingDelta: pendingDeltaBigInt,
            balanceAfter,
            grantId: grantId ?? null,
            referenceType: referenceType ?? null,
            referenceId: referenceId ?? null,
            idempotencyKey,
            reason: reason ?? null,
            metadata: metadata
              ? (metadata as Prisma.InputJsonValue)
              : Prisma.DbNull,
          },
        });

        // 4. Update cached balance on loyalty account (with OCC if ledgerVersion supported)
        const updateData: Prisma.WeleticLoyaltyAccountUpdateManyMutationInput =
          {
            cachedPointsBalance: balanceAfter,
            lifetimePointsEarned: lifetimeEarned,
            lifetimePointsRedeemed: lifetimeRedeemed,
            ledgerVersion: sequenceNumber,
          };

        if (pendingDeltaBigInt !== BigInt(0)) {
          updateData.cachedPendingPoints = pendingAfter;
        }
        if (isQualifying) {
          updateData.lastQualifyingActivityAt = activityAt;
          if (expiryPolicy) {
            updateData.nextExpiryDate =
              balanceAfter > BigInt(0)
                ? calculateNextPointsExpiryDate({
                    policy: expiryPolicy,
                    lastActivityAt: activityAt,
                    fallbackAt: activityAt,
                  })
                : null;
            updateData.pointsExpiryPolicyVersion =
              expiryPolicy.pointsExpiryPolicyVersion;
            updateData.pointsExpiryJobsScheduledAt = null;
          }
        }

        const updateResult = await client.weleticLoyaltyAccount.updateMany({
          where: {
            id: accountId,
            storeId,
            ledgerVersion: currentVersion,
          },
          data: updateData,
        });

        if (updateResult.count === 0) {
          // We own `sequenceNumber` (unique insert succeeded), so the entry is
          // durable. A lost CAS means the cache was moved by a healer/another
          // writer: fold the ledger into the cache instead of failing, which
          // on D1 (no rollback) would leave an orphaned entry.
          const healed = await healLedgerCache(client, accountId, storeId);
          const ownEntryDurable =
            typeof ledgerEntry?.id === "string" &&
            Boolean(
              await client.weleticPointsLedgerEntry.findUnique({
                where: { id: ledgerEntry.id },
                select: { id: true },
              }),
            );
          if (
            ownEntryDurable &&
            healed &&
            (healed.ledgerVersion ?? 0) >= sequenceNumber
          ) {
            return { entry: ledgerEntry, created: true as const };
          }
          throw new OptimisticConcurrencyError(
            `OCC version conflict for account ${accountId} at version ${currentVersion}`,
          );
        }

        return { entry: ledgerEntry, created: true as const };
      };

      if (tx) {
        return await executeTransaction(tx);
      } else {
        return await prisma.$transaction(
          async (client) => await executeTransaction(client),
        );
      }
    } catch (error: any) {
      if (
        error instanceof OptimisticConcurrencyError &&
        attempt < maxRetries &&
        !tx
      ) {
        const jitter = Math.floor(Math.random() * 25);
        const delay =
          Math.min(1000, baseDelayMs * Math.pow(2, attempt - 1)) + jitter;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const db = tx ?? prisma;
        const existing = await db.weleticPointsLedgerEntry.findUnique({
          where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
        });
        if (existing) {
          assertLedgerIdempotencyMatch({
            existing,
            storeId,
            accountId,
            entryType,
            pointsDelta: deltaBigInt,
            pendingDelta: pendingDeltaBigInt,
            grantId: grantId ?? null,
            referenceType: referenceType ?? null,
            referenceId: referenceId ?? null,
            idempotencyKey,
          });
          return { entry: existing, created: false as const };
        }

        if (attempt < maxRetries && !tx) {
          const jitter = Math.floor(Math.random() * 25);
          const delay =
            Math.min(1000, baseDelayMs * Math.pow(2, attempt - 1)) + jitter;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      throw error;
    }
  }

  throw new Error(`Exhausted OCC retry attempts for account ${accountId}`);
}

export async function getAccountPointsBalance(
  accountId: string,
  tx?: Prisma.TransactionClient,
) {
  const db = tx ?? prisma;
  const stored = await db.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
  });

  if (!stored) {
    return null;
  }
  const account =
    (await healLedgerCache(db, accountId, stored.storeId, stored)) ?? stored;

  const balance =
    typeof account.cachedPointsBalance === "bigint"
      ? account.cachedPointsBalance
      : BigInt(account.cachedPointsBalance ?? 0);
  const pending =
    typeof account.cachedPendingPoints === "bigint"
      ? account.cachedPendingPoints
      : BigInt(account.cachedPendingPoints ?? 0);
  const lifetimeEarned =
    typeof account.lifetimePointsEarned === "bigint"
      ? account.lifetimePointsEarned
      : BigInt(account.lifetimePointsEarned ?? 0);
  const lifetimeRedeemed =
    typeof account.lifetimePointsRedeemed === "bigint"
      ? account.lifetimePointsRedeemed
      : BigInt(account.lifetimePointsRedeemed ?? 0);

  const isNegative = balance < BigInt(0);
  const canRedeem = account.status === "active" && balance > BigInt(0);

  return {
    accountId: account.id,
    storeId: account.storeId,
    status: account.status,
    pointsBalance: balance,
    pendingPoints: pending,
    lifetimeEarned,
    lifetimeRedeemed,
    isNegative,
    canRedeem,
  };
}

export async function getAccountLedgerHistory(
  accountId: string,
  options?: {
    take?: number;
    skip?: number;
  },
) {
  const take = options?.take ?? 50;
  const skip = options?.skip ?? 0;

  const [entries, total] = await Promise.all([
    prisma.weleticPointsLedgerEntry.findMany({
      where: { accountId },
      orderBy: { sequenceNumber: "desc" },
      take,
      skip,
    }),
    prisma.weleticPointsLedgerEntry.count({
      where: { accountId },
    }),
  ]);

  return {
    entries,
    total,
    take,
    skip,
  };
}

class LedgerReconciliationAnomalyError extends Error {
  constructor(
    public readonly accountId: string,
    public readonly reason: string,
    public readonly existingMeta: Record<string, unknown>,
  ) {
    super(reason);
    this.name = "LedgerReconciliationAnomalyError";
  }
}

export async function reconcileAccountPoints(accountId: string) {
  try {
    return await prisma.$transaction(async (tx) => {
      const account = await tx.weleticLoyaltyAccount.findUnique({
        where: { id: accountId },
      });

      if (!account) {
        throw new Error(`Loyalty account ${accountId} not found`);
      }

      const entries = await tx.weleticPointsLedgerEntry.findMany({
        where: { accountId },
        orderBy: { sequenceNumber: "asc" },
      });

      let runningBalance = BigInt(0);
      let lifetimeEarned = BigInt(0);
      let lifetimeRedeemed = BigInt(0);

      const seenSequences = new Set<number>();

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const expectedSequence = i + 1;

        if (entry.sequenceNumber < 1) {
          const existingMeta =
            account.metadata &&
            typeof account.metadata === "object" &&
            !Array.isArray(account.metadata)
              ? (account.metadata as Record<string, unknown>)
              : {};
          const reason = `Invalid sequence number ${entry.sequenceNumber} <= 0 detected for account ${accountId} at entry ${entry.id}`;
          throw new LedgerReconciliationAnomalyError(
            accountId,
            reason,
            existingMeta,
          );
        }

        if (entry.storeId && entry.storeId !== account.storeId) {
          const existingMeta =
            account.metadata &&
            typeof account.metadata === "object" &&
            !Array.isArray(account.metadata)
              ? (account.metadata as Record<string, unknown>)
              : {};
          const reason = `Cross-tenant entry detected for account ${accountId} at entry ${entry.id}: entry storeId ${entry.storeId} does not match account storeId ${account.storeId}`;
          throw new LedgerReconciliationAnomalyError(
            accountId,
            reason,
            existingMeta,
          );
        }

        if (
          entry.entryType === WeleticPointsLedgerEntryType.REDEEM_REWARD &&
          entry.pointsDelta > BigInt(0)
        ) {
          const existingMeta =
            account.metadata &&
            typeof account.metadata === "object" &&
            !Array.isArray(account.metadata)
              ? (account.metadata as Record<string, unknown>)
              : {};
          const reason = `Illegal positive points delta (${entry.pointsDelta}) for REDEEM_REWARD at entry ${entry.id}`;
          throw new LedgerReconciliationAnomalyError(
            accountId,
            reason,
            existingMeta,
          );
        }

        if (seenSequences.has(entry.sequenceNumber)) {
          const existingMeta =
            account.metadata &&
            typeof account.metadata === "object" &&
            !Array.isArray(account.metadata)
              ? (account.metadata as Record<string, unknown>)
              : {};
          const reason = `Sequence collision detected for account ${accountId}: duplicate sequence number ${entry.sequenceNumber} at entry ${entry.id}`;
          if (typeof (tx as any).weleticLoyaltyAccount?.update === "function") {
            await (tx as any).weleticLoyaltyAccount.update({
              where: { id: accountId },
              data: {
                status: "suspended",
                metadata: {
                  ...existingMeta,
                  quarantine: {
                    isQuarantined: true,
                    quarantinedAt: new Date().toISOString(),
                    reason,
                  },
                } as Prisma.InputJsonValue,
              },
            });
          }
          throw new LedgerReconciliationAnomalyError(
            accountId,
            reason,
            existingMeta,
          );
        }
        seenSequences.add(entry.sequenceNumber);

        if (entry.sequenceNumber !== expectedSequence) {
          const existingMeta =
            account.metadata &&
            typeof account.metadata === "object" &&
            !Array.isArray(account.metadata)
              ? (account.metadata as Record<string, unknown>)
              : {};
          const reason = `Sequence gap detected for account ${accountId}: entry ${entry.id} has sequence ${entry.sequenceNumber}, expected ${expectedSequence}`;
          if (typeof (tx as any).weleticLoyaltyAccount?.update === "function") {
            await (tx as any).weleticLoyaltyAccount.update({
              where: { id: accountId },
              data: {
                status: "suspended",
                metadata: {
                  ...existingMeta,
                  quarantine: {
                    isQuarantined: true,
                    quarantinedAt: new Date().toISOString(),
                    reason,
                  },
                } as Prisma.InputJsonValue,
              },
            });
          }
          throw new LedgerReconciliationAnomalyError(
            accountId,
            reason,
            existingMeta,
          );
        }

        if (entry.balanceAfter !== undefined && entry.balanceAfter !== null) {
          const expectedBalanceAfter = runningBalance + entry.pointsDelta;
          if (entry.balanceAfter !== expectedBalanceAfter) {
            const existingMeta =
              account.metadata &&
              typeof account.metadata === "object" &&
              !Array.isArray(account.metadata)
                ? (account.metadata as Record<string, unknown>)
                : {};
            const reason = `Balance chain discontinuity detected for account ${accountId}: entry ${entry.id} recorded ${entry.balanceAfter}, expected ${expectedBalanceAfter}`;
            if (
              typeof (tx as any).weleticLoyaltyAccount?.update === "function"
            ) {
              await (tx as any).weleticLoyaltyAccount.update({
                where: { id: accountId },
                data: {
                  status: "suspended",
                  metadata: {
                    ...existingMeta,
                    quarantine: {
                      isQuarantined: true,
                      quarantinedAt: new Date().toISOString(),
                      reason,
                    },
                  } as Prisma.InputJsonValue,
                },
              });
            }
            throw new LedgerReconciliationAnomalyError(
              accountId,
              reason,
              existingMeta,
            );
          }
        }

        runningBalance += entry.pointsDelta;

        lifetimeEarned += getLifetimeEarnedPointsDelta(
          entry.entryType,
          entry.pointsDelta,
          entry.referenceType,
        );

        if (
          entry.entryType === WeleticPointsLedgerEntryType.REDEEM_REWARD &&
          entry.pointsDelta < BigInt(0)
        ) {
          lifetimeRedeemed += -entry.pointsDelta;
        }
      }

      const cachedBalance =
        typeof account.cachedPointsBalance === "bigint"
          ? account.cachedPointsBalance
          : BigInt(account.cachedPointsBalance ?? 0);
      const cachedLifetimeEarned =
        typeof account.lifetimePointsEarned === "bigint"
          ? account.lifetimePointsEarned
          : BigInt(account.lifetimePointsEarned ?? 0);
      const cachedLifetimeRedeemed =
        typeof account.lifetimePointsRedeemed === "bigint"
          ? account.lifetimePointsRedeemed
          : BigInt(account.lifetimePointsRedeemed ?? 0);

      const isMatch =
        cachedBalance === runningBalance &&
        cachedLifetimeEarned === lifetimeEarned &&
        cachedLifetimeRedeemed === lifetimeRedeemed &&
        (account.ledgerVersion === undefined ||
          account.ledgerVersion === entries.length);

      if (!isMatch) {
        const updateData: any = {
          cachedPointsBalance: runningBalance,
          lifetimePointsEarned: lifetimeEarned,
          lifetimePointsRedeemed: lifetimeRedeemed,
        };
        if (typeof account.ledgerVersion === "number") {
          updateData.ledgerVersion = entries.length;
        }
        await tx.weleticLoyaltyAccount.update({
          where: { id: accountId },
          data: updateData,
        });
      }

      return {
        accountId,
        entriesCount: entries.length,
        calculatedBalance: runningBalance,
        previousCachedBalance: cachedBalance,
        repaired: !isMatch,
      };
    });
  } catch (error) {
    if (error instanceof LedgerReconciliationAnomalyError) {
      if (typeof prisma.weleticLoyaltyAccount?.update === "function") {
        await prisma.weleticLoyaltyAccount.update({
          where: { id: error.accountId },
          data: {
            status: "suspended",
            metadata: {
              ...error.existingMeta,
              quarantine: {
                isQuarantined: true,
                quarantinedAt: new Date().toISOString(),
                reason: error.reason,
              },
            } as Prisma.InputJsonValue,
          },
        });
      }
    }
    throw error;
  }
}
