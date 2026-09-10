import { prisma } from "@/lib/prisma";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import {
  appendPointsLedgerEntry,
  appendPointsLedgerEntryWithReceipt,
} from "@/lib/weletic/loyalty/ledger";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueSignupPointsCommunication } from "@/lib/weletic/loyalty/points-communication-producer";
import { scheduleTierReviewAfterQualifyingActivity } from "@/lib/weletic/loyalty/tier-review-scheduling";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  WeleticPointsLedgerEntry,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";

export interface AwardSignupWelcomeBonusParams {
  storeId: string;
  accountId: string;
  bonusPoints: bigint | number;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}

export interface BirthdayEligibilityResult {
  calendarYear: number;
  birthdayThisYear: Date;
  leadTimeDays: number;
  isEligible: boolean;
  isLockedOut: boolean;
  nextEligibleYear: number;
  reason: string;
}

export interface BirthdayRewardSchedule {
  calendarYear: number;
  scheduledFor: Date;
}

export function getBirthdayRewardDateForYear(
  birthDateInput: Date | string,
  calendarYear: number,
): Date {
  const birthDate = new Date(birthDateInput);
  if (Number.isNaN(birthDate.getTime()) || !Number.isInteger(calendarYear)) {
    throw new Error("Invalid birthday scheduling date.");
  }
  const month = birthDate.getUTCMonth();
  const day = birthDate.getUTCDate();
  if (month === 1 && day === 29) {
    const isLeapYear =
      (calendarYear % 4 === 0 && calendarYear % 100 !== 0) ||
      calendarYear % 400 === 0;
    return new Date(Date.UTC(calendarYear, 1, isLeapYear ? 29 : 28));
  }
  return new Date(Date.UTC(calendarYear, month, day));
}

export function getNextBirthdayRewardSchedule({
  birthDate: birthDateInput,
  registeredAt: registeredAtInput,
  now: nowInput = new Date(),
}: {
  birthDate: Date | string;
  registeredAt: Date | string;
  now?: Date;
}): BirthdayRewardSchedule {
  const birthDate = new Date(birthDateInput);
  const registeredAt = new Date(registeredAtInput);
  const now = new Date(nowInput);
  if (
    Number.isNaN(birthDate.getTime()) ||
    Number.isNaN(registeredAt.getTime()) ||
    Number.isNaN(now.getTime())
  ) {
    throw new Error("Invalid birthday scheduling date.");
  }

  const registeredMidnight = new Date(
    Date.UTC(
      registeredAt.getUTCFullYear(),
      registeredAt.getUTCMonth(),
      registeredAt.getUTCDate(),
    ),
  );
  const nowMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  for (let offset = 0; offset <= 2; offset++) {
    const calendarYear = now.getUTCFullYear() + offset;
    const scheduledFor = getBirthdayRewardDateForYear(birthDate, calendarYear);
    const leadTimeDays = Math.floor(
      (scheduledFor.getTime() - registeredMidnight.getTime()) /
        (24 * 60 * 60 * 1000),
    );
    if (scheduledFor >= nowMidnight && leadTimeDays >= 30) {
      return { calendarYear, scheduledFor };
    }
  }

  const calendarYear = now.getUTCFullYear() + 3;
  return {
    calendarYear,
    scheduledFor: getBirthdayRewardDateForYear(birthDate, calendarYear),
  };
}

export interface AwardBirthdayRewardParams {
  storeId: string;
  accountId: string;
  birthDate: Date | string;
  rewardPoints: bigint | number;
  now?: Date;
  enrollmentDate?: Date | string;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}

export interface BirthdayRewardResult {
  awarded: boolean;
  isLockedOut: boolean;
  isDuplicate?: boolean;
  calendarYear: number;
  nextEligibleYear?: number;
  leadTimeDays?: number;
  ledgerEntry?: WeleticPointsLedgerEntry | null;
  reason: string;
}

export interface AwardActivityPointsParams {
  storeId: string;
  accountId: string;
  activityType: string;
  points: bigint | number;
  externalId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown> | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}

/**
 * Validates whether a customer is eligible for a birthday reward in the current calendar year
 * under the 30-day anti-gaming lead-time lockout policy (ADR 0004 & Smile.io Parity).
 *
 * Anti-Gaming Rule:
 * A customer must have registered / provided their birthday at least 30 days before their
 * birthday in the current calendar year. If registered within 30 days of their birthday,
 * the reward for the current calendar year is locked out and deferred to next year.
 */
export function checkBirthdayEligibility(
  birthDateInput: Date | string,
  registrationDateInput: Date | string,
  nowInput?: Date,
): BirthdayEligibilityResult {
  const now = nowInput ? new Date(nowInput) : new Date();
  const birthDate = new Date(birthDateInput);
  const registrationDate = new Date(registrationDateInput);

  if (isNaN(birthDate.getTime())) {
    throw new Error("Invalid birthDate provided to checkBirthdayEligibility.");
  }
  if (isNaN(registrationDate.getTime())) {
    throw new Error(
      "Invalid registrationDate provided to checkBirthdayEligibility.",
    );
  }

  const calendarYear = now.getUTCFullYear();
  const birthMonth = birthDate.getUTCMonth(); // 0-indexed
  const birthDay = birthDate.getUTCDate();

  // Construct birthday in the current calendar year
  // Handle Feb 29 for non-leap years gracefully (clamp to Feb 28)
  let birthdayThisYear: Date;
  if (birthMonth === 1 && birthDay === 29) {
    const isLeapYear =
      (calendarYear % 4 === 0 && calendarYear % 100 !== 0) ||
      calendarYear % 400 === 0;
    birthdayThisYear = new Date(
      Date.UTC(calendarYear, 1, isLeapYear ? 29 : 28, 0, 0, 0, 0),
    );
  } else {
    birthdayThisYear = new Date(
      Date.UTC(calendarYear, birthMonth, birthDay, 0, 0, 0, 0),
    );
  }

  // Calculate lead time between registration and birthday in the current year
  // Using UTC midnight comparison for consistent day boundaries
  const regMidnight = new Date(
    Date.UTC(
      registrationDate.getUTCFullYear(),
      registrationDate.getUTCMonth(),
      registrationDate.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );

  const leadTimeMs = birthdayThisYear.getTime() - regMidnight.getTime();
  const leadTimeDays = Math.floor(leadTimeMs / (1000 * 60 * 60 * 24));

  // Anti-gaming rule: leadTimeDays must be >= 30 days
  const isEligible = leadTimeDays >= 30;
  const isLockedOut = !isEligible;
  const nextEligibleYear = isEligible ? calendarYear : calendarYear + 1;

  const reason = isEligible
    ? `Eligible for ${calendarYear} birthday reward (${leadTimeDays} days lead time >= 30 days).`
    : `Birthday locked out for ${calendarYear}: registered ${leadTimeDays < 0 ? `${Math.abs(leadTimeDays)} days after` : `only ${leadTimeDays} days before`} birthday (requires >= 30 days). Deferred to ${nextEligibleYear}.`;

  return {
    calendarYear,
    birthdayThisYear,
    leadTimeDays,
    isEligible,
    isLockedOut,
    nextEligibleYear,
    reason,
  };
}

/**
 * Awards welcome signup bonus points to a customer's loyalty account.
 * Idempotency Key: `signup:${accountId}`
 */
export async function awardSignupWelcomeBonus(
  params: AwardSignupWelcomeBonusParams,
): Promise<WeleticPointsLedgerEntry | null> {
  if (!params.tx) {
    return prisma.$transaction((tx) =>
      awardSignupWelcomeBonus({ ...params, tx }),
    );
  }

  const {
    storeId,
    accountId,
    bonusPoints,
    reason,
    metadata,
    loyaltyMaintenancePermit,
    tx,
  } = params;
  await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: "signup_points_earn",
    loyaltyMaintenancePermit,
    tx,
  });
  const pointsDelta = BigInt(bonusPoints);

  if (pointsDelta <= BigInt(0)) {
    return null;
  }

  const idempotencyKey = `signup:${accountId}`;

  const receipt = await appendPointsLedgerEntryWithReceipt({
    storeId,
    accountId,
    entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
    pointsDelta,
    referenceType: "SIGNUP_BONUS",
    referenceId: accountId,
    idempotencyKey,
    reason: reason ?? "Welcome bonus points for account signup",
    metadata: {
      bonusType: "WELCOME_SIGNUP",
      ...(metadata ?? {}),
    },
    tx,
  });
  const entry = receipt.entry;
  await enqueueSignupPointsCommunication({
    tx: tx!,
    storeId,
    receipt,
    loyaltyMaintenancePermit,
  });
  await enqueueFlowTriggerJob({
    storeId,
    eventId: entry.id,
    payload: {
      accountId,
      handle: "weletic-points-earned",
      pointsDelta: pointsDelta.toString(),
      pointsBalance: entry.balanceAfter.toString(),
      reason: "signup_bonus",
    },
    loyaltyMaintenancePermit,
    tx: tx!,
  });
  await scheduleTierReviewAfterQualifyingActivity({
    storeId,
    accountId,
    activityKey: idempotencyKey,
    reason: "signup_points_earned",
    loyaltyMaintenancePermit,
    tx,
  });
  return entry;
}

/**
 * Awards an annual customer birthday reward with 30-day anti-gaming lead-time lockout
 * and annual calendar-year idempotency.
 * Idempotency Key: `birthday:${accountId}:${calendarYear}`
 */
async function awardBirthdayRewardInTransaction(
  {
    storeId,
    accountId,
    birthDate,
    rewardPoints,
    now = new Date(),
    enrollmentDate,
    reason,
    metadata,
    loyaltyMaintenancePermit,
  }: AwardBirthdayRewardParams,
  db: Prisma.TransactionClient,
): Promise<BirthdayRewardResult> {
  await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: "birthday_points_earn",
    loyaltyMaintenancePermit,
    tx: db,
  });
  const pointsDelta = BigInt(rewardPoints);

  if (pointsDelta <= BigInt(0)) {
    return {
      awarded: false,
      isLockedOut: false,
      calendarYear: now.getUTCFullYear(),
      reason: "Reward points must be greater than zero.",
    };
  }

  // Acquire an active-account row lock inside the same transaction as the
  // ledger append. Customer redaction closes this row with its own CAS, so an
  // award that starts after redaction cannot mutate the closed account, while
  // concurrent award/redaction attempts serialize deterministically.
  const activeAccountClaim = await db.weleticLoyaltyAccount.updateMany({
    where: {
      id: accountId,
      storeId,
      status: "active",
    },
    data: { updatedAt: new Date() },
  });
  if (activeAccountClaim.count !== 1) {
    return {
      awarded: false,
      isLockedOut: false,
      calendarYear: now.getUTCFullYear(),
      reason: "Loyalty account is not active.",
    };
  }

  // 1. Resolve registration date if not explicitly passed
  let registrationDate: Date;
  if (enrollmentDate) {
    registrationDate = new Date(enrollmentDate);
  } else {
    const account = await db.weleticLoyaltyAccount.findUnique({
      where: { id: accountId },
      select: { enrolledAt: true, createdAt: true },
    });

    if (!account) {
      throw new Error(`Loyalty account ${accountId} not found.`);
    }

    registrationDate = account.enrolledAt ?? account.createdAt;
  }

  // 2. Evaluate 30-day anti-gaming lockout
  const eligibility = checkBirthdayEligibility(
    birthDate,
    registrationDate,
    now,
  );

  if (eligibility.isLockedOut) {
    return {
      awarded: false,
      isLockedOut: true,
      calendarYear: eligibility.calendarYear,
      nextEligibleYear: eligibility.nextEligibleYear,
      leadTimeDays: eligibility.leadTimeDays,
      reason: eligibility.reason,
    };
  }

  // 3. Construct annual calendar idempotency key
  const calendarYear = eligibility.calendarYear;
  const idempotencyKey = `birthday:${accountId}:${calendarYear}`;

  // 4. Check if already awarded (idempotency preview)
  const existingEntry = await db.weleticPointsLedgerEntry.findUnique({
    where: {
      storeId_idempotencyKey: {
        storeId,
        idempotencyKey,
      },
    },
  });

  if (existingEntry) {
    return {
      awarded: true,
      isLockedOut: false,
      isDuplicate: true,
      calendarYear,
      leadTimeDays: eligibility.leadTimeDays,
      ledgerEntry: existingEntry,
      reason: `Birthday reward already awarded for calendar year ${calendarYear}.`,
    };
  }

  // 5. Append immutable ledger entry
  const nonPiiMetadata = { ...(metadata ?? {}) };
  delete nonPiiMetadata.birthDate;
  const entry = await appendPointsLedgerEntry({
    storeId,
    accountId,
    entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
    pointsDelta,
    referenceType: "BIRTHDAY_REWARD",
    referenceId: String(calendarYear),
    idempotencyKey,
    reason: reason ?? `Birthday celebration bonus for ${calendarYear}`,
    metadata: {
      bonusType: "BIRTHDAY_REWARD",
      calendarYear,
      leadTimeDays: eligibility.leadTimeDays,
      ...nonPiiMetadata,
    },
    tx: db,
  });
  await enqueueFlowTriggerJob({
    storeId,
    eventId: entry.id,
    payload: {
      accountId,
      handle: "weletic-points-earned",
      pointsDelta: pointsDelta.toString(),
      pointsBalance: entry.balanceAfter.toString(),
      reason: "birthday_reward",
    },
    loyaltyMaintenancePermit,
    tx: db,
  });
  await scheduleTierReviewAfterQualifyingActivity({
    storeId,
    accountId,
    activityKey: idempotencyKey,
    reason: "birthday_points_earned",
    loyaltyMaintenancePermit,
    tx: db,
  });

  return {
    awarded: true,
    isLockedOut: false,
    isDuplicate: false,
    calendarYear,
    leadTimeDays: eligibility.leadTimeDays,
    ledgerEntry: entry,
    reason: `Successfully awarded ${pointsDelta.toString()} birthday points for ${calendarYear}.`,
  };
}

export async function awardBirthdayReward(
  params: AwardBirthdayRewardParams,
): Promise<BirthdayRewardResult> {
  if (params.tx) {
    return awardBirthdayRewardInTransaction(params, params.tx);
  }

  return prisma.$transaction((tx) =>
    awardBirthdayRewardInTransaction(params, tx),
  );
}

/**
 * Awards non-order activity points (e.g. social follow, product review, custom actions).
 * Idempotency Key: `activity:${activityType}:${accountId}:${externalId ?? 'default'}`
 */
export async function awardActivityPoints(
  params: AwardActivityPointsParams,
): Promise<WeleticPointsLedgerEntry | null> {
  if (!params.tx) {
    return prisma.$transaction((tx) => awardActivityPoints({ ...params, tx }));
  }

  const {
    storeId,
    accountId,
    activityType,
    points,
    externalId,
    reason,
    metadata,
    loyaltyMaintenancePermit,
    tx,
  } = params;
  await assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action: "activity_points_earn",
    loyaltyMaintenancePermit,
    tx,
  });
  const pointsDelta = BigInt(points);

  if (pointsDelta <= BigInt(0)) {
    return null;
  }

  const normalizedType = activityType.toLowerCase().trim();
  const normalizedRef = (externalId ?? "default").trim();
  const idempotencyKey = `activity:${normalizedType}:${accountId}:${normalizedRef}`;

  const entry = await appendPointsLedgerEntry({
    storeId,
    accountId,
    entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
    pointsDelta,
    referenceType: `ACTIVITY_${normalizedType.toUpperCase()}`,
    referenceId: externalId ?? null,
    idempotencyKey,
    reason: reason ?? `Bonus points awarded for ${normalizedType}`,
    metadata: {
      bonusType: "ACTIVITY_REWARD",
      activityType: normalizedType,
      externalId: externalId ?? null,
      ...(metadata ?? {}),
    },
    tx,
  });
  await enqueueFlowTriggerJob({
    storeId,
    eventId: entry.id,
    payload: {
      accountId,
      handle: "weletic-points-earned",
      pointsDelta: pointsDelta.toString(),
      pointsBalance: entry.balanceAfter.toString(),
      reason: normalizedType,
      orderId: externalId ?? null,
    },
    loyaltyMaintenancePermit,
    tx: tx!,
  });
  await scheduleTierReviewAfterQualifyingActivity({
    storeId,
    accountId,
    activityKey: idempotencyKey,
    reason: `${normalizedType}_points_earned`,
    loyaltyMaintenancePermit,
    tx,
  });
  return entry;
}
