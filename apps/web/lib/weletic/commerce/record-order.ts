import { createId } from "@/lib/api/create-id";
import { syncTotalCommissions } from "@/lib/api/partners/sync-total-commissions";
import { orderSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import {
  allocateCommissionProportionally,
  calculateCommission,
  selectCommissionRule,
} from "@/lib/weletic/commissions/rules";
import {
  resolveShopifyEcommerceCommission,
  type ResolvedShopifyCommission,
  type ShopifyCustomerClassification,
} from "@/lib/weletic/commissions/shopify-reward";
import { getAccountingFxQuote, persistFxQuote } from "@/lib/weletic/fx";
import { createWeleticId } from "@/lib/weletic/ids";
import { processOrderPointsEarn } from "@/lib/weletic/loyalty/earn";
import { resolveLoyaltyEarnPolicyRevisionAt } from "@/lib/weletic/loyalty/earn-policy-revision";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { upsertWeleticShopper } from "@/lib/weletic/loyalty/shopper";
import {
  convertMoney,
  decimalToMinorUnits,
  normalizeCurrency,
} from "@/lib/weletic/money";
import {
  getShopifyCustomerOrderHistory,
  getShopifyCustomerSegmentIds,
} from "@/lib/weletic/shopify/customer-segments";
import {
  assertShopifySettlementLockContext,
  withShopifySettlementLocks,
  type ShopifySettlementLockContext,
} from "@/lib/weletic/shopify/customer-settlement-lock";
import { getShopifyOrderLineContext } from "@/lib/weletic/shopify/order-context";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import {
  resolveShopifyRewardConfigAt,
  ShopifyEcommerceRewardConfigSchema,
  ShopifyOrderRewardSnapshotSchema,
  type ShopifyOrderRewardSnapshot,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";
import {
  Prisma,
  WeleticOrderStatus,
  type WeleticCommissionRule,
} from "@prisma/client";
import { createHash } from "node:crypto";
import {
  classifyLifetimeShopifyCustomerOrder,
  isExplicitShopifyCommissionRuleKey,
  resolveOrderAttributionTransition,
  resolveShopifySubscriptionCycle,
  retainKnownShopifyCustomerSnapshot,
  selectCapturedReward,
  selectEffectiveRuleVersions,
} from "./order-attribution";

const shopifyGid = (type: "Product" | "ProductVariant", id?: number | null) =>
  id ? `gid://shopify/${type}/${id}` : undefined;

function toSafeInt(value: bigint, field: string) {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number > 2_147_483_647 ||
    number < -2_147_483_648
  ) {
    throw new Error(`${field} exceeds the Dub integer money range.`);
  }
  return number;
}

function orderStatus(status?: string | null): WeleticOrderStatus {
  switch (status) {
    case "refunded":
      return "refunded";
    case "voided":
      return "voided";
    case "partially_refunded":
      return "partially_refunded";
    case "paid":
      return "paid";
    default:
      return "pending";
  }
}

/**
 * Resolves the immutable loyalty policy generation for a newly-created order.
 *
 * The caller must already own the transaction-scoped store -> loyalty-program
 * locks. A store without a loyalty program (or a pre-cutover order without an
 * effective revision) intentionally binds null; the earn pipeline treats that
 * as unavailable policy and fails closed instead of evaluating mutable state.
 */
export async function resolveOrderLoyaltyPolicyRevisionId({
  tx,
  storeId,
  occurredAt,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  occurredAt: Date;
}): Promise<string | null> {
  const delegates = tx as Prisma.TransactionClient & {
    weleticLoyaltyProgram?: Prisma.TransactionClient["weleticLoyaltyProgram"];
    weleticLoyaltyEarnPolicyRevision?: Prisma.TransactionClient["weleticLoyaltyEarnPolicyRevision"];
  };
  if (
    !delegates.weleticLoyaltyProgram?.findUnique ||
    !delegates.weleticLoyaltyEarnPolicyRevision?.findFirst
  ) {
    // Legacy focused tests predate the revision delegates. Generated runtime
    // clients always expose both; never silently skip a production binding.
    if (process.env.NODE_ENV === "test") return null;
    throw new Error("Loyalty policy revision binding is unavailable.");
  }

  const loyaltyProgram = await tx.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select: { id: true },
  });
  if (!loyaltyProgram) return null;

  const resolved = await resolveLoyaltyEarnPolicyRevisionAt({
    tx,
    storeId,
    programId: loyaltyProgram.id,
    occurredAt,
  });
  return resolved?.revision.id ?? null;
}

const commissionScopeSpecificity = {
  program: 0,
  partner: 1,
  collection: 2,
  tag: 2,
  product: 3,
  variant: 4,
  promotion: 5,
} as const;

const settlementRewardSelect = {
  id: true,
  config: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RewardSelect;

type SettlementReward = Prisma.RewardGetPayload<{
  select: typeof settlementRewardSelect;
}>;

function capturedRewardAt(
  reward: SettlementReward | null,
  occurredAt: Date,
): ShopifyOrderRewardSnapshot["rewards"][number] | null {
  if (!reward || reward.createdAt > occurredAt) return null;
  const parsedConfig = ShopifyEcommerceRewardConfigSchema.safeParse(
    reward.config,
  );
  if (!parsedConfig.success) return null;
  const config = resolveShopifyRewardConfigAt({
    rawConfig: reward.config,
    occurredAt,
    currentEffectiveAt: reward.updatedAt,
  });
  if (!config) return null;

  return {
    rewardId: reward.id,
    config,
  };
}

async function captureShopifyOrderRewardSnapshot({
  programId,
  occurredAt,
}: {
  programId: string;
  occurredAt: Date;
}): Promise<ShopifyOrderRewardSnapshot> {
  const [groups, enrollmentOverrides, commissionRules] = await Promise.all([
    prisma.partnerGroup.findMany({
      where: { programId },
      select: {
        id: true,
        saleReward: { select: settlementRewardSelect },
      },
    }),
    prisma.programEnrollment.findMany({
      where: {
        programId,
        saleRewardId: { not: null },
        OR: [
          { groupId: null },
          { partnerGroup: { is: { saleRewardId: null } } },
        ],
      },
      select: {
        partnerId: true,
        saleReward: { select: settlementRewardSelect },
      },
    }),
    prisma.weleticCommissionRule.findMany({
      where: {
        programId,
        effectiveAt: { lte: occurredAt },
        NOT: [
          { logicalKey: { startsWith: "shopify-config:" } },
          { logicalKey: { startsWith: "dub-sale-reward:" } },
        ],
      },
      select: {
        id: true,
        logicalKey: true,
        version: true,
        createdAt: true,
        expiresAt: true,
        scope: true,
        collectionExternalId: true,
      },
    }),
  ]);

  const effectiveManualRules = selectEffectiveRuleVersions(
    commissionRules,
    occurredAt,
  ).filter((rule) => isExplicitShopifyCommissionRuleKey(rule.logicalKey));

  const rewards = new Map<
    string,
    ShopifyOrderRewardSnapshot["rewards"][number]
  >();
  const groupSnapshots = groups.map(({ id, saleReward }) => {
    const snapshot = capturedRewardAt(saleReward, occurredAt);
    if (snapshot) rewards.set(snapshot.rewardId, snapshot);
    return { groupId: id, rewardId: snapshot?.rewardId ?? null };
  });
  const enrollmentOverrideSnapshots = enrollmentOverrides.flatMap(
    ({ partnerId, saleReward }) => {
      const snapshot = capturedRewardAt(saleReward, occurredAt);
      if (!snapshot) return [];
      rewards.set(snapshot.rewardId, snapshot);
      return [{ partnerId, rewardId: snapshot.rewardId }];
    },
  );

  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    rewards: [...rewards.values()],
    groups: groupSnapshots,
    enrollmentOverrides: enrollmentOverrideSnapshots,
    commissionRuleIds: effectiveManualRules.map(({ id }) => id),
    collectionRuleExternalIds: effectiveManualRules.flatMap(
      ({ scope, collectionExternalId }) =>
        scope === "collection" && collectionExternalId
          ? [collectionExternalId]
          : [],
    ),
  };
}

function previousGroupIdFromChangeSet(changeSet: Prisma.JsonValue) {
  if (!changeSet || typeof changeSet !== "object" || Array.isArray(changeSet)) {
    return undefined;
  }
  const group = changeSet.group;
  if (!group || typeof group !== "object" || Array.isArray(group)) {
    return undefined;
  }
  if (group.old === null) return null;
  if (
    group.old &&
    typeof group.old === "object" &&
    !Array.isArray(group.old) &&
    typeof group.old.id === "string"
  ) {
    return group.old.id;
  }
  return undefined;
}

async function resolvePartnerGroupIdAt({
  programId,
  partnerId,
  currentGroupId,
  enrollmentCreatedAt,
  occurredAt,
}: {
  programId: string;
  partnerId: string;
  currentGroupId: string | null;
  enrollmentCreatedAt: Date;
  occurredAt: Date;
}) {
  if (enrollmentCreatedAt > occurredAt) return null;
  const nextGroupChange = await prisma.activityLog.findFirst({
    where: {
      programId,
      resourceType: "partner",
      resourceId: partnerId,
      action: "partner.groupChanged",
      createdAt: { gt: occurredAt },
    },
    orderBy: { createdAt: "asc" },
    select: { changeSet: true },
  });
  if (!nextGroupChange) return currentGroupId;
  return previousGroupIdFromChangeSet(nextGroupChange.changeSet) ?? null;
}

async function materializeShopifyCommissionRule({
  programId,
  partnerId,
  accountingCurrency,
  resolved,
}: {
  programId: string;
  partnerId: string;
  accountingCurrency: string;
  resolved: ResolvedShopifyCommission;
}) {
  const descriptorHash = createHash("sha256")
    .update(
      JSON.stringify({
        source: resolved.source,
        sourceId: resolved.sourceId,
        type: resolved.type,
        basisPoints: resolved.basisPoints,
        fixedAmount: resolved.fixedAmount?.toString() ?? null,
        currency: resolved.type === "fixed" ? accountingCurrency : null,
        classification: resolved.customerClassification,
        segmentId: resolved.matchedSegmentId,
        subscriptionCycle:
          resolved.source === "subscription"
            ? resolved.subscriptionCycle
            : null,
        sellingPlanId:
          resolved.source === "subscription" ? resolved.sellingPlanId : null,
      }),
    )
    .digest("hex")
    .slice(0, 24);
  const logicalKey = `shopify-config:${resolved.configHash}:${descriptorHash}:partner:${partnerId}`;

  return prisma.weleticCommissionRule.upsert({
    where: {
      programId_logicalKey_version: {
        programId,
        logicalKey,
        version: 1,
      },
    },
    create: {
      id: createWeleticId("wrule_"),
      logicalKey,
      version: 1,
      programId,
      partnerId,
      scope: "partner",
      ruleType: resolved.type,
      fixedAmountMode: resolved.type === "fixed" ? "order" : "line",
      priority: resolved.priority,
      basisPoints: resolved.basisPoints,
      fixedAmount: resolved.fixedAmount,
      currency: resolved.type === "fixed" ? accountingCurrency : null,
      effectiveAt: new Date(0),
    },
    update: {},
  });
}

type LoyaltyFinalizationOrder = {
  id: string;
  storeId: string;
  shopperId: string | null;
  presentmentNet: bigint;
  presentmentCurrency: string;
  shopNet: bigint;
  shopCurrency: string;
  customerOrderSequence?: number | null;
};

async function resolveOrderShopperForLoyalty({
  storeId,
  order,
  candidateShopperId,
}: {
  storeId: string;
  order: LoyaltyFinalizationOrder;
  candidateShopperId: string | null;
}) {
  if (order.storeId !== storeId) {
    throw new Error(
      `Commerce order ${order.id} does not belong to Shopify store ${storeId}`,
    );
  }

  // Once an order is attached, the persisted relationship is authoritative.
  // A later webhook must never move loyalty value to a different shopper.
  if (order.shopperId) return order.shopperId;
  if (!candidateShopperId) return null;

  const attached = await prisma.weleticCommerceOrder.updateMany({
    where: {
      id: order.id,
      storeId,
      shopperId: null,
    },
    data: { shopperId: candidateShopperId },
  });
  if (attached.count === 1) return candidateShopperId;

  // A concurrent recovery may have attached the order between the initial
  // read and the conditional update. Re-read instead of overwriting it.
  const currentOrder = await prisma.weleticCommerceOrder.findUnique({
    where: { id: order.id },
    select: { storeId: true, shopperId: true },
  });
  if (!currentOrder || currentOrder.storeId !== storeId) {
    throw new Error(
      `Commerce order ${order.id} disappeared during loyalty finalization`,
    );
  }

  return currentOrder.shopperId;
}

async function finalizeOrderLoyalty({
  storeId,
  order,
  candidateShopperId,
  referralFriendEmail,
  customerOrderSequence,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  order: LoyaltyFinalizationOrder;
  candidateShopperId: string | null;
  referralFriendEmail?: string | null;
  customerOrderSequence?: number | null;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const shopperId = await resolveOrderShopperForLoyalty({
    storeId,
    order,
    candidateShopperId,
  });

  // Smile-compatible friend rewards are claimed by email before a Shopify
  // customer account exists. Qualify that claim from the first paid order,
  // including guest checkout orders that have no loyalty shopper yet.
  const { evaluateReferralFriendClaimQualification } = await import(
    "@/lib/weletic/loyalty/referral-friend-claim"
  );
  const friendClaim = await evaluateReferralFriendClaimQualification({
    storeId,
    orderId: order.id,
    friendEmail: referralFriendEmail,
    refereeShopperId: shopperId,
    orderSubtotal: order.shopNet,
    currency: order.shopCurrency,
    customerOrderSequence,
    loyaltyMaintenancePermit,
  });
  if (!shopperId) {
    return { shopperId: null, loyaltyLedgerEntry: null };
  }

  const loyaltyAccount = await prisma.weleticLoyaltyAccount.findUnique({
    where: { shopperId },
    select: { id: true, storeId: true, status: true },
  });
  if (loyaltyAccount && loyaltyAccount.storeId !== storeId) {
    throw new Error(
      `Loyalty account ${loyaltyAccount.id} does not belong to Shopify store ${storeId}`,
    );
  }
  // Customer redaction closes the account before delayed customer/order events
  // can be replayed. Preserve the accounting association, but never restart
  // earning, referrals, or tier progression for a closed/suspended member.
  if (!loyaltyAccount || loyaltyAccount.status !== "active") {
    return { shopperId, loyaltyLedgerEntry: null };
  }

  // These three operations own their own idempotency keys / state claims. A
  // duplicate paid-order webhook is therefore the recovery signal for a crash
  // after commerce committed but before the loyalty lifecycle completed.
  const loyaltyLedgerEntry = await processOrderPointsEarn({
    storeId,
    orderId: order.id,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  const { evaluateReferralQualification } = await import(
    "@/lib/weletic/loyalty/referrals"
  );
  if (!friendClaim.qualified) {
    await evaluateReferralQualification({
      storeId,
      orderId: order.id,
      refereeShopperId: shopperId,
      // Referral rules are configured and displayed in the store currency.
      // Never compare a buyer's presentment amount with that threshold.
      orderSubtotal: order.shopNet,
      currency: order.shopCurrency,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    });
  }

  const { evaluateAccountTier } = await import("@/lib/weletic/loyalty/tiers");
  await evaluateAccountTier(loyaltyAccount.id, {
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  return { shopperId, loyaltyLedgerEntry };
}

export async function recordWeleticOrder(input: {
  event: unknown;
  workspaceId: string;
  programId?: string | null;
  partnerId?: string | null;
  linkId?: string | null;
  customerId?: string | null;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  settlementLockContext?: ShopifySettlementLockContext;
}) {
  const order = orderSchema.parse(input.event);
  const externalId = String(order.id ?? order.confirmation_number);
  const execute = () => recordWeleticOrderUnlocked({ ...input, event: order });

  if (input.settlementLockContext) {
    assertShopifySettlementLockContext({
      context: input.settlementLockContext,
      workspaceId: input.workspaceId,
      storeId: input.storeId,
      orderExternalId: externalId,
      shopifyCustomerId: order.customer?.id,
    });
    return execute();
  }

  return withShopifySettlementLocks({
    workspaceId: input.workspaceId,
    storeId: input.storeId,
    orderExternalId: externalId,
    shopifyCustomerId: order.customer?.id,
    fn: execute,
  });
}

async function recordWeleticOrderUnlocked({
  event,
  workspaceId,
  programId,
  partnerId,
  linkId,
  customerId,
  storeId,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
}: {
  event: unknown;
  workspaceId: string;
  programId?: string | null;
  partnerId?: string | null;
  linkId?: string | null;
  customerId?: string | null;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const order = orderSchema.parse(event);
  const externalId = String(order.id ?? order.confirmation_number);

  await assertShopifyStoreAcceptsOperationalWrites({
    ...(storeId ? { storeId } : { workspaceId }),
    action: "order_ingestion",
    allowMissing: true,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  const workspace = await prisma.project.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { shopifyStoreId: true, defaultProgramId: true },
  });

  if (!workspace.shopifyStoreId) {
    throw new Error("Shopify store is not connected to the workspace.");
  }
  if (!workspace.defaultProgramId) {
    throw new Error("Shopify settlement requires a default program.");
  }
  if (programId && programId !== workspace.defaultProgramId) {
    throw new Error(
      "Shopify orders can only be attributed to the workspace default program.",
    );
  }

  const effectiveProgramId = workspace.defaultProgramId;
  const program = await prisma.program.findUniqueOrThrow({
    where: { id: effectiveProgramId },
    select: { id: true, accountingCurrency: true, workspaceId: true },
  });

  if (program && program.workspaceId !== workspaceId) {
    throw new Error("Program does not belong to the Shopify workspace.");
  }

  const shopMoney = order.current_subtotal_price_set.shop_money;
  const shopCurrency = normalizeCurrency(shopMoney.currency_code);
  const accountingCurrency = normalizeCurrency(
    program?.accountingCurrency || shopCurrency,
  );

  const store = await prisma.weleticShopifyStore.upsert({
    where: { projectId: workspaceId },
    create: {
      id: createWeleticId("wstore_"),
      projectId: workspaceId,
      programId: effectiveProgramId,
      shopDomain: workspace.shopifyStoreId,
      shopCurrency,
      apiVersion: "2026-07",
    },
    // Existing store identity is owned by install/catalog and compliance
    // lifecycles. A stale order may have read the raw project domain just
    // before shop-redact replaces the store domain with a non-routable value;
    // never let that in-flight order rebind raw domain (or other store config)
    // before the transaction-scoped compliance guard claims the store row.
    update: {},
  });
  const occurredAt = new Date(
    order.processed_at ?? order.created_at ?? Date.now(),
  );

  // Upsert the shared shopper; enroll in loyalty only when explicitly active.
  let shopperId: string | null = null;
  let customerPrivacyTombstoned = false;
  if (order.customer && order.customer.id) {
    const shopperResult = await upsertWeleticShopper({
      storeId: store.id,
      customer: order.customer,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    });
    shopperId = shopperResult?.shopper?.id ?? null;
    customerPrivacyTombstoned = shopperResult?.privacyTombstoned === true;
  }

  const existing = await prisma.weleticCommerceOrder.findUnique({
    where: { storeId_externalId: { storeId: store.id, externalId } },
    include: {
      lines: {
        include: {
          calculations: { where: { entryType: "sale" }, take: 1 },
          refundLines: {
            include: {
              refund: { select: { externalId: true, occurredAt: true } },
            },
          },
        },
      },
    },
  });
  if (
    existing &&
    (existing.programId !== effectiveProgramId ||
      existing.accountingCurrency !== accountingCurrency)
  ) {
    throw new Error(
      "Existing Shopify order accounting does not match the default program.",
    );
  }

  const attributionTransition = resolveOrderAttributionTransition({
    orderExists: Boolean(existing),
    existingPartnerId: existing?.partnerId,
    requestedPartnerId: partnerId,
  });
  if (existing) {
    if (attributionTransition === "conflict") {
      throw new Error(
        `Shopify order ${externalId} is already attributed to a different partner.`,
      );
    }

    if (attributionTransition === "duplicate") {
      if (existing.partnerId && effectiveProgramId) {
        await syncTotalCommissions({
          partnerId: existing.partnerId,
          programId: effectiveProgramId,
        });
      }

      const loyalty = await finalizeOrderLoyalty({
        storeId: store.id,
        order: existing,
        candidateShopperId: shopperId,
        referralFriendEmail:
          order.customer?.email || order.contact_email || order.email,
        customerOrderSequence: existing.customerOrderSequence,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
      });

      return {
        orderId: existing.id,
        accountingNet: existing.accountingNet,
        accountingCurrency: existing.accountingCurrency,
        analyticsRecordedAt: existing.analyticsRecordedAt,
        dubStatsRecordedAt: existing.dubStatsRecordedAt,
        shopperId: loyalty.shopperId,
        loyaltyLedgerEntryId: loyalty.loyaltyLedgerEntry?.id ?? null,
        customerPrivacyTombstoned,
        duplicate: true,
      };
    }
  }

  const fx = existing
    ? null
    : await getAccountingFxQuote({
        base: shopCurrency,
        quote: accountingCurrency,
      });
  const fxSnapshot = fx ? await persistFxQuote(fx) : null;
  const persistedRewardSnapshot = ShopifyOrderRewardSnapshotSchema.safeParse(
    existing?.shopifyRewardSnapshot,
  );
  const orderRewardSnapshot = persistedRewardSnapshot.success
    ? persistedRewardSnapshot.data
    : existing
      ? null
      : await captureShopifyOrderRewardSnapshot({
          programId: effectiveProgramId,
          occurredAt,
        });

  let enrollment: {
    groupId: string | null;
    createdAt: Date;
    saleRewardId: string | null;
    saleReward: SettlementReward | null;
    partnerGroup: {
      id: string;
      saleReward: SettlementReward | null;
    } | null;
  } | null = null;
  let productLink: {
    marketId: string | null;
    countryCode: string | null;
  } | null = null;

  if (effectiveProgramId && partnerId) {
    [enrollment, productLink] = await Promise.all([
      prisma.programEnrollment.findUnique({
        where: {
          partnerId_programId: { partnerId, programId: effectiveProgramId },
        },
        select: {
          groupId: true,
          createdAt: true,
          saleRewardId: true,
          saleReward: { select: settlementRewardSelect },
          partnerGroup: {
            select: {
              id: true,
              saleReward: { select: settlementRewardSelect },
            },
          },
        },
      }),
      linkId
        ? prisma.weleticProductLink.findFirst({
            where: { linkId, programId: effectiveProgramId, partnerId },
            select: { marketId: true, countryCode: true },
          })
        : null,
    ]);
  }

  const reward =
    enrollment?.partnerGroup?.saleReward ?? enrollment?.saleReward ?? null;
  const rewardSnapshotCapturedAt = orderRewardSnapshot
    ? new Date(orderRewardSnapshot.capturedAt)
    : occurredAt;
  const settlementGroupId =
    orderRewardSnapshot && enrollment && effectiveProgramId && partnerId
      ? await resolvePartnerGroupIdAt({
          programId: effectiveProgramId,
          partnerId,
          currentGroupId: enrollment.groupId,
          enrollmentCreatedAt: enrollment.createdAt,
          occurredAt: rewardSnapshotCapturedAt,
        })
      : enrollment?.groupId ?? null;
  const snapshotReward = selectCapturedReward({
    snapshot: orderRewardSnapshot,
    groupId: settlementGroupId,
    partnerId,
  });
  const parsedShopifyConfig = ShopifyEcommerceRewardConfigSchema.safeParse(
    reward?.config,
  );
  const mayUseCurrentReward = !orderRewardSnapshot;
  const settlementShopifyConfig = snapshotReward
    ? snapshotReward.config
    : mayUseCurrentReward && reward && parsedShopifyConfig.success
      ? resolveShopifyRewardConfigAt({
          rawConfig: reward.config,
          occurredAt,
          currentEffectiveAt: reward.updatedAt,
        })
      : null;
  const effectiveRewardId = settlementShopifyConfig
    ? snapshotReward?.rewardId ?? reward?.id ?? null
    : null;

  const ruleSnapshotSelector: Prisma.WeleticCommissionRuleWhereInput =
    orderRewardSnapshot
      ? { id: { in: orderRewardSnapshot.commissionRuleIds } }
      : {};
  const rules = (
    partnerId
      ? await prisma.weleticCommissionRule.findMany({
          where: {
            programId: effectiveProgramId,
            effectiveAt: { lte: occurredAt },
            ...ruleSnapshotSelector,
            NOT: [
              { logicalKey: { startsWith: "shopify-config:" } },
              { logicalKey: { startsWith: "dub-sale-reward:" } },
            ],
            AND: [
              { OR: [{ partnerId: null }, { partnerId }] },
              {
                OR: [{ expiresAt: null }, { expiresAt: { gt: occurredAt } }],
              },
            ],
          },
        })
      : []
  ).filter((rule) => isExplicitShopifyCommissionRuleKey(rule.logicalKey));

  const orderId = existing?.id ?? createWeleticId("worder_");
  const presentmentCurrency = normalizeCurrency(
    order.current_subtotal_price_set.presentment_money?.currency_code ??
      shopCurrency,
  );
  const amount = (
    set: typeof order.current_subtotal_price_set | undefined,
    side: "shop_money" | "presentment_money",
  ) => {
    const money =
      side === "shop_money"
        ? set?.shop_money
        : set?.presentment_money ?? set?.shop_money;
    if (!money) return BigInt(0);
    return decimalToMinorUnits(money.amount, money.currency_code);
  };

  const shopSubtotal = amount(order.current_subtotal_price_set, "shop_money");
  const shopDiscount = amount(order.current_total_discounts_set, "shop_money");
  const shopNet = shopSubtotal;
  const shopTax = amount(order.current_total_tax_set, "shop_money");
  const shopShipping = amount(order.total_shipping_price_set, "shop_money");
  const shopTotal = order.current_total_price_set
    ? amount(order.current_total_price_set, "shop_money")
    : shopNet + shopTax + shopShipping;
  const accountingNet =
    existing?.accountingNet ??
    convertMoney({ amount: shopNet, currency: shopCurrency }, fx!).amount;
  const accountingTotal =
    existing?.accountingTotal ??
    convertMoney({ amount: shopTotal, currency: shopCurrency }, fx!).amount;

  const rawLines = order.line_items.length
    ? order.line_items
    : [
        {
          id: order.id ?? 0,
          product_id: null,
          variant_id: null,
          sku: null,
          title: customerPrivacyTombstoned
            ? "Redacted order line"
            : order.name ?? order.confirmation_number,
          quantity: 1,
          price_set: order.current_subtotal_price_set,
          total_discount_set: undefined,
        },
      ];
  let customerOrderSequence: number | null = null;
  let customerClassification: ShopifyCustomerClassification = "unknown";
  const shopifyCustomerId =
    !customerPrivacyTombstoned && order.customer?.id
      ? `gid://shopify/Customer/${order.customer.id}`
      : null;
  const persistedCustomerSnapshot = retainKnownShopifyCustomerSnapshot({
    sequence: existing?.customerOrderSequence,
    classification: existing?.customerClassification,
  });
  const customerOrderHistory =
    shopifyCustomerId && !persistedCustomerSnapshot
      ? await getShopifyCustomerOrderHistory({
          workspaceId,
          customerId: shopifyCustomerId,
        })
      : null;
  if (shopperId && !customerPrivacyTombstoned) {
    if (persistedCustomerSnapshot) {
      customerOrderSequence = persistedCustomerSnapshot.sequence;
      customerClassification = persistedCustomerSnapshot.classification;
    } else if (customerOrderHistory) {
      customerOrderSequence = Math.max(1, customerOrderHistory.numberOfOrders);
      customerClassification = order.id
        ? classifyLifetimeShopifyCustomerOrder({
            numberOfOrders: customerOrderHistory.numberOfOrders,
            visibleOrderIds: customerOrderHistory.visibleOrderIds,
            currentOrderId: `gid://shopify/Order/${order.id}`,
          })
        : "returning";
    } else {
      const priorOrderCount = await prisma.weleticCommerceOrder.count({
        where: {
          storeId: store.id,
          shopperId,
          ...(existing ? { id: { not: existing.id } } : {}),
        },
      });
      customerOrderSequence = priorOrderCount + 1;
      customerClassification = priorOrderCount === 0 ? "new" : "returning";
    }
  }

  const capturedRewards = orderRewardSnapshot
    ? orderRewardSnapshot.rewards
    : [];
  const factualRewardConfigs = orderRewardSnapshot
    ? capturedRewards
        .map(({ config }) => config)
        .filter(
          (config): config is NonNullable<typeof config> => config !== null,
        )
    : settlementShopifyConfig
      ? [settlementShopifyConfig]
      : [];
  const configuredSegmentIds = [
    ...new Set(
      factualRewardConfigs.flatMap((config) =>
        config.customerSegmentMode === "shopify_segment" &&
        config.shopifySegment
          ? [config.shopifySegment.id]
          : [],
      ),
    ),
  ];
  const persistedSegmentIds = Array.isArray(existing?.customerSegmentIds)
    ? existing.customerSegmentIds.filter(
        (segmentId): segmentId is string => typeof segmentId === "string",
      )
    : [];
  const customerSegmentIds = customerPrivacyTombstoned
    ? []
    : existing && persistedRewardSnapshot.success
      ? persistedSegmentIds
      : shopifyCustomerId && configuredSegmentIds.length > 0
        ? await getShopifyCustomerSegmentIds({
            workspaceId,
            customerId: shopifyCustomerId,
            segmentIds: configuredSegmentIds,
          })
        : [];
  const factualCollectionRuleExternalIds = orderRewardSnapshot
    ? orderRewardSnapshot.collectionRuleExternalIds
    : [];
  const relevantCollectionIds = [
    ...new Set([
      ...factualRewardConfigs.flatMap((config) =>
        config.collectionOverrides.map(({ id }) => id),
      ),
      ...rules
        .map(({ collectionExternalId }) => collectionExternalId)
        .filter((id): id is string => Boolean(id)),
      ...factualCollectionRuleExternalIds,
    ]),
  ];

  const orderLineContext =
    order.id && (!existing || !persistedRewardSnapshot.success)
      ? await getShopifyOrderLineContext({
          workspaceId,
          orderId: order.id,
          relevantCollectionIds,
        })
      : new Map();
  const existingLineMap = new Map(
    existing?.lines.map((line) => [line.externalId, line]) ?? [],
  );
  const subscriptionSeriesKeys = [
    ...new Set(
      rawLines
        .map(
          (line) =>
            orderLineContext.get(String(line.id))?.subscriptionSeriesKey ??
            existingLineMap.get(String(line.id))?.subscriptionSeriesKey,
        )
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const priorSubscriptionOrders = new Map<string, number>();
  if (shopperId && subscriptionSeriesKeys.length > 0) {
    const priorOrders = await prisma.weleticCommerceOrderLine.findMany({
      where: {
        subscriptionSeriesKey: { in: subscriptionSeriesKeys },
        ...(existing ? { orderId: { not: existing.id } } : {}),
        order: { storeId: store.id, shopperId },
      },
      select: { orderId: true, subscriptionSeriesKey: true },
      distinct: ["orderId", "subscriptionSeriesKey"],
    });
    for (const priorOrder of priorOrders) {
      if (!priorOrder.subscriptionSeriesKey) continue;
      priorSubscriptionOrders.set(
        priorOrder.subscriptionSeriesKey,
        (priorSubscriptionOrders.get(priorOrder.subscriptionSeriesKey) ?? 0) +
          1,
      );
    }
  }

  const productExternalIds = rawLines
    .map((line) => shopifyGid("Product", line.product_id))
    .filter((id): id is string => Boolean(id));
  const variantExternalIds = rawLines
    .map((line) => shopifyGid("ProductVariant", line.variant_id))
    .filter((id): id is string => Boolean(id));
  const [products, variants] = await Promise.all([
    prisma.weleticShopifyProduct.findMany({
      where: { storeId: store.id, externalId: { in: productExternalIds } },
      select: {
        id: true,
        externalId: true,
        collectionExternalIds: true,
        tags: true,
      },
    }),
    prisma.weleticShopifyVariant.findMany({
      where: {
        externalId: { in: variantExternalIds },
        product: { storeId: store.id },
      },
      select: { id: true, externalId: true },
    }),
  ]);
  const productMap = new Map(
    products.map((product) => [product.externalId, product]),
  );
  const variantMap = new Map(
    variants.map((variant) => [variant.externalId, variant]),
  );
  const promotionCodes = order.discount_codes.map(({ code }) => code);

  const lines = await Promise.all(
    rawLines.map(async (line) => {
      const product = productMap.get(
        shopifyGid("Product", line.product_id) ?? "",
      );
      const variant = variantMap.get(
        shopifyGid("ProductVariant", line.variant_id) ?? "",
      );
      const shopGross =
        decimalToMinorUnits(
          line.price_set.shop_money.amount,
          line.price_set.shop_money.currency_code,
        ) * BigInt(line.quantity);
      const lineShopDiscount = line.total_discount_set
        ? amount(line.total_discount_set, "shop_money")
        : BigInt(0);
      const lineShopNet = shopGross - lineShopDiscount;
      const existingLine = existingLineMap.get(String(line.id));
      const lineAccountingNet =
        existingLine?.accountingNet ??
        convertMoney({ amount: lineShopNet, currency: shopCurrency }, fx!)
          .amount;
      const liveLineContext = orderLineContext.get(String(line.id));
      const persistedCollectionExternalIds = Array.isArray(
        existingLine?.collectionExternalIds,
      )
        ? existingLine.collectionExternalIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      const collectionExternalIds =
        existingLine && persistedRewardSnapshot.success
          ? persistedCollectionExternalIds
          : liveLineContext
            ? liveLineContext.collectionExternalIds
            : Array.isArray(product?.collectionExternalIds)
              ? product.collectionExternalIds.filter(
                  (id): id is string => typeof id === "string",
                )
              : [];
      const persistedProductTags = Array.isArray(existingLine?.productTags)
        ? existingLine.productTags.filter(
            (tag): tag is string => typeof tag === "string",
          )
        : [];
      const productTags =
        existingLine && persistedRewardSnapshot.success
          ? persistedProductTags
          : liveLineContext
            ? liveLineContext.productTags
            : Array.isArray(product?.tags)
              ? product.tags.filter((t): t is string => typeof t === "string")
              : [];

      const sellingPlanId =
        liveLineContext?.sellingPlanId ?? existingLine?.sellingPlanId ?? null;
      const sellingPlanCategory =
        liveLineContext?.sellingPlanCategory ??
        existingLine?.sellingPlanCategory ??
        null;
      const subscriptionSeriesKey =
        liveLineContext?.subscriptionSeriesKey ??
        existingLine?.subscriptionSeriesKey ??
        null;
      const subscriptionSequence = subscriptionSeriesKey
        ? (priorSubscriptionOrders.get(subscriptionSeriesKey) ?? 0) + 1
        : null;

      let rule: WeleticCommissionRule | null = null;
      let shopifyResolution: ResolvedShopifyCommission | null = null;
      let earnings = BigInt(0);

      if (effectiveProgramId && partnerId) {
        const context = {
          programId: effectiveProgramId,
          partnerId,
          productId: product?.id,
          productExternalId:
            product?.externalId ?? shopifyGid("Product", line.product_id),
          variantId: variant?.id,
          variantExternalId:
            variant?.externalId ??
            shopifyGid("ProductVariant", line.variant_id),
          collectionExternalIds,
          productTags,
          promotionCodes,
          accountingCurrency,
          commissionableAmount: lineAccountingNet,
          orderAmount: accountingNet,
          quantity: line.quantity,
          occurredAt,
        };
        const manualRule = selectCommissionRule(rules, context) ?? null;
        const resolved = settlementShopifyConfig
          ? resolveShopifyEcommerceCommission({
              rawConfig: settlementShopifyConfig,
              accountingCurrency,
              occurredAt,
              productContext: {
                productId: product?.id,
                productExternalId:
                  product?.externalId ?? shopifyGid("Product", line.product_id),
                variantId: variant?.id,
                variantExternalId:
                  variant?.externalId ??
                  shopifyGid("ProductVariant", line.variant_id),
                collectionExternalIds,
              },
              customerContext: {
                classification: customerClassification,
                segmentIds: customerSegmentIds,
              },
              subscriptionContext: {
                sellingPlanId,
                subscriptionSeriesKey,
                sequence: subscriptionSequence,
                cycle:
                  sellingPlanId &&
                  sellingPlanCategory == null &&
                  !subscriptionSeriesKey
                    ? "unknown"
                    : resolveShopifySubscriptionCycle({
                        subscriptionSeriesKey,
                        priorOrderCount:
                          subscriptionSeriesKey && subscriptionSequence
                            ? subscriptionSequence - 1
                            : 0,
                      }),
              },
            })
          : null;

        if (resolved) {
          const configRule = await materializeShopifyCommissionRule({
            programId: effectiveProgramId,
            partnerId,
            accountingCurrency,
            resolved,
          });
          const manualSpecificity = manualRule
            ? commissionScopeSpecificity[manualRule.scope]
            : -1;
          const configWins =
            resolved.subscriptionCycle === "recurring" ||
            !manualRule ||
            resolved.specificity > manualSpecificity;
          rule = configWins ? configRule : manualRule;
          shopifyResolution = configWins ? resolved : null;
        } else {
          rule = manualRule;
        }
        earnings = rule ? calculateCommission({ rule, context }) : BigInt(0);
      }

      return {
        id: existingLine?.id ?? createWeleticId("wline_"),
        externalId: String(line.id),
        productId: product?.id,
        variantId: variant?.id,
        sku: line.sku,
        sellingPlanId,
        sellingPlanCategory,
        subscriptionSeriesKey,
        subscriptionSequence,
        collectionExternalIds,
        productTags,
        title: line.title,
        quantity: line.quantity,
        presentmentGross:
          decimalToMinorUnits(
            line.price_set.presentment_money?.amount ??
              line.price_set.shop_money.amount,
            line.price_set.presentment_money?.currency_code ?? shopCurrency,
          ) * BigInt(line.quantity),
        presentmentDiscount: line.total_discount_set
          ? amount(line.total_discount_set, "presentment_money")
          : BigInt(0),
        shopGross,
        shopDiscount: lineShopDiscount,
        shopNet: lineShopNet,
        accountingNet: lineAccountingNet,
        commissionableAccountingAmount: lineAccountingNet,
        rule,
        shopifyResolution,
        earnings,
      };
    }),
  );

  const fixedOrderLines = new Map<string, (typeof lines)[number][]>();
  for (const line of lines) {
    if (
      line.rule?.ruleType !== "fixed" ||
      line.rule.fixedAmountMode !== "order"
    ) {
      continue;
    }
    fixedOrderLines.set(line.rule.id, [
      ...(fixedOrderLines.get(line.rule.id) ?? []),
      line,
    ]);
  }
  for (const ruleLines of fixedOrderLines.values()) {
    const allocations = allocateCommissionProportionally({
      total: ruleLines[0].earnings,
      amounts: ruleLines.map((line) => line.commissionableAccountingAmount),
    });
    for (const [index, line] of ruleLines.entries()) {
      line.earnings = allocations[index];
    }
  }
  const totalEarnings = lines.reduce(
    (total, line) => total + line.earnings,
    BigInt(0),
  );
  const commissionRewardId = effectiveRewardId
    ? (
        await prisma.reward.findUnique({
          where: { id: effectiveRewardId },
          select: { id: true },
        })
      )?.id ?? null
    : null;

  const result = await prisma.$transaction(
    async (tx) => {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId: store.id,
        action: "order_ingestion",
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
      let attributionClaimed = true;
      let savedOrder;
      if (existing) {
        const claim = await tx.weleticCommerceOrder.updateMany({
          where: { id: existing.id, partnerId: null },
          data: {
            programId: effectiveProgramId || existing.programId,
            partnerId: partnerId || null,
            linkId: linkId || null,
            shopperId: shopperId || existing.shopperId,
            marketId: productLink?.marketId || null,
            marketCountryCode: productLink?.countryCode || null,
            customerOrderSequence,
            customerClassification,
            customerSegmentIds:
              customerSegmentIds.length > 0
                ? customerSegmentIds
                : Prisma.DbNull,
            processedAt: new Date(),
          },
        });
        attributionClaimed = claim.count === 1;
        savedOrder = await tx.weleticCommerceOrder.findUniqueOrThrow({
          where: { id: existing.id },
        });

        if (attributionClaimed) {
          await Promise.all(
            lines.map((line) =>
              tx.weleticCommerceOrderLine.update({
                where: { id: line.id },
                data: {
                  sellingPlanId: line.sellingPlanId,
                  sellingPlanCategory: line.sellingPlanCategory,
                  subscriptionSeriesKey: line.subscriptionSeriesKey,
                  subscriptionSequence: line.subscriptionSequence,
                  collectionExternalIds: line.collectionExternalIds,
                  productTags: line.productTags,
                },
              }),
            ),
          );
        }
      } else {
        const loyaltyPolicyRevisionId =
          await resolveOrderLoyaltyPolicyRevisionId({
            tx,
            storeId: store.id,
            occurredAt,
          });
        savedOrder = await tx.weleticCommerceOrder.create({
          data: {
            id: orderId,
            storeId: store.id,
            programId: effectiveProgramId || store.programId,
            partnerId: partnerId || null,
            linkId: linkId || null,
            shopperId: shopperId || null,
            marketId: productLink?.marketId || null,
            marketCountryCode: productLink?.countryCode || null,
            externalId,
            orderName: customerPrivacyTombstoned ? null : order.name,
            checkoutToken: customerPrivacyTombstoned
              ? null
              : order.checkout_token,
            customerOrderSequence,
            customerClassification,
            customerSegmentIds:
              customerSegmentIds.length > 0
                ? customerSegmentIds
                : Prisma.DbNull,
            loyaltyPolicyRevisionId,
            shopifyRewardSnapshot: orderRewardSnapshot as Prisma.InputJsonValue,
            status: orderStatus(order.financial_status),
            presentmentCurrency,
            presentmentSubtotal: amount(
              order.current_subtotal_price_set,
              "presentment_money",
            ),
            presentmentDiscount: amount(
              order.current_total_discounts_set,
              "presentment_money",
            ),
            presentmentNet: amount(
              order.current_subtotal_price_set,
              "presentment_money",
            ),
            presentmentTax: amount(
              order.current_total_tax_set,
              "presentment_money",
            ),
            presentmentShipping: amount(
              order.total_shipping_price_set,
              "presentment_money",
            ),
            presentmentTotal: order.current_total_price_set
              ? amount(order.current_total_price_set, "presentment_money")
              : amount(order.current_subtotal_price_set, "presentment_money") +
                amount(order.current_total_tax_set, "presentment_money") +
                amount(order.total_shipping_price_set, "presentment_money"),
            shopCurrency,
            shopSubtotal,
            shopDiscount,
            shopNet,
            shopTax,
            shopShipping,
            shopTotal,
            accountingCurrency,
            accountingNet,
            accountingTotal,
            accountingFxRate: fx!.rate,
            fxRateSnapshotId: fxSnapshot!.id,
            occurredAt,
            processedAt: new Date(),
          },
        });

        await tx.weleticCommerceOrderLine.createMany({
          data: lines.map((line) => ({
            id: line.id,
            orderId,
            externalId: line.externalId,
            productId: line.productId,
            variantId: line.variantId,
            sku: line.sku,
            sellingPlanId: line.sellingPlanId,
            sellingPlanCategory: line.sellingPlanCategory,
            subscriptionSeriesKey: line.subscriptionSeriesKey,
            subscriptionSequence: line.subscriptionSequence,
            collectionExternalIds: line.collectionExternalIds,
            productTags: line.productTags,
            title: line.title,
            quantity: line.quantity,
            presentmentGross: line.presentmentGross,
            presentmentDiscount: line.presentmentDiscount,
            presentmentNet: line.presentmentGross - line.presentmentDiscount,
            shopGross: line.shopGross,
            shopDiscount: line.shopDiscount,
            shopNet: line.shopNet,
            accountingNet: line.accountingNet,
            commissionableAccountingAmount: line.commissionableAccountingAmount,
          })),
        });
      }

      let commissionId: string | undefined;
      const shouldRecordCalculations =
        attributionClaimed &&
        effectiveProgramId &&
        partnerId &&
        enrollment &&
        lines.some((line) => line.rule);
      if (shouldRecordCalculations && totalEarnings !== BigInt(0)) {
        commissionId = createId({ prefix: "cm_" });
        await tx.commission.create({
          data: {
            id: commissionId,
            programId: effectiveProgramId,
            partnerId,
            rewardId: commissionRewardId,
            linkId,
            customerId,
            eventId: `weletic:shopify:order:${store.id}:${externalId}`,
            invoiceId: `shopify:${externalId}`,
            description: `Shopify order ${order.name ?? order.confirmation_number}`,
            type: "sale",
            amount: toSafeInt(accountingNet, "Order amount"),
            quantity: rawLines.reduce(
              (total, line) => total + line.quantity,
              0,
            ),
            earnings: toSafeInt(totalEarnings, "Commission earnings"),
            currency: accountingCurrency,
            status: "pending",
            createdAt: occurredAt,
          },
        });
      }

      if (shouldRecordCalculations) {
        await tx.weleticCommissionCalculation.createMany({
          data: lines.flatMap((line) =>
            line.rule
              ? [
                  {
                    id: createWeleticId("wcalc_"),
                    entryType: "sale" as const,
                    orderLineId: line.id,
                    commissionId: commissionId ?? null,
                    ruleId: line.rule.id,
                    sourceKey: `sale:${store.id}:${externalId}:${line.externalId}`,
                    accountingCurrency,
                    commissionableAmount: line.commissionableAccountingAmount,
                    earnings: line.earnings,
                    inputs: {
                      ruleVersion: line.rule.version,
                      ruleType: line.rule.ruleType,
                      basisPoints: line.rule.basisPoints,
                      fixedAmount: line.rule.fixedAmount?.toString() ?? null,
                      fixedAmountMode: line.rule.fixedAmountMode,
                      quantity: line.quantity,
                      promotionCodes,
                      fxRateSnapshotId:
                        existing?.fxRateSnapshotId ?? fxSnapshot?.id ?? null,
                      customerOrderSequence,
                      customerClassification,
                      customerSegmentIds,
                      collectionExternalIds: line.collectionExternalIds,
                      productTags: line.productTags,
                      rewardId: effectiveRewardId,
                      shopifyReward: line.shopifyResolution
                        ? {
                            configHash: line.shopifyResolution.configHash,
                            source: line.shopifyResolution.source,
                            sourceId: line.shopifyResolution.sourceId,
                            matchedSegmentId:
                              line.shopifyResolution.matchedSegmentId,
                            subscriptionCycle:
                              line.shopifyResolution.subscriptionCycle,
                            sellingPlanId: line.shopifyResolution.sellingPlanId,
                            sellingPlanCategory: line.sellingPlanCategory,
                            subscriptionSeriesKey: line.subscriptionSeriesKey,
                          }
                        : null,
                    },
                  },
                ]
              : [],
          ),
        });

        const reversedByOrderLine = new Map<string, bigint>();
        const refundedByOrderLine = new Map<string, bigint>();
        const priorRefunds = new Map<
          string,
          {
            occurredAt: Date;
            lines: Array<{
              refundLineId: string;
              externalId: string;
              orderLineId: string;
              quantity: number;
              accountingAmount: bigint;
              earnings: bigint;
              ruleId: string;
            }>;
          }
        >();
        for (const line of lines) {
          if (!line.rule) continue;
          const existingLine = existingLineMap.get(line.externalId);
          for (const refundLine of existingLine?.refundLines ?? []) {
            const alreadyReversed =
              reversedByOrderLine.get(line.id) ?? BigInt(0);
            const alreadyRefunded =
              refundedByOrderLine.get(line.id) ?? BigInt(0);
            const reversal = calculateRefundReversal({
              originalEarnings: line.earnings,
              originalCommissionableAmount: line.commissionableAccountingAmount,
              refundedAmount: refundLine.accountingAmount,
              alreadyReversed,
              alreadyRefunded,
            });
            reversedByOrderLine.set(line.id, alreadyReversed + reversal);
            refundedByOrderLine.set(
              line.id,
              alreadyRefunded + refundLine.accountingAmount,
            );
            if (reversal === BigInt(0)) continue;

            const priorRefund = priorRefunds.get(
              refundLine.refund.externalId,
            ) ?? {
              occurredAt: refundLine.refund.occurredAt,
              lines: [],
            };
            priorRefund.lines.push({
              refundLineId: refundLine.id,
              externalId: refundLine.externalId,
              orderLineId: line.id,
              quantity: refundLine.quantity,
              accountingAmount: refundLine.accountingAmount,
              earnings: -reversal,
              ruleId: line.rule.id,
            });
            priorRefunds.set(refundLine.refund.externalId, priorRefund);
          }
        }

        for (const [refundExternalId, priorRefund] of priorRefunds) {
          const reversalEarnings = priorRefund.lines.reduce(
            (total, line) => total + line.earnings,
            BigInt(0),
          );
          const reversalCommissionId = createId({ prefix: "cm_" });
          await tx.commission.create({
            data: {
              id: reversalCommissionId,
              programId: effectiveProgramId,
              partnerId,
              linkId,
              customerId,
              eventId: `weletic:shopify:refund:${store.id}:${refundExternalId}`,
              description: `Refund for Shopify order ${order.name ?? externalId}`,
              type: "custom",
              amount: 0,
              quantity: priorRefund.lines.reduce(
                (total, line) => total + line.quantity,
                0,
              ),
              earnings: toSafeInt(reversalEarnings, "Refund reversal"),
              currency: accountingCurrency,
              status: "pending",
              sourceCommissionId: commissionId,
              createdAt: occurredAt,
            },
          });
          await tx.weleticCommissionCalculation.createMany({
            data: priorRefund.lines.map((line) => ({
              id: createWeleticId("wcalc_"),
              entryType: "reversal" as const,
              refundLineId: line.refundLineId,
              commissionId: reversalCommissionId,
              ruleId: line.ruleId,
              sourceKey: `refund:${store.id}:${refundExternalId}:${line.externalId}`,
              accountingCurrency,
              commissionableAmount: -line.accountingAmount,
              earnings: line.earnings,
              inputs: {
                orderId,
                orderLineId: line.orderLineId,
                refundExternalId,
                attachedAfterRefundAt: priorRefund.occurredAt.toISOString(),
                fxRateSnapshotId: existing?.fxRateSnapshotId ?? null,
              },
            })),
          });
        }
      }

      if (!attributionClaimed) {
        const concurrentCommission = await tx.commission.findUnique({
          where: {
            eventId: `weletic:shopify:order:${store.id}:${externalId}`,
          },
          select: { id: true },
        });
        commissionId = concurrentCommission?.id;
      }

      return { savedOrder, commissionId, attributionClaimed };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );

  if (result.commissionId && effectiveProgramId && partnerId) {
    await syncTotalCommissions({ partnerId, programId: effectiveProgramId });
  }

  if (shopperId && customerOrderSequence) {
    await prisma.weleticShopper.updateMany({
      where: { id: shopperId, ordersCount: { lt: customerOrderSequence } },
      data: {
        ordersCount: customerOrderSequence,
        ...(customerSegmentIds.length > 0
          ? { segmentIds: customerSegmentIds }
          : {}),
      },
    });
  }

  const loyalty = await finalizeOrderLoyalty({
    storeId: store.id,
    order: result.savedOrder,
    candidateShopperId: shopperId,
    referralFriendEmail:
      order.customer?.email || order.contact_email || order.email,
    customerOrderSequence,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  return {
    orderId: result.savedOrder.id,
    accountingNet,
    accountingCurrency,
    commissionId: result.commissionId,
    shopperId: loyalty.shopperId,
    loyaltyLedgerEntryId: loyalty.loyaltyLedgerEntry?.id ?? null,
    customerPrivacyTombstoned,
    analyticsRecordedAt: result.savedOrder.analyticsRecordedAt,
    dubStatsRecordedAt: result.savedOrder.dubStatsRecordedAt,
    duplicate: !result.attributionClaimed,
  };
}
