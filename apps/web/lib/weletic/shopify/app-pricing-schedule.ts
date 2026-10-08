import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { isCoreLaunch } from "../core-launch-policy";
import { reconcileSubscribedInstallation } from "./app-pricing-service";
export const subscriptionSweepSchema = z
  .object({
    appId: z.string().min(1).max(191),
    scheduledAt: z.string().datetime(),
    afterId: z.string().min(1).max(191).optional(),
  })
  .strict();
export const subscriptionJobSchema = subscriptionSweepSchema
  .omit({ afterId: true })
  .extend({
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
  })
  .strict();
const pageSize = 100;
function current(input: { appId: string; scheduledAt: string }) {
  const age = Date.now() - Date.parse(input.scheduledAt);
  return (
    isCoreLaunch() &&
    input.appId === process.env.SHOPIFY_API_KEY &&
    age >= -60_000 &&
    age < 10 * 60_000
  );
}
export async function listSubscriptionRefreshPage(value: unknown) {
  const input = subscriptionSweepSchema.parse(value);
  if (!current(input)) return { jobs: [], nextCursor: null };
  const stores = await prisma.weleticShopifyStore.findMany({
    where: {
      id: input.afterId ? { gt: input.afterId } : undefined,
      complianceState: "active",
      installationGeneration: { not: null },
      pendingInstallation: { is: { appId: input.appId, state: "mapped" } },
    },
    select: { id: true, installationGeneration: true },
    orderBy: { id: "asc" },
    take: pageSize,
  });
  return {
    jobs: stores.map((store) => ({
      storeId: store.id,
      installationGeneration: store.installationGeneration!,
      appId: input.appId,
      scheduledAt: input.scheduledAt,
    })),
    nextCursor:
      stores.length === pageSize ? stores[stores.length - 1].id : null,
  };
}
export async function refreshScheduledSubscription(value: unknown) {
  const input = subscriptionJobSchema.parse(value);
  if (!current(input)) return;
  const store = await prisma.weleticShopifyStore.findFirst({
    where: {
      id: input.storeId,
      installationGeneration: input.installationGeneration,
      complianceState: "active",
    },
    select: { shopDomain: true, pendingInstallation: { select: { id: true } } },
  });
  if (!store || !store.pendingInstallation) return;
  // One-minute sweep, refresh near minute four: retain the five-minute maximum
  // authority lifetime while leaving room for provider latency and queue jitter.
  const snapshot = await prisma.weleticShopifySubscriptionSnapshot.findFirst({
    where: {
      appId: input.appId,
      pendingInstallationId: store.pendingInstallation.id,
      installationGeneration: input.installationGeneration,
    },
    select: { status: true, validUntil: true },
  });
  if (
    snapshot &&
    ["paid", "private_free", "development"].includes(snapshot.status) &&
    snapshot.validUntil &&
    snapshot.validUntil.getTime() > Date.now() + 90_000
  )
    return;
  const result = await reconcileSubscribedInstallation(
    store.shopDomain,
    fetch,
    input.installationGeneration,
  );
  if (result.status === "unavailable")
    throw new Error("Subscription verification unavailable");
}
