import { decrypt, encrypt } from "@/lib/encryption";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/integrations/shopify/admin-graphql";
import { integrationCredentialsSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { lockLoyaltyProgramRowIfPresent } from "@/lib/weletic/loyalty/program-write-fence";
import { resolveComplianceShopifyStoreByDomain } from "@/lib/weletic/shopify/compliance-store-resolver";
import {
  ensurePendingInstallationAfterAuthentication,
  readPendingInstallation,
} from "@/lib/weletic/shopify/installation-admission";
import {
  ensureShopifyWebhooksRegistered,
  SHOPIFY_CANONICAL_WEBHOOK_TOPICS,
} from "@/lib/weletic/shopify/provision-webhooks";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import {
  shopifySessionMutationFenceSchema,
  shopifySessionWritePropertiesSchema,
  shopifySessionShopSchema as shopSchema,
} from "@/lib/weletic/shopify/session-contract-validation";
import {
  advanceLegacyShopifySessionRevision,
  advanceShopifySessionRevision,
  observeShopifySessionCoordination,
  renewShopifySessionLease,
  ShopifySessionCoordinationError,
  type ShopifySessionLease,
} from "@/lib/weletic/shopify/session-coordination";
import {
  lockShopifySessionLifecycle,
  SessionCredentialWriteBlockedError,
} from "@/lib/weletic/shopify/session-lifecycle-fence";
import {
  bindShopifyOnlineSession,
  readShopifySessionPayload,
} from "@/lib/weletic/shopify/session-online-binding";
import {
  assertShopifySessionObservation,
  configuredShopifySessionScope,
  readShopifySessionSnapshot,
} from "@/lib/weletic/shopify/session-snapshot";
import {
  assertLegacyShopifyCredentialAuthority,
  publishStoreOwnedShopifyCredential,
  readStoreOwnedShopifyCredential,
} from "@/lib/weletic/shopify/store-owned-credential";
import {
  canonicalizeShopifyDomain,
  fetchVerifiedShopifyShopDetails,
  readShopifyCredentialTokenHash,
  shopifyCredentialVerificationHash,
} from "@/lib/weletic/shopify/store-resolver";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import * as z from "zod/v4";

export const dynamic = "force-dynamic";

const sessionIdSchema = z.string().min(1).max(255);
const credentialTokenHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
const storeSchema = z.object({
  properties: shopifySessionWritePropertiesSchema,
  expectedCredentialTokenHash: credentialTokenHashSchema.optional(),
  coordination: shopifySessionMutationFenceSchema.optional(),
  onlineCoordination: shopifySessionMutationFenceSchema.optional(),
});
const deleteSchema = z.object({
  ids: z.array(sessionIdSchema).min(1).max(100),
  coordination: shopifySessionMutationFenceSchema.optional(),
  onlineDeletion: z
    .object({
      shop: shopSchema,
      expectedPayloadDigest: z.string().regex(/^[a-f0-9]{64}$/),
      coordination: shopifySessionMutationFenceSchema,
    })
    .strict()
    .optional(),
});

function unauthorized() {
  return sessionJson({ error: "Unauthorized" }, { status: 401 });
}

function badRequest() {
  return sessionJson({ error: "Invalid request" }, { status: 400 });
}

function sessionJson(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.json(data, { ...init, headers });
}

const LEGACY_ACTIVATION_OUTBOX_JOB_STATUSES = [
  "pending",
  "processing",
  "failed",
  "dead_letter",
] as const;

type LegacyActivationClient = typeof prisma | Prisma.TransactionClient;

async function inspectLegacyActivationFence(
  client: LegacyActivationClient,
  storeId: string,
) {
  const [
    fencedActivePrograms,
    writeEnabledPrograms,
    provisioningRedemptions,
    blockingOutboxJobs,
    committingBackfills,
  ] = await Promise.all([
    client.weleticLoyaltyProgram.count({
      where: { storeId, status: "active", killSwitchActive: true },
    }),
    client.weleticLoyaltyProgram.count({
      where: { storeId, status: "active", killSwitchActive: false },
    }),
    client.weleticRewardRedemption.count({
      where: { storeId, status: "provisioning" },
    }),
    client.weleticLoyaltyOutboxJob.count({
      where: {
        storeId,
        status: { in: [...LEGACY_ACTIVATION_OUTBOX_JOB_STATUSES] },
      },
    }),
    client.weleticLoyaltyBackfillJob.count({
      where: { storeId, status: "committing" },
    }),
  ]);
  return {
    fencedActivePrograms,
    writeEnabledPrograms,
    provisioningRedemptions,
    blockingOutboxJobs,
    committingBackfills,
  };
}

function assertLegacyActivationFence(
  state: Awaited<ReturnType<typeof inspectLegacyActivationFence>>,
) {
  if (
    state.fencedActivePrograms !== 1 ||
    state.writeEnabledPrograms !== 0 ||
    state.provisioningRedemptions !== 0 ||
    state.blockingOutboxJobs !== 0 ||
    state.committingBackfills !== 0
  ) {
    throw new SessionCredentialWriteBlockedError(
      "Legacy Shopify installation activation requires a drained loyalty maintenance fence.",
    );
  }
}

type SessionTransactionOperation<T> = (
  tx: Prisma.TransactionClient,
) => Promise<T>;

function createSessionTransactionRunner(useExtendedTimeout: boolean) {
  return <T>(operation: SessionTransactionOperation<T>) =>
    useExtendedTimeout
      ? prisma.$transaction(operation, {
          maxWait: 10_000,
          timeout: 60_000,
        })
      : prisma.$transaction(operation);
}

function serializeSession(payload: string) {
  const session = readShopifySessionPayload(JSON.parse(decrypt(payload)));
  return {
    ...session,
    ...(session.onlineBinding
      ? { onlineDigest: createHash("sha256").update(payload).digest("hex") }
      : {}),
  };
}

export async function GET(request: Request) {
  if (!verifyWeleticShopifyRequest({ request, body: "" })) {
    return unauthorized();
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const shop = searchParams.get("shop");
  if (Boolean(id) === Boolean(shop)) {
    return badRequest();
  }

  try {
    const sessions = id
      ? await prisma.weleticShopifyAppSession.findMany({
          where: { id: sessionIdSchema.parse(id) },
          select: { payload: true },
        })
      : await prisma.weleticShopifyAppSession.findMany({
          where: { shop: shopSchema.parse(shop) },
          select: { payload: true },
        });

    return sessionJson({
      sessions: sessions.map(({ payload }) => serializeSession(payload)),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return badRequest();
    }
    console.error("[Shopify session load error]");
    return sessionJson(
      { error: "Unable to load Shopify session" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const rawBody = await readWeleticShopifyRequestBody(request);
  if (rawBody === null) {
    return sessionJson({ error: "Request body is too large" }, { status: 413 });
  }
  if (!verifyWeleticShopifyRequest({ request, body: rawBody })) {
    return unauthorized();
  }

  try {
    const {
      properties,
      expectedCredentialTokenHash,
      coordination,
      onlineCoordination,
    } = storeSchema.parse(JSON.parse(rawBody));
    if (new URL(request.url).pathname.endsWith("/coordinated") && !coordination)
      return badRequest();
    const values = Object.fromEntries(properties);
    const id = sessionIdSchema.parse(values.id);
    const shop = shopSchema.parse(values.shop);
    const isOnline = z.boolean().parse(values.isOnline);
    if (
      (!isOnline && id !== `offline_${shop}`) ||
      (isOnline && id.startsWith("offline_")) ||
      (isOnline && coordination) ||
      (!isOnline && onlineCoordination)
    ) {
      return badRequest();
    }
    z.string().parse(values.state);

    const expiresAt =
      values.expires === undefined
        ? null
        : new Date(z.number().nonnegative().parse(values.expires));
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return badRequest();
    }
    const payload = encrypt(JSON.stringify(properties));

    const [exactStore, resolvedStore] = await Promise.all([
      prisma.weleticShopifyStore.findUnique({
        where: { shopDomain: shop },
        select: {
          id: true,
          projectId: true,
          complianceState: true,
          installationGeneration: true,
        },
      }),
      resolveComplianceShopifyStoreByDomain(shop),
    ]);
    if (
      (exactStore && !resolvedStore) ||
      resolvedStore?.resolvedFromTombstone ||
      resolvedStore?.complianceState === "redacted"
    ) {
      throw new SessionCredentialWriteBlockedError(
        "A redacted or ambiguous Shopify store cannot accept session credentials.",
      );
    }

    let legacyActivation:
      | {
          installationId: string;
          observedCredentialTokenHash: string;
          installationGeneration: string;
        }
      | undefined;
    if (
      exactStore?.installationGeneration === null &&
      !isOnline &&
      typeof values.accessToken === "string"
    ) {
      if (exactStore.complianceState !== "active") {
        throw new SessionCredentialWriteBlockedError(
          "A non-active Shopify store cannot bootstrap an installation generation.",
        );
      }
      const pendingLifecycleRequests =
        await prisma.weleticShopifyComplianceRequest.count({
          where: {
            storeId: exactStore.id,
            requestType: { in: ["app_uninstalled", "shop_redact"] },
            status: { not: "completed" },
          },
        });
      if (pendingLifecycleRequests > 0) {
        throw new SessionCredentialWriteBlockedError(
          "A pending Shopify deletion lifecycle prevents generation activation.",
        );
      }
      const installations = await prisma.installedIntegration.findMany({
        where: {
          projectId: exactStore.projectId,
          integrationId: SHOPIFY_INTEGRATION_ID,
        },
        orderBy: { id: "asc" },
        take: 2,
        select: { id: true, credentials: true },
      });
      if (installations.length > 1) {
        throw new SessionCredentialWriteBlockedError(
          "Ambiguous Shopify installation authority cannot activate a generation.",
        );
      }
      const installation = installations[0];
      const credentials = integrationCredentialsSchema.safeParse(
        installation?.credentials || {},
      ).data;
      const currentTokenHash = readShopifyCredentialTokenHash(
        installation?.credentials,
      );
      const isExactLegacyCredential = Boolean(
        installation &&
          credentials?.accessToken &&
          credentials.installationGeneration == null &&
          canonicalizeShopifyDomain(credentials.shop || "") === shop &&
          expectedCredentialTokenHash !== undefined &&
          expectedCredentialTokenHash === currentTokenHash &&
          currentTokenHash,
      );
      if (isExactLegacyCredential && installation && currentTokenHash) {
        assertLegacyActivationFence(
          await inspectLegacyActivationFence(prisma, exactStore.id),
        );
        legacyActivation = {
          installationId: installation.id,
          observedCredentialTokenHash: currentTokenHash,
          installationGeneration: createWeleticId("sgen_"),
        };
      }
    }

    const runSessionTransaction = createSessionTransactionRunner(
      legacyActivation !== undefined,
    );
    const result = await runSessionTransaction(async (tx) => {
      const storeId = resolvedStore?.storeId ?? exactStore?.id ?? null;
      const lockedStore = await lockShopifySessionLifecycle({
        tx,
        shop,
        storeId,
      });

      // Unknown installs may publish coordinated offline authentication only.
      // Online merchant authority requires the existing exact mapped store.
      if (!lockedStore && (isOnline || !coordination)) {
        throw new SessionCredentialWriteBlockedError(
          "Unmapped installation requires coordinated offline authentication.",
        );
      }

      const publicationScope = configuredShopifySessionScope(shop);
      // Even tokenless invalidations and new online IDs must pass the public
      // admission boundary. Keep Store → coordinator → admission lock order.
      await observeShopifySessionCoordination(tx, publicationScope);
      const publicAdmission = await readPendingInstallation(
        tx,
        publicationScope,
      );
      if (lockedStore && publicAdmission) {
        if (
          (isOnline && !onlineCoordination) ||
          (!isOnline && !coordination) ||
          !lockedStore.installationGeneration
        )
          throw new SessionCredentialWriteBlockedError(
            "Public session publication requires coordinated authentication.",
          );
        await readStoreOwnedShopifyCredential(tx, {
          ...publicationScope,
          storeId: lockedStore.id,
          workspaceId: lockedStore.projectId,
          installationGeneration: lockedStore.installationGeneration,
        });
      } else if (lockedStore) {
        await assertLegacyShopifyCredentialAuthority(
          tx,
          lockedStore.id,
          publicationScope.appId,
        );
      }

      let storedPayload = payload;
      if (isOnline && !onlineCoordination) {
        const existing = await tx.weleticShopifyAppSession.findUnique({
          where: { id },
        });
        if (
          existing &&
          readShopifySessionPayload(JSON.parse(decrypt(existing.payload)))
            .onlineBinding
        )
          throw new ShopifySessionCoordinationError("stale_session");
      }
      if (onlineCoordination) {
        const scope = configuredShopifySessionScope(shop);
        const current = await readShopifySessionSnapshot(
          tx,
          scope,
          lockedStore,
        );
        assertShopifySessionObservation(
          current.observed,
          onlineCoordination.observed,
        );
        if (
          !lockedStore?.installationGeneration ||
          lockedStore.installationGeneration !==
            onlineCoordination.observed.installationGeneration ||
          !current.observed.credentialTokenHash ||
          onlineCoordination.lease.revision !==
            onlineCoordination.observed.revision
        ) {
          throw new ShopifySessionCoordinationError("stale_session");
        }
        // Validate winning ownership after row-lock waits, without advancing the
        // offline credential revision or projecting an online token to workers.
        await renewShopifySessionLease(tx, {
          ...scope,
          ...onlineCoordination.lease,
        });
        const envelope = bindShopifyOnlineSession(properties, {
          ...scope,
          storeId: lockedStore.id,
          installationGeneration: lockedStore.installationGeneration,
        });
        if (!expiresAt || expiresAt.getTime() <= Date.now()) {
          throw new SessionCredentialWriteBlockedError(
            "Expired online session cannot be published.",
          );
        }
        storedPayload = encrypt(JSON.stringify(envelope));
      }

      let nextLease: ShopifySessionLease | undefined;
      if (!isOnline) {
        const scope = configuredShopifySessionScope(shop);
        if (coordination) {
          if (legacyActivation) {
            // The legacy bootstrap performs provider provisioning under its old
            // maintenance fence. It is not a coordinated token-renewal path.
            throw new SessionCredentialWriteBlockedError(
              "Legacy generation activation requires its separately approved bootstrap path.",
            );
          }
          const current = await readShopifySessionSnapshot(
            tx,
            scope,
            lockedStore,
          );
          assertShopifySessionObservation(
            current.observed,
            coordination.observed,
          );
          if (
            coordination.lease.revision !== coordination.observed.revision ||
            expectedCredentialTokenHash !==
              coordination.observed.credentialTokenHash
          ) {
            throw new ShopifySessionCoordinationError("stale_session");
          }
          nextLease = await advanceShopifySessionRevision(tx, {
            ...scope,
            ...coordination.lease,
          });
        } else {
          await advanceLegacyShopifySessionRevision(tx, scope);
        }
      }

      if (legacyActivation) {
        if (
          !lockedStore ||
          lockedStore.id !== exactStore?.id ||
          lockedStore.projectId !== exactStore.projectId ||
          lockedStore.installationGeneration !== null
        ) {
          throw new SessionCredentialWriteBlockedError(
            "The Shopify store lifecycle changed during legacy activation.",
          );
        }
        const lockedProgram = await lockLoyaltyProgramRowIfPresent({
          tx,
          storeId: lockedStore.id,
        });
        if (
          !lockedProgram ||
          lockedProgram.status !== "active" ||
          !Boolean(lockedProgram.killSwitchActive)
        ) {
          throw new SessionCredentialWriteBlockedError(
            "The loyalty program maintenance fence changed during legacy activation.",
          );
        }
        assertLegacyActivationFence(
          await inspectLegacyActivationFence(tx, lockedStore.id),
        );
      }

      let currentInstallation:
        | { id: string; credentials: Prisma.JsonValue }
        | undefined;
      let nativePublication:
        | {
            identity: {
              appId: string;
              shop: string;
              storeId: string;
              workspaceId: string;
              installationGeneration: string;
            };
            expectedRevision: number | null;
          }
        | undefined;
      if (
        lockedStore &&
        !isOnline &&
        values.accessToken &&
        typeof values.accessToken === "string"
      ) {
        const scope = configuredShopifySessionScope(shop);
        if (publicAdmission) {
          // Public admissions use only the store/app-owned credential. A
          // legacy integration is neither an owner nor a recovery fallback.
          if (
            !coordination ||
            !lockedStore.installationGeneration ||
            legacyActivation
          )
            throw new SessionCredentialWriteBlockedError(
              "Public credential publication requires coordinated authentication.",
            );
          const identity = {
            ...scope,
            storeId: lockedStore.id,
            workspaceId: lockedStore.projectId,
            installationGeneration: lockedStore.installationGeneration,
          };
          const credential = await readStoreOwnedShopifyCredential(
            tx,
            identity,
          );
          const tokenHash = credential
            ? shopifyCredentialVerificationHash(credential.accessToken)
            : null;
          if (expectedCredentialTokenHash !== tokenHash)
            throw new ShopifySessionCoordinationError("stale_session");
          nativePublication = {
            identity,
            expectedRevision: credential?.revision ?? null,
          };
        } else {
          const installations = await tx.installedIntegration.findMany({
            where: {
              projectId: lockedStore.projectId,
              integrationId: SHOPIFY_INTEGRATION_ID,
            },
            orderBy: { id: "asc" },
            take: 2,
            select: { id: true, credentials: true },
          });
          if (installations.length > 1) {
            throw new SessionCredentialWriteBlockedError(
              "Ambiguous Shopify installation authority cannot accept session credentials.",
            );
          }
          currentInstallation = installations[0];
          if (currentInstallation) {
            const currentCredentials = integrationCredentialsSchema.safeParse(
              currentInstallation.credentials || {},
            ).data;
            const currentTokenHash = readShopifyCredentialTokenHash(
              currentInstallation.credentials,
            );
            const activatingLegacyCredential = Boolean(
              legacyActivation &&
                currentInstallation.id === legacyActivation.installationId &&
                lockedStore.installationGeneration === null &&
                currentCredentials?.installationGeneration == null &&
                currentTokenHash ===
                  legacyActivation.observedCredentialTokenHash,
            );
            if (
              expectedCredentialTokenHash === undefined ||
              expectedCredentialTokenHash !== currentTokenHash ||
              (!activatingLegacyCredential &&
                (!lockedStore.installationGeneration ||
                  currentCredentials?.installationGeneration !==
                    lockedStore.installationGeneration)) ||
              canonicalizeShopifyDomain(currentCredentials?.shop || "") !== shop
            ) {
              throw new SessionCredentialWriteBlockedError(
                "A newer or invalid Shopify credential prevents this session refresh.",
              );
            }
          }
        }
      }

      let credentialGeneration = lockedStore?.installationGeneration ?? null;
      if (legacyActivation && lockedStore) {
        // The store row remains locked while Shopify authority is verified and
        // mandatory webhooks are provisioned. Uninstall/shop-redact ingress
        // takes the same row lock, so remote mutations cannot race a freeze.
        const verifiedShop = await fetchVerifiedShopifyShopDetails({
          shopDomain: shop,
          accessToken: values.accessToken as string,
        });
        if (!verifiedShop) {
          throw new SessionCredentialWriteBlockedError(
            "Shopify rejected the replacement credential during legacy activation.",
          );
        }
        const webhookProvisioning = await ensureShopifyWebhooksRegistered({
          shopDomain: shop,
          accessToken: values.accessToken as string,
          allowSdkFallback: false,
        });
        const provisionedTopics = new Set([
          ...webhookProvisioning.registered,
          ...webhookProvisioning.skipped,
        ]);
        if (
          !webhookProvisioning.success ||
          webhookProvisioning.failed.length > 0 ||
          SHOPIFY_CANONICAL_WEBHOOK_TOPICS.some(
            (topic) => !provisionedTopics.has(topic),
          )
        ) {
          throw new SessionCredentialWriteBlockedError(
            "Mandatory Shopify webhooks are incomplete during legacy activation.",
          );
        }
        const verifiedAt = new Date();
        const published = await tx.weleticShopifyStore.updateMany({
          where: {
            id: lockedStore.id,
            projectId: lockedStore.projectId,
            shopDomain: shop,
            complianceState: "active",
            installationGeneration: null,
          },
          data: {
            shopCurrency: verifiedShop.shopCurrency,
            currencyVerifiedAt: verifiedAt,
            installationGeneration: legacyActivation.installationGeneration,
            apiVersion: SHOPIFY_ADMIN_API_VERSION,
            syncStatus: "pending",
            lastSyncError: null,
          },
        });
        if (published.count !== 1) {
          throw new SessionCredentialWriteBlockedError(
            "The Shopify store lifecycle changed before generation publication.",
          );
        }
        credentialGeneration = legacyActivation.installationGeneration;
      }

      if (
        !lockedStore &&
        !isOnline &&
        typeof values.accessToken === "string" &&
        values.accessToken
      ) {
        const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
          Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
        );
        await ensurePendingInstallationAfterAuthentication(
          tx,
          configuredShopifySessionScope(shop),
          clock.now,
        );
      }
      await tx.weleticShopifyAppSession.upsert({
        where: { id },
        update: { shop, isOnline, expiresAt, payload: storedPayload },
        create: { id, shop, isOnline, expiresAt, payload: storedPayload },
      });

      if (nativePublication) {
        await publishStoreOwnedShopifyCredential(tx, {
          ...nativePublication,
          material: {
            accessToken: values.accessToken,
            scope: String(values.scope || ""),
          },
        });
      }

      if (
        currentInstallation &&
        credentialGeneration &&
        !isOnline &&
        typeof values.accessToken === "string"
      ) {
        const priorCredentials =
          currentInstallation.credentials &&
          typeof currentInstallation.credentials === "object" &&
          !Array.isArray(currentInstallation.credentials)
            ? currentInstallation.credentials
            : {};
        await tx.installedIntegration.update({
          where: { id: currentInstallation.id },
          data: {
            credentials: {
              ...priorCredentials,
              shop,
              scope: String(values.scope || ""),
              accessToken: encrypt(values.accessToken),
              installationGeneration: credentialGeneration,
              shopVerifiedAt: new Date().toISOString(),
              shopVerificationTokenHash: shopifyCredentialVerificationHash(
                values.accessToken,
              ),
            },
          },
        });
      }
      if (nextLease) {
        const snapshot = await readShopifySessionSnapshot(
          tx,
          // Snapshot identity is only app/shop. Passing the entire lease leaks
          // token/epoch/revision into the strict native credential identity and
          // rolls back an otherwise valid SDK publication as an invalid request.
          publicationScope,
          lockedStore,
        );
        return {
          stored: true,
          coordination: {
            lease: {
              token: nextLease.token,
              epoch: nextLease.epoch,
              revision: nextLease.revision,
            },
            observed: snapshot.observed,
          },
        };
      }
      return { stored: true };
    });

    return sessionJson(result);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return badRequest();
    }
    if (
      error instanceof SessionCredentialWriteBlockedError ||
      error instanceof ShopifySessionCoordinationError
    ) {
      return sessionJson(
        { error: "Shopify session credential write is blocked" },
        { status: 409 },
      );
    }
    console.error("[Shopify session store error]");
    return sessionJson(
      { error: "Unable to store Shopify session" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const rawBody = await readWeleticShopifyRequestBody(request);
  if (rawBody === null) {
    return sessionJson({ error: "Request body is too large" }, { status: 413 });
  }
  if (!verifyWeleticShopifyRequest({ request, body: rawBody })) {
    return unauthorized();
  }

  try {
    const { ids, coordination, onlineDeletion } = deleteSchema.parse(
      JSON.parse(rawBody),
    );
    if (new URL(request.url).pathname.endsWith("/coordinated") && !coordination)
      return badRequest();
    if (coordination && (ids.length !== 1 || !ids[0].startsWith("offline_")))
      return badRequest();
    if (onlineDeletion) {
      if (
        coordination ||
        ids.length !== 1 ||
        !new RegExp(
          `^${onlineDeletion.shop.replaceAll(".", "\\.")}_[1-9][0-9]*$`,
        ).test(ids[0])
      )
        return badRequest();
    } else if (ids.some((id) => !id.startsWith("offline_"))) {
      // Unscoped online deletes cannot distinguish an old SDK callback from a
      // replacement session. Lifecycle/privacy cleanup uses its own DB service.
      return badRequest();
    }
    const shops = [
      ...new Set(
        ids
          .filter((id) => id.startsWith("offline_"))
          .map((id) => {
            const shop = shopSchema.parse(id.slice("offline_".length));
            if (id !== `offline_${shop}`)
              throw new ShopifySessionCoordinationError("invalid_scope");
            return shop;
          }),
      ),
    ].sort();
    const result = await prisma.$transaction(async (tx) => {
      if (onlineDeletion) {
        const {
          shop,
          expectedPayloadDigest,
          coordination: proof,
        } = onlineDeletion;
        const scope = configuredShopifySessionScope(shop);
        const store = await lockShopifySessionLifecycle({
          tx,
          shop,
          storeId: null,
        });
        const current = await readShopifySessionSnapshot(tx, scope, store);
        assertShopifySessionObservation(current.observed, proof.observed);
        if (
          !store?.installationGeneration ||
          !current.observed.credentialTokenHash ||
          store.installationGeneration !==
            proof.observed.installationGeneration ||
          proof.lease.revision !== proof.observed.revision
        )
          throw new ShopifySessionCoordinationError("stale_session");
        await renewShopifySessionLease(tx, { ...scope, ...proof.lease });
        const row = await tx.weleticShopifyAppSession.findUnique({
          where: { id: ids[0] },
        });
        if (!row) return { deleted: 0 };
        const stored = serializeSession(row.payload);
        if (
          !row.isOnline ||
          row.shop !== shop ||
          stored.onlineDigest !== expectedPayloadDigest ||
          stored.onlineBinding?.appId !== scope.appId ||
          stored.onlineBinding.storeId !== store.id ||
          stored.onlineBinding.installationGeneration !==
            store.installationGeneration
        )
          throw new ShopifySessionCoordinationError("stale_session");
        const deleted = await tx.weleticShopifyAppSession.deleteMany({
          where: { id: row.id, shop, isOnline: true, payload: row.payload },
        });
        if (deleted.count !== 1)
          throw new ShopifySessionCoordinationError("stale_session");
        return { deleted: deleted.count };
      }
      if (coordination) {
        const shop = shops[0];
        const scope = configuredShopifySessionScope(shop);
        const store = await lockShopifySessionLifecycle({
          tx,
          shop,
          storeId: null,
        });
        const current = await readShopifySessionSnapshot(tx, scope, store);
        assertShopifySessionObservation(
          current.observed,
          coordination.observed,
        );
        if (coordination.lease.revision !== coordination.observed.revision) {
          throw new ShopifySessionCoordinationError("stale_session");
        }
        const nextLease = await advanceShopifySessionRevision(tx, {
          ...scope,
          ...coordination.lease,
        });
        const deleted = await tx.weleticShopifyAppSession.deleteMany({
          where: { id: ids[0], shop, isOnline: false },
        });
        const snapshot = await readShopifySessionSnapshot(tx, scope, store);
        return {
          deleted: deleted.count,
          coordination: {
            lease: {
              token: nextLease.token,
              epoch: nextLease.epoch,
              revision: nextLease.revision,
            },
            observed: snapshot.observed,
          },
        };
      }
      // Compatibility-only SDK deletes are fenced as soon as a shop has been
      // promoted. Never let a delayed old client bypass coordinated publication.
      for (const shop of shops) {
        await lockShopifySessionLifecycle({ tx, shop, storeId: null });
        await advanceLegacyShopifySessionRevision(
          tx,
          configuredShopifySessionScope(shop),
        );
      }
      const deleted = await tx.weleticShopifyAppSession.deleteMany({
        where: { id: { in: ids } },
      });
      return { deleted: deleted.count };
    });
    return sessionJson(result);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      return badRequest();
    }
    if (
      error instanceof SessionCredentialWriteBlockedError ||
      error instanceof ShopifySessionCoordinationError
    ) {
      return sessionJson(
        { error: "Shopify session credential write is blocked" },
        { status: 409 },
      );
    }
    console.error("[Shopify session delete error]");
    return sessionJson(
      { error: "Unable to delete Shopify session" },
      { status: 500 },
    );
  }
}
