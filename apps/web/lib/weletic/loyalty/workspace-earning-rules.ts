import { prisma } from "@/lib/prisma";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import {
  earningRulesResponseSchema,
  shopifyEarningRulesInputSchema,
} from "./earning-rule-contract";
import {
  projectEarningRule,
  projectEarningRuleCurrency,
} from "./earning-rule-projection";
import {
  readEarningRulesInTransaction,
  retireEarningRulesInTransaction,
  saveEarningRulesInTransaction,
} from "./earning-rule-service";
import type { WorkspaceConfigurationAuthority } from "./workspace-configuration";

/** Authority comes exclusively from withWorkspace, including narrowed token scopes. */
export async function manageWorkspaceEarningRulesInTransaction({
  tx,
  authority,
  request,
}: {
  tx: Prisma.TransactionClient;
  authority: WorkspaceConfigurationAuthority;
  request: unknown;
}) {
  const data = shopifyEarningRulesInputSchema.parse(request);
  const permission =
    data.operation === "read" ? "loyalty.read" : "loyalty.write";
  if (!authority.permissions.includes(permission))
    throw new MerchantSettingsError("forbidden");
  const readStore = () =>
    tx.weleticShopifyStore.findFirst({
      where: {
        projectId: authority.workspaceId,
        complianceState: "active",
        installationGeneration: { not: null },
      },
      select: {
        id: true,
        projectId: true,
        installationGeneration: true,
        shopCurrency: true,
      },
    });
  let store = await readStore();
  if (
    !store?.installationGeneration ||
    store.projectId !== authority.workspaceId
  )
    throw new MerchantSettingsError("not_found");
  if (data.operation !== "read") {
    if (
      store.installationGeneration !== data.input.expectedInstallationGeneration
    )
      throw new MerchantSettingsError("conflict");
    const storeId = store.id;
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId,
      action: "loyalty_earning_rule_write",
      expectedInstallationGeneration: data.input.expectedInstallationGeneration,
    });
    store = await readStore();
    if (
      !store ||
      store.id !== storeId ||
      store.projectId !== authority.workspaceId ||
      store.installationGeneration !== data.input.expectedInstallationGeneration
    )
      throw new MerchantSettingsError("conflict");
  }
  const context = {
    tx,
    storeId: store.id,
    installationGeneration: store.installationGeneration!,
  };
  const state =
    data.operation === "read"
      ? await readEarningRulesInTransaction(tx, store.id)
      : data.operation === "save"
        ? await saveEarningRulesInTransaction({ ...context, input: data.input })
        : await retireEarningRulesInTransaction({
            ...context,
            input: data.input,
          });
  const response = earningRulesResponseSchema.safeParse({
    storeId: store.id,
    installationGeneration: store.installationGeneration,
    programId: state.programId,
    shopCurrency: projectEarningRuleCurrency(store.shopCurrency),
    revision: state.revision,
    affectedRuleId: "affectedRuleId" in state ? state.affectedRuleId : null,
    rules: state.rules.map(projectEarningRule),
    capabilities: {
      configure: authority.permissions.includes("loyalty.write"),
    },
  });
  if (!response.success) throw new Error("Earning rules are unavailable");
  return response.data;
}

export function manageWorkspaceEarningRules(
  authority: WorkspaceConfigurationAuthority,
  request: unknown,
) {
  return prisma.$transaction(
    (tx) =>
      manageWorkspaceEarningRulesInTransaction({ tx, authority, request }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
