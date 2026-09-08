import { createId } from "@/lib/api/create-id";
import { syncTotalCommissions } from "@/lib/api/partners/sync-total-commissions";
import { refundSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { persistFxQuote } from "@/lib/weletic/fx";
import { createWeleticId } from "@/lib/weletic/ids";
import { processRefundPointsReversal } from "@/lib/weletic/loyalty/earn";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import {
  convertMoney,
  decimalToMinorUnits,
  normalizeCurrency,
} from "@/lib/weletic/money";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import {
  SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS,
  shopifyCustomerSettlementLockKeys,
} from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration,
} from "@/lib/weletic/shopify/store-compliance-state";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { Prisma, WeleticLoyaltyReferralStatus } from "@prisma/client";
import {
  assertRecordedShopifyOrder,
  shopifyOrderSettlementLockKey,
} from "./order-attribution";

function divideAndRound(numerator: bigint, denominator: bigint) {
  if (denominator <= BigInt(0)) return BigInt(0);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;
}

export function calculateRefundReversal({
  originalEarnings,
  originalCommissionableAmount,
  refundedAmount,
  alreadyReversed = BigInt(0),
  alreadyRefunded,
}: {
  originalEarnings: bigint;
  originalCommissionableAmount: bigint;
  refundedAmount: bigint;
  alreadyReversed?: bigint;
  alreadyRefunded?: bigint;
}) {
  if (
    originalCommissionableAmount <= BigInt(0) ||
    originalEarnings <= BigInt(0) ||
    refundedAmount <= BigInt(0)
  ) {
    return BigInt(0);
  }
  const safeAlreadyReversed =
    alreadyReversed < BigInt(0) ? BigInt(0) : alreadyReversed;
  const inferredAlreadyRefunded =
    alreadyRefunded ??
    (safeAlreadyReversed * originalCommissionableAmount) / originalEarnings;
  const safeAlreadyRefunded =
    inferredAlreadyRefunded < BigInt(0) ? BigInt(0) : inferredAlreadyRefunded;
  const cumulativeRefunded =
    safeAlreadyRefunded + refundedAmount < originalCommissionableAmount
      ? safeAlreadyRefunded + refundedAmount
      : originalCommissionableAmount;
  const targetTotalReversal = divideAndRound(
    originalEarnings * cumulativeRefunded,
    originalCommissionableAmount,
  );
  const reversal = targetTotalReversal - safeAlreadyReversed;
  return reversal > BigInt(0) ? reversal : BigInt(0);
}

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

async function assertRefundStoreAcceptsWrite({
  storeId,
  action,
  privacyMinimizedFinancialSettlement,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
  tx,
}: {
  storeId: string;
  action: string;
  privacyMinimizedFinancialSettlement: boolean;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}) {
  if (!privacyMinimizedFinancialSettlement) {
    return assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
      tx,
    });
  }

  const financialStore = await assertShopifyStoreMatchesInstallationGeneration({
    storeId,
    action,
    expectedInstallationGeneration,
    tx,
  });
  if (financialStore?.complianceState === "active") {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
      tx,
    });
  }
  return financialStore;
}

export async function recordWeleticRefund(
  input:
    | { event: unknown; workspaceId: string; shopDomain?: never }
    | { event: unknown; shopDomain: string; workspaceId?: never },
  options: {
    privacyMinimizedFinancialSettlement?: boolean;
    expectedInstallationGeneration?: string | null;
    loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  } = {},
) {
  const refundEvent = refundSchema.parse(input.event);
  let workspaceId = input.workspaceId;
  if (!workspaceId && input.shopDomain) {
    const store =
      (await prisma.weleticShopifyStore?.findFirst?.({
        where: { shopDomain: input.shopDomain },
      })) ||
      (await prisma.weleticShopifyStore?.findUnique?.({
        where: { shopDomain: input.shopDomain } as any,
      }));
    if (store?.projectId || store?.id) {
      workspaceId = (store.projectId || store.id) as string;
    } else {
      const resolved = await resolveShopifyStoreByDomain(input.shopDomain);
      if (resolved?.workspaceId) {
        workspaceId = resolved.workspaceId;
      }
    }
  }
  if (!workspaceId) {
    throw new Error(`Shopify store ${input.shopDomain} could not be resolved`);
  }
  return withDistributedLock({
    key: shopifyOrderSettlementLockKey(workspaceId, refundEvent.order_id),
    ttlSeconds: 120,
    fn: () =>
      recordWeleticRefundUnlocked({
        event: refundEvent,
        workspaceId: workspaceId!,
        privacyMinimizedFinancialSettlement:
          options.privacyMinimizedFinancialSettlement === true,
        expectedInstallationGeneration: options.expectedInstallationGeneration,
        loyaltyMaintenancePermit: options.loyaltyMaintenancePermit,
      }),
  });
}

async function withRefundCustomerSettlementLocks<T>({
  storeId,
  orderId,
  shopperId,
  hasAuthoritativeMerchandiseRefund,
  fn,
}: {
  storeId: string;
  orderId: string;
  shopperId: string | null;
  hasAuthoritativeMerchandiseRefund: boolean;
  fn: () => Promise<T>;
}): Promise<T> {
  const referral = hasAuthoritativeMerchandiseRefund
    ? await prisma.weleticLoyaltyReferral.findFirst({
        where: {
          storeId,
          qualifyingOrderId: orderId,
          status: {
            in: [
              WeleticLoyaltyReferralStatus.qualified,
              WeleticLoyaltyReferralStatus.rewarded,
            ],
          },
        },
        select: { advocateAccountId: true, refereeAccountId: true },
      })
    : null;
  const accountIds = [
    referral?.advocateAccountId,
    referral?.refereeAccountId,
  ].filter((id): id is string => Boolean(id));
  if (!shopperId && accountIds.length === 0) return fn();

  const accounts = await prisma.weleticLoyaltyAccount.findMany({
    where: {
      storeId,
      OR: [
        ...(shopperId ? [{ shopperId }] : []),
        ...(accountIds.length > 0 ? [{ id: { in: accountIds } }] : []),
      ],
    },
    select: {
      shopper: { select: { shopifyCustomerId: true } },
      store: { select: { projectId: true } },
    },
  });
  const lockKeys = Array.from(
    new Set(
      accounts.flatMap((account) =>
        shopifyCustomerSettlementLockKeys({
          storeId,
          workspaceId: account.store.projectId,
          shopifyCustomerId: account.shopper.shopifyCustomerId,
        }),
      ),
    ),
  ).sort();

  const runWithLock = (index: number): Promise<T> =>
    index >= lockKeys.length
      ? fn()
      : withDistributedLock({
          key: lockKeys[index],
          ttlSeconds: SHOPIFY_CUSTOMER_SETTLEMENT_LOCK_TTL_SECONDS,
          fn: () => runWithLock(index + 1),
        });

  return runWithLock(0);
}

async function processLoyaltyRefundEffectsUnlocked({
  storeId,
  orderId,
  shopperId,
  refundId,
  hasAuthoritativeMerchandiseRefund,
  isFullOrderRefund,
  privacyMinimizedFinancialSettlement = false,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  orderId: string;
  shopperId: string | null;
  refundId: string;
  hasAuthoritativeMerchandiseRefund: boolean;
  isFullOrderRefund: boolean;
  privacyMinimizedFinancialSettlement?: boolean;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  // A refund without persisted Shopify merchandise lines can represent tax,
  // shipping, an order adjustment, or goodwill. The reconciliation issue is
  // the only safe effect until an authoritative merchandise allocation exists.
  if (!hasAuthoritativeMerchandiseRefund) {
    return null;
  }

  const loyaltyLedgerEntry = await processRefundPointsReversal({
    storeId,
    refundId,
    privacyMinimized: privacyMinimizedFinancialSettlement,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  if (!privacyMinimizedFinancialSettlement) {
    const { cancelIneligibleReviewRequests } = await import(
      "@/lib/weletic/reviews/requests"
    );
    await cancelIneligibleReviewRequests(storeId, orderId, false, {
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    });
  }

  // Smile keeps a completed referral intact for partial refunds and only
  // cancels it when the qualifying order is fully refunded. Order-points
  // accounting above remains proportional for every authoritative refund.
  if (isFullOrderRefund) {
    const { reverseReferralPointsOnRefund } = await import(
      "@/lib/weletic/loyalty/referrals"
    );
    await reverseReferralPointsOnRefund({
      storeId,
      orderId,
      refundId,
      privacyMinimized: privacyMinimizedFinancialSettlement,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    });
    if (!privacyMinimizedFinancialSettlement) {
      const { deactivateCancelledReferralFriendReward } = await import(
        "@/lib/weletic/loyalty/referral-friend-claim"
      );
      await deactivateCancelledReferralFriendReward({ storeId, orderId });
    }
  }

  if (shopperId && !privacyMinimizedFinancialSettlement) {
    const { evaluateAccountTier } = await import("@/lib/weletic/loyalty/tiers");
    const loyaltyAccount = await prisma.weleticLoyaltyAccount.findUnique({
      where: { shopperId },
      select: {
        id: true,
        status: true,
        metadata: true,
        shopper: { select: { shopifyCustomerId: true } },
        store: { select: { projectId: true } },
      },
    });
    if (
      loyaltyAccount?.status === "active" &&
      !hasShopifyCustomerRedactionTombstone(loyaltyAccount.metadata)
    ) {
      const current = await prisma.weleticLoyaltyAccount.findFirst({
        where: { id: loyaltyAccount.id, storeId },
        select: { status: true, metadata: true },
      });
      if (
        current?.status === "active" &&
        !hasShopifyCustomerRedactionTombstone(current.metadata)
      ) {
        await evaluateAccountTier(loyaltyAccount.id, {
          expectedInstallationGeneration,
          loyaltyMaintenancePermit,
        });
      }
    }
  }

  return loyaltyLedgerEntry;
}

async function processLoyaltyRefundEffects(
  input: Parameters<typeof processLoyaltyRefundEffectsUnlocked>[0],
) {
  return withRefundCustomerSettlementLocks({
    ...input,
    fn: () => processLoyaltyRefundEffectsUnlocked(input),
  });
}

type RefundReconciliationDb = Pick<
  typeof prisma,
  | "weleticLoyaltyEarnGrant"
  | "weleticLoyaltyReferral"
  | "weleticReconciliationIssue"
>;

async function ensureUnresolvedLoyaltyRefundIssue({
  db,
  storeId,
  orderId,
  orderExternalId,
  refundId,
  refundExternalId,
}: {
  db: RefundReconciliationDb;
  storeId: string;
  orderId: string;
  orderExternalId: string;
  refundId: string;
  refundExternalId: string;
}) {
  const [grant, referral] = await Promise.all([
    db.weleticLoyaltyEarnGrant.findUnique({
      where: { storeId_orderId: { storeId, orderId } },
      select: { id: true, grossPoints: true, reversedPoints: true },
    }),
    db.weleticLoyaltyReferral.findFirst({
      where: {
        storeId,
        qualifyingOrderId: orderId,
        status: {
          in: [
            WeleticLoyaltyReferralStatus.qualified,
            WeleticLoyaltyReferralStatus.rewarded,
          ],
        },
      },
      select: { id: true, status: true },
    }),
  ]);
  const remainingEarnedPoints = grant
    ? grant.grossPoints - grant.reversedPoints
    : BigInt(0);
  if (remainingEarnedPoints <= BigInt(0) && !referral) return null;

  return db.weleticReconciliationIssue.upsert({
    where: {
      storeId_kind_externalKey: {
        storeId,
        kind: "loyalty_refund_merchandise_amount_unresolved",
        externalKey: refundExternalId,
      },
    },
    create: {
      id: createWeleticId("wrecon_"),
      storeId,
      externalKey: refundExternalId,
      kind: "loyalty_refund_merchandise_amount_unresolved",
      severity: "critical",
      status: "open",
      details: {
        refundId,
        refundExternalId,
        orderId,
        orderExternalId,
        earnGrantId: grant?.id ?? null,
        remainingEarnedPoints: remainingEarnedPoints.toString(),
        referralId: referral?.id ?? null,
        referralStatus: referral?.status ?? null,
        reason:
          "Shopify refund contains no merchandise line items; transaction and adjustment totals may include tax or shipping.",
        resolution:
          "Fetch authoritative merchandise refund lines or resolve by manual review before applying a loyalty clawback.",
      } as Prisma.InputJsonValue,
    },
    update: {
      severity: "critical",
      status: "open",
      detectedAt: new Date(),
      resolvedAt: null,
      details: {
        refundId,
        refundExternalId,
        orderId,
        orderExternalId,
        earnGrantId: grant?.id ?? null,
        remainingEarnedPoints: remainingEarnedPoints.toString(),
        referralId: referral?.id ?? null,
        referralStatus: referral?.status ?? null,
        reason:
          "Shopify refund contains no merchandise line items; transaction and adjustment totals may include tax or shipping.",
        resolution:
          "Fetch authoritative merchandise refund lines or resolve by manual review before applying a loyalty clawback.",
      } as Prisma.InputJsonValue,
    },
  });
}

async function recordWeleticRefundUnlocked({
  event,
  workspaceId,
  privacyMinimizedFinancialSettlement,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
}: {
  event: unknown;
  workspaceId: string;
  privacyMinimizedFinancialSettlement: boolean;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const refundEvent = refundSchema.parse(event);
  const store =
    (await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspaceId },
    })) ||
    (await prisma.weleticShopifyStore.findUnique({
      where: { id: workspaceId } as any,
    })) ||
    (await prisma.weleticShopifyStore.findFirst?.({
      where: { OR: [{ projectId: workspaceId }, { id: workspaceId }] },
    }));
  if (!store)
    throw new Error(`Weletic Shopify store ${workspaceId} was not synced.`);
  await assertRefundStoreAcceptsWrite({
    storeId: store.id,
    action: privacyMinimizedFinancialSettlement
      ? "refund_financial_settlement"
      : "refund_ingestion",
    privacyMinimizedFinancialSettlement,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });
  const externalId = String(refundEvent.id);
  const duplicate = await prisma.weleticCommerceRefund.findUnique({
    where: { storeId_externalId: { storeId: store.id, externalId } },
    include: {
      lines: { select: { id: true }, take: 1 },
      order: {
        select: {
          id: true,
          externalId: true,
          partnerId: true,
          programId: true,
          shopperId: true,
          status: true,
        },
      },
    },
  });
  if (duplicate) {
    const hasPersistedMerchandiseRefund = duplicate.lines.length > 0;
    if (!hasPersistedMerchandiseRefund) {
      await prisma.$transaction(async (tx) => {
        await assertRefundStoreAcceptsWrite({
          storeId: store.id,
          action: "refund_reconciliation_issue",
          privacyMinimizedFinancialSettlement,
          expectedInstallationGeneration,
          loyaltyMaintenancePermit,
          tx,
        });
        return ensureUnresolvedLoyaltyRefundIssue({
          db: tx,
          storeId: store.id,
          orderId: duplicate.order.id,
          orderExternalId: duplicate.order.externalId,
          refundId: duplicate.id,
          refundExternalId: externalId,
        });
      });
    }
    if (duplicate.order.partnerId) {
      await syncTotalCommissions({
        partnerId: duplicate.order.partnerId,
        programId: duplicate.order.programId,
      });
    }
    const loyaltyLedgerEntry = await processLoyaltyRefundEffects({
      storeId: store.id,
      orderId: duplicate.order.id,
      shopperId: duplicate.order.shopperId,
      refundId: duplicate.id,
      hasAuthoritativeMerchandiseRefund: hasPersistedMerchandiseRefund,
      isFullOrderRefund: duplicate.order.status === "refunded",
      privacyMinimizedFinancialSettlement,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    });
    return {
      refundId: duplicate.id,
      loyaltyLedgerEntryId: loyaltyLedgerEntry?.id ?? null,
      duplicate: true,
      ignored: false,
    };
  }

  const order = await prisma.weleticCommerceOrder.findUnique({
    where: {
      storeId_externalId: {
        storeId: store.id,
        externalId: String(refundEvent.order_id),
      },
    },
    include: {
      lines: {
        include: {
          calculations: { where: { entryType: "sale" }, take: 1 },
        },
      },
    },
  });
  assertRecordedShopifyOrder(order, refundEvent.order_id);

  const fx = {
    base: normalizeCurrency(order.shopCurrency),
    quote: normalizeCurrency(order.accountingCurrency),
    rate: order.accountingFxRate.toString(),
    provider: `order-snapshot:${order.fxRateSnapshotId ?? order.id}`,
    capturedAt: new Date(refundEvent.created_at),
  };
  const fxSnapshot = await persistFxQuote(fx);
  const orderLines = new Map(
    order.lines.map((line) => [line.externalId, line]),
  );
  const lines = [] as Array<{
    id: string;
    externalId: string;
    orderLineId: string;
    quantity: number;
    presentmentAmount: bigint;
    shopAmount: bigint;
    accountingAmount: bigint;
    ruleId?: string;
    sourceCommissionId?: string;
    originalEarnings: bigint;
    originalCommissionableAmount: bigint;
    earnings: bigint;
  }>;

  for (const refundLine of refundEvent.refund_line_items) {
    const orderLine = orderLines.get(String(refundLine.line_item_id));
    if (!orderLine) {
      throw new Error(
        `Refund line ${refundLine.id} references unknown order line ${refundLine.line_item_id}.`,
      );
    }
    const shopAmount = decimalToMinorUnits(
      refundLine.subtotal_set.shop_money.amount,
      refundLine.subtotal_set.shop_money.currency_code,
    );
    const accountingAmount = convertMoney(
      { amount: shopAmount, currency: fx.base },
      fx,
    ).amount;
    const saleCalculation = orderLine.calculations[0];
    lines.push({
      id: createWeleticId("wrline_"),
      externalId: String(refundLine.id),
      orderLineId: orderLine.id,
      quantity: refundLine.quantity,
      presentmentAmount: decimalToMinorUnits(
        refundLine.subtotal_set.presentment_money?.amount ??
          refundLine.subtotal_set.shop_money.amount,
        refundLine.subtotal_set.presentment_money?.currency_code ??
          order.presentmentCurrency,
      ),
      shopAmount,
      accountingAmount,
      ruleId: saleCalculation?.ruleId,
      sourceCommissionId: saleCalculation?.commissionId ?? undefined,
      originalEarnings: saleCalculation?.earnings ?? BigInt(0),
      originalCommissionableAmount:
        saleCalculation?.commissionableAmount ?? BigInt(0),
      earnings: BigInt(0),
    });
  }

  const refundId = createWeleticId("wrefund_");
  const accountingAmount = lines.reduce(
    (total, line) => total + line.accountingAmount,
    BigInt(0),
  );
  const shopAmount = lines.reduce(
    (total, line) => total + line.shopAmount,
    BigInt(0),
  );
  const presentmentAmount = lines.reduce(
    (total, line) => total + line.presentmentAmount,
    BigInt(0),
  );
  const result = await prisma.$transaction(
    async (tx) => {
      await assertRefundStoreAcceptsWrite({
        storeId: store.id,
        action: privacyMinimizedFinancialSettlement
          ? "refund_financial_settlement"
          : "refund_ingestion",
        privacyMinimizedFinancialSettlement,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
      const alreadyReversedByOrderLine = new Map<string, bigint>();
      const alreadyRefundedByOrderLine = new Map<string, bigint>();

      for (const line of lines) {
        if (!line.ruleId) continue;

        let reversedAmountSoFar = alreadyReversedByOrderLine.get(
          line.orderLineId,
        );
        let refundedAmountSoFar = alreadyRefundedByOrderLine.get(
          line.orderLineId,
        );
        if (reversedAmountSoFar === undefined) {
          const [reversed, refunded] = await Promise.all([
            tx.weleticCommissionCalculation.aggregate({
              where: {
                entryType: "reversal",
                refundLine: { orderLineId: line.orderLineId },
              },
              _sum: { earnings: true },
            }),
            tx.weleticCommerceRefundLine.aggregate({
              where: { orderLineId: line.orderLineId },
              _sum: { accountingAmount: true },
            }),
          ]);
          reversedAmountSoFar = -(reversed._sum.earnings ?? BigInt(0));
          refundedAmountSoFar = refunded._sum.accountingAmount ?? BigInt(0);
        }

        const reversal = calculateRefundReversal({
          originalEarnings: line.originalEarnings,
          originalCommissionableAmount: line.originalCommissionableAmount,
          refundedAmount: line.accountingAmount,
          alreadyReversed: reversedAmountSoFar,
          alreadyRefunded: refundedAmountSoFar,
        });

        line.earnings = -reversal;
        alreadyReversedByOrderLine.set(
          line.orderLineId,
          reversedAmountSoFar + reversal,
        );
        alreadyRefundedByOrderLine.set(
          line.orderLineId,
          (refundedAmountSoFar ?? BigInt(0)) + line.accountingAmount,
        );
      }
      const totalEarnings = lines.reduce(
        (total, line) => total + line.earnings,
        BigInt(0),
      );

      await tx.weleticCommerceRefund.create({
        data: {
          id: refundId,
          storeId: store.id,
          orderId: order.id,
          externalId,
          presentmentCurrency: order.presentmentCurrency,
          presentmentAmount,
          shopCurrency: order.shopCurrency,
          shopAmount,
          accountingCurrency: order.accountingCurrency,
          accountingAmount,
          accountingFxRate: fx.rate,
          fxRateSnapshotId: fxSnapshot.id,
          occurredAt: new Date(refundEvent.created_at),
          processedAt: new Date(),
        },
      });
      await tx.weleticCommerceRefundLine.createMany({
        data: lines.map((line) => ({
          id: line.id,
          refundId,
          orderLineId: line.orderLineId,
          externalId: line.externalId,
          quantity: line.quantity,
          presentmentAmount: line.presentmentAmount,
          shopAmount: line.shopAmount,
          accountingAmount: line.accountingAmount,
        })),
      });

      if (lines.length === 0) {
        await ensureUnresolvedLoyaltyRefundIssue({
          db: tx,
          storeId: store.id,
          orderId: order.id,
          orderExternalId: order.externalId,
          refundId,
          refundExternalId: externalId,
        });
      }

      let commissionId: string | undefined;
      if (totalEarnings < BigInt(0) && order.partnerId) {
        commissionId = createId({ prefix: "cm_" });
        const sourceCommissionId = lines.find(
          (line) => line.sourceCommissionId,
        )?.sourceCommissionId;
        await tx.commission.create({
          data: {
            id: commissionId,
            programId: order.programId,
            partnerId: order.partnerId,
            linkId: order.linkId,
            eventId: `weletic:shopify:refund:${store.id}:${externalId}`,
            description: `Refund for Shopify order ${order.orderName ?? order.externalId}`,
            type: "custom",
            amount: 0,
            quantity: lines.reduce((total, line) => total + line.quantity, 0),
            earnings: toSafeInt(totalEarnings, "Refund reversal"),
            currency: order.accountingCurrency,
            status: "pending",
            sourceCommissionId,
            // Use the sale occurrence for payout eligibility so a pre-payout
            // clawback matures with its source commission. The refund ledger
            // retains the actual refund occurrence independently.
            createdAt: order.occurredAt,
          },
        });
        await tx.weleticCommissionCalculation.createMany({
          data: lines.flatMap((line) =>
            line.ruleId && line.earnings < BigInt(0)
              ? [
                  {
                    id: createWeleticId("wcalc_"),
                    entryType: "reversal" as const,
                    refundLineId: line.id,
                    commissionId,
                    ruleId: line.ruleId,
                    sourceKey: `refund:${store.id}:${externalId}:${line.externalId}`,
                    accountingCurrency: order.accountingCurrency,
                    commissionableAmount: -line.accountingAmount,
                    earnings: line.earnings,
                    inputs: {
                      orderId: order.id,
                      orderLineId: line.orderLineId,
                      refundId,
                      fxRateSnapshotId: fxSnapshot.id,
                    },
                  },
                ]
              : [],
          ),
        });
      }

      const refunded = await tx.weleticCommerceRefund.aggregate({
        where: { orderId: order.id },
        _sum: { accountingAmount: true },
      });
      const isFullOrderRefund =
        (refunded._sum.accountingAmount ?? BigInt(0)) >= order.accountingNet;
      await tx.weleticCommerceOrder.update({
        where: { id: order.id },
        data: {
          status: isFullOrderRefund ? "refunded" : "partially_refunded",
        },
      });
      return { commissionId, isFullOrderRefund };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    },
  );

  if (result.commissionId && order.partnerId) {
    await syncTotalCommissions({
      partnerId: order.partnerId,
      programId: order.programId,
    });
  }

  // These effects are idempotent and intentionally run after the refund
  // transaction. If one fails, Shopify retries the webhook; the duplicate
  // path above resumes the effects instead of silently losing them.
  const loyaltyLedgerEntry = await processLoyaltyRefundEffects({
    storeId: store.id,
    orderId: order.id,
    shopperId: order.shopperId,
    refundId,
    hasAuthoritativeMerchandiseRefund: lines.length > 0,
    isFullOrderRefund: result.isFullOrderRefund,
    privacyMinimizedFinancialSettlement,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  return {
    refundId,
    commissionId: result.commissionId,
    loyaltyLedgerEntryId: loyaltyLedgerEntry?.id ?? null,
    duplicate: false,
    ignored: false,
  };
}
