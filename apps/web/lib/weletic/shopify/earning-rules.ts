import type { Prisma } from "@prisma/client";
import {
  earningRulesResponseSchema,
  shopifyEarningRulesInputSchema,
} from "../loyalty/earning-rule-contract";
import {
  projectEarningRule,
  projectEarningRuleCurrency,
} from "../loyalty/earning-rule-projection";
import {
  readEarningRulesInTransaction,
  retireEarningRulesInTransaction,
  saveEarningRulesInTransaction,
} from "../loyalty/earning-rule-service";
import { EarningRuleWriteError } from "../loyalty/earning-rule-writer";
import { readSettingsCapabilities } from "./settings-capabilities";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

/** Called only after signature verification, within the route's Serializable TX. */
export async function manageShopifyEarningRulesInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = shopifyEarningRulesInputSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission:
      data.operation === "read" ? "loyalty.read" : "loyalty.configure",
  });
  if (data.operation !== "read") {
    if (
      data.input.expectedInstallationGeneration !== actor.installationGeneration
    )
      throw new EarningRuleWriteError({
        code: "conflict",
        message: "Installation changed",
      });
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: actor.storeId,
      action: "loyalty_earning_rule_write",
      expectedInstallationGeneration: actor.installationGeneration,
    });
  }
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: { projectId: true, shopCurrency: true },
  });
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const context = {
    tx,
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
  };
  const state =
    data.operation === "read"
      ? await readEarningRulesInTransaction(tx, actor.storeId)
      : data.operation === "save"
        ? await saveEarningRulesInTransaction({ ...context, input: data.input })
        : await retireEarningRulesInTransaction({
            ...context,
            input: data.input,
          });
  const capabilities = await readSettingsCapabilities(tx, actor);
  return earningRulesResponseSchema.parse({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    programId: state.programId,
    shopCurrency: projectEarningRuleCurrency(store.shopCurrency),
    revision: state.revision,
    affectedRuleId: "affectedRuleId" in state ? state.affectedRuleId : null,
    rules: state.rules.map(projectEarningRule),
    capabilities: { configure: capabilities.loyalty },
  });
}
