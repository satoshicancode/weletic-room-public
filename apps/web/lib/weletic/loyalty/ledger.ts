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

export async function appendPointsLedgerEntry(
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
          return existing;
        }

        // 2. Load account state
        const account = await client.weleticLoyaltyAccount.findUnique({
          where: { id: accountId },
        });

        if (!account) {
          throw new Error(`Loyalty account ${accountId} not found.`);
        }

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
          throw new OptimisticConcurrencyError(
            `OCC version conflict for account ${accountId} at version ${currentVersion}`,
          );
        }

        return ledgerEntry;
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
          return existing;
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
  const account = await db.weleticLoyaltyAccount.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    return null;
  }

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

export async function reconcileAccountPoints(accountId: string) {
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

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const expectedSequence = i + 1;

      if (entry.sequenceNumber !== expectedSequence) {
        throw new Error(
          `Sequence gap detected for account ${accountId}: entry ${entry.id} has sequence ${entry.sequenceNumber}, expected ${expectedSequence}`,
        );
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
}
