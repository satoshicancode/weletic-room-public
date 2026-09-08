import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { createWeleticId } from "@/lib/weletic/ids";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import { getWeleticShopifyInstallation } from "@/lib/weletic/shopify/get-installation";

const ORDER_RECONCILIATION_QUERY = `#graphql
  query WeleticOrderReconciliation($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        updatedAt
        currentSubtotalPriceSet {
          shopMoney { amount currencyCode }
        }
        refunds(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            id
            refundLineItems(first: 250) {
              pageInfo { hasNextPage }
              nodes {
                subtotalSet { shopMoney { amount currencyCode } }
              }
            }
          }
        }
      }
    }
  }
`;

const gid = (externalId: string) => `gid://shopify/Order/${externalId}`;
const numericId = (shopifyGid: string) =>
  shopifyGid.split("/").at(-1) ?? shopifyGid;

async function performWeleticShopifyOrderReconciliation({
  workspaceId,
  limit = 100,
}: {
  workspaceId: string;
  limit?: number;
}) {
  const installation = await getWeleticShopifyInstallation(workspaceId);
  const store = await prisma.weleticShopifyStore.findUniqueOrThrow({
    where: { projectId: workspaceId },
  });
  const orders = await prisma.weleticCommerceOrder.findMany({
    where: { storeId: store.id },
    include: {
      lines: {
        include: {
          calculations: {
            where: { entryType: "sale" },
            select: { earnings: true, commissionableAmount: true },
          },
        },
      },
      refunds: {
        orderBy: { occurredAt: "asc" },
        include: {
          lines: {
            include: {
              calculations: {
                where: { entryType: "reversal" },
                select: { earnings: true },
              },
            },
          },
        },
      },
    },
    orderBy: { occurredAt: "desc" },
    take: Math.min(limit, 250),
  });
  const reconcilable = orders.filter((order) => /^\d+$/.test(order.externalId));
  const remoteById = new Map<
    string,
    {
      id: string;
      currentSubtotalPriceSet: {
        shopMoney: { amount: string; currencyCode: string };
      };
      refunds: {
        pageInfo: { hasNextPage: boolean };
        nodes: Array<{
          id: string;
          refundLineItems: {
            pageInfo: { hasNextPage: boolean };
            nodes: Array<{
              subtotalSet: {
                shopMoney: { amount: string; currencyCode: string };
              };
            }>;
          };
        }>;
      };
    }
  >();

  for (let index = 0; index < reconcilable.length; index += 50) {
    const batch = reconcilable.slice(index, index + 50);
    const data = await shopifyAdminGraphql<{
      nodes: Array<{
        id: string;
        currentSubtotalPriceSet: {
          shopMoney: { amount: string; currencyCode: string };
        };
        refunds: {
          pageInfo: { hasNextPage: boolean };
          nodes: Array<{
            id: string;
            refundLineItems: {
              pageInfo: { hasNextPage: boolean };
              nodes: Array<{
                subtotalSet: {
                  shopMoney: { amount: string; currencyCode: string };
                };
              }>;
            };
          }>;
        };
      } | null>;
    }>({
      shopifyStoreId: installation.shopDomain,
      accessToken: installation.accessToken,
      query: ORDER_RECONCILIATION_QUERY,
      variables: { ids: batch.map((order) => gid(order.externalId)) },
    });
    for (const node of data.nodes) {
      if (node) remoteById.set(numericId(node.id), node);
    }
  }

  let open = 0;
  let resolved = 0;
  const setIssue = async ({
    externalKey,
    kind,
    severity,
    details,
  }: {
    externalKey: string;
    kind: string;
    severity: "warning" | "critical";
    details: Record<string, string | string[]>;
  }) => {
    await prisma.weleticReconciliationIssue.upsert({
      where: {
        storeId_kind_externalKey: { storeId: store.id, kind, externalKey },
      },
      create: {
        id: createWeleticId("wrecon_"),
        storeId: store.id,
        externalKey,
        kind,
        severity,
        details,
      },
      update: {
        severity,
        details,
        status: "open",
        detectedAt: new Date(),
        resolvedAt: null,
      },
    });
    open += 1;
  };
  const resolveIssue = async (externalKey: string, kind: string) => {
    const result = await prisma.weleticReconciliationIssue.updateMany({
      where: { storeId: store.id, externalKey, kind, status: "open" },
      data: { status: "resolved", resolvedAt: new Date() },
    });
    resolved += result.count;
  };

  for (const order of orders) {
    if (!/^\d+$/.test(order.externalId)) {
      await setIssue({
        externalKey: order.externalId,
        kind: "order_identifier_unusable",
        severity: "warning",
        details: { orderId: order.id, externalId: order.externalId },
      });
      continue;
    }
    const remote = remoteById.get(order.externalId);
    if (!remote) {
      await setIssue({
        externalKey: order.externalId,
        kind: "order_missing_in_shopify",
        severity: "critical",
        details: { orderId: order.id },
      });
      continue;
    }
    await resolveIssue(order.externalId, "order_missing_in_shopify");

    const remoteShopNet = decimalToMinorUnits(
      remote.currentSubtotalPriceSet.shopMoney.amount,
      remote.currentSubtotalPriceSet.shopMoney.currencyCode,
    );
    if (remoteShopNet !== order.shopNet) {
      await setIssue({
        externalKey: order.externalId,
        kind: "order_amount_mismatch",
        severity: "critical",
        details: {
          ledgerShopNet: order.shopNet.toString(),
          shopifyShopNet: remoteShopNet.toString(),
          currency: order.shopCurrency,
        },
      });
    } else {
      await resolveIssue(order.externalId, "order_amount_mismatch");
    }

    if (remote.refunds.pageInfo.hasNextPage) {
      await setIssue({
        externalKey: order.externalId,
        kind: "refund_pagination_incomplete",
        severity: "critical",
        details: { orderId: order.id, limit: "100" },
      });
    } else {
      await resolveIssue(order.externalId, "refund_pagination_incomplete");
    }

    const localRefunds = new Map(
      order.refunds.map((refund) => [refund.externalId, refund]),
    );
    const remoteRefundIds = new Set<string>();
    for (const remoteRefund of remote.refunds.nodes) {
      const refundId = numericId(remoteRefund.id);
      remoteRefundIds.add(refundId);
      const localRefund = localRefunds.get(refundId);
      if (!localRefund) {
        await setIssue({
          externalKey: `${order.externalId}:${refundId}`,
          kind: "refund_missing_in_ledger",
          severity: "critical",
          details: { orderId: order.id, shopifyRefundId: refundId },
        });
      } else {
        await resolveIssue(
          `${order.externalId}:${refundId}`,
          "refund_missing_in_ledger",
        );
        if (remoteRefund.refundLineItems.pageInfo.hasNextPage) {
          await setIssue({
            externalKey: `${order.externalId}:${refundId}`,
            kind: "refund_line_pagination_incomplete",
            severity: "critical",
            details: {
              orderId: order.id,
              shopifyRefundId: refundId,
              limit: "250",
            },
          });
          continue;
        }
        await resolveIssue(
          `${order.externalId}:${refundId}`,
          "refund_line_pagination_incomplete",
        );
        const remoteShopAmount = remoteRefund.refundLineItems.nodes.reduce(
          (total, line) =>
            total +
            decimalToMinorUnits(
              line.subtotalSet.shopMoney.amount,
              line.subtotalSet.shopMoney.currencyCode,
            ),
          BigInt(0),
        );
        if (remoteShopAmount !== localRefund.shopAmount) {
          await setIssue({
            externalKey: `${order.externalId}:${refundId}`,
            kind: "refund_amount_mismatch",
            severity: "critical",
            details: {
              orderId: order.id,
              ledgerShopAmount: localRefund.shopAmount.toString(),
              shopifyShopAmount: remoteShopAmount.toString(),
              currency: order.shopCurrency,
            },
          });
        } else {
          await resolveIssue(
            `${order.externalId}:${refundId}`,
            "refund_amount_mismatch",
          );
        }
      }
    }
    for (const localRefund of order.refunds) {
      const externalKey = `${order.externalId}:${localRefund.externalId}`;
      if (!remoteRefundIds.has(localRefund.externalId)) {
        await setIssue({
          externalKey,
          kind: "refund_missing_in_shopify",
          severity: "critical",
          details: {
            orderId: order.id,
            ledgerRefundId: localRefund.externalId,
          },
        });
      } else {
        await resolveIssue(externalKey, "refund_missing_in_shopify");
      }
    }

    const originalEarnings = order.lines.reduce(
      (total, line) =>
        total +
        line.calculations.reduce(
          (lineTotal, calculation) => lineTotal + calculation.earnings,
          BigInt(0),
        ),
      BigInt(0),
    );
    const reversedEarnings = -order.refunds.reduce(
      (total, refund) =>
        total +
        refund.lines.reduce(
          (lineTotal, line) =>
            lineTotal +
            line.calculations.reduce(
              (calculationTotal, calculation) =>
                calculationTotal + calculation.earnings,
              BigInt(0),
            ),
          BigInt(0),
        ),
      BigInt(0),
    );
    const orderLineById = new Map(order.lines.map((line) => [line.id, line]));
    const expectedReversedByLine = new Map<string, bigint>();
    for (const refund of order.refunds) {
      for (const refundLine of refund.lines) {
        const sourceLine = orderLineById.get(refundLine.orderLineId);
        const sourceCalculation = sourceLine?.calculations[0];
        if (!sourceCalculation) continue;
        const alreadyReversed =
          expectedReversedByLine.get(refundLine.orderLineId) ?? BigInt(0);
        const expected = calculateRefundReversal({
          originalEarnings: sourceCalculation.earnings,
          originalCommissionableAmount: sourceCalculation.commissionableAmount,
          refundedAmount: refundLine.accountingAmount,
          alreadyReversed,
        });
        expectedReversedByLine.set(
          refundLine.orderLineId,
          alreadyReversed + expected,
        );
      }
    }
    const expectedReversedEarnings = [
      ...expectedReversedByLine.values(),
    ].reduce((total, earnings) => total + earnings, BigInt(0));
    if (reversedEarnings !== expectedReversedEarnings) {
      await setIssue({
        externalKey: order.externalId,
        kind: "commission_reversal_mismatch",
        severity: "critical",
        details: {
          orderId: order.id,
          expectedReversedEarnings: expectedReversedEarnings.toString(),
          ledgerReversedEarnings: reversedEarnings.toString(),
          currency: order.accountingCurrency,
        },
      });
    } else {
      await resolveIssue(order.externalId, "commission_reversal_mismatch");
    }
    if (reversedEarnings > originalEarnings) {
      await setIssue({
        externalKey: order.externalId,
        kind: "commission_reversal_exceeds_sale",
        severity: "critical",
        details: {
          orderId: order.id,
          originalEarnings: originalEarnings.toString(),
          reversedEarnings: reversedEarnings.toString(),
          currency: order.accountingCurrency,
        },
      });
    } else {
      await resolveIssue(order.externalId, "commission_reversal_exceeds_sale");
    }
  }

  await prisma.weleticShopifyStore.update({
    where: { id: store.id },
    data: { lastReconciledAt: new Date() },
  });
  return { checked: orders.length, open, resolved };
}

export async function reconcileWeleticShopifyOrders({
  workspaceId,
  limit = 100,
}: {
  workspaceId: string;
  limit?: number;
}) {
  const lockKey = `weletic:reconciliation:${workspaceId}`;
  return await withDistributedLock({
    key: lockKey,
    ttlSeconds: 15 * 60,
    onLocked: () => {
      throw new Error("Shopify financial reconciliation is already running.");
    },
    fn: async () => {
      return await performWeleticShopifyOrderReconciliation({
        workspaceId,
        limit,
      });
    },
  });
}
