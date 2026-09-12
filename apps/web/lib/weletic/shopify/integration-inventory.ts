import { prisma } from "@/lib/prisma";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";

/** Configuration inventory, NOT health or authorization. Caller must authorize
 * workspace access. Retained uninstall mappings and pending approvals remain
 * discoverable for recovery. No credentials or installer identities are read.
 */
export async function readWorkspaceIntegrationInventory(workspaceId: string) {
  const appId = process.env.SHOPIFY_API_KEY?.trim();
  const nativeStore = appId
    ? await prisma.weleticShopifyStore.findFirst({
        where: {
          projectId: workspaceId,
          complianceState: { not: "redacted" },
          OR: [
            {
              pendingInstallation: {
                is: { appId, state: { not: "redacted" } },
              },
            },
            { installationCredentials: { some: { appId } } },
          ],
        },
        select: { id: true },
      })
    : null;

  return prisma.integration.findMany({
    where: {
      OR: [
        { installations: { some: { projectId: workspaceId } } },
        ...(nativeStore ? [{ id: SHOPIFY_INTEGRATION_ID }] : []),
      ],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      projectId: true,
      name: true,
      slug: true,
      description: true,
      logo: true,
      verified: true,
      guideUrl: true,
      comingSoon: true,
    },
  });
}
