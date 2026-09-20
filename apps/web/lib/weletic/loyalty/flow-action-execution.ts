import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { hasShopifyCustomerPrivacyTombstone } from "../shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "../shopify/store-compliance-state";
import {
  FlowPointsActionSchema,
  flowPointsActionDigest,
  flowPointsActionRunKey,
} from "./flow-action-contract";
import { consumeFlowPointsBudget } from "./flow-action-grant-contract";
import { readFlowGrantQuantities } from "./flow-action-grant-storage";
import { appendPointsLedgerEntryWithReceipt } from "./ledger";
import { enqueueOutboxJob } from "./outbox";
import { lockLoyaltyProgramRow } from "./program-write-fence";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";

export class FlowActionExecutionError extends Error {
  constructor(
    readonly code: "unavailable" | "run_conflict" | "balance_overflow",
  ) {
    super(code);
    this.name = "FlowActionExecutionError";
  }
}

/** Internal transaction primitive, NOT a request handler. The caller must:
 * - authenticate the exact request bytes using the configured public app;
 * - resolve AND verify paired Shopify shop ID/domain to this store;
 * - acquire customer settlement/privacy locks before the Serializable SQL tx.
 * Scope comes from that resolution, never from an untrusted grant/customer ID.
 * Keep receipt, budget, ledger and outbox in this same transaction.
 */
export async function executeFlowPointsActionInTransaction({
  tx,
  scope,
  input,
}: {
  tx: Prisma.TransactionClient;
  scope: {
    storeId: string;
    appId: string;
    installationGeneration: string;
  };
  input: unknown;
}) {
  const action = FlowPointsActionSchema.parse(input);
  const { storeId, appId, installationGeneration } = scope;
  if (!storeId || !appId || !installationGeneration)
    throw new FlowActionExecutionError("unavailable");
  // Lock identity before reading receipts, but do not require new-write
  // eligibility to acknowledge a transaction that has already committed.
  const stores = await tx.$queryRaw<
    Array<{ installationGeneration: string | null }>
  >(Prisma.sql`
    SELECT installationGeneration FROM WeleticShopifyStore
    WHERE id = ${storeId} FOR UPDATE`);
  if (
    stores.length !== 1 ||
    stores[0].installationGeneration !== installationGeneration
  )
    throw new FlowActionExecutionError("unavailable");
  const runKey = flowPointsActionRunKey(action);
  const payloadDigest = flowPointsActionDigest(action);
  const prior = await tx.weleticShopifyFlowActionRun.findUnique({
    where: { storeId_appId_runKey: { storeId, appId, runKey } },
  });
  if (prior) {
    if (prior.payloadDigest !== payloadDigest)
      throw new FlowActionExecutionError("run_conflict");
    // No shopper lookup or re-enrollment: receipts survive erasure and reinstall.
    return { status: "replayed" as const, runId: prior.id };
  }
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId,
    expectedInstallationGeneration: installationGeneration,
    action: "flow_points_adjustment",
  });
  const program = await lockLoyaltyProgramRow({ tx, storeId, mode: "active" });
  const grantId = action.properties.grant_id;
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM WeleticShopifyFlowPointsGrant WHERE id = ${grantId}
    AND storeId = ${storeId} AND appId = ${appId}
    AND installationGeneration = ${installationGeneration} FOR UPDATE`);
  const grant = await tx.weleticShopifyFlowPointsGrant.findUnique({
    where: { id: grantId },
  });
  const rows = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  const now = rows[0]?.now;
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !grant ||
    grant.storeId !== storeId ||
    grant.appId !== appId ||
    grant.installationGeneration !== installationGeneration ||
    grant.revokedAt ||
    grant.expiresAt <= now
  )
    throw new FlowActionExecutionError("unavailable");

  const customerId = action.properties.customer_id;
  const shoppers = await tx.weleticShopper.findMany({
    where: {
      storeId,
      shopifyCustomerId: {
        in: [customerId, customerId.slice("gid://shopify/Customer/".length)],
      },
    },
    take: 2,
  });
  const shopper = shoppers[0];
  if (
    shoppers.length !== 1 ||
    (await hasShopifyCustomerPrivacyTombstone({
      tx,
      storeId,
      shopifyCustomerId: customerId,
      email: shopper.email,
      now,
    }))
  )
    throw new FlowActionExecutionError("unavailable");
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM WeleticLoyaltyAccount WHERE storeId = ${storeId}
    AND shopperId = ${shopper.id} FOR UPDATE`);
  const account = await tx.weleticLoyaltyAccount.findUnique({
    where: { shopperId: shopper.id },
  });
  if (
    !account ||
    account.storeId !== storeId ||
    account.programId !== program.id ||
    account.status !== "active" ||
    hasShopifyCustomerRedactionTombstone(account.metadata)
  )
    throw new FlowActionExecutionError("unavailable");
  const pointsDelta = BigInt(action.properties.points_delta);
  const balance = account.cachedPointsBalance + pointsDelta;
  if (
    balance < BigInt("-9223372036854775808") ||
    balance > BigInt("9223372036854775807")
  )
    throw new FlowActionExecutionError("balance_overflow");
  const used = consumeFlowPointsBudget({
    ...readFlowGrantQuantities(grant),
    allowCredit: grant.allowCredit,
    allowDebit: grant.allowDebit,
    pointsDelta,
  });
  const id = createHash("sha256")
    .update(JSON.stringify(["flow-action-v1", storeId, appId, runKey]))
    .digest("hex");
  const receipt = await appendPointsLedgerEntryWithReceipt({
    tx,
    storeId,
    accountId: account.id,
    entryType: "MANUAL_ADJUSTMENT",
    pointsDelta,
    referenceType: "SHOPIFY_FLOW_ADJUSTMENT",
    referenceId: id,
    idempotencyKey: `flow:${id}`,
    reason: "Owner-authorized Shopify Flow adjustment",
  });
  // An orphan ledger entry is an integrity error, not permission to reconsume.
  if (!receipt.created) throw new FlowActionExecutionError("run_conflict");
  await tx.weleticShopifyFlowPointsGrant.update({
    where: { id: grant.id },
    data: { absolutePointsUsed: used.toString() },
  });
  await tx.weleticShopifyFlowActionRun.create({
    data: {
      id,
      storeId,
      appId,
      installationGeneration,
      runKey,
      payloadDigest,
      grantId,
      grantRevision: grant.revision,
      ledgerEntryId: receipt.entry.id,
      pointsDelta,
    },
  });
  await enqueueOutboxJob({
    tx,
    storeId,
    jobType: "METAFIELD_SYNC",
    payload: { accountId: account.id, triggerReason: "flow_points_adjustment" },
    idempotencyKey: `flow_sync:${id}`,
  });
  return { status: "applied" as const, runId: id };
}
