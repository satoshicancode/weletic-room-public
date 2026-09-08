import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  rewardCatalogContainSchema,
  rewardCatalogWriteSchema,
} from "./reward-catalog-contract";
import { projectRewardCatalogEntry } from "./reward-catalog-projection";
import {
  containRewardDefinition,
  createRewardDefinition,
  RewardDefinitionConflictError,
  updateRewardDefinition,
} from "./rewards";

/** Internal state only. Gateways must authorize and project the response. */
export async function readRewardCatalogInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: { shopCurrency: true },
  });
  if (!store) throw new Error("Reward catalog store is unavailable");
  const shopCurrency =
    store.shopCurrency && /^[A-Z]{3}$/.test(store.shopCurrency)
      ? store.shopCurrency
      : null;
  const rewards = await tx.weleticRewardDefinition.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
  });
  const revision = createHash("sha256")
    .update(
      JSON.stringify(
        ["reward-catalog-v1", storeId, store.shopCurrency, rewards],
        (_key, value) => {
          if (typeof value === "bigint") return value.toString();
          if (value && typeof value === "object" && !Array.isArray(value))
            return Object.fromEntries(
              Object.entries(value).sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              ),
            );
          return value;
        },
      ),
    )
    .digest("hex");
  return { revision, rewards, shopCurrency };
}

export async function containRewardCatalogInTransaction({
  tx,
  storeId,
  installationGeneration,
  input,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string;
  input: unknown;
}) {
  const data = rewardCatalogContainSchema.parse(input);
  if (data.expectedInstallationGeneration !== installationGeneration)
    throw new RewardDefinitionConflictError();
  const state = await readRewardCatalogInTransaction(tx, storeId);
  if (
    state.revision !== data.expectedRevision ||
    !state.rewards.some((reward) => reward.id === data.rewardId)
  )
    throw new RewardDefinitionConflictError();
  await containRewardDefinition({
    tx,
    storeId,
    id: data.rewardId,
    status: data.status,
  });
  return {
    ...(await readRewardCatalogInTransaction(tx, storeId)),
    affectedRewardId: data.rewardId,
  };
}

/** Caller authorizes, fences/rechecks store binding and owns the transaction.
 * Never invokes Shopify, creates a ledger entry or changes issued snapshots.
 */
export async function saveRewardCatalogInTransaction({
  tx,
  storeId,
  installationGeneration,
  input,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  installationGeneration: string;
  input: unknown;
}) {
  const data = rewardCatalogWriteSchema.parse(input);
  if (data.expectedInstallationGeneration !== installationGeneration)
    throw new RewardDefinitionConflictError();
  const state = await readRewardCatalogInTransaction(tx, storeId);
  if (!state.shopCurrency || state.revision !== data.expectedRevision)
    throw new RewardDefinitionConflictError();
  if (data.rewardId !== null) {
    const existing = state.rewards.find(
      (reward) => reward.id === data.rewardId,
    );
    if (!existing || projectRewardCatalogEntry(existing).fields === null)
      throw new RewardDefinitionConflictError();
  }
  const {
    purchaseType,
    subscriptionCadence,
    subscriptionPaymentLimit,
    ...rewardFields
  } = data.reward;
  const fields = {
    ...rewardFields,
    pointsCost: BigInt(data.reward.pointsCost),
    pointsStep:
      data.reward.pointsStep === null ? null : BigInt(data.reward.pointsStep),
    minPointsCost:
      data.reward.minPointsCost === null
        ? null
        : BigInt(data.reward.minPointsCost),
    maxPointsCost:
      data.reward.maxPointsCost === null
        ? null
        : BigInt(data.reward.maxPointsCost),
    purchasePolicy: {
      purchaseType,
      subscriptionCadence,
      subscriptionPaymentLimit,
    },
  };
  let affectedId: string;
  if (data.rewardId !== null) {
    const saved = await updateRewardDefinition({
      tx,
      storeId,
      id: data.rewardId,
      data: fields,
    });
    affectedId = saved.id;
  } else {
    const saved = await createRewardDefinition({ tx, storeId, ...fields });
    affectedId = saved.id;
    // The legacy writer defaults active. Preserve an explicit inactive/archive
    // request atomically before any other transaction can observe the new row.
    if (fields.status !== "active")
      await updateRewardDefinition({
        tx,
        storeId,
        id: saved.id,
        data: { status: fields.status },
      });
  }
  return {
    ...(await readRewardCatalogInTransaction(tx, storeId)),
    affectedRewardId: affectedId,
  };
}
