import { prisma } from "@/lib/prisma";
import { sendEmail } from "@dub/email";
import IntegrationInstalled from "@dub/email/templates/integration-installed";
import { Prisma } from "@prisma/client";
import { waitUntil } from "@vercel/functions";

interface InstallIntegration {
  userId: string;
  workspaceId: string;
  integrationId: string;
  credentials?: Record<string, any>;
  settings?: Record<string, any>;
  tx?: Prisma.TransactionClient;
}

export function notifyIntegrationInstalled({
  userId,
  workspaceId,
  integrationId,
}: Pick<InstallIntegration, "userId" | "workspaceId" | "integrationId">) {
  waitUntil(
    (async () => {
      const workspace = await prisma.project.findUniqueOrThrow({
        where: { id: workspaceId },
        select: {
          name: true,
          slug: true,
          users: {
            select: { user: { select: { email: true } } },
            where: { userId },
          },
          installedIntegrations: {
            where: { integrationId },
            select: {
              integration: { select: { name: true, slug: true } },
            },
          },
        },
      });
      const email = workspace.users[0]?.user.email ?? null;
      const integration =
        workspace.installedIntegrations[0]?.integration ?? null;
      if (email && integration) {
        await sendEmail({
          to: email,
          subject: `The "${integration.name}" integration has been added to your workspace`,
          react: IntegrationInstalled({
            email,
            workspace: { name: workspace.name, slug: workspace.slug },
            integration: { name: integration.name, slug: integration.slug },
          }),
        });
      }
    })(),
  );
}

// Install an integration for a user in a workspace
export const installIntegration = async ({
  userId,
  workspaceId,
  integrationId,
  credentials,
  settings,
  tx,
}: InstallIntegration) => {
  const installation = await (tx ?? prisma).installedIntegration.upsert({
    create: {
      userId,
      projectId: workspaceId,
      integrationId,
      credentials,
      settings,
    },
    update: {
      credentials,
      ...(settings ? { settings } : {}),
    },
    where: {
      userId_integrationId_projectId: {
        userId,
        projectId: workspaceId,
        integrationId,
      },
    },
  });

  if (!tx) {
    notifyIntegrationInstalled({ userId, workspaceId, integrationId });
  }

  return installation;
};
