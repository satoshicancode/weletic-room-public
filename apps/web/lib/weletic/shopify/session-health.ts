import { prisma } from "@/lib/prisma";
import {
  SHOPIFY_SESSION_MISSING_ISSUE_KIND,
  type ShopifySessionHealth,
} from "./session-health-contract";

/** Read only the current workspace installation; no credential or incident
 * details leave the service. Absence of an incident is not a live health check.
 */
export async function readShopifySessionHealth(
  workspaceId: string,
): Promise<ShopifySessionHealth> {
  return prisma.$transaction(async (tx) => {
    const store = await tx.weleticShopifyStore.findUnique({
      where: { projectId: workspaceId },
      select: { id: true, installationGeneration: true, complianceState: true },
    });
    if (
      !store ||
      !store.installationGeneration ||
      store.complianceState !== "active"
    )
      return { status: "not_connected", detectedAt: null };
    const incident = await tx.weleticReconciliationIssue.findUnique({
      where: {
        storeId_kind_externalKey: {
          storeId: store.id,
          kind: SHOPIFY_SESSION_MISSING_ISSUE_KIND,
          externalKey: store.installationGeneration,
        },
      },
      select: { status: true, detectedAt: true },
    });
    return incident?.status === "open"
      ? {
          status: "reconnect_required",
          detectedAt: incident.detectedAt.toISOString(),
        }
      : { status: "not_observed", detectedAt: null };
  });
}
