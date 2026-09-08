import { withPrismaRetry } from "@/lib/api/utils/with-prisma-retry";
import { prisma } from "@/lib/prisma";

export interface MigrationOptions {
  batchSize?: number;
  dryRun?: boolean;
  storeId?: string;
}

export interface MigrationResult {
  totalAccounts: number;
  updatedAccounts: number;
  alreadySyncedAccounts: number;
  zeroEntryAccounts: number;
  dryRun: boolean;
  durationMs: number;
  errors: Array<{ accountId: string; error: string }>;
}

export async function migrateLedgerVersions(
  options: MigrationOptions = {},
): Promise<MigrationResult> {
  const batchSize = options.batchSize ?? 500;
  const dryRun = options.dryRun ?? false;
  const storeId = options.storeId;
  const startTime = Date.now();

  const whereClause = storeId ? { storeId } : {};

  console.log(`[Migration] Starting ledgerVersion initialization...`);
  console.log(
    `[Migration] Config: batchSize=${batchSize}, dryRun=${dryRun}, storeId=${storeId ?? "ALL"}`,
  );

  const totalAccounts = await prisma.weleticLoyaltyAccount.count({
    where: whereClause,
  });

  console.log(
    `[Migration] Found ${totalAccounts} total loyalty accounts to inspect.`,
  );

  let processedCount = 0;
  let updatedAccounts = 0;
  let alreadySyncedAccounts = 0;
  let zeroEntryAccounts = 0;
  const errors: Array<{ accountId: string; error: string }> = [];

  let cursor: string | undefined = undefined;

  while (processedCount < totalAccounts) {
    const batch = await prisma.weleticLoyaltyAccount.findMany({
      where: whereClause,
      take: batchSize,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { id: "asc" },
      select: {
        id: true,
        storeId: true,
        ledgerVersion: true,
      },
    });

    if (!batch || batch.length === 0) {
      break;
    }

    cursor = batch[batch.length - 1].id;
    const accountIds = batch.map((a) => a.id);

    // 1. Group ledger entries by accountId and compute MAX(sequenceNumber)
    const maxSequences = await prisma.weleticPointsLedgerEntry.groupBy({
      by: ["accountId"],
      where: {
        accountId: { in: accountIds },
      },
      _max: {
        sequenceNumber: true,
      },
    });

    const maxSeqMap = new Map<string, number>();
    for (const item of maxSequences || []) {
      maxSeqMap.set(item.accountId, item._max?.sequenceNumber ?? 0);
    }

    // 2. Identify required updates
    const updatesToApply: Array<{
      id: string;
      targetVersion: number;
      currentVersion: number;
    }> = [];

    for (const account of batch) {
      const maxSeq = maxSeqMap.get(account.id) ?? 0;
      if (maxSeq === 0) {
        zeroEntryAccounts++;
      }

      if (account.ledgerVersion !== maxSeq) {
        updatesToApply.push({
          id: account.id,
          targetVersion: maxSeq,
          currentVersion: account.ledgerVersion,
        });
      } else {
        alreadySyncedAccounts++;
      }
    }

    // 3. Apply updates
    if (updatesToApply.length > 0) {
      if (dryRun) {
        updatedAccounts += updatesToApply.length;
      } else {
        try {
          await withPrismaRetry(async () => {
            await prisma.$transaction(
              updatesToApply.map((item) =>
                prisma.weleticLoyaltyAccount.update({
                  where: { id: item.id },
                  data: { ledgerVersion: item.targetVersion },
                }),
              ),
            );
          });
          updatedAccounts += updatesToApply.length;
        } catch (err: any) {
          for (const item of updatesToApply) {
            errors.push({
              accountId: item.id,
              error: err?.message || String(err),
            });
          }
        }
      }
    }

    processedCount += batch.length;
    const pct =
      totalAccounts > 0
        ? ((processedCount / totalAccounts) * 100).toFixed(1)
        : "100.0";
    console.log(
      `[Migration] Progress: ${processedCount}/${totalAccounts} accounts (${pct}%) - Batch updated: ${updatesToApply.length}`,
    );
  }

  const durationMs = Date.now() - startTime;
  console.log(`[Migration] Completed in ${durationMs}ms.`);
  console.log(
    `[Migration] Summary: Total=${totalAccounts}, Updated=${updatedAccounts}, AlreadySynced=${alreadySyncedAccounts}, ZeroEntries=${zeroEntryAccounts}, Errors=${errors.length}`,
  );

  return {
    totalAccounts,
    updatedAccounts,
    alreadySyncedAccounts,
    zeroEntryAccounts,
    dryRun,
    durationMs,
    errors,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const storeArg = args.find((a) => a.startsWith("--store="));
  const storeId = storeArg ? storeArg.split("=")[1] : undefined;

  migrateLedgerVersions({ dryRun, storeId })
    .then((res) => {
      console.log("[Migration CLI] Result:", JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("[Migration CLI] Fatal Error:", err);
      process.exit(1);
    });
}
