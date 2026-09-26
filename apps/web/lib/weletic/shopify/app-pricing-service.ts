import { prisma } from "@/lib/prisma";
import {
  Prisma,
  type WeleticShopifySubscriptionSnapshot,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { isCoreLaunch } from "../core-launch-policy";
import { fetchActiveAppSubscription } from "./app-pricing-client";
import {
  hasFreshSubscription,
  pricingIdentitySchema,
  SUBSCRIPTION_VERIFICATION_MS,
  unavailableSubscription,
} from "./app-pricing-contract";
import { readPendingInstallation } from "./installation-admission";
import { readBoundedShopifyJson } from "./read-bounded-json";
import { lockShopifySessionLifecycle } from "./session-lifecycle-fence";
import {
  assertShopifySessionObservation,
  configuredShopifySessionScope,
  readShopifySessionSnapshot,
} from "./session-snapshot";

export class SubscriptionVerificationRequiredError extends Error {
  readonly code = "unavailable";
  constructor() {
    super(
      "A current Shopify subscription verification is required for new benefits.",
    );
  }
}
const fail = () => new SubscriptionVerificationRequiredError();
const snapshotId = (appId: string, pendingId: string, generation: string) =>
  createHash("sha256")
    .update(JSON.stringify([appId, pendingId, generation]))
    .digest("hex");

/** Same store -> privacy -> coordinator -> admission order as SDK publication.
 * The token never leaves this server module and no HTTP occurs under SQL locks.
 */
async function capture(tx: Prisma.TransactionClient, shop: string) {
  const scope = configuredShopifySessionScope(shop);
  const store = await lockShopifySessionLifecycle({ tx, shop, storeId: null });
  const session = await readShopifySessionSnapshot(tx, scope, store);
  const pending = await readPendingInstallation(tx, scope);
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  if (
    !clock ||
    !pending ||
    !pending.installationGeneration ||
    !pending.authenticatedAt ||
    pending.uninstalledAt ||
    pending.redactedAt ||
    (pending.expiresAt && pending.expiresAt <= clock.now) ||
    (store
      ? pending.state !== "mapped" ||
        pending.mappedStoreId !== store.id ||
        pending.installationGeneration !== store.installationGeneration
      : pending.state !== "pending_approval" || pending.mappedStoreId !== null)
  )
    throw fail();
  const [row] = await tx.$queryRaw<Array<{ expiresAt: Date | null }>>(
    Prisma.sql`SELECT expiresAt FROM WeleticShopifyAppSession WHERE id = ${`offline_${shop}`} FOR UPDATE`,
  );
  const properties = Object.fromEntries(session.properties ?? []);
  if (
    !row ||
    (row.expiresAt && row.expiresAt <= clock.now) ||
    properties.id !== `offline_${shop}` ||
    properties.shop !== shop ||
    properties.isOnline !== false ||
    typeof properties.accessToken !== "string" ||
    !properties.accessToken.trim() ||
    session.observed.installationGeneration !==
      pending.installationGeneration ||
    BigInt(session.observed.epoch) <= BigInt(0)
  )
    throw fail();
  return {
    scope,
    store,
    pending,
    observed: session.observed,
    accessToken: properties.accessToken,
    now: clock.now,
    generation: pending.installationGeneration,
  };
}

/** Called only after the gateway authenticates app/shop or by the bounded
 * internal scheduler. The shop argument cannot come from a pricing return URL.
 */
export async function refreshAppPricingForShop(
  shop: string,
  customFetch: typeof fetch = fetch,
  expectedGeneration?: string,
) {
  const partnerAppId = process.env.SHOPIFY_PARTNER_APP_ID ?? "";
  if (!/^gid:\/\/shopify\/App\/[1-9][0-9]*$/.test(partnerAppId)) throw fail();
  const first = await prisma.$transaction(async (tx) => {
    const captured = await capture(tx, shop);
    if (expectedGeneration && captured.generation !== expectedGeneration)
      throw fail();
    const id = snapshotId(
      captured.scope.appId,
      captured.pending.id,
      captured.generation,
    );
    const refreshToken = randomUUID();
    const snapshot = await tx.weleticShopifySubscriptionSnapshot.upsert({
      where: { id },
      create: {
        id,
        appId: captured.scope.appId,
        partnerAppId,
        pendingInstallationId: captured.pending.id,
        installationGeneration: captured.generation,
        refreshToken,
        revision: 1,
      },
      update: { refreshToken, revision: { increment: 1 } },
    });
    if (
      snapshot.partnerAppId !== partnerAppId ||
      snapshot.revision >= 2147483647
    )
      throw fail();
    return { ...captured, snapshot, refreshToken };
  });
  let shopId: string | null = null;
  let decision = unavailableSubscription();
  try {
    const signal = AbortSignal.timeout(10_000);
    const response = await customFetch(
      `https://${first.scope.shop}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": first.accessToken,
        },
        body: JSON.stringify({
          query:
            "query CoreBillingShopIdentity { shop { id myshopifyDomain plan { partnerDevelopment } } }",
        }),
      },
    );
    if (!response.ok) throw fail();
    const payload = z
      .object({
        data: z.object({
          shop: z.object({
            id: z.string().regex(/^gid:\/\/shopify\/Shop\/[1-9][0-9]*$/),
            myshopifyDomain: z.literal(first.scope.shop),
            plan: z.object({ partnerDevelopment: z.boolean() }),
          }),
        }),
        errors: z.array(z.unknown()).optional(),
      })
      .parse(await readBoundedShopifyJson(response, signal));
    if (payload.errors?.length) throw fail();
    shopId = payload.data.shop.id;
    if (first.snapshot.shopId && first.snapshot.shopId !== shopId) throw fail();
    decision = await fetchActiveAppSubscription(
      {
        appId: first.scope.appId,
        partnerAppId,
        shopId,
        installationGeneration: first.generation,
      },
      {
        customFetch,
        now: first.now,
        verifiedDevelopmentStore: payload.data.shop.plan.partnerDevelopment,
      },
    );
  } catch {
    decision = unavailableSubscription();
  }
  return prisma.$transaction(async (tx) => {
    const current = await capture(tx, shop);
    assertShopifySessionObservation(current.observed, first.observed);
    if (
      current.observed.epoch !== first.observed.epoch ||
      current.pending.id !== first.pending.id ||
      current.pending.revision !== first.pending.revision ||
      current.generation !== first.generation ||
      current.now < first.now ||
      current.now.getTime() - first.now.getTime() > 60_000
    )
      throw fail();
    const validUntil = new Date(
      Math.min(
        first.now.getTime() + SUBSCRIPTION_VERIFICATION_MS,
        decision.cycleEndsAt?.getTime() ?? Infinity,
      ),
    );
    const changed = await tx.weleticShopifySubscriptionSnapshot.updateMany({
      where: {
        id: first.snapshot.id,
        refreshToken: first.refreshToken,
        revision: first.snapshot.revision,
        shopId: first.snapshot.shopId,
      },
      data: {
        ...decision,
        shopId: first.snapshot.shopId ?? shopId,
        verifiedAt: first.now,
        validUntil:
          decision.status === "unavailable" ? current.now : validUntil,
        refreshToken: null,
      },
    });
    if (changed.count !== 1) throw fail();
    return {
      credentialsChanged: false,
      status: decision.status,
      pendingInstallationId: first.pending.id,
      installationGeneration: first.generation,
      revision: current.pending.revision,
      storeId: current.store?.id ?? null,
      validUntil,
    };
  });
}

/** Internal admission primitive; caller already owns the store/admission fence.
 * Does not change suspension, privacy, staff access or any program switch.
 */
export async function assertFreshInstallationSubscription(
  tx: Prisma.TransactionClient,
  pendingInstallationId: string,
  generation: string,
  now: Date,
) {
  const appId = process.env.SHOPIFY_API_KEY ?? "";
  const partnerAppId = process.env.SHOPIFY_PARTNER_APP_ID ?? "";
  const id = snapshotId(appId, pendingInstallationId, generation);
  const rows = await tx.$queryRaw<WeleticShopifySubscriptionSnapshot[]>(
    Prisma.sql`SELECT * FROM WeleticShopifySubscriptionSnapshot WHERE id = ${id} LIMIT 1 FOR UPDATE`,
  );
  const row = rows[0];
  if (!row?.shopId || !row.verifiedAt || !row.validUntil) throw fail();
  const identity = pricingIdentitySchema.parse({
    appId,
    partnerAppId,
    shopId: row.shopId,
    installationGeneration: generation,
  });
  if (
    !hasFreshSubscription(
      {
        ...row,
        verifiedAt: row.verifiedAt,
        validUntil: row.validUntil,
        shopId: row.shopId,
        status:
          row.status === "paid"
            ? "paid"
            : row.status === "private_free"
              ? "private_free"
              : row.status === "development"
                ? "development"
                : "inactive",
      },
      identity,
      now,
    )
  )
    throw fail();
  return row;
}

/** New benefits only. Existing issuance/refund/privacy obligations deliberately
 * do not call this gate. Caller holds the store lock before this current read.
 */
export async function assertStoreSubscriptionForNewBenefit(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  if (!isCoreLaunch()) return;
  const [store] = await tx.$queryRaw<
    Array<{ installationGeneration: string | null }>
  >(
    Prisma.sql`SELECT installationGeneration FROM WeleticShopifyStore WHERE id = ${storeId} LIMIT 1 FOR UPDATE`,
  );
  const pending = await tx.weleticShopifyPendingInstallation.findUnique({
    where: { mappedStoreId: storeId },
  });
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  if (
    !store?.installationGeneration ||
    !pending ||
    pending.appId !== process.env.SHOPIFY_API_KEY ||
    pending.state !== "mapped" ||
    pending.installationGeneration !== store.installationGeneration ||
    pending.uninstalledAt ||
    pending.redactedAt ||
    !clock
  )
    throw fail();
  return assertFreshInstallationSubscription(
    tx,
    pending.id,
    store.installationGeneration,
    clock.now,
  );
}

/** Finishes only admission covered by a fresh subscription. Explicit suspension
 * is never cleared here, including after a new successful payment. */
export async function reconcileSubscribedInstallation(
  shop: string,
  customFetch: typeof fetch = fetch,
  expectedGeneration?: string,
) {
  const result = await refreshAppPricingForShop(
    shop,
    customFetch,
    expectedGeneration,
  );
  if (!["paid", "private_free", "development"].includes(result.status))
    return result;
  if (!result.storeId) {
    const { bootstrapSubscribedStore } = await import(
      "./company-store-bootstrap"
    );
    await bootstrapSubscribedStore(
      {
        appId: process.env.SHOPIFY_API_KEY ?? "",
        shop,
        pendingInstallationId: result.pendingInstallationId,
        expectedInstallationGeneration: result.installationGeneration,
        expectedRevision: result.revision,
      },
      customFetch,
    );
    return { ...result, credentialsChanged: true };
  }
  await prisma.$transaction(async (tx) => {
    const current = await capture(tx, shop);
    if (
      current.store?.id !== result.storeId ||
      current.generation !== result.installationGeneration
    )
      throw fail();
    await assertFreshInstallationSubscription(
      tx,
      current.pending.id,
      current.generation,
      current.now,
    );
    const store = await tx.weleticShopifyStore.findUniqueOrThrow({
      where: { id: result.storeId! },
    });
    if (store.storeAccessState !== "pending_approval") return;
    if (store.storeAccessRevision >= 2147483646) throw fail();
    const revision = store.storeAccessRevision + 1;
    const changed = await tx.weleticShopifyStore.updateMany({
      where: {
        id: store.id,
        installationGeneration: current.generation,
        storeAccessState: "pending_approval",
        storeAccessRevision: store.storeAccessRevision,
        complianceState: "active",
      },
      data: { storeAccessState: "active", storeAccessRevision: revision },
    });
    if (changed.count !== 1) throw fail();
    await tx.weleticShopifyStoreAccessChange.create({
      data: {
        id: randomUUID(),
        storeId: store.id,
        installationGeneration: current.generation,
        previousState: "pending_approval",
        nextState: "active",
        revision,
        operator: "shopify-app-pricing",
        reason: "Verified current Shopify-hosted subscription",
      },
    });
  });
  return result;
}
