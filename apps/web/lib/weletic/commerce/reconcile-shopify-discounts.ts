import { linkCache } from "@/lib/api/links/cache";
import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import { getWeleticShopifyInstallation } from "@/lib/weletic/shopify/get-installation";
import { withShopifyStoreOperationalWriteFence } from "@/lib/weletic/shopify/store-compliance-state";
import { DiscountProvider } from "@prisma/client";

export const DISCOUNT_RECONCILIATION_QUERY = `#graphql
  query WeleticDiscountReconciliation($first: Int!, $after: String) {
    codeDiscountNodes(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            status
            codes(first: 250) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                code
                asyncUsageCount
              }
            }
          }
          ... on DiscountCodeBxgy {
            title
            status
            codes(first: 250) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                code
                asyncUsageCount
              }
            }
          }
          ... on DiscountCodeFreeShipping {
            title
            status
            codes(first: 250) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                code
                asyncUsageCount
              }
            }
          }
          ... on DiscountCodeApp {
            title
            status
            codes(first: 250) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                code
                asyncUsageCount
              }
            }
          }
        }
      }
    }
  }
`;

export const DISCOUNT_REDEEM_CODES_PAGE_QUERY = `#graphql
  query WeleticDiscountRedeemCodesPage($id: ID!, $after: String) {
    codeDiscountNode(id: $id) {
      codeDiscount {
        ... on DiscountCodeBasic {
          codes(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id code asyncUsageCount }
          }
        }
        ... on DiscountCodeBxgy {
          codes(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id code asyncUsageCount }
          }
        }
        ... on DiscountCodeFreeShipping {
          codes(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id code asyncUsageCount }
          }
        }
        ... on DiscountCodeApp {
          codes(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id code asyncUsageCount }
          }
        }
      }
    }
  }
`;

type ShopifyDiscountStatus = "ACTIVE" | "EXPIRED" | "SCHEDULED";

const SHOPIFY_DISCOUNT_STATUSES = new Set<ShopifyDiscountStatus>([
  "ACTIVE",
  "EXPIRED",
  "SCHEDULED",
]);

interface ShopifyCodeInfo {
  code: string;
  codeUpper: string;
  nodeId: string;
  redeemCodeId: string;
  status: ShopifyDiscountStatus;
}

export type DiscountReconciliationIssueKind =
  | "discount_missing_in_shopify"
  | "discount_orphaned_in_shopify"
  | "discount_status_desync";

export type DiscountDriftState =
  | "in_sync"
  | "orphaned_in_weletic"
  | "orphaned_in_shopify"
  | "status_desync_shopify_active"
  | "status_desync_shopify_inactive";

export interface ReconciliationIssueItem {
  id?: string;
  code: string;
  kind: DiscountReconciliationIssueKind;
  severity: "critical" | "warning";
  driftState: DiscountDriftState;
  healed: boolean;
  healingAction?: string;
  details: Record<string, unknown>;
}

export interface ReconcileShopifyDiscountsResult {
  scannedCount: number;
  checked: number;
  openCount: number;
  open: number;
  resolvedCount: number;
  resolved: number;
  healedCount: number;
  manualCleanupCount: number;
  issues: ReconciliationIssueItem[];
  driftStates: {
    inSync: number;
    orphanedInWeletic: number;
    orphanedInShopify: number;
    statusDesyncShopifyActive: number;
    statusDesyncShopifyInactive: number;
  };
}

async function performWeleticShopifyDiscountReconciliation({
  workspaceId,
  storeId,
  autoHeal = false,
  limit = 250,
}: {
  workspaceId: string;
  storeId?: string;
  autoHeal?: boolean;
  limit?: number;
}): Promise<ReconcileShopifyDiscountsResult> {
  const store = await prisma.weleticShopifyStore.findFirst({
    where: {
      projectId: workspaceId,
      ...(storeId ? { id: storeId } : {}),
    },
  });

  if (!store) {
    throw new Error(
      `WeleticShopifyStore not found for workspaceId: ${workspaceId}${storeId ? ` / storeId: ${storeId}` : ""}`,
    );
  }
  const reconciliationCurrencyGeneration = store.currencyVerifiedAt;
  const reconciliationInstallationGeneration =
    store.installationGeneration ?? null;

  // Snapshot every eligible local code before the first Shopify request. A
  // code created or reactivated while the remote scan is in flight is outside
  // this run and must never be disabled from this older observation.
  const dbDiscountCodes = await prisma.discountCode.findMany({
    where: {
      program: {
        workspaceId: store.projectId,
      },
      discount: {
        provider: DiscountProvider.shopify,
      },
    },
    include: {
      discount: true,
      partner: true,
      link: true,
    },
  });

  let shopDomain = store.shopDomain;
  let accessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "";

  try {
    const installation = await getWeleticShopifyInstallation(store.projectId);
    shopDomain = installation.shopDomain;
    accessToken = installation.accessToken;
  } catch (error) {
    if (!accessToken) {
      console.warn(
        `[Discount Reconciliation] Could not load installation for workspace ${store.projectId}:`,
        error,
      );
    }
  }

  // 1. Query Shopify Admin GraphQL codeDiscountNodes with cursor pagination
  const shopifyCodesMap = new Map<string, ShopifyCodeInfo>();
  const shopifyCodesByIdentity = new Map<string, ShopifyCodeInfo>();
  let hasNextPage = true;
  let cursor: string | null = null;
  const seenDiscountPageCursors = new Set<string>();

  while (hasNextPage) {
    const batchSize = Math.min(limit, 250);
    const data: {
      codeDiscountNodes?: {
        pageInfo?: {
          hasNextPage?: boolean;
          endCursor?: string | null;
        };
        nodes?: Array<{
          id: string;
          codeDiscount?: {
            title?: string;
            status?: string;
            codes?: {
              pageInfo?: {
                hasNextPage?: boolean;
                endCursor?: string | null;
              };
              nodes?: Array<{
                id?: string;
                code?: string;
                asyncUsageCount?: number;
              }>;
            };
          } | null;
        }>;
      };
    } = await shopifyAdminGraphql({
      shopifyStoreId: shopDomain,
      accessToken,
      query: DISCOUNT_RECONCILIATION_QUERY,
      variables: {
        first: batchSize,
        after: cursor,
      },
    });

    const topLevelConnection = data?.codeDiscountNodes;
    if (!topLevelConnection?.pageInfo) {
      throw new Error(
        "Incomplete Shopify discount-code scan: top-level pageInfo unavailable.",
      );
    }
    if (typeof topLevelConnection.pageInfo.hasNextPage !== "boolean") {
      throw new Error(
        "Incomplete Shopify discount-code scan: top-level hasNextPage unavailable.",
      );
    }
    if (!Array.isArray(topLevelConnection.nodes)) {
      throw new Error(
        "Incomplete Shopify discount-code scan: top-level nodes unavailable.",
      );
    }
    const nodes = topLevelConnection.nodes;
    if (cursor !== null && nodes.length === 0) {
      throw new Error(
        "Incomplete Shopify discount-code scan: empty top-level continuation page.",
      );
    }
    for (const node of nodes) {
      if (
        !node ||
        typeof node.id !== "string" ||
        node.id.length === 0 ||
        !node.codeDiscount
      ) {
        throw new Error(
          "Incomplete Shopify discount-code scan: malformed top-level discount node.",
        );
      }
      if (
        typeof node.codeDiscount.status !== "string" ||
        node.codeDiscount.status.trim().length === 0
      ) {
        throw new Error(
          `Incomplete Shopify discount-code scan for node ${node.id}: status unavailable.`,
        );
      }

      const status = node.codeDiscount.status.trim();
      if (
        status !== node.codeDiscount.status ||
        !SHOPIFY_DISCOUNT_STATUSES.has(status as ShopifyDiscountStatus)
      ) {
        throw new Error(
          `Incomplete Shopify discount-code scan for node ${node.id}: unsupported status '${node.codeDiscount.status}'.`,
        );
      }
      const initialCodesConnection = node.codeDiscount.codes;
      if (!initialCodesConnection?.pageInfo) {
        throw new Error(
          `Incomplete Shopify discount-code scan for node ${node.id}: nested pageInfo unavailable.`,
        );
      }
      if (typeof initialCodesConnection.pageInfo.hasNextPage !== "boolean") {
        throw new Error(
          `Incomplete Shopify discount-code scan for node ${node.id}: nested hasNextPage unavailable.`,
        );
      }
      if (!Array.isArray(initialCodesConnection.nodes)) {
        throw new Error(
          `Incomplete Shopify discount-code scan for node ${node.id}: nested nodes unavailable.`,
        );
      }
      if (
        initialCodesConnection.nodes.some(
          (code) =>
            !code ||
            typeof code.id !== "string" ||
            code.id.length === 0 ||
            typeof code.code !== "string" ||
            code.code.length === 0,
        )
      ) {
        throw new Error(
          `Incomplete Shopify discount-code scan for node ${node.id}: redeem-code identity unavailable.`,
        );
      }
      const codeNodes = [
        ...(initialCodesConnection.nodes as Array<{
          id: string;
          code: string;
          asyncUsageCount?: number;
        }>),
      ];
      let hasMoreCodes = initialCodesConnection.pageInfo.hasNextPage;
      let codeCursor = initialCodesConnection.pageInfo.endCursor ?? null;
      const seenCodeCursors = new Set<string>();

      while (hasMoreCodes) {
        if (!codeCursor || seenCodeCursors.has(codeCursor)) {
          throw new Error(
            `Incomplete Shopify discount-code scan for node ${node.id}: invalid nested cursor.`,
          );
        }
        seenCodeCursors.add(codeCursor);

        const codePage = await shopifyAdminGraphql<{
          codeDiscountNode?: {
            codeDiscount?: {
              codes?: {
                pageInfo?: {
                  hasNextPage?: boolean;
                  endCursor?: string | null;
                };
                nodes?: Array<{
                  id?: string;
                  code?: string;
                  asyncUsageCount?: number;
                }>;
              };
            } | null;
          } | null;
        }>({
          shopifyStoreId: shopDomain,
          accessToken,
          query: DISCOUNT_REDEEM_CODES_PAGE_QUERY,
          variables: { id: node.id, after: codeCursor },
        });
        const connection = codePage?.codeDiscountNode?.codeDiscount?.codes;
        if (!connection?.pageInfo) {
          throw new Error(
            `Incomplete Shopify discount-code scan for node ${node.id}: nested pageInfo unavailable.`,
          );
        }
        if (typeof connection.pageInfo.hasNextPage !== "boolean") {
          throw new Error(
            `Incomplete Shopify discount-code scan for node ${node.id}: nested hasNextPage unavailable.`,
          );
        }
        if (!Array.isArray(connection.nodes)) {
          throw new Error(
            `Incomplete Shopify discount-code scan for node ${node.id}: nested nodes unavailable.`,
          );
        }
        if (connection.nodes.length === 0) {
          throw new Error(
            `Incomplete Shopify discount-code scan for node ${node.id}: empty nested continuation page.`,
          );
        }
        if (
          connection.nodes.some(
            (code) =>
              !code ||
              typeof code.id !== "string" ||
              code.id.length === 0 ||
              typeof code.code !== "string" ||
              code.code.length === 0,
          )
        ) {
          throw new Error(
            `Incomplete Shopify discount-code scan for node ${node.id}: redeem-code identity unavailable.`,
          );
        }

        codeNodes.push(
          ...(connection.nodes as Array<{
            id: string;
            code: string;
            asyncUsageCount?: number;
          }>),
        );
        hasMoreCodes = connection.pageInfo.hasNextPage;
        codeCursor = connection.pageInfo.endCursor ?? null;
      }

      for (const codeNode of codeNodes) {
        const codeUpper = codeNode.code.toUpperCase();
        const codeInfo: ShopifyCodeInfo = {
          code: codeNode.code,
          codeUpper,
          nodeId: node.id,
          redeemCodeId: codeNode.id,
          status: status as ShopifyDiscountStatus,
        };
        shopifyCodesMap.set(codeUpper, codeInfo);
        shopifyCodesByIdentity.set(`${node.id}\u0000${codeNode.id}`, codeInfo);
      }
    }

    hasNextPage = topLevelConnection.pageInfo.hasNextPage;
    cursor = topLevelConnection.pageInfo.endCursor ?? null;

    if (hasNextPage) {
      if (
        !cursor ||
        nodes.length === 0 ||
        seenDiscountPageCursors.has(cursor)
      ) {
        throw new Error(
          "Incomplete Shopify discount-code scan: invalid top-level cursor.",
        );
      }
      seenDiscountPageCursors.add(cursor);
    }
  }

  const dbCodesMap = new Map<string, (typeof dbDiscountCodes)[0]>();
  const dbCodesById = new Map<string, (typeof dbDiscountCodes)[0]>();
  for (const dbCode of dbDiscountCodes) {
    dbCodesMap.set(dbCode.code.toUpperCase(), dbCode);
    dbCodesById.set(dbCode.id, dbCode);
  }

  // Tracking counters
  const driftStates = {
    inSync: 0,
    orphanedInWeletic: 0,
    orphanedInShopify: 0,
    statusDesyncShopifyActive: 0,
    statusDesyncShopifyInactive: 0,
  };

  let openCount = 0;
  let resolvedCount = 0;
  let healedCount = 0;
  let manualCleanupCount = 0;
  const issues: ReconciliationIssueItem[] = [];

  // Issue DB helpers
  const recordOpenIssue = async ({
    externalKey,
    kind,
    severity,
    driftState,
    details,
  }: {
    externalKey: string;
    kind: DiscountReconciliationIssueKind;
    severity: "critical" | "warning";
    driftState: DiscountDriftState;
    details: Record<string, unknown>;
  }): Promise<ReconciliationIssueItem> => {
    const issueRecord = await withShopifyStoreOperationalWriteFence({
      storeId: store.id,
      action: "shopify_discount_reconciliation_issue_open",
      expectedCurrencyGeneration: reconciliationCurrencyGeneration,
      expectedInstallationGeneration: reconciliationInstallationGeneration,
      operation: (tx) =>
        tx.weleticReconciliationIssue.upsert({
          where: {
            storeId_kind_externalKey: {
              storeId: store.id,
              kind,
              externalKey,
            },
          },
          create: {
            id: createWeleticId("wrecon_"),
            storeId: store.id,
            externalKey,
            kind,
            severity,
            details: details as any,
            status: "open",
            detectedAt: new Date(),
          },
          update: {
            severity,
            details: details as any,
            status: "open",
            detectedAt: new Date(),
            resolvedAt: null,
          },
        }),
    });

    openCount += 1;
    return {
      id: issueRecord.id,
      code: externalKey,
      kind,
      severity,
      driftState,
      healed: false,
      details,
    };
  };

  const resolveDbIssue = async (
    externalKey: string,
    kind: DiscountReconciliationIssueKind,
  ) => {
    const result = await withShopifyStoreOperationalWriteFence({
      storeId: store.id,
      action: "shopify_discount_reconciliation_issue_resolve",
      expectedCurrencyGeneration: reconciliationCurrencyGeneration,
      expectedInstallationGeneration: reconciliationInstallationGeneration,
      operation: (tx) =>
        tx.weleticReconciliationIssue.updateMany({
          where: {
            storeId: store.id,
            externalKey,
            kind,
            status: "open",
          },
          data: {
            status: "resolved",
            resolvedAt: new Date(),
          },
        }),
    });
    resolvedCount += result.count;
  };

  const markIssueAsHealed = async ({
    issueItem,
    healingAction,
  }: {
    issueItem: ReconciliationIssueItem;
    healingAction: string;
  }) => {
    await withShopifyStoreOperationalWriteFence({
      storeId: store.id,
      action: "shopify_discount_reconciliation_issue_heal",
      expectedCurrencyGeneration: reconciliationCurrencyGeneration,
      expectedInstallationGeneration: reconciliationInstallationGeneration,
      operation: (tx) =>
        tx.weleticReconciliationIssue.updateMany({
          where: {
            storeId: store.id,
            externalKey: issueItem.code,
            kind: issueItem.kind,
          },
          data: {
            status: "resolved",
            resolvedAt: new Date(),
          },
        }),
    });

    issueItem.healed = true;
    issueItem.healingAction = healingAction;
    healedCount += 1;
    resolvedCount += 1;
    if (openCount > 0) openCount -= 1;
  };

  // 3. Process DB Discount Codes
  for (const dbCode of dbDiscountCodes) {
    const codeUpper = dbCode.code.toUpperCase();
    const shopifyCode = shopifyCodesMap.get(codeUpper);
    const isDbActive = dbCode.disabledAt === null;

    if (isDbActive) {
      if (!shopifyCode) {
        // STATE 2: Orphaned in Weletic (Active in DB, Missing in Shopify)
        driftStates.orphanedInWeletic += 1;
        const details = {
          code: dbCode.code,
          dbStatus: "active",
          shopifyStatus: "missing",
          partnerId: dbCode.partnerId,
          linkId: dbCode.linkId,
          discountId: dbCode.discountId,
          programId: dbCode.programId,
          hasParentCoupon: Boolean(dbCode.discount?.couponId),
        };

        const issue = await recordOpenIssue({
          externalKey: dbCode.code,
          kind: "discount_missing_in_shopify",
          severity: "critical",
          driftState: "orphaned_in_weletic",
          details,
        });
        issues.push(issue);

        if (autoHeal) {
          // Shopify is the authoritative source of truth for active customer discounts.
          // If code was deleted on Shopify, soft-delete locally in DB and purge link cache.
          const disabled = await withShopifyStoreOperationalWriteFence({
            storeId: store.id,
            action: "shopify_discount_reconciliation_local_disable",
            expectedCurrencyGeneration: reconciliationCurrencyGeneration,
            expectedInstallationGeneration:
              reconciliationInstallationGeneration,
            operation: (tx) =>
              tx.discountCode.updateMany({
                where: {
                  id: dbCode.id,
                  code: dbCode.code,
                  disabledAt: null,
                  updatedAt: dbCode.updatedAt,
                },
                data: { disabledAt: new Date() },
              }),
          });

          if (disabled.count === 1 && dbCode.link) {
            await linkCache.delete({
              domain: dbCode.link.domain,
              key: dbCode.link.key,
            });
          }

          if (disabled.count === 1) {
            await markIssueAsHealed({
              issueItem: issue,
              healingAction: "disabled_in_db_missing_in_shopify",
            });
          }
        }
      } else if (shopifyCode.status === "ACTIVE") {
        // STATE 1: In-Sync (Active in DB, Active in Shopify)
        driftStates.inSync += 1;
        await resolveDbIssue(dbCode.code, "discount_missing_in_shopify");
      } else {
        // STATE 5: Status Desync (Active in DB, Inactive/Expired in Shopify)
        driftStates.statusDesyncShopifyInactive += 1;
        const details = {
          code: dbCode.code,
          dbStatus: "active",
          shopifyStatus: shopifyCode.status,
          partnerId: dbCode.partnerId,
          linkId: dbCode.linkId,
          shopifyNodeId: shopifyCode.nodeId,
        };

        const issue = await recordOpenIssue({
          externalKey: dbCode.code,
          kind: "discount_status_desync",
          severity: "warning",
          driftState: "status_desync_shopify_inactive",
          details,
        });
        issues.push(issue);

        if (autoHeal) {
          const disabled = await withShopifyStoreOperationalWriteFence({
            storeId: store.id,
            action: "shopify_discount_reconciliation_local_disable",
            expectedCurrencyGeneration: reconciliationCurrencyGeneration,
            expectedInstallationGeneration:
              reconciliationInstallationGeneration,
            operation: (tx) =>
              tx.discountCode.updateMany({
                where: {
                  id: dbCode.id,
                  code: dbCode.code,
                  disabledAt: null,
                  updatedAt: dbCode.updatedAt,
                },
                data: { disabledAt: new Date() },
              }),
          });
          if (disabled.count === 1) {
            await markIssueAsHealed({
              issueItem: issue,
              healingAction: "disabled_in_db_expired_in_shopify",
            });
          }
        }
      }
    } else {
      // DB is disabled (`disabledAt !== null`)
      if (shopifyCode && shopifyCode.status === "ACTIVE") {
        // STATE 4: Status Desync (Active in Shopify, Disabled in DB)
        driftStates.statusDesyncShopifyActive += 1;
        const details = {
          code: dbCode.code,
          dbStatus: "disabled",
          shopifyStatus: "ACTIVE",
          disabledAt: dbCode.disabledAt?.toISOString(),
          partnerId: dbCode.partnerId,
          shopifyNodeId: shopifyCode.nodeId,
          requiresManualCleanup: true,
          cleanupMode: "manual_verified_shopify_cleanup",
          recommendedAction:
            "Verify the local DiscountCode ownership and current Shopify node, then manually deactivate or delete the exact Shopify code.",
          ownershipEvidence: {
            source: "discount_code_row",
            discountCodeId: dbCode.id,
            discountId: dbCode.discountId,
            programId: dbCode.programId,
            provider: dbCode.discount?.provider,
            shopifyNodeId: shopifyCode.nodeId,
            shopifyRedeemCodeId: shopifyCode.redeemCodeId,
          },
        };

        const issue = await recordOpenIssue({
          externalKey: dbCode.code,
          kind: "discount_status_desync",
          severity: "warning",
          driftState: "status_desync_shopify_active",
          details,
        });
        issues.push(issue);
        manualCleanupCount += 1;
      } else {
        // In-sync: disabled in DB and missing or inactive in Shopify
        await resolveDbIssue(dbCode.code, "discount_missing_in_shopify");
        driftStates.inSync += 1;
      }
    }
  }

  // Parent membership and titles do not prove that an unmatched sibling was
  // created by Weletic. Only a previously persisted issue with exact ownership
  // evidence may carry that classification after its local row disappears.
  const persistedManualIssues =
    await prisma.weleticReconciliationIssue.findMany({
      where: {
        storeId: store.id,
        kind: {
          in: ["discount_orphaned_in_shopify", "discount_status_desync"],
        },
        status: "open",
      },
      select: {
        id: true,
        externalKey: true,
        kind: true,
        severity: true,
        details: true,
      },
    });

  const resolvePersistedManualIssue = async (issueId: string) => {
    const resolved = await withShopifyStoreOperationalWriteFence({
      storeId: store.id,
      action: "shopify_discount_reconciliation_manual_cleanup_confirmed",
      expectedCurrencyGeneration: reconciliationCurrencyGeneration,
      expectedInstallationGeneration: reconciliationInstallationGeneration,
      operation: (tx) =>
        tx.weleticReconciliationIssue.updateMany({
          where: {
            id: issueId,
            storeId: store.id,
            status: "open",
          },
          data: {
            status: "resolved",
            resolvedAt: new Date(),
          },
        }),
    });
    resolvedCount += resolved.count;
  };

  for (const persistedIssue of persistedManualIssues) {
    const details = persistedIssue.details;
    const ownershipEvidence =
      details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>).ownershipEvidence
        : null;
    const ownershipRecord =
      ownershipEvidence !== null &&
      typeof ownershipEvidence === "object" &&
      !Array.isArray(ownershipEvidence)
        ? (ownershipEvidence as Record<string, unknown>)
        : null;
    // A shared Shopify parent only proves container membership; a merchant can
    // add unrelated siblings to that same parent. Carry an orphan forward only
    // when the durable issue captured the exact Weletic DiscountCode row.
    const hasPersistedOwnershipEvidence =
      ownershipRecord?.source === "discount_code_row" &&
      typeof ownershipRecord.discountCodeId === "string" &&
      ownershipRecord.discountCodeId.length > 0 &&
      typeof ownershipRecord.discountId === "string" &&
      ownershipRecord.discountId.length > 0 &&
      ownershipRecord.programId === store.programId &&
      ownershipRecord.provider === DiscountProvider.shopify &&
      typeof ownershipRecord.shopifyNodeId === "string" &&
      ownershipRecord.shopifyNodeId.length > 0 &&
      typeof ownershipRecord.shopifyRedeemCodeId === "string" &&
      ownershipRecord.shopifyRedeemCodeId.length > 0;
    const persistedKind: DiscountReconciliationIssueKind =
      persistedIssue.kind === "discount_status_desync"
        ? "discount_status_desync"
        : "discount_orphaned_in_shopify";
    const persistedDriftState: DiscountDriftState =
      persistedKind === "discount_status_desync"
        ? "status_desync_shopify_active"
        : "orphaned_in_shopify";

    if (hasPersistedOwnershipEvidence) {
      const exactShopifyCode = shopifyCodesByIdentity.get(
        `${String(ownershipRecord.shopifyNodeId)}\u0000${String(ownershipRecord.shopifyRedeemCodeId)}`,
      );
      if (exactShopifyCode?.status === "ACTIVE") {
        const exactLocalAnchor = dbCodesById.get(
          String(ownershipRecord.discountCodeId),
        );
        if (exactLocalAnchor) {
          if (exactLocalAnchor.disabledAt === null) {
            await resolvePersistedManualIssue(persistedIssue.id);
          }
          // A disabled surviving anchor was already emitted as State 4 above.
          continue;
        }

        if (persistedKind === "discount_status_desync") {
          driftStates.statusDesyncShopifyActive += 1;
        } else {
          driftStates.orphanedInShopify += 1;
        }
        openCount += 1;
        manualCleanupCount += 1;
        issues.push({
          id: persistedIssue.id,
          code: persistedIssue.externalKey,
          kind: persistedKind,
          severity:
            persistedIssue.severity === "critical" ? "critical" : "warning",
          driftState: persistedDriftState,
          healed: false,
          details: details as Record<string, unknown>,
        });
        continue;
      }

      // The exact managed remote object is absent/inactive. A merchant-created
      // replacement that reuses the same code text is intentionally unmanaged.
      await resolvePersistedManualIssue(persistedIssue.id);
      continue;
    }

    const codeMatch = shopifyCodesMap.get(
      persistedIssue.externalKey.toUpperCase(),
    );
    if (!codeMatch || codeMatch.status !== "ACTIVE") {
      await resolvePersistedManualIssue(persistedIssue.id);
      continue;
    }

    const verificationDetails = {
      ...(details && typeof details === "object" && !Array.isArray(details)
        ? (details as Record<string, unknown>)
        : {}),
      requiresManualCleanup: false,
      cleanupMode: "ownership_verification_required",
      ownershipVerificationRequired: true,
      recommendedAction:
        "Verify exact Shopify node and redeem-code IDs against a surviving Weletic DiscountCode record before any manual cleanup.",
    };
    await withShopifyStoreOperationalWriteFence({
      storeId: store.id,
      action: "shopify_discount_reconciliation_ownership_quarantine",
      expectedCurrencyGeneration: reconciliationCurrencyGeneration,
      expectedInstallationGeneration: reconciliationInstallationGeneration,
      operation: (tx) =>
        tx.weleticReconciliationIssue.updateMany({
          where: {
            id: persistedIssue.id,
            storeId: store.id,
            status: "open",
          },
          data: {
            details: verificationDetails as any,
            resolvedAt: null,
          },
        }),
    });
    openCount += 1;
    issues.push({
      id: persistedIssue.id,
      code: persistedIssue.externalKey,
      kind: persistedKind,
      severity: persistedIssue.severity === "critical" ? "critical" : "warning",
      driftState: persistedDriftState,
      healed: false,
      details: verificationDetails,
    });
  }

  // Update lastReconciledAt timestamp
  await withShopifyStoreOperationalWriteFence({
    storeId: store.id,
    action: "shopify_discount_reconciliation_complete",
    expectedCurrencyGeneration: reconciliationCurrencyGeneration,
    expectedInstallationGeneration: reconciliationInstallationGeneration,
    operation: (tx) =>
      tx.weleticShopifyStore.update({
        where: { id: store.id },
        data: { lastReconciledAt: new Date() },
      }),
  });

  const totalScanned = dbDiscountCodes.length + shopifyCodesMap.size;

  return {
    scannedCount: totalScanned,
    checked: totalScanned,
    openCount,
    open: openCount,
    resolvedCount,
    resolved: resolvedCount,
    healedCount,
    manualCleanupCount,
    issues,
    driftStates,
  };
}

export async function reconcileWeleticShopifyDiscounts({
  workspaceId,
  storeId,
  autoHeal = false,
  limit = 250,
}: {
  workspaceId: string;
  storeId?: string;
  autoHeal?: boolean;
  limit?: number;
}): Promise<ReconcileShopifyDiscountsResult> {
  const lockKey = `weletic:reconciliation:discounts:${workspaceId}`;
  return await withDistributedLock({
    key: lockKey,
    ttlSeconds: 15 * 60,
    onLocked: () => {
      throw new Error("Shopify discount reconciliation is already running.");
    },
    fn: async () => {
      return await performWeleticShopifyDiscountReconciliation({
        workspaceId,
        storeId,
        autoHeal,
        limit,
      });
    },
  });
}
