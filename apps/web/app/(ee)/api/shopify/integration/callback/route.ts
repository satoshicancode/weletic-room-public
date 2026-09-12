import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { qstash } from "@/lib/cron";
import { encrypt } from "@/lib/encryption";
import {
  installIntegration,
  notifyIntegrationInstalled,
} from "@/lib/integrations/install";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { lockLoyaltyProgramRowIfPresent } from "@/lib/weletic/loyalty/program-write-fence";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import { persistAndQueueInternalShopifyDisconnect } from "@/lib/weletic/shopify/compliance-ingress";
import {
  inspectShopifyConnectLifecycle,
  type ShopifyConnectLifecycle,
} from "@/lib/weletic/shopify/integration-lifecycle";
import { lockLegacyShopifyConnection } from "@/lib/weletic/shopify/legacy-connection-fence";
import {
  ensureShopifyWebhooksRegistered,
  SHOPIFY_CANONICAL_WEBHOOK_TOPICS,
} from "@/lib/weletic/shopify/provision-webhooks";
import {
  canonicalizeShopifyDomain,
  fetchVerifiedShopifyShopDetails,
  invalidateShopifyStoreDomainCache,
  readShopifyCredentialTokenHash,
  shopifyCredentialVerificationHash,
} from "@/lib/weletic/shopify/store-resolver";
import { APP_DOMAIN_WITH_NGROK, SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import * as z from "zod/v4";

const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("connect"),
    shopifyStoreId: z.string().min(1),
    accessToken: z.string().min(1),
    scope: z.string().min(1),
  }),

  z.object({
    action: z.literal("disconnect"),
    shopifyStoreId: z.literal(null),
  }),
]);

type CredentialObservation = {
  installationId: string | null;
  installationUserId: string | null;
  tokenHash: string | null;
};

// PATCH /api/shopify/integration/callback – update a shopify store id
export const PATCH = withWorkspace(
  async ({ req, workspace, session }) => {
    const body = requestSchema.parse(await parseRequestBody(req));
    const canonicalShopDomain =
      body.action === "connect"
        ? canonicalizeShopifyDomain(body.shopifyStoreId)
        : null;

    let verifiedShopCurrency: string | null = null;
    let connectLifecycle: ShopifyConnectLifecycle | null = null;
    let credentialObservation: CredentialObservation | null = null;
    if (body.action === "connect") {
      if (!workspace.defaultProgramId) {
        throw new DubApiError({
          code: "conflict",
          message:
            "Create a default program before connecting a Shopify store.",
        });
      }
      if (!canonicalShopDomain) {
        throw new DubApiError({
          code: "bad_request",
          message: "Enter a valid *.myshopify.com store domain.",
        });
      }
      await prisma.$transaction((tx) =>
        lockLegacyShopifyConnection(tx, {
          workspaceId: workspace.id,
          shop: canonicalShopDomain,
        }),
      );
      // Snapshot the exact installation generation before either Shopify
      // verification or webhook provisioning. The final transaction compares
      // this observation under the store -> program locks, so a slower callback
      // cannot overwrite a newer connection that completed while it was doing
      // remote work.
      const [lifecycle, observedInstallations] = await Promise.all([
        inspectShopifyConnectLifecycle({
          workspaceId: workspace.id,
          currentProjectShopDomain: workspace.shopifyStoreId,
          canonicalShopDomain,
        }),
        prisma.installedIntegration.findMany({
          where: {
            projectId: workspace.id,
            integrationId: SHOPIFY_INTEGRATION_ID,
          },
          orderBy: { id: "asc" },
          take: 2,
          select: { id: true, userId: true, credentials: true },
        }),
      ]);
      if (observedInstallations.length > 1) {
        throw new DubApiError({
          code: "conflict",
          message:
            "Multiple Shopify credential authorities exist for this workspace. Resolve the retained installation before reconnecting.",
        });
      }
      const observedInstallation = observedInstallations[0];
      connectLifecycle = lifecycle;
      credentialObservation = {
        installationId: observedInstallation?.id ?? null,
        installationUserId: observedInstallation?.userId ?? null,
        tokenHash: readShopifyCredentialTokenHash(
          observedInstallation?.credentials,
        ),
      };
      const verifiedShop = await fetchVerifiedShopifyShopDetails({
        shopDomain: canonicalShopDomain,
        accessToken: body.accessToken,
      });
      if (!verifiedShop) {
        throw new DubApiError({
          code: "unauthorized",
          message:
            "The Shopify access token or authoritative shop currency could not be verified for this store.",
        });
      }
      verifiedShopCurrency = verifiedShop.shopCurrency;
    }

    try {
      if (body.action === "disconnect") {
        const store = await prisma.weleticShopifyStore.findUnique({
          where: { projectId: workspace.id },
          select: {
            id: true,
            shopDomain: true,
            complianceState: true,
            installationGeneration: true,
          },
        });
        if (!store || !store.installationGeneration) {
          throw new DubApiError({
            code: "conflict",
            message: "No bound Shopify integration lifecycle is available.",
          });
        }
        if (store.complianceState === "redacted") {
          throw new DubApiError({
            code: "conflict",
            message: "A redacted Shopify store cannot be disconnected again.",
          });
        }
        const verifiedShopDomain = canonicalizeShopifyDomain(store.shopDomain);
        if (!verifiedShopDomain) {
          throw new DubApiError({
            code: "conflict",
            message: "The retained Shopify store domain is invalid.",
          });
        }
        const request = await persistAndQueueInternalShopifyDisconnect({
          storeId: store.id,
          canonicalShopDomain: verifiedShopDomain,
          expectedInstallationGeneration: store.installationGeneration,
          // Stable after credential scrub deletes generic/native records.
          // The retained Store and generation, not an installer User, own this
          // lifecycle. Generation is rechecked under the ingress Store lock.
          idempotencyKey: createHash("sha256")
            .update(
              JSON.stringify([
                "store-disconnect-v1",
                store.id,
                store.installationGeneration,
              ]),
            )
            .digest("hex"),
        });
        return NextResponse.json({
          shopifyStoreId: null,
          complianceState: "frozen",
          disconnectRequestId: request.requestId,
        });
      }

      if (body.action === "connect") {
        const verifiedShopDomain = canonicalShopDomain;
        if (!verifiedShopDomain) {
          throw new Error("Verified Shopify domain is missing.");
        }
        if (!verifiedShopCurrency) {
          throw new Error("Verified Shopify currency is missing.");
        }
        const currencyVerifiedAt = new Date();
        const installationGeneration = createWeleticId("sgen_");
        const lifecycle = connectLifecycle;
        if (!lifecycle) {
          throw new Error("Shopify connection lifecycle is missing.");
        }
        const observedCredential = credentialObservation;
        if (!observedCredential) {
          throw new Error("Shopify credential observation is missing.");
        }

        // Fresh frozen credentials still need mandatory compliance and
        // financial-settlement subscriptions. Operational handlers remain
        // guarded by the store's frozen state.
        const webhookProvisioning = await ensureShopifyWebhooksRegistered({
          shopDomain: verifiedShopDomain,
          accessToken: body.accessToken,
        });
        const provisionedTopics = new Set([
          ...webhookProvisioning.registered,
          ...webhookProvisioning.skipped,
        ]);
        const missingTopics = SHOPIFY_CANONICAL_WEBHOOK_TOPICS.filter(
          (topic) => !provisionedTopics.has(topic),
        );
        if (
          !webhookProvisioning.success ||
          webhookProvisioning.failed.length > 0 ||
          missingTopics.length > 0
        ) {
          const failedTopics = webhookProvisioning.failed
            .map(({ topic }) => topic)
            .concat(missingTopics)
            .join(", ");
          throw new Error(
            `Shopify webhook provisioning failed${failedTopics ? ` for: ${failedTopics}` : "."}`,
          );
        }

        const buildCredentials = (credentialGeneration: string) => ({
          accessToken: encrypt(body.accessToken),
          scope: body.scope,
          shop: verifiedShopDomain,
          installationGeneration: credentialGeneration,
          shopVerifiedAt: new Date().toISOString(),
          shopVerificationTokenHash: shopifyCredentialVerificationHash(
            body.accessToken,
          ),
        });

        let finalizedConnection: {
          mode: "active" | "frozen_refresh";
          project?: { shopifyStoreId: string | null };
        };
        finalizedConnection = await prisma.$transaction(async (tx) => {
          await lockLegacyShopifyConnection(tx, {
            workspaceId: workspace.id,
            shop: verifiedShopDomain,
          });
          const persistCredential = async (credentialGeneration: string) => {
            const currentInstallations = await tx.installedIntegration.findMany(
              {
                where: {
                  projectId: workspace.id,
                  integrationId: SHOPIFY_INTEGRATION_ID,
                },
                orderBy: { id: "asc" },
                take: 2,
                select: { id: true, userId: true, credentials: true },
              },
            );
            const currentInstallation = currentInstallations[0];
            const currentObservation: CredentialObservation = {
              installationId: currentInstallation?.id ?? null,
              installationUserId: currentInstallation?.userId ?? null,
              tokenHash: readShopifyCredentialTokenHash(
                currentInstallation?.credentials,
              ),
            };
            if (
              currentInstallations.length > 1 ||
              currentObservation.installationId !==
                observedCredential.installationId ||
              currentObservation.installationUserId !==
                observedCredential.installationUserId ||
              currentObservation.tokenHash !== observedCredential.tokenHash
            ) {
              throw new DubApiError({
                code: "conflict",
                message:
                  "A newer Shopify credential completed while this connection was being verified. Retry with the latest credentials.",
              });
            }
            const credentials = buildCredentials(credentialGeneration);
            if (
              currentInstallation &&
              currentInstallation.userId !== session.user.id
            ) {
              return tx.installedIntegration.update({
                where: { id: currentInstallation.id },
                data: { credentials },
              });
            }
            return installIntegration({
              userId: session.user.id,
              workspaceId: workspace.id,
              integrationId: SHOPIFY_INTEGRATION_ID,
              credentials,
              tx,
            });
          };

          if (!lifecycle.storeId) {
            // The shared legacy fence already checked Store and tombstone
            // authority, before locking the coordinator and admission.
            const globalStores = await tx.$queryRaw<
              Array<{ id: string; projectId: string }>
            >(Prisma.sql`
              SELECT id, projectId
              FROM WeleticShopifyStore
              WHERE shopDomain = ${verifiedShopDomain}
              LIMIT 1
              FOR UPDATE
            `);
            if (globalStores[0]) {
              throw new Error(
                "This Shopify domain became bound while the connection was being verified.",
              );
            }
            await tx.weleticShopifyStore.create({
              data: {
                id: createWeleticId("wstore_"),
                projectId: workspace.id,
                // The connect branch fails before token verification or webhook
                // provisioning when this workspace invariant is absent.
                programId: workspace.defaultProgramId!,
                shopDomain: verifiedShopDomain,
                shopCurrency: verifiedShopCurrency,
                currencyVerifiedAt,
                installationGeneration,
                apiVersion: SHOPIFY_ADMIN_API_VERSION,
                syncStatus: "pending",
                complianceState: "active",
              },
            });
            const project = await tx.project.update({
              where: { id: workspace.id },
              data: { shopifyStoreId: verifiedShopDomain },
              select: { shopifyStoreId: true },
            });
            await persistCredential(installationGeneration);
            return { mode: "active" as const, project };
          }

          const lockedStores = await tx.$queryRaw<
            Array<{
              id: string;
              projectId: string;
              shopDomain: string;
              complianceState: string;
              uninstalledAt: Date | null;
              installationGeneration: string | null;
            }>
          >(Prisma.sql`
              SELECT id, projectId, shopDomain, complianceState, uninstalledAt, installationGeneration
              FROM WeleticShopifyStore
              WHERE id = ${lifecycle.storeId}
              LIMIT 1
              FOR UPDATE
            `);
          const lockedStore = lockedStores[0];
          if (!lockedStore) {
            throw new Error(
              "The retained Shopify store disappeared during connection.",
            );
          }
          if (
            lockedStore.projectId !== workspace.id ||
            canonicalizeShopifyDomain(lockedStore.shopDomain) !==
              verifiedShopDomain
          ) {
            throw new Error(
              "The retained Shopify store changed tenant or domain during connection.",
            );
          }
          if (lockedStore.complianceState === "redacted") {
            throw new Error(
              "A redacted Shopify store cannot accept refreshed credentials.",
            );
          }
          // Currency and lifecycle generations use the global store -> program
          // lock order. A voucher create holding the program row therefore
          // linearizes entirely before this refresh, or starts afterward and
          // re-reads the newly verified currency before remote Shopify I/O.
          const lockedLoyaltyProgram = await lockLoyaltyProgramRowIfPresent({
            tx,
            storeId: lifecycle.storeId,
          });
          if (
            lockedStore.installationGeneration !==
            lifecycle.observedInstallationGeneration
          ) {
            throw new DubApiError({
              code: "conflict",
              message:
                "A newer Shopify connection completed while this connection was being verified. Retry with the latest credentials.",
            });
          }
          const blockingRequests =
            await tx.weleticShopifyComplianceRequest.findMany({
              where: {
                storeId: lifecycle.storeId,
                requestType: { in: ["app_uninstalled", "shop_redact"] },
                status: { not: "completed" },
              },
              orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
              select: {
                requestType: true,
                triggeredAt: true,
                receivedAt: true,
              },
            });
          if (
            blockingRequests.some(
              ({ requestType }) => requestType === "shop_redact",
            )
          ) {
            throw new Error(
              "Shopify credential refresh is blocked by a newer shop-redact request.",
            );
          }
          const blockingUninstall = blockingRequests.find(
            ({ requestType }) => requestType === "app_uninstalled",
          );
          const retainedInstallationGeneration =
            lockedStore.installationGeneration;
          if (lockedStore.complianceState === "active" && blockingUninstall) {
            if (!retainedInstallationGeneration) {
              throw new Error(
                "The frozen Shopify lifecycle has no immutable installation generation.",
              );
            }
            const uninstallCutoff =
              blockingUninstall.triggeredAt ?? blockingUninstall.receivedAt;
            await tx.weleticShopifyStore.update({
              where: { id: lifecycle.storeId },
              data: {
                complianceState: "frozen",
                uninstalledAt:
                  lockedStore.uninstalledAt &&
                  lockedStore.uninstalledAt <= uninstallCutoff
                    ? lockedStore.uninstalledAt
                    : uninstallCutoff,
                syncStatus: "failed",
                lastSyncError:
                  "Shopify app uninstalled; loyalty writes are frozen pending voucher cleanup.",
              },
            });
            const disabledPrograms = await tx.weleticLoyaltyProgram.updateMany({
              where: { storeId: lifecycle.storeId },
              data: {
                status: "disabled",
                killSwitchActive: true,
                disabledAt: uninstallCutoff,
              },
            });
            if (lockedLoyaltyProgram && disabledPrograms.count === 1) {
              // Keep immutable policy effective time monotonic. The authenticated
              // uninstall cutoff remains on the store/program lifecycle fields.
              await publishLoyaltyEarnPolicyRevision({
                tx,
                storeId: lifecycle.storeId,
                programId: lockedLoyaltyProgram.id,
                reason: "shopify_uninstall_frozen",
              });
            }
            await persistCredential(retainedInstallationGeneration);
            return { mode: "frozen_refresh" as const };
          }
          if (lockedStore.complianceState === "frozen") {
            if (lifecycle.mode !== "reactivate" || blockingUninstall) {
              if (!retainedInstallationGeneration) {
                throw new Error(
                  "The frozen Shopify lifecycle has no immutable installation generation.",
                );
              }
              await persistCredential(retainedInstallationGeneration);
              return { mode: "frozen_refresh" as const };
            }
            const [nonCompletedCleanups, completedUninstalls] =
              await Promise.all([
                tx.weleticShopifyVoucherCleanup.count({
                  where: {
                    storeId: lifecycle.storeId,
                    status: { not: "completed" },
                  },
                }),
                tx.weleticShopifyComplianceRequest.count({
                  where: {
                    storeId: lifecycle.storeId,
                    requestType: "app_uninstalled",
                    status: "completed",
                  },
                }),
              ]);
            if (nonCompletedCleanups > 0 || completedUninstalls === 0) {
              if (!retainedInstallationGeneration) {
                throw new Error(
                  "The frozen Shopify lifecycle has no immutable installation generation.",
                );
              }
              await persistCredential(retainedInstallationGeneration);
              return { mode: "frozen_refresh" as const };
            }
            const reactivated = await tx.weleticShopifyStore.updateMany({
              where: {
                id: lifecycle.storeId,
                projectId: workspace.id,
                shopDomain: verifiedShopDomain,
                complianceState: "frozen",
                installationGeneration:
                  lifecycle.observedInstallationGeneration,
              },
              data: {
                complianceState: "active",
                uninstalledAt: null,
                shopCurrency: verifiedShopCurrency,
                currencyVerifiedAt,
                installationGeneration,
                syncStatus: "pending",
                lastSyncError: null,
              },
            });
            if (reactivated.count !== 1) {
              throw new Error(
                "The frozen Shopify store changed during reactivation.",
              );
            }
          } else if (lockedStore.complianceState !== "active") {
            throw new Error(
              "The Shopify store entered an unsupported compliance state during connection.",
            );
          }

          if (lockedStore.complianceState === "active") {
            const refreshed = await tx.weleticShopifyStore.updateMany({
              where: {
                id: lifecycle.storeId,
                projectId: workspace.id,
                shopDomain: verifiedShopDomain,
                complianceState: "active",
                installationGeneration:
                  lifecycle.observedInstallationGeneration,
              },
              data: {
                shopCurrency: verifiedShopCurrency,
                currencyVerifiedAt,
                installationGeneration,
              },
            });
            if (refreshed.count !== 1) {
              throw new Error(
                "The active Shopify store changed during currency verification.",
              );
            }
          }

          const project = await tx.project.update({
            where: { id: workspace.id },
            data: { shopifyStoreId: verifiedShopDomain },
            select: { shopifyStoreId: true },
          });
          await persistCredential(installationGeneration);
          return { mode: "active" as const, project };
        });

        invalidateShopifyStoreDomainCache([
          verifiedShopDomain,
          workspace.shopifyStoreId ?? "",
        ]);

        notifyIntegrationInstalled({
          userId: session.user.id,
          workspaceId: workspace.id,
          integrationId: SHOPIFY_INTEGRATION_ID,
        });

        if (finalizedConnection.mode === "frozen_refresh") {
          return NextResponse.json({
            shopifyStoreId: verifiedShopDomain,
            complianceState: "frozen",
            reactivationPending: true,
          });
        }

        if (workspace.defaultProgramId) {
          try {
            await syncWeleticShopifyCatalog({ workspaceId: workspace.id });
          } catch (syncErr) {
            console.error(
              "[Weletic Shopify Auto-Sync Error on Install]:",
              syncErr,
            );
          }

          try {
            await qstash.publishJSON({
              url: `${APP_DOMAIN_WITH_NGROK}/api/cron/weletic/shopify/sync`,
              body: { workspaceId: workspace.id },
              retries: 3,
            });
          } catch {}
        }
        return NextResponse.json(finalizedConnection.project);
      }

      throw new Error("Unsupported Shopify integration action.");
    } catch (error: any) {
      if (error instanceof DubApiError) throw error;
      if (error.code === "P2002") {
        throw new DubApiError({
          code: "conflict",
          message: `The shopify store "${body.shopifyStoreId}" is already in use.`,
        });
      }

      throw new DubApiError({
        code: "internal_server_error",
        message: error.message,
      });
    }
  },
  {
    requiredRoles: ["owner", "member"],
    requiredPlan: ["business", "advanced", "enterprise"],
  },
);
