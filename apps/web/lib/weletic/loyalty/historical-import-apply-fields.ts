import { createWeleticId } from "@/lib/weletic/ids";
import { Prisma } from "@prisma/client";
import { readHistoricalImportCommitRowInTransaction } from "./historical-import-commit-row";
import { captureHistoricalImportFields } from "./historical-import-fields";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";

/** Internal row step, AFTER enrollment and BEFORE opening-balance posting.
 * Caller must verify manifest/idempotency and persist returned before evidence
 * alongside ledger and row execution in the SAME transaction. Capture the FINAL
 * after state again after ledger posting, which can update expiry fields. Any
 * failure must abort that transaction. This is not a merchant mutation endpoint.
 */
export async function applyHistoricalImportFieldsInTransaction({
  tx,
  lease,
  snapshotId,
}: {
  tx: Prisma.TransactionClient;
  lease: unknown;
  snapshotId: unknown;
}) {
  const current = await readHistoricalImportCommitRowInTransaction({
    tx,
    lease,
    snapshotId,
  });
  const { account, row, birthday, now } = current;
  if (!account) throw new HistoricalImportConflictError();
  const before = captureHistoricalImportFields(account);
  const tierChanged = Boolean(
    row.tierId && row.tierId !== account.currentTierId,
  );
  let tierHistorySequence: number | null = null;
  if (tierChanged) {
    // The account lock serializes history allocation. Fail closed on legacy
    // unsequenced history rather than inventing an ordering around it.
    const history = await tx.$queryRaw<
      Array<{ sequenceNumber: number | null }>
    >(Prisma.sql`
      SELECT sequenceNumber FROM WeleticLoyaltyTierHistory
      WHERE accountId = ${account.id}
      ORDER BY (sequenceNumber IS NULL) DESC, sequenceNumber DESC
      LIMIT 1 FOR UPDATE
    `);
    if (
      history.length &&
      (history[0].sequenceNumber === null ||
        !Number.isInteger(history[0].sequenceNumber) ||
        history[0].sequenceNumber < 1 ||
        history[0].sequenceNumber >= 2147483647)
    )
      throw new HistoricalImportConflictError();
    tierHistorySequence = (history[0]?.sequenceNumber ?? 0) + 1;
  }
  const afterAccount = {
    ...account,
    ...(birthday.schedule ? { metadata: birthday.metadata } : {}),
    ...(tierChanged ? { currentTierId: row.tierId!, tierExpiresAt: null } : {}),
  };
  const after = captureHistoricalImportFields(afterAccount);
  if (birthday.schedule || tierChanged) {
    const updated = await tx.weleticLoyaltyAccount.updateMany({
      where: {
        id: account.id,
        storeId: current.lease.storeId,
        programId: current.lease.programId,
        shopperId: current.shopper.id,
        status: "active",
        ledgerVersion: account.ledgerVersion,
      },
      data: {
        ...(birthday.schedule
          ? { metadata: birthday.metadata as Prisma.InputJsonObject }
          : {}),
        ...(tierChanged
          ? { currentTierId: row.tierId!, tierExpiresAt: null }
          : {}),
      },
    });
    if (updated.count !== 1) throw new HistoricalImportConflictError();
  }
  let tierHistoryId: string | null = null;
  if (tierChanged) {
    tierHistoryId = createWeleticId("wtier_");
    await tx.weleticLoyaltyTierHistory.create({
      data: {
        id: tierHistoryId,
        accountId: account.id,
        sequenceNumber: tierHistorySequence!,
        fromTierId: account.currentTierId,
        toTierId: row.tierId!,
        changeReason: "manual_override",
        notes: `Historical import ${current.lease.sourceId}, row ${current.snapshot.id}`,
        qualifyingSpendSnapshot: account.tierSpendRolling12Months,
        qualifyingPointsSnapshot: account.tierPointsRolling12Months,
        effectiveAt: now,
      },
    });
    // Imported placement is not threshold achievement: no entry points, voucher
    // or VIP achievement event is emitted and qualifying counters stay unchanged.
  }
  if (birthday.schedule) {
    const scheduled = await enqueueOutboxJobFromProgramTransaction({
      tx,
      storeId: current.lease.storeId,
      jobType: "BIRTHDAY_REWARD",
      payload: {
        accountId: account.id,
        birthDate: birthday.schedule.birthDate,
        registeredAt: birthday.schedule.registeredAt,
        calendarYear: birthday.schedule.calendarYear,
      },
      scheduledFor: birthday.schedule.scheduledFor,
      idempotencyKey: `birthday_reward:${account.id}:${birthday.schedule.calendarYear}`,
    });
    // An absent birthday registration cannot safely adopt an earlier job for
    // this year (possibly cancelled, completed or bound to a rolled-back date).
    // Abort the row instead of claiming success or reissuing an annual reward.
    if (!scheduled.created) throw new HistoricalImportConflictError();
  }
  return { before, afterFields: after, tierHistoryId };
}
