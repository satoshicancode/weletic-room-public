import { linkCache } from "@/lib/api/links/cache";
import { prisma } from "@/lib/prisma";
import { WorkspaceProps } from "@/lib/types";
import { canonicalizeLoyaltyDiscountCode } from "@/lib/weletic/loyalty/redemption-discount-identity";
import {
  compensateDiscountSaga,
  withLockedLoyaltyAccount,
} from "@/lib/weletic/loyalty/saga";
import {
  isShopifyStoreOperationalWritesBlocked,
  withShopifyStoreOperationalWriteFence,
} from "@/lib/weletic/shopify/store-compliance-state";
import { WeleticRedemptionStatus } from "@prisma/client";

function getCanonicalLoyaltyCandidateCodes(candidateCodes: readonly string[]) {
  const canonicalCodes = new Set<string>();
  for (const code of candidateCodes) {
    if (typeof code !== "string") continue;
    try {
      canonicalCodes.add(canonicalizeLoyaltyDiscountCode(code));
    } catch {
      // Malformed external codes must not broaden a tenant lookup. An exact
      // Shopify GID, when present, remains available as the fallback identity.
    }
  }
  return [...canonicalCodes];
}

export async function discountsDelete({
  event,
  workspace,
  storeId,
  expectedInstallationGeneration,
}: {
  event: any;
  workspace: Pick<WorkspaceProps, "id" | "defaultProgramId">;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
}) {
  const programId = workspace.defaultProgramId;

  // Extract potential candidate code strings & GIDs from event payload
  const candidateCodes: string[] = [];
  if (event?.code) candidateCodes.push(event.code);
  if (Array.isArray(event?.codes)) {
    for (const c of event.codes) {
      if (typeof c === "string") candidateCodes.push(c);
      else if (c?.code) candidateCodes.push(c.code);
    }
  }
  if (event?.title) {
    const match = event.title.match(/Dub Discount \(([^)]+)\)/i);
    if (match?.[1]) candidateCodes.push(match[1]);
    const wlMatch = event.title.match(/\((WL-[^)]+)\)/i);
    if (wlMatch?.[1]) candidateCodes.push(wlMatch[1]);
  }

  const candidateGids = [
    event?.admin_graphql_api_id,
    event?.id ? String(event.id) : null,
    event?.id ? `gid://shopify/DiscountCodeNode/${event.id}` : null,
    event?.id ? `gid://shopify/PriceRule/${event.id}` : null,
    event?.price_rule_id ? String(event.price_rule_id) : null,
    event?.price_rule_id
      ? `gid://shopify/PriceRule/${event.price_rule_id}`
      : null,
  ].filter(Boolean) as string[];
  const candidateCanonicalLoyaltyCodes =
    getCanonicalLoyaltyCandidateCodes(candidateCodes);

  // Also reconcile Weletic Loyalty Reward Redemptions
  if (candidateCanonicalLoyaltyCodes.length > 0 || candidateGids.length > 0) {
    const effectiveStoreId =
      storeId ??
      (
        await prisma.weleticShopifyStore.findUnique({
          where: { projectId: workspace.id },
          select: { id: true },
        })
      )?.id;
    if (effectiveStoreId) {
      const matchingRedemptions = await withShopifyStoreOperationalWriteFence({
        storeId: effectiveStoreId,
        action: "shopify_discount_delete_discovery",
        expectedInstallationGeneration,
        operation: (tx) =>
          tx.weleticRewardRedemption.findMany({
            where: {
              storeId: effectiveStoreId,
              OR: [
                ...(candidateCanonicalLoyaltyCodes.length > 0
                  ? [
                      {
                        shopifyDiscountCodeCanonical: {
                          in: candidateCanonicalLoyaltyCodes,
                        },
                      },
                    ]
                  : []),
                ...(candidateGids.length > 0
                  ? [{ shopifyDiscountId: { in: candidateGids } }]
                  : []),
              ],
              status: {
                in: [
                  WeleticRedemptionStatus.issued,
                  WeleticRedemptionStatus.provisioning,
                  WeleticRedemptionStatus.active,
                ],
              },
            },
          }),
      });

      for (const redemption of matchingRedemptions) {
        assertAccountBackedReward(redemption);
        const compensation = await withLockedLoyaltyAccount({
          storeId: effectiveStoreId,
          accountId: redemption.accountId,
          fn: () =>
            compensateDiscountSaga({
              redemptionId: redemption.id,
              reason: "Discount deleted in Shopify Admin",
              targetStatus: WeleticRedemptionStatus.cancelled,
              expectedInstallationGeneration,
            }),
        });
        if (compensation === null) {
          throw new Error(
            `Cannot compensate redemption ${redemption.id}; owning loyalty account is unavailable.`,
          );
        }
      }
    }
  }

  if (!programId) {
    return "[Shopify] Workspace has no default program. Skipping affiliate discount deletion.";
  }

  if (candidateCodes.length === 0 && candidateGids.length === 0) {
    return "[Shopify] No discount code or GID provided in event payload.";
  }

  const effectiveStoreId =
    storeId ??
    (
      await prisma.weleticShopifyStore.findUnique({
        where: { projectId: workspace.id },
        select: { id: true },
      })
    )?.id;
  if (!effectiveStoreId) {
    throw new Error(
      `Cannot process Shopify discount deletion: store is missing for workspace ${workspace.id}`,
    );
  }

  const targetCodes = await withShopifyStoreOperationalWriteFence({
    storeId: effectiveStoreId,
    action: "shopify_discount_delete",
    expectedInstallationGeneration,
    operation: async (tx) => {
      const codes = await tx.discountCode.findMany({
        where: {
          programId,
          OR: [
            ...(candidateCodes.length > 0
              ? [{ code: { in: candidateCodes } }]
              : []),
            ...(candidateGids.length > 0
              ? [{ discount: { couponId: { in: candidateGids } } }]
              : []),
          ],
        },
        include: {
          link: {
            select: {
              domain: true,
              key: true,
            },
          },
        },
      });
      if (codes.length > 0) {
        await tx.discountCode.updateMany({
          where: {
            id: { in: codes.map(({ id }) => id) },
            disabledAt: null,
          },
          data: { disabledAt: new Date() },
        });
      }
      return codes;
    },
  });

  if (targetCodes.length === 0) {
    return "[Shopify] No matching Weletic discount codes found for deletion.";
  }

  // Purge link and SWR caches
  const linksToExpire = targetCodes
    .map((c) => c.link)
    .filter((l): l is NonNullable<typeof l> => Boolean(l));
  if (linksToExpire.length > 0) {
    await linkCache.expireMany(linksToExpire);
    for (const link of linksToExpire) {
      await linkCache.delete({ domain: link.domain, key: link.key });
    }
  }

  return `[Shopify] Successfully disabled ${targetCodes.length} discount code(s) and purged cache.`;
}

import { reconcileWeleticShopifyDiscounts } from "@/lib/weletic/commerce/reconcile-shopify-discounts";
import { assertAccountBackedReward } from "@/lib/weletic/loyalty/reward-ownership";

export async function discountsUpdate({
  event,
  workspace,
  storeId,
  expectedInstallationGeneration,
}: {
  event: any;
  workspace: Pick<WorkspaceProps, "id" | "defaultProgramId">;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
}) {
  const isDeactivated =
    event?.status === "expired" ||
    event?.status === "disabled" ||
    (event?.ends_at && new Date(event.ends_at) < new Date());

  if (isDeactivated) {
    return await discountsDelete({
      event,
      workspace,
      storeId,
      expectedInstallationGeneration,
    });
  }

  // If reactivated:
  if (event?.status === "active" && workspace.defaultProgramId) {
    const candidateCodes: string[] = [];
    if (event?.code) candidateCodes.push(event.code);
    if (Array.isArray(event?.codes)) {
      for (const c of event.codes) {
        if (typeof c === "string") candidateCodes.push(c);
        else if (c?.code) candidateCodes.push(c.code);
      }
    }
    if (event?.title) {
      const match = event.title.match(/Dub Discount \(([^)]+)\)/i);
      if (match?.[1]) candidateCodes.push(match[1]);
    }
    const candidateGids = [
      event?.admin_graphql_api_id,
      event?.id ? String(event.id) : null,
      event?.id ? `gid://shopify/DiscountCodeNode/${event.id}` : null,
      event?.id ? `gid://shopify/PriceRule/${event.id}` : null,
      event?.price_rule_id ? String(event.price_rule_id) : null,
      event?.price_rule_id
        ? `gid://shopify/PriceRule/${event.price_rule_id}`
        : null,
    ].filter(Boolean) as string[];

    if (candidateCodes.length > 0 || candidateGids.length > 0) {
      const reactivated = await withShopifyStoreOperationalWriteFence({
        ...(storeId ? { storeId } : { workspaceId: workspace.id }),
        action: "shopify_discount_reactivation",
        expectedInstallationGeneration,
        operation: (tx) =>
          tx.discountCode.updateMany({
            where: {
              programId: workspace.defaultProgramId!,
              disabledAt: { not: null },
              OR: [
                ...(candidateCodes.length > 0
                  ? [{ code: { in: candidateCodes } }]
                  : []),
                ...(candidateGids.length > 0
                  ? [{ discount: { couponId: { in: candidateGids } } }]
                  : []),
              ],
            },
            data: { disabledAt: null },
          }),
      });

      if (reactivated.count > 0) {
        return `[Shopify] Discount code ${event?.code || "nodes"} reactivated (${reactivated.count} updated).`;
      }
    }
  }

  // Trigger full drift reconciliation to catch any added or removed child redemption codes
  try {
    await withShopifyStoreOperationalWriteFence({
      ...(storeId ? { storeId } : { workspaceId: workspace.id }),
      action: "shopify_discount_reconciliation_dispatch",
      expectedInstallationGeneration,
      operation: async () => undefined,
    });
    const reconcileResult = await reconcileWeleticShopifyDiscounts({
      workspaceId: workspace.id,
      storeId,
      autoHeal: true,
    });
    if (reconcileResult.healedCount > 0) {
      return `[Shopify] Discount update processed. Reconciled ${reconcileResult.checked} codes (${reconcileResult.healedCount} healed).`;
    }
  } catch (err) {
    if (isShopifyStoreOperationalWritesBlocked(err)) throw err;
    console.warn("[discountsUpdate Reconcile Error]:", err);
  }

  return "[Shopify] Discount update received; no status change required.";
}
