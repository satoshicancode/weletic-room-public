import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { awardActivityPoints } from "@/lib/weletic/loyalty/non-purchase-earn";
import { Prisma } from "@prisma/client";

import {
  getCustomerIntentAction,
  isCustomerIntentTriggerCode,
} from "./customer-intent-policy";
export {
  CUSTOMER_INTENT_TRIGGER_CODES,
  getCustomerIntentAction,
  isCustomerIntentTriggerCode,
  validateCustomerIntentConditions,
  type CustomerIntentAction,
  type CustomerIntentTriggerCode,
} from "./customer-intent-policy";

export class CustomerActivityClaimError extends Error {
  readonly code:
    | "account_not_found"
    | "rule_not_found"
    | "rule_unavailable"
    | "claim_key_required"
    | "earning_limit_reached";

  constructor(code: CustomerActivityClaimError["code"], message: string) {
    super(message);
    this.name = "CustomerActivityClaimError";
    this.code = code;
  }
}

export function serializeCustomerEarningRule(rule: {
  id: string;
  name: string;
  description: string | null;
  triggerCode: string;
  ruleType: unknown;
  multiplier: unknown;
  fixedPoints: bigint | null;
  maxEventsPerCustomer?: number | null;
  limitInterval?: string | null;
  conditions?: unknown;
}) {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    triggerCode: rule.triggerCode,
    ruleType: rule.ruleType,
    multiplier: Number(rule.multiplier),
    fixedPoints: rule.fixedPoints?.toString() ?? null,
    maxEventsPerCustomer: rule.maxEventsPerCustomer ?? null,
    limitInterval: rule.limitInterval ?? null,
    action: getCustomerIntentAction({
      triggerCode: rule.triggerCode,
      conditions: rule.conditions,
    }),
  };
}

function claimPeriod({ interval, now }: { interval: string; now: Date }) {
  if (interval === "daily" || interval === "day") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    return {
      key: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`,
      start,
    };
  }
  if (interval === "weekly" || interval === "week") {
    const dayOfWeek = now.getUTCDay();
    const distanceToMonday = (dayOfWeek + 6) % 7;
    const start = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - distanceToMonday,
      ),
    );
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil(
      ((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
    );
    return {
      key: `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`,
      start,
    };
  }
  if (interval === "monthly") {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    return {
      key: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
      start,
    };
  }
  if (interval === "calendar_year") {
    return {
      key: String(now.getUTCFullYear()),
      start: new Date(Date.UTC(now.getUTCFullYear(), 0, 1)),
    };
  }
  return { key: "lifetime", start: null };
}

export async function claimCustomerIntentActivity({
  storeId,
  shopifyCustomerId,
  ruleId,
  claimKey,
  now = new Date(),
}: {
  storeId: string;
  shopifyCustomerId: string;
  ruleId: string;
  claimKey?: string;
  now?: Date;
}) {
  return withActiveStoreLoyaltyMutation({
    storeId,
    action: "customer_intent_points_earn",
    operation: async (tx) => {
      const account = await tx.weleticLoyaltyAccount.findFirst({
        where: {
          storeId,
          status: "active",
          shopper: { shopifyCustomerId },
        },
        include: {
          program: {
            include: {
              earningRules: {
                where: { id: ruleId, deletedAt: null },
                take: 1,
              },
            },
          },
        },
      });
      if (!account) {
        throw new CustomerActivityClaimError(
          "account_not_found",
          "Loyalty account not found.",
        );
      }

      const rule = account.program.earningRules[0];
      if (!rule) {
        throw new CustomerActivityClaimError(
          "rule_not_found",
          "Earning action not found.",
        );
      }
      const withinWindow =
        (!rule.startAt || rule.startAt <= now) &&
        (!rule.endAt || rule.endAt > now);
      if (
        account.program.status !== "active" ||
        account.program.killSwitchActive ||
        !rule.isActive ||
        rule.ruleType !== "fixed_points" ||
        !rule.fixedPoints ||
        rule.fixedPoints <= BigInt(0) ||
        !withinWindow ||
        !isCustomerIntentTriggerCode(rule.triggerCode) ||
        !getCustomerIntentAction(rule)
      ) {
        throw new CustomerActivityClaimError(
          "rule_unavailable",
          "This earning action is not currently available.",
        );
      }

      const interval = [
        "daily",
        "day",
        "weekly",
        "week",
        "monthly",
        "calendar_year",
        "lifetime",
      ].includes(rule.limitInterval || "")
        ? rule.limitInterval!
        : "lifetime";
      const maxEvents = Math.max(
        1,
        Math.min(100, rule.maxEventsPerCustomer ?? 1),
      );
      const period = claimPeriod({ interval, now });
      if (maxEvents > 1 && !claimKey) {
        throw new CustomerActivityClaimError(
          "claim_key_required",
          "A claim key is required for recurring earning actions.",
        );
      }

      const normalizedClaimKey =
        maxEvents === 1 ? "once" : claimKey!.trim().toLowerCase();
      const externalId = `${rule.id}:${period.key}:${normalizedClaimKey}`;
      const idempotencyKey = `activity:${rule.triggerCode}:${account.id}:${externalId}`;
      const existing = await tx.weleticPointsLedgerEntry.findUnique({
        where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
      });
      if (existing) {
        return {
          awarded: false,
          alreadyCompleted: true,
          pointsAwarded: existing.pointsDelta.toString(),
          pointsBalance: existing.balanceAfter.toString(),
          ruleId: rule.id,
        };
      }

      const completedCount = await tx.weleticPointsLedgerEntry.count({
        where: {
          storeId,
          accountId: account.id,
          referenceType: `ACTIVITY_${rule.triggerCode.toUpperCase()}`,
          referenceId: { startsWith: `${rule.id}:${period.key}:` },
          ...(period.start
            ? { createdAt: { gte: period.start, lt: now } }
            : {}),
        },
      });
      if (completedCount >= maxEvents) {
        throw new CustomerActivityClaimError(
          "earning_limit_reached",
          "You have already reached the earning limit for this action.",
        );
      }

      const entry = await awardActivityPoints({
        storeId,
        accountId: account.id,
        activityType: rule.triggerCode,
        points: rule.fixedPoints,
        externalId,
        reason: `Points awarded for ${rule.name}`,
        metadata: {
          earningRuleId: rule.id,
          triggerCode: rule.triggerCode,
          verification: "customer_intent",
          limitInterval: interval,
          limitPeriod: period.key,
        },
        tx: tx as Prisma.TransactionClient,
      });
      if (!entry) {
        throw new CustomerActivityClaimError(
          "rule_unavailable",
          "This earning action is not currently available.",
        );
      }

      return {
        awarded: true,
        alreadyCompleted: false,
        pointsAwarded: entry.pointsDelta.toString(),
        pointsBalance: entry.balanceAfter.toString(),
        ruleId: rule.id,
      };
    },
  });
}
