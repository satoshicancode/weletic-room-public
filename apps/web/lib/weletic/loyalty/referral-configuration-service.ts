import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { currencyMinorUnits } from "../money";
import { projectEarningRuleCurrency } from "./earning-rule-projection";
import {
  DEFAULT_REFERRAL_PURCHASE_POLICY,
  loyaltyPurchasePolicySchema,
} from "./purchase-policy";
import {
  canonicalReferralFields,
  referralConfigurationFieldsSchema,
  referralConfigurationRequestSchema,
  referralConfigurationResponseSchema,
} from "./referral-configuration-contract";
import { DEFAULT_REFERRAL_RULE_CONFIG } from "./referral-rule-config";
import { writeReferralRuleInTransaction } from "./referral-rule-write";
import {
  isReferralCouponProvisionable,
  RewardDefinitionConflictError,
} from "./rewards";

const {
  purchaseType: _defaultPurchaseType,
  subscriptionCadence: _defaultSubscriptionCadence,
  subscriptionPaymentLimit: _defaultSubscriptionPaymentLimit,
  ...DEFAULT_REFERRAL_RULE_PERSISTED_FIELDS
} = DEFAULT_REFERRAL_RULE_CONFIG;

export async function readReferralConfigurationState(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: { shopCurrency: true },
  });
  if (!store) throw new RewardDefinitionConflictError();
  const program = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select: { id: true },
  });
  const rules = program
    ? await tx.weleticLoyaltyReferralRule.findMany({
        where: { programId: program.id },
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      })
    : [];
  const rewards = await tx.weleticRewardDefinition.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
  });
  const revision = createHash("sha256")
    .update(
      JSON.stringify(
        [
          "referral-configuration-v1",
          storeId,
          store.shopCurrency,
          program,
          rules,
          rewards,
        ],
        (_key, value) =>
          typeof value === "bigint"
            ? value.toString()
            : value && typeof value === "object" && !Array.isArray(value)
              ? Object.fromEntries(
                  Object.entries(value).sort(([a], [b]) =>
                    a < b ? -1 : a > b ? 1 : 0,
                  ),
                )
              : value,
      ),
    )
    .digest("hex");
  const shopCurrency = projectEarningRuleCurrency(store.shopCurrency);
  const thresholdDecimalPlaces = shopCurrency
    ? Math.min(2, currencyMinorUnits(shopCurrency))
    : null;
  const rule = rules[0];
  const purchasePolicy = loyaltyPurchasePolicySchema.safeParse(
    rule?.purchasePolicy ?? DEFAULT_REFERRAL_PURCHASE_POLICY,
  );
  const projected = rule
    ? {
        advocatePointsReward: rule.advocatePointsReward.toString(),
        refereePointsReward: rule.refereePointsReward.toString(),
        advocateRewardKind: rule.advocateRewardKind,
        refereeRewardKind: rule.refereeRewardKind,
        advocateRewardDefinitionId: rule.advocateRewardDefinitionId,
        refereeRewardDefinitionId: rule.refereeRewardDefinitionId,
        minQualifyingOrderSubtotal:
          rule.minQualifyingOrderSubtotal?.toString() ?? null,
        maxReferralsPerAdvocate: rule.maxReferralsPerAdvocate,
        fraudCheckSameIp: rule.fraudCheckSameIp,
        ...(purchasePolicy.success ? purchasePolicy.data : {}),
        isActive: rule.isActive,
      }
    : { ...DEFAULT_REFERRAL_RULE_CONFIG };
  const parsed = referralConfigurationFieldsSchema.safeParse(projected);
  const fields = parsed.success ? canonicalReferralFields(parsed.data) : null;
  const couponOptions = rewards
    .filter(
      (reward) =>
        reward.status === "active" &&
        reward.exchangeType === "fixed" &&
        isReferralCouponProvisionable(reward),
    )
    .map(({ id, name, rewardType }) => ({ id, name, rewardType }));
  return {
    programId: program?.id ?? null,
    revision,
    shopCurrency,
    thresholdDecimalPlaces,
    ruleId: rule?.id ?? null,
    fields,
    // Runtime lazily creates active defaults when an existing program has no
    // rule. Display that effective state rather than inventing a paused state.
    active:
      program !== null &&
      (rules.length === 0 || rules.some((rule) => rule.isActive)),
    legacyConfiguration: rule !== undefined && fields === null,
    couponOptions,
  };
}

/** Gateways supply transaction-local authority and the winning store fence. */
export async function manageReferralConfigurationInTransaction({
  tx,
  storeId,
  installationGeneration,
  configure,
  request,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string;
  configure: boolean;
  request: unknown;
}) {
  const data = referralConfigurationRequestSchema.parse(request);
  let state = await readReferralConfigurationState(tx, storeId);
  if (data.operation !== "read") {
    if (
      !configure ||
      data.input.expectedInstallationGeneration !== installationGeneration ||
      data.input.expectedRevision !== state.revision ||
      !state.programId
    )
      throw new RewardDefinitionConflictError();
    if (data.operation === "pause") {
      if (state.ruleId === null) {
        await writeReferralRuleInTransaction({
          tx,
          storeId,
          ruleData: {
            ...DEFAULT_REFERRAL_RULE_PERSISTED_FIELDS,
            advocatePointsReward: BigInt(
              DEFAULT_REFERRAL_RULE_CONFIG.advocatePointsReward,
            ),
            refereePointsReward: BigInt(
              DEFAULT_REFERRAL_RULE_CONFIG.refereePointsReward,
            ),
            minQualifyingOrderSubtotal: new Prisma.Decimal(
              DEFAULT_REFERRAL_RULE_CONFIG.minQualifyingOrderSubtotal,
            ),
            purchasePolicy: DEFAULT_REFERRAL_PURCHASE_POLICY,
            isActive: false,
          },
        });
      }
      // Status only: do not require valid economic fields or a known currency.
      await tx.weleticLoyaltyProgram.updateMany({
        where: { id: state.programId },
        data: { updatedAt: new Date() },
      });
      await tx.weleticLoyaltyReferralRule.updateMany({
        where: { programId: state.programId, isActive: true },
        data: { isActive: false },
      });
    } else {
      const input = data.input;
      if (!state.fields || !state.shopCurrency || state.ruleId !== input.ruleId)
        throw new RewardDefinitionConflictError();
      const fraction =
        input.fields.minQualifyingOrderSubtotal
          ?.split(".")[1]
          ?.replace(/0+$/, "") ?? "";
      if (fraction.length > state.thresholdDecimalPlaces!)
        throw new RewardDefinitionConflictError();
      for (const side of ["advocate", "referee"] as const) {
        if (
          input.fields[`${side}RewardKind`] === "coupon" &&
          !state.couponOptions.some(
            (option) => option.id === input.fields[`${side}RewardDefinitionId`],
          )
        )
          throw new RewardDefinitionConflictError();
      }
      const {
        purchaseType,
        subscriptionCadence,
        subscriptionPaymentLimit,
        ...ruleFields
      } = input.fields;
      const saved = await writeReferralRuleInTransaction({
        tx,
        storeId,
        ruleId: input.ruleId,
        ruleData: {
          ...ruleFields,
          purchasePolicy: {
            purchaseType,
            subscriptionCadence,
            subscriptionPaymentLimit,
          },
          advocatePointsReward: BigInt(input.fields.advocatePointsReward),
          refereePointsReward: BigInt(input.fields.refereePointsReward),
          minQualifyingOrderSubtotal:
            input.fields.minQualifyingOrderSubtotal === null
              ? null
              : new Prisma.Decimal(input.fields.minQualifyingOrderSubtotal),
        },
      });
      state = await readReferralConfigurationState(tx, storeId);
      // Legacy duplicate rows must not silently switch the canonical rule when
      // deactivating an older active row. Roll back rather than acknowledge it.
      if (
        state.ruleId !== saved.id ||
        JSON.stringify(state.fields) !==
          JSON.stringify(canonicalReferralFields(input.fields))
      )
        throw new RewardDefinitionConflictError();
    }
    state = await readReferralConfigurationState(tx, storeId);
  }
  return referralConfigurationResponseSchema.parse({
    ...state,
    storeId,
    installationGeneration,
    capabilities: { configure },
    acknowledgedOperation: data.operation,
  });
}
