import {
  Prisma,
  type WeleticLoyaltyAccount,
  type WeleticLoyaltyImportRowExecution,
  type WeleticLoyaltyOutboxJob,
  type WeleticLoyaltyTierHistory,
} from "@prisma/client";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  historicalImportFieldStateSchema,
  planHistoricalImportFieldRestoration,
} from "./historical-import-fields";
import { HistoricalImportRollbackContainedError } from "./historical-import-ledger";

/** Prepare under current store/program/source/execution/account locks BEFORE
 * financial reversal. Caller must verify manifest and execution provenance, then
 * apply this plan after the correction in the SAME transaction. No mutation here.
 * The correction itself updates expiry fields; validating only afterward would
 * confuse those new fields with unrelated activity.
 */
export async function prepareHistoricalImportFieldRollback({
  tx,
  account,
  execution,
  installationGeneration,
}: {
  tx: Prisma.TransactionClient;
  account: WeleticLoyaltyAccount;
  execution: WeleticLoyaltyImportRowExecution;
  installationGeneration: string;
}) {
  const contain = (): never => {
    throw new HistoricalImportRollbackContainedError();
  };
  if (
    account.id !== execution.accountId ||
    account.storeId !== execution.storeId ||
    account.programId !== execution.programId ||
    execution.status !== "committed" ||
    !(execution.committedAt instanceof Date) ||
    !Number.isFinite(execution.committedAt.getTime()) ||
    account.ledgerVersion !== execution.ledgerVersionAfter
  )
    contain();
  const parsedBefore = historicalImportFieldStateSchema.safeParse(
    execution.fieldStateBefore,
  );
  const parsedAfter = historicalImportFieldStateSchema.safeParse(
    execution.fieldStateAfter,
  );
  if (!parsedBefore.success || !parsedAfter.success) return contain();
  const before = parsedBefore.data;
  const after = parsedAfter.data;
  let patch: Prisma.WeleticLoyaltyAccountUncheckedUpdateManyInput;
  try {
    patch = planHistoricalImportFieldRestoration({
      before,
      after,
      current: account,
    });
  } catch {
    return contain();
  }

  const histories = await tx.$queryRaw<WeleticLoyaltyTierHistory[]>(Prisma.sql`
    SELECT * FROM WeleticLoyaltyTierHistory WHERE accountId = ${account.id}
    ORDER BY (sequenceNumber IS NULL) DESC, sequenceNumber DESC LIMIT 1 FOR UPDATE
  `);
  const latest = histories[0];
  if (
    histories.length > 1 ||
    (latest &&
      (latest.accountId !== account.id ||
        latest.sequenceNumber === null ||
        !Number.isInteger(latest.sequenceNumber) ||
        latest.sequenceNumber < 1 ||
        latest.sequenceNumber >= 2147483647 ||
        !(latest.effectiveAt instanceof Date) ||
        !Number.isFinite(latest.effectiveAt.getTime())))
  )
    contain();
  const tierChanged = before.currentTierId !== after.currentTierId;
  let tierTransition: {
    fromTierId: string | null;
    toTierId: string | null;
    sequenceNumber: number;
  } | null = null;
  if (tierChanged) {
    if (
      !latest ||
      latest.fromTierId !== before.currentTierId ||
      latest.toTierId !== after.currentTierId ||
      latest.changeReason !== "manual_override" ||
      latest.notes !==
        `Historical import ${execution.sourceId}, row ${execution.snapshotId}` ||
      latest.effectiveAt < execution.committedAt!
    )
      contain();
    // A deleted/foreign original tier cannot be silently restored by ID.
    if (
      before.currentTierId !== null &&
      !(await tx.weleticLoyaltyTier.findFirst({
        where: {
          id: before.currentTierId,
          programId: account.programId,
          deletedAt: null,
        },
        select: { id: true },
      }))
    )
      contain();
    tierTransition = {
      fromTierId: after.currentTierId,
      toTierId: before.currentTierId,
      sequenceNumber: latest!.sequenceNumber! + 1,
    };
  } else if (latest && latest.effectiveAt >= execution.committedAt!) {
    // Even an A -> B -> A trip is later activity, despite equal current fields.
    contain();
  }

  let birthdayJobId: string | null = null;
  if (!isDeepStrictEqual(before.birthday, after.birthday)) {
    if (
      (before.birthday.present && before.birthday.value !== null) ||
      !after.birthday.present
    )
      return contain();
    const registration = z
      .object({
        birthDate: z.string().regex(/^2000-\d{2}-\d{2}$/),
        registeredAt: z.string().datetime(),
        nextEligibleYear: z.number().int(),
      })
      .strict()
      .safeParse(after.birthday.value);
    if (!registration.success) return contain();
    const { birthDate, registeredAt, nextEligibleYear } = registration.data;
    const key = `birthday_reward:${account.id}:${nextEligibleYear}`;
    const jobs = await tx.$queryRaw<WeleticLoyaltyOutboxJob[]>(Prisma.sql`
      SELECT * FROM WeleticLoyaltyOutboxJob WHERE storeId = ${account.storeId} AND idempotencyKey = ${key} FOR UPDATE
    `);
    const job = jobs[0];
    if (
      jobs.length !== 1 ||
      job.storeId !== account.storeId ||
      job.idempotencyKey !== key ||
      job.jobType !== "BIRTHDAY_REWARD" ||
      !["pending", "failed", "dead_letter", "cancelled"].includes(job.status) ||
      job.lockedAt !== null ||
      job.lockedBy !== null ||
      !isDeepStrictEqual(job.payload, {
        accountId: account.id,
        birthDate,
        registeredAt,
        calendarYear: nextEligibleYear,
        installationGeneration,
      })
    )
      contain();
    if (job.status !== "cancelled") birthdayJobId = job.id;
  }
  return { patch, tierTransition, birthdayJobId };
}
