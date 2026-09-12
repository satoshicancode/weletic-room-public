import { prisma } from "@/lib/prisma";
import {
  APPSFLYER_INTEGRATION_ID,
  SHOPIFY_INTEGRATION_ID,
} from "@dub/utils/src";
import { redirect } from "next/navigation";
import IntegrationPageClient from "./page-client";

export const revalidate = 0;

export default async function IntegrationPage(props: {
  params: Promise<{ slug: string; integrationSlug: string }>;
}) {
  const { slug: workspaceSlug, integrationSlug } = await props.params;

  const integration = await prisma.integration.findUnique({
    where: {
      slug: integrationSlug,
    },
  });

  if (!integration || integration.comingSoon) {
    redirect(`/${workspaceSlug}/settings/integrations`);
  }

  // Native Shopify installations have no generic installer identity. Do not
  // fetch or serialize a legacy user's details even when an old row remains.
  const installedIntegration =
    integration.id === SHOPIFY_INTEGRATION_ID
      ? null
      : await prisma.installedIntegration.findFirst({
          where: {
            integration: {
              slug: integrationSlug,
            },
            project: {
              slug: workspaceSlug,
            },
          },
          select: {
            id: true,
            integrationId: true,
            userId: true,
            settings: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
            webhooks: {
              select: {
                id: true,
              },
            },
          },
        });

  if (
    integration.guideUrl &&
    integration.id !== APPSFLYER_INTEGRATION_ID &&
    integration.id !== SHOPIFY_INTEGRATION_ID
  ) {
    redirect(integration.guideUrl);
  }

  const settings = installedIntegration
    ? installedIntegration.settings
    : undefined;

  const webhookId = installedIntegration
    ? installedIntegration.webhooks[0]?.id
    : undefined;

  return (
    <IntegrationPageClient
      integration={{
        ...integration,
        screenshots: integration.screenshots as string[],
        installed: installedIntegration
          ? {
              id: installedIntegration.id,
              createdAt: installedIntegration.createdAt,
              by: {
                id: installedIntegration.userId,
                name: installedIntegration.user.name,
                email: installedIntegration.user.email,
                image: installedIntegration.user.image,
              },
            }
          : null,
        credentials: {}, // TODO: Fix this
        settings,
        webhookId,
      }}
    />
  );
}
