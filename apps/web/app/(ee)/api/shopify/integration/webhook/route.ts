import { captureWebhookLog } from "@/lib/api-logs/capture-webhook-log";
import { isLocalDev } from "@/lib/api/environment";
import { qstash } from "@/lib/cron";
import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/upstash";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  assertAuthenticatedFixtureCustomerCreateMaintenanceIdentity,
  createAuthenticatedFixtureCustomerCreateMaintenancePermit,
  createLoyaltyMaintenanceOwnerPermit,
  isLoyaltyMaintenanceBlockedError,
  LoyaltyMaintenanceBlockedError,
  readLoyaltyMaintenanceLease,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { shopifyAdminGraphqlRequest } from "@/lib/weletic/loyalty/shopify-discounts";
import { syncWeleticShopifyCatalog } from "@/lib/weletic/shopify/catalog-sync";
import { persistAndQueueShopifyComplianceRequest } from "@/lib/weletic/shopify/compliance-ingress";
import { resolveComplianceShopifyStoreByDomain } from "@/lib/weletic/shopify/compliance-store-resolver";
import {
  isShopifyDurableComplianceTopic,
  parseShopifyComplianceSubject,
} from "@/lib/weletic/shopify/compliance-types";
import { createAllShopifyWebhookBodyDigests } from "@/lib/weletic/shopify/privacy-identity";
import {
  readWeleticShopifyRequestBodyBytes,
  WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
} from "@/lib/weletic/shopify/service-auth";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  assertShopifyStoreMatchesInstallationGeneration,
  isShopifyStoreOperationalWritesBlocked,
} from "@/lib/weletic/shopify/store-compliance-state";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import { APP_DOMAIN_WITH_NGROK, log } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { waitUntil } from "@vercel/functions";
import { customerSegmentMembershipChanged } from "./customer-segment-membership";
import { customersSync } from "./customers-sync";
import { discountsDelete, discountsUpdate } from "./discounts-sync";
import { ordersPaid } from "./orders-paid";
import { refundsCreate } from "./refunds-create";

const relevantTopics = new Set([
  "orders/paid",
  "orders/fulfilled",
  "orders/cancelled",
  "refunds/create",
  "discounts/delete",
  "discounts/update",
  "products/create",
  "products/update",
  "products/delete",
  "markets/create",
  "markets/update",
  "markets/delete",
  "customer.joined_segment",
  "customer.left_segment",
  "customers/create",
  "customers/update",

  // Mandatory compliance webhooks
  "app/uninstalled",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

const signedTenantTopics = new Set([
  "app/uninstalled",
  "customers/data_request",
  "customers/redact",
  "shop/redact",
]);

const privacyMinimizedFinancialTopics = new Set([
  "orders/paid",
  "refunds/create",
]);

const SHOPIFY_TRIGGERED_AT_MAX_FUTURE_SKEW_MS = 5 * 60_000;
const SHOPIFY_FIXTURE_CUSTOMER_READBACK_TIMEOUT_MS = 1_500;
const SHOPIFY_NUMERIC_CUSTOMER_ID = /^[1-9]\d{0,19}$/;
const SHOPIFY_CUSTOMER_GID = /^gid:\/\/shopify\/Customer\/([1-9]\d{0,19})$/;
const RELEASE_CATALOG_DEBOUNCE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;
const SHOPIFY_RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function sameInstallationGeneration(
  left: string | null | undefined,
  right: string | null | undefined,
) {
  return (left ?? null) === (right ?? null);
}

function parseAuthenticatedShopifyTriggeredAt(
  value: string | null,
  now = new Date(),
) {
  if (!value || value.length > 64 || !SHOPIFY_RFC3339_TIMESTAMP.test(value)) {
    return null;
  }
  const triggeredAt = new Date(value);
  if (
    !Number.isFinite(triggeredAt.getTime()) ||
    triggeredAt.getTime() >
      now.getTime() + SHOPIFY_TRIGGERED_AT_MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return triggeredAt;
}

function loyaltyMaintenanceRetryResponse() {
  return new Response(
    "[Shopify] Loyalty maintenance is active; retry this webhook later.",
    {
      status: 503,
      headers: { "Retry-After": "5" },
    },
  );
}

function readSafeShopifyCustomerId(id: unknown): string | null {
  if (typeof id === "number") {
    return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
  }
  if (typeof id !== "string" || !SHOPIFY_NUMERIC_CUSTOMER_ID.test(id)) {
    return null;
  }
  return id;
}

function readSignedCanonicalShopifyCustomerGid(event: unknown):
  | {
      gid: string;
      numericId: string;
    }
  | undefined {
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const gid = (event as { admin_graphql_api_id?: unknown })
    .admin_graphql_api_id;
  if (typeof gid !== "string") return;
  const match = SHOPIFY_CUSTOMER_GID.exec(gid);
  return match ? { gid, numericId: match[1] } : undefined;
}

function hasConflictingSignedShopifyCustomerIds(event: unknown) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const canonicalGid = readSignedCanonicalShopifyCustomerGid(event);
  if (!canonicalGid) return false;
  const numericId = readSafeShopifyCustomerId((event as { id?: unknown }).id);
  return numericId !== null && numericId !== canonicalGid.numericId;
}

function readSignedShopifyCustomerGid(event: unknown): string | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const canonicalGid = readSignedCanonicalShopifyCustomerGid(event);
  if (canonicalGid) return canonicalGid.gid;
  const payload = event as { id?: unknown; admin_graphql_api_id?: unknown };
  if (payload.admin_graphql_api_id !== undefined) {
    return null;
  }
  const numericId = readSafeShopifyCustomerId(payload.id);
  return numericId ? `gid://shopify/Customer/${numericId}` : null;
}

function normalizeShopifyCustomerDispatchEvent(event: any) {
  const canonicalGid = readSignedCanonicalShopifyCustomerGid(event);
  return canonicalGid ? { ...event, id: canonicalGid.numericId } : event;
}

async function readBackMaintenanceFixtureCustomerTags({
  storeId,
  shopDomain,
  accessToken,
  event,
}: {
  storeId: string;
  shopDomain: string;
  accessToken: string;
  event: unknown;
}) {
  const customerGid = readSignedShopifyCustomerGid(event);
  if (!customerGid) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_permit",
      storeId,
    });
  }

  try {
    const result = await shopifyAdminGraphqlRequest<{
      customer: {
        id: string;
        tags: string[];
      } | null;
    }>({
      shopDomain,
      accessToken,
      query: `query WeleticMaintenanceFixtureCustomer($id: ID!) {
        customer(id: $id) { id tags }
      }`,
      variables: { id: customerGid },
      maxRetries: 0,
      requestTimeoutMs: SHOPIFY_FIXTURE_CUSTOMER_READBACK_TIMEOUT_MS,
    });
    const customer = result?.customer;
    if (
      !customer ||
      customer.id !== customerGid ||
      !Array.isArray(customer.tags) ||
      customer.tags.some((tag) => typeof tag !== "string")
    ) {
      throw new LoyaltyMaintenanceBlockedError({
        reason: "invalid_permit",
        storeId,
      });
    }
    return customer;
  } catch (error) {
    if (isLoyaltyMaintenanceBlockedError(error)) throw error;
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_permit",
      storeId,
    });
  }
}

async function createAuthenticatedLoyaltyMaintenancePermit({
  storeId,
  shopDomain,
  accessToken,
  topic,
  event,
  ownerToken,
  webhookAuthenticated,
}: {
  storeId: string;
  shopDomain: string;
  accessToken: string;
  topic: string;
  event: any;
  ownerToken: string | null;
  webhookAuthenticated: boolean;
}): Promise<LoyaltyMaintenancePermit | undefined> {
  if (!webhookAuthenticated || (!ownerToken && topic !== "customers/create")) {
    return undefined;
  }
  const program = await prisma.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select: { metadata: true },
  });
  const metadata = program?.metadata ?? null;

  if (ownerToken) {
    return createLoyaltyMaintenanceOwnerPermit({
      storeId,
      metadata,
      ownerToken,
    });
  }
  if (!readLoyaltyMaintenanceLease(metadata)) return undefined;
  const hasSignedTags =
    event !== null &&
    typeof event === "object" &&
    !Array.isArray(event) &&
    Object.prototype.hasOwnProperty.call(event, "tags");
  const signedEmail = typeof event?.email === "string" ? event.email : "";
  if (!hasSignedTags) {
    assertAuthenticatedFixtureCustomerCreateMaintenanceIdentity({
      storeId,
      metadata,
      topic,
      webhookAuthenticated,
      email: signedEmail,
    });
  }
  const tags = hasSignedTags
    ? typeof event.tags === "string" ||
      (Array.isArray(event.tags) &&
        event.tags.every((tag: unknown) => typeof tag === "string"))
      ? event.tags
      : []
    : (
        await readBackMaintenanceFixtureCustomerTags({
          storeId,
          shopDomain,
          accessToken,
          event,
        })
      ).tags;
  return createAuthenticatedFixtureCustomerCreateMaintenancePermit({
    storeId,
    metadata,
    topic,
    webhookAuthenticated,
    email: signedEmail,
    tags,
  });
}

async function assertWebhookStoreAcceptsWrite({
  storeId,
  action,
  financialTopic,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
  tx,
}: {
  storeId: string;
  action: string;
  financialTopic: boolean;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}) {
  if (financialTopic) {
    const financialStore =
      await assertShopifyStoreMatchesInstallationGeneration({
        storeId,
        action,
        expectedInstallationGeneration,
        tx,
      });
    if (financialStore.complianceState !== "active") return financialStore;
  }
  return assertShopifyStoreAcceptsOperationalWrites({
    storeId,
    action,
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
    tx,
  });
}

export async function enqueueDebouncedShopifyCatalogSync({
  workspaceId,
  webhookId,
}: {
  workspaceId: string;
  webhookId: string;
}) {
  const debounceKey = `weletic:shopify:sync-debounced:${workspaceId}`;
  const reservation = createWeleticId("whook_");
  const isFirstInBurst = await redis.set(debounceKey, reservation, {
    nx: true,
    ex: 20,
  });
  if (!isFirstInBurst) return false;

  try {
    await qstash.publishJSON({
      url: `${APP_DOMAIN_WITH_NGROK}/api/cron/weletic/shopify/sync`,
      body: { workspaceId },
      retries: 3,
      // A retry after an uncertain publish response is safe: QStash retains
      // this provider-side idempotency key even if the Redis reservation is
      // released so the webhook can retry a definite transport failure.
      deduplicationId: `weletic-shopify-catalog:${workspaceId}:${webhookId}`,
    });
    return true;
  } catch (error) {
    await redis
      .eval(RELEASE_CATALOG_DEBOUNCE_SCRIPT, [debounceKey], [reservation])
      .catch(() => undefined);
    throw error;
  }
}

// POST /api/shopify/integration/webhook – Listen to Shopify webhook events
export const POST = async (req: Request) => {
  const startTime = Date.now();
  const bodyBytes = await readWeleticShopifyRequestBodyBytes(req, {
    maxBytes: WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
  });
  if (bodyBytes === null) {
    return new Response("[Shopify] Webhook payload is too large or invalid.", {
      status: 413,
    });
  }
  const data = new TextDecoder().decode(bodyBytes);
  const headers = req.headers;
  const topic = headers.get("x-shopify-topic") || "";
  const signature = headers.get("x-shopify-hmac-sha256") || "";

  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const allowUnsignedTestWebhook =
    process.env.NODE_ENV === "test" &&
    isLocalDev &&
    !signedTenantTopics.has(topic);
  let webhookAuthenticated = false;

  // Local/ngrok is still a real ingress boundary. Only non-compliance test
  // fixtures may bypass Shopify authentication; every non-test runtime and
  // every compliance topic must fail closed on a missing/invalid HMAC.
  if (!allowUnsignedTestWebhook || signature) {
    if (!webhookSecret) {
      return new Response("[Shopify] Webhook verification is unavailable.", {
        status: 503,
      });
    }
    if (
      !verifyShopifyWebhookSignature({
        body: bodyBytes,
        signature,
        secret: webhookSecret,
      })
    ) {
      return new Response(`[Shopify] Invalid webhook signature. Skipping...`, {
        status: 401,
      });
    }
    webhookAuthenticated = true;
  }

  // Check if topic is relevant
  if (!relevantTopics.has(topic)) {
    return new Response(`[Shopify] Unsupported topic: ${topic}. Skipping...`);
  }

  let authenticatedBodyDigests: string[];
  try {
    authenticatedBodyDigests = createAllShopifyWebhookBodyDigests({
      topic,
      rawBodyBytes: bodyBytes,
    });
  } catch {
    return new Response(
      "[Shopify] Webhook identity verification is unavailable.",
      { status: 503 },
    );
  }
  const authenticatedBodyDigest = authenticatedBodyDigests[0];

  let event: any;
  try {
    event = JSON.parse(data);
  } catch {
    return new Response("[Shopify] Invalid JSON webhook payload.", {
      status: 400,
    });
  }
  if (
    (topic === "customers/create" || topic === "customers/update") &&
    hasConflictingSignedShopifyCustomerIds(event)
  ) {
    return new Response(
      "[Shopify] Customer webhook identity fields do not agree.",
      { status: 400 },
    );
  }
  const shopDomain = headers.get("x-shopify-shop-domain") || "";
  const webhookId = headers.get("x-shopify-webhook-id") || "";

  if (isLocalDev) {
    console.log(
      `\x1b[36m[Shopify Webhook Ingest]\x1b[0m \x1b[33m${topic}\x1b[0m | ID: \x1b[90m${webhookId || "none"}\x1b[0m`,
    );
  }

  // Mandatory compliance delivery has Shopify's five-second response budget.
  // Authenticate first (above), then resolve without Admin credentials,
  // persist encrypted work idempotently, freeze uninstall/shop-redact lifecycle
  // writes through the exact store row, and acknowledge. Export, erasure, and
  // voucher work remain bounded background phases.
  if (isShopifyDurableComplianceTopic(topic)) {
    let subject;
    try {
      subject = parseShopifyComplianceSubject({ topic, payload: event });
    } catch {
      return new Response("[Shopify] Invalid compliance webhook payload.", {
        status: 400,
      });
    }
    const [headerStore, signedBodyStore] = await Promise.all([
      resolveComplianceShopifyStoreByDomain(shopDomain),
      resolveComplianceShopifyStoreByDomain(subject.shopDomain),
    ]);
    if (
      !headerStore ||
      !signedBodyStore ||
      headerStore.storeId !== signedBodyStore.storeId
    ) {
      return new Response(
        "[Shopify] Signed compliance shop does not match the webhook tenant.",
        { status: 401 },
      );
    }
    if (!webhookId.trim()) {
      return new Response("[Shopify] Missing webhook identifier.", {
        status: 400,
      });
    }
    const triggeredAt =
      topic === "app/uninstalled"
        ? parseAuthenticatedShopifyTriggeredAt(
            headers.get("x-shopify-triggered-at"),
          )
        : null;
    if (topic === "app/uninstalled" && !triggeredAt) {
      return new Response(
        "[Shopify] Missing or invalid uninstall event timestamp.",
        { status: 400 },
      );
    }

    try {
      const persisted = await persistAndQueueShopifyComplianceRequest({
        storeId: headerStore.storeId,
        canonicalShopDomain: headerStore.canonicalShopDomain,
        storageShopDomain: headerStore.storageShopDomain,
        alreadyRedacted:
          headerStore.complianceState === "redacted" ||
          headerStore.resolvedFromTombstone,
        ...(triggeredAt ? { triggeredAt } : {}),
        webhookId,
        authenticatedBodyDigests,
        topic,
        payload: event,
      });
      const responseBody = persisted.created
        ? "[Shopify] Compliance request persisted."
        : "[Shopify] Duplicate compliance request is already durable.";
      waitUntil(
        captureWebhookLog({
          workspaceId: headerStore.workspaceId,
          method: req.method,
          path: "/shopify/integration/webhook",
          requestBody: {
            webhookId,
            topic,
            storeId: headerStore.storeId,
            authenticatedBodyDigest,
          },
          userAgent: req.headers.get("user-agent"),
          statusCode: 200,
          duration: Date.now() - startTime,
          responseBody,
        }),
      );
      return new Response(responseBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await log({
        message: `Shopify compliance ingress failed. Error: ${message}`,
        type: "errors",
      });
      return new Response("[Shopify] Compliance request persistence failed.", {
        status: 500,
      });
    }
  }

  // Financial truth may arrive after shop erasure, when the raw domain has
  // already been replaced by a non-routable pseudonym and Admin credentials
  // are gone. Resolve only frozen/redacted financial deliveries through the
  // unexpired keyed-HMAC tombstone; active stores still use the credential-
  // bound operational resolver.
  const financialComplianceStore = privacyMinimizedFinancialTopics.has(topic)
    ? await resolveComplianceShopifyStoreByDomain(shopDomain)
    : null;
  const privacyFinancialTenant =
    financialComplianceStore &&
    ["frozen", "redacted"].includes(financialComplianceStore.complianceState)
      ? {
          storeId: financialComplianceStore.storeId,
          workspaceId: financialComplianceStore.workspaceId,
          programId: financialComplianceStore.programId,
        }
      : null;
  const resolved =
    privacyFinancialTenant ?? (await resolveShopifyStoreByDomain(shopDomain));
  if (!resolved) {
    return new Response(
      "[Shopify] Workspace not found for signed shop. Skipping...",
    );
  }

  // The header is covered by Shopify's transport contract, while the shop
  // identity in the payload is covered by the HMAC. Resolve both and require
  // them to identify the same tenant before dispatching a destructive or
  // privacy-sensitive request. app/uninstalled uses myshopify_domain; the
  // mandatory GDPR topics use shop_domain.
  let signedBodyStore: Awaited<ReturnType<typeof resolveShopifyStoreByDomain>> =
    null;
  if (signedTenantTopics.has(topic)) {
    const signedShopDomainCandidate =
      topic === "app/uninstalled"
        ? event?.myshopify_domain
        : event?.shop_domain;
    const signedShopDomain =
      typeof signedShopDomainCandidate === "string"
        ? signedShopDomainCandidate
        : "";
    signedBodyStore = signedShopDomain
      ? await resolveShopifyStoreByDomain(signedShopDomain)
      : null;
    if (
      !signedBodyStore ||
      signedBodyStore.workspaceId !== resolved.workspaceId ||
      (signedBodyStore.storeId &&
        resolved.storeId &&
        signedBodyStore.storeId !== resolved.storeId)
    ) {
      return new Response(
        "[Shopify] Signed compliance shop does not match the webhook tenant.",
        { status: 401 },
      );
    }
  }

  const workspace = await prisma.project.findUnique({
    where: { id: resolved.workspaceId },
    select: {
      id: true,
      defaultProgramId: true,
      webhookEnabled: true,
    },
  });

  if (!workspace) {
    return new Response(
      "[Shopify] Workspace not found for signed shop. Skipping...",
    );
  }

  const store = resolved.storeId
    ? { id: resolved.storeId }
    : await prisma.weleticShopifyStore.findUnique({
        where: { projectId: workspace.id },
        select: { id: true },
      });
  if (!store || !webhookId.trim()) {
    return new Response(
      "[Shopify] Operational webhook store or identifier is unavailable.",
      { status: 400 },
    );
  }
  const financialTopic = privacyMinimizedFinancialTopics.has(topic);
  let loyaltyMaintenancePermit: LoyaltyMaintenancePermit | undefined;
  try {
    // Frozen/redacted financial truth is deliberately maintenance-exempt. It
    // may settle retained accounting state, but never re-enters active loyalty
    // earning; do not interpret a private synthetic owner header on this path.
    loyaltyMaintenancePermit = privacyFinancialTenant
      ? undefined
      : await createAuthenticatedLoyaltyMaintenancePermit({
          storeId: store.id,
          shopDomain:
            "myshopifyDomain" in resolved ? resolved.myshopifyDomain : "",
          accessToken: "accessToken" in resolved ? resolved.accessToken : "",
          topic,
          event,
          ownerToken: headers.get("x-weletic-loyalty-maintenance-token"),
          webhookAuthenticated,
        });
    await assertWebhookStoreAcceptsWrite({
      storeId: store.id,
      action: `webhook:${topic}`,
      financialTopic,
      loyaltyMaintenancePermit,
    });
  } catch (error) {
    if (isLoyaltyMaintenanceBlockedError(error)) {
      return loyaltyMaintenanceRetryResponse();
    }
    if (isShopifyStoreOperationalWritesBlocked(error)) {
      return new Response(
        "[Shopify] Store is frozen for compliance; operational webhook ignored.",
      );
    }
    throw error;
  }

  let eventClaim: {
    id: string;
    storeId: string;
    attempt: number;
    storeInstallationGeneration: string | null;
    dispatchInstallationGeneration: string | null;
    privacyMinimizedFinancialSettlement: boolean;
  };
  try {
    const claimResult = await prisma.$transaction(async (tx) => {
      const claimedStore = await assertWebhookStoreAcceptsWrite({
        storeId: store.id,
        action: `webhook_persist:${topic}`,
        financialTopic,
        loyaltyMaintenancePermit,
        tx,
      });
      const storeInstallationGeneration =
        claimedStore?.installationGeneration ?? null;
      try {
        const record = await tx.weleticShopifyWebhookEvent.create({
          data: {
            id: createWeleticId("whook_"),
            storeId: store.id,
            webhookId,
            topic,
            authenticatedBodyDigest,
            storeInstallationGeneration,
            // Shopify redelivers the signed body. Persisting even selected raw
            // resource identifiers creates a post-redaction crash residue, so
            // operational idempotency retains only webhook/body identity.
            payload: Prisma.DbNull,
            attempts: 1,
          },
        });
        return {
          kind: "claim",
          claim: {
            id: record.id,
            storeId: store.id,
            attempt: 1,
            storeInstallationGeneration,
            dispatchInstallationGeneration: storeInstallationGeneration,
            privacyMinimizedFinancialSettlement:
              financialTopic && claimedStore?.complianceState !== "active",
          },
        } as const;
      } catch (error) {
        if (
          !(
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === "P2002"
          )
        ) {
          throw error;
        }
        const existing = await tx.weleticShopifyWebhookEvent.findUnique({
          where: { webhookId },
          select: {
            id: true,
            storeId: true,
            topic: true,
            status: true,
            attempts: true,
            authenticatedBodyDigest: true,
            storeInstallationGeneration: true,
          },
        });
        if (
          !existing ||
          existing.storeId !== store.id ||
          existing.topic !== topic ||
          !existing.authenticatedBodyDigest ||
          !authenticatedBodyDigests.includes(existing.authenticatedBodyDigest)
        ) {
          return {
            kind: "response",
            response: new Response(
              "[Shopify] Webhook identifier belongs to a different tenant or topic.",
              { status: 409 },
            ),
          } as const;
        }
        const generationMatches = sameInstallationGeneration(
          existing.storeInstallationGeneration,
          storeInstallationGeneration,
        );
        if (!financialTopic && !generationMatches) {
          await tx.weleticShopifyWebhookEvent.updateMany({
            where: {
              id: existing.id,
              storeId: store.id,
              topic,
              storeInstallationGeneration: existing.storeInstallationGeneration,
              status: { in: ["received", "failed"] },
            },
            data: {
              status: "processed",
              processedAt: new Date(),
              error:
                "Suppressed because the Shopify installation generation changed.",
              payload: Prisma.DbNull,
            },
          });
          return {
            kind: "response",
            response: new Response(
              "[Shopify] Stale installation webhook was suppressed.",
            ),
          } as const;
        }
        const claimed = await tx.weleticShopifyWebhookEvent.updateMany({
          where: {
            id: existing.id,
            storeId: store.id,
            topic,
            attempts: existing.attempts,
            storeInstallationGeneration: existing.storeInstallationGeneration,
            OR: [
              { status: "failed" },
              {
                status: "received",
                updatedAt: { lt: new Date(Date.now() - 60_000) },
              },
            ],
          },
          data: {
            status: "received",
            attempts: { increment: 1 },
            error: null,
            payload: Prisma.DbNull,
          },
        });
        if (claimed.count === 0) {
          const current = await tx.weleticShopifyWebhookEvent.findUnique({
            where: { webhookId },
            select: {
              storeId: true,
              topic: true,
              status: true,
              authenticatedBodyDigest: true,
              storeInstallationGeneration: true,
            },
          });
          if (
            current?.storeId !== store.id ||
            current?.topic !== topic ||
            !current.authenticatedBodyDigest ||
            !authenticatedBodyDigests.includes(
              current.authenticatedBodyDigest,
            ) ||
            (!financialTopic &&
              !sameInstallationGeneration(
                current.storeInstallationGeneration,
                storeInstallationGeneration,
              ))
          ) {
            return {
              kind: "response",
              response: new Response(
                "[Shopify] Webhook identifier belongs to a different tenant or topic.",
                { status: 409 },
              ),
            } as const;
          }
          if (current.status === "received") {
            return {
              kind: "response",
              response: new Response(
                "[Shopify] Webhook is already being processed; retry later.",
                { status: 409 },
              ),
            } as const;
          }
          if (current.status === "failed") {
            return {
              kind: "response",
              response: new Response(
                "[Shopify] Webhook processing failed again; retry later.",
                { status: 503 },
              ),
            } as const;
          }
          if (current.status !== "processed") {
            return {
              kind: "response",
              response: new Response(
                "[Shopify] Webhook state is not safe to acknowledge.",
                { status: 409 },
              ),
            } as const;
          }
          return {
            kind: "response",
            response: new Response(
              "[Shopify] Duplicate webhook was already processed.",
            ),
          } as const;
        }
        return {
          kind: "claim",
          claim: {
            id: existing.id,
            storeId: store.id,
            attempt: existing.attempts + 1,
            storeInstallationGeneration: existing.storeInstallationGeneration,
            dispatchInstallationGeneration: storeInstallationGeneration,
            privacyMinimizedFinancialSettlement:
              financialTopic &&
              (!generationMatches ||
                claimedStore?.complianceState !== "active"),
          },
        } as const;
      }
    });
    if (claimResult.kind === "response") return claimResult.response;
    eventClaim = claimResult.claim;
  } catch (error) {
    if (isLoyaltyMaintenanceBlockedError(error)) {
      return loyaltyMaintenanceRetryResponse();
    }
    if (isShopifyStoreOperationalWritesBlocked(error)) {
      return new Response(
        "[Shopify] Store is frozen for compliance; operational webhook ignored.",
      );
    }
    throw error;
  }

  const requestLog = {
    workspaceId: workspace.id,
    method: req.method,
    path: "/shopify/integration/webhook" as const,
    requestBody: {
      webhookId,
      topic,
      storeId: store.id,
      authenticatedBodyDigest,
    },
    userAgent: req.headers.get("user-agent"),
  };

  let response = "OK";

  try {
    await assertWebhookStoreAcceptsWrite({
      storeId: eventClaim.storeId,
      action: `webhook_dispatch:${topic}`,
      financialTopic,
      expectedInstallationGeneration: financialTopic
        ? eventClaim.dispatchInstallationGeneration
        : eventClaim.storeInstallationGeneration,
      loyaltyMaintenancePermit,
    });
    switch (topic) {
      case "orders/fulfilled":
      case "orders/cancelled": {
        const { processReviewOrderEvent } = await import(
          "@/lib/weletic/reviews/shopify-events"
        );
        await processReviewOrderEvent({
          topic,
          event,
          storeId: eventClaim.storeId,
          workspaceId: workspace.id,
          expectedInstallationGeneration:
            eventClaim.storeInstallationGeneration,
        });
        response = "[Shopify] Review order lifecycle processed.";
        break;
      }
      case "orders/paid":
        response = await ordersPaid({
          event,
          workspace,
          storeId: eventClaim.storeId,
          expectedInstallationGeneration:
            eventClaim.dispatchInstallationGeneration,
          privacyMinimizedFinancialSettlement:
            eventClaim.privacyMinimizedFinancialSettlement,
          loyaltyMaintenancePermit,
        });
        break;
      case "refunds/create":
        response = await refundsCreate({
          event,
          workspaceId: workspace.id,
          storeId: eventClaim.storeId,
          expectedInstallationGeneration:
            eventClaim.dispatchInstallationGeneration,
          privacyMinimizedFinancialSettlement:
            eventClaim.privacyMinimizedFinancialSettlement,
          loyaltyMaintenancePermit,
        });
        break;
      case "discounts/delete":
        response = await discountsDelete({
          event,
          workspace,
          storeId: eventClaim.storeId,
          expectedInstallationGeneration:
            eventClaim.storeInstallationGeneration,
        });
        break;
      case "discounts/update":
        response = await discountsUpdate({
          event,
          workspace,
          storeId: eventClaim.storeId,
          expectedInstallationGeneration:
            eventClaim.storeInstallationGeneration,
        });
        break;
      case "products/create":
      case "products/update":
      case "products/delete":
      case "markets/create":
      case "markets/update":
      case "markets/delete": {
        if (isLocalDev) {
          waitUntil(
            syncWeleticShopifyCatalog({ workspaceId: workspace.id }).catch(
              (err) => {
                console.error(
                  "[Shopify Webhook] Local catalog sync failed:",
                  err,
                );
              },
            ),
          );
          response = `[Shopify] ${topic} catalog sync executed locally.`;
          break;
        }
        const isFirstInBurst = await enqueueDebouncedShopifyCatalogSync({
          workspaceId: workspace.id,
          webhookId,
        });
        if (isFirstInBurst) {
          response = `[Shopify] ${topic} catalog reconciliation queued.`;
        } else {
          response = `[Shopify] ${topic} catalog sync debounced (already queued in burst).`;
        }
        break;
      }
      case "customer.joined_segment":
      case "customer.left_segment":
        response = await customerSegmentMembershipChanged({
          event,
          workspaceId: workspace.id,
          member: topic === "customer.joined_segment",
          storeId: eventClaim.storeId,
          expectedInstallationGeneration:
            eventClaim.storeInstallationGeneration,
        });
        break;
      case "customers/create":
      case "customers/update":
        response = await customersSync({
          // Shopify customer IDs are unsigned 64-bit values. JSON.parse can
          // round the numeric REST field, while the signed GID string remains
          // exact; normalize only this in-memory dispatch projection.
          event: normalizeShopifyCustomerDispatchEvent(event),
          workspaceId: workspace.id,
          storeId: eventClaim.storeId,
          expectedInstallationGeneration:
            eventClaim.storeInstallationGeneration,
          loyaltyMaintenancePermit,
        });
        break;
    }
  } catch (error) {
    const failed = await prisma.weleticShopifyWebhookEvent.updateMany({
      where: {
        id: eventClaim.id,
        storeId: eventClaim.storeId,
        topic,
        status: "received",
        attempts: eventClaim.attempt,
        storeInstallationGeneration: eventClaim.storeInstallationGeneration,
      },
      data: {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        payload: Prisma.DbNull,
      },
    });
    if (failed.count !== 1) {
      return new Response(
        "[Shopify] Webhook lease was reclaimed; stale failure was discarded.",
        { status: 409 },
      );
    }
    if (isLoyaltyMaintenanceBlockedError(error)) {
      return loyaltyMaintenanceRetryResponse();
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    await log({
      message: `Shopify webhook failed. Error: ${errorMessage}`,
      type: "errors",
    });

    const response = new Response(
      `[Shopify] Webhook handler failed. View logs`,
      { status: 500 },
    );

    waitUntil(
      captureWebhookLog({
        ...requestLog,
        statusCode: 500,
        duration: Date.now() - startTime,
        responseBody: response,
      }),
    );

    return response;
  }

  let completed: { count: number };
  try {
    completed = await prisma.$transaction(async (tx) => {
      await assertWebhookStoreAcceptsWrite({
        storeId: eventClaim.storeId,
        action: `webhook_complete:${topic}`,
        financialTopic,
        expectedInstallationGeneration: financialTopic
          ? eventClaim.dispatchInstallationGeneration
          : eventClaim.storeInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
      return tx.weleticShopifyWebhookEvent.updateMany({
        where: {
          id: eventClaim.id,
          storeId: eventClaim.storeId,
          topic,
          status: "received",
          attempts: eventClaim.attempt,
          storeInstallationGeneration: eventClaim.storeInstallationGeneration,
        },
        data: {
          status: "processed",
          processedAt: new Date(),
          payload: Prisma.DbNull,
        },
      });
    });
  } catch (error) {
    if (isLoyaltyMaintenanceBlockedError(error)) {
      return loyaltyMaintenanceRetryResponse();
    }
    throw error;
  }
  if (completed.count !== 1) {
    return new Response(
      "[Shopify] Webhook lease was reclaimed; stale completion was discarded.",
      { status: 409 },
    );
  }

  waitUntil(
    captureWebhookLog({
      ...requestLog,
      statusCode: 200,
      duration: Date.now() - startTime,
      responseBody: response,
    }),
  );

  return new Response(response);
};
