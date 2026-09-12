import { prisma } from "@/lib/prisma";
import { changeShopifyStoreAccess } from "@/lib/weletic/shopify/store-access-operator";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      store: { type: "string" },
      domain: { type: "string" },
      generation: { type: "string" },
      revision: { type: "string" },
      state: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const result = await changeShopifyStoreAccess({
    storeId: values.store,
    shopDomain: values.domain,
    expectedInstallationGeneration: values.generation,
    expectedRevision: Number(values.revision),
    nextState: values.state,
    operator: values.operator,
    reason: values.reason,
    apply: values.apply,
  });
  console.log(JSON.stringify(result));
}

main()
  .catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Store access change failed.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
