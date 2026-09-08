import { createWeleticId } from "@/lib/weletic/ids";
import { Prisma, type WeleticLoyaltyEarningRule } from "@prisma/client";
import { publishLoyaltyEarnPolicyRevision } from "./earn-policy-revision";
import { JUDGEME_PROVIDER } from "./review-providers/judgeme";
import { reviewRewardConditionsSchema } from "./review-rewards";

export class EarningRuleWriteError extends Error {
  readonly code: "conflict" | "not_found";
  constructor({
    code,
    message,
  }: {
    code: "conflict" | "not_found";
    message: string;
  }) {
    super(message);
    this.name = "EarningRuleWriteError";
    this.code = code;
  }
}
// Normalized internal fields, never raw HTTP input. Gateways own validation,
// authorization and store/installation fencing on the supplied transaction.
export type ValidatedEarningRuleData = Pick<
  WeleticLoyaltyEarningRule,
  | "name"
  | "description"
  | "triggerCode"
  | "ruleType"
  | "priority"
  | "multiplier"
  | "fixedPoints"
  | "maxPointsPerEvent"
  | "maxEventsPerCustomer"
  | "limitInterval"
  | "minOrderSubtotal"
  | "excludeDiscountedItems"
  | "excludeTaxesAndShipping"
  | "isActive"
> & { conditions: Prisma.InputJsonValue | Prisma.NullTypes.DbNull };
export async function writeEarningRuleInTransaction({
  tx,
  storeId,
  ruleId,
  ruleData,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  ruleId?: string | null;
  ruleData: ValidatedEarningRuleData;
}) {
  if (ruleData.triggerCode === "product_review" && ruleData.isActive) {
    const reviewProvider = reviewRewardConditionsSchema.parse(
      ruleData.conditions,
    ).provider;
    const reviewIntegration =
      reviewProvider === "native"
        ? await tx.weleticReviewSettings.findUnique({
            where: { storeId },
            select: { enabled: true },
          })
        : await tx.weleticLoyaltyReviewIntegration.findUnique({
            where: {
              storeId_provider: {
                storeId,
                provider: JUDGEME_PROVIDER,
              },
            },
            select: { enabled: true },
          });
    if (!reviewIntegration?.enabled) {
      throw new EarningRuleWriteError({
        code: "conflict",
        message:
          "Enable the selected reviews provider before activating this earning rule.",
      });
    }
  }
  const program = await tx.weleticLoyaltyProgram.upsert({
    where: { storeId },
    create: {
      id: createWeleticId("wprog_"),
      storeId,
      name: "Customer Loyalty Program",
      status: "draft",
    },
    update: {},
  });
  let savedRule;
  if (ruleId) {
    const existing = await tx.weleticLoyaltyEarningRule.findFirst({
      where: { id: ruleId, programId: program.id, deletedAt: null },
    });
    if (!existing) {
      throw new EarningRuleWriteError({
        code: "not_found",
        message: `Earning rule '${ruleId}' not found for this store.`,
      });
    }
    savedRule = await tx.weleticLoyaltyEarningRule.update({
      where: { id: ruleId },
      data: ruleData,
    });
  } else {
    savedRule = await tx.weleticLoyaltyEarningRule.create({
      data: {
        id: createWeleticId("wrule_"),
        programId: program.id,
        ...ruleData,
      },
    });
  }
  await publishLoyaltyEarnPolicyRevision({
    tx,
    storeId,
    programId: program.id,
    reason: ruleId ? "earning_rule_updated" : "earning_rule_created",
  });
  return savedRule;
}

export async function retireEarningRuleInTransaction({
  tx,
  storeId,
  ruleId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  ruleId: string;
}) {
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
  });
  if (!program)
    throw new EarningRuleWriteError({
      code: "not_found",
      message: "Loyalty program not found.",
    });
  const existing = await tx.weleticLoyaltyEarningRule.findFirst({
    where: { id: ruleId, programId: program.id, deletedAt: null },
  });
  if (!existing)
    throw new EarningRuleWriteError({
      code: "not_found",
      message: `Earning rule '${ruleId}' not found for this store.`,
    });
  const retired = await tx.weleticLoyaltyEarningRule.update({
    where: { id: ruleId },
    data: { deletedAt: new Date(), isActive: false },
  });
  await publishLoyaltyEarnPolicyRevision({
    tx,
    storeId,
    programId: program.id,
    reason: "earning_rule_retired",
  });
  return retired;
}
