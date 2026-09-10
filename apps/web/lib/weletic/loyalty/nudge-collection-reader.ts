import { getShopifyAdminGraphqlUrl } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { readBoundedShopifyJson } from "@/lib/weletic/shopify/read-bounded-json";
import { fetchShopifyTokenAuthorityCredential } from "@/lib/weletic/shopify/token-authority";
import { getCustomerLoyaltySummary } from "./customer";
import {
  buildNudgeCollectionMembershipQuery,
  parseNudgeCollectionMembership,
} from "./nudge-collection-membership";

async function readAdmission(storeId: string) {
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      shopDomain: true,
      installationGeneration: true,
      storeAccessState: true,
      complianceState: true,
      uninstalledAt: true,
      redactedAt: true,
    },
  });
  if (
    !store ||
    store.storeAccessState !== "active" ||
    store.complianceState !== "active" ||
    store.uninstalledAt ||
    store.redactedAt ||
    !store.installationGeneration
  )
    return null;
  const program = await prisma.weleticLoyaltyProgram.findUnique({
    where: { storeId },
    select: { id: true, status: true, killSwitchActive: true, updatedAt: true },
  });
  if (!program || program.status !== "active" || program.killSwitchActive)
    return null;
  return { store, program };
}

/** Internal read only. The caller must supply its authenticated customer/store
 * identity. Collection scope is never accepted from the browser. */
export async function readCustomerNudgeCollectionMembership({
  storeId,
  shopifyCustomerId,
  productIds,
}: {
  storeId: string;
  shopifyCustomerId: string;
  productIds: readonly string[];
}): Promise<Record<string, string[]> | null> {
  // Validate product IDs before any database or credential access.
  if (
    !buildNudgeCollectionMembershipQuery(productIds, [
      "gid://shopify/Collection/1",
    ])
  )
    return null;
  try {
    const before = await readAdmission(storeId);
    if (!before) return null;
    const summary = await getCustomerLoyaltySummary({
      storeId,
      shopifyCustomerId,
      shopDomain: before.store.shopDomain,
      redemptionChannel: "online_store",
      provisionReferralIdentity: false,
    });
    if (
      !summary.isEnrolled ||
      !summary.account.canParticipate ||
      !summary.program.isActive
    )
      return null;
    const ids = new Set<string>();
    for (const reward of summary.rewards) {
      if (reward.canRedeem)
        for (const id of reward.entitledCollectionIds) {
          if (typeof id !== "string") return null;
          ids.add(id);
        }
    }
    for (const reward of summary.rewardWallet) {
      if (reward.status === "available" && reward.termsSnapshot) {
        for (const id of reward.termsSnapshot.entitledCollectionIds)
          ids.add(id);
      }
    }
    const request = buildNudgeCollectionMembershipQuery(productIds, [...ids]);
    if (!request) return null;
    const credential = await fetchShopifyTokenAuthorityCredential({
      shopDomain: before.store.shopDomain,
      installationGeneration: before.store.installationGeneration!,
    });
    const scopes = new Set(
      credential.scope.split(",").map((value) => value.trim()),
    );
    if (
      credential.shopDomain !== before.store.shopDomain ||
      (!scopes.has("read_products") && !scopes.has("write_products"))
    )
      return null;
    const signal = AbortSignal.timeout(5000);
    const response = await fetch(
      getShopifyAdminGraphqlUrl(credential.shopDomain),
      {
        method: "POST",
        cache: "no-store",
        redirect: "error",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": credential.accessToken,
        },
        body: JSON.stringify({
          query: request.query,
          variables: request.variables,
        }),
      },
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    const membership = parseNudgeCollectionMembership(
      request,
      await readBoundedShopifyJson(response, signal),
    );
    if (!membership) return null;
    const after = await readAdmission(storeId);
    if (
      !after ||
      after.store.shopDomain !== before.store.shopDomain ||
      after.store.installationGeneration !==
        before.store.installationGeneration ||
      after.program.id !== before.program.id ||
      after.program.updatedAt.getTime() !== before.program.updatedAt.getTime()
    )
      return null;
    return membership;
  } catch {
    // Optional guidance must not expose credentials, customer identifiers or
    // upstream error payloads, and must not break the ordinary wallet read.
    return null;
  }
}
