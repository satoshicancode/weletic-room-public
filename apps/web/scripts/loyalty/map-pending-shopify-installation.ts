import { prisma } from "@/lib/prisma";
import { mapPendingInstallation } from "@/lib/weletic/shopify/installation-admission-operator";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      shop: { type: "string" },
      store: { type: "string" },
      pending: { type: "string" },
      generation: { type: "string" },
      revision: { type: "string" },
      "store-revision": { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const result = await mapPendingInstallation({
    shop: values.shop,
    storeId: values.store,
    pendingInstallationId: values.pending,
    expectedInstallationGeneration: values.generation,
    expectedRevision: Number(values.revision),
    expectedStoreAccessRevision: Number(values["store-revision"]),
    operator: values.operator,
    reason: values.reason,
    apply: values.apply,
  });
  console.log(JSON.stringify(result));
}
main()
  .catch(() => {
    console.error(
      "Pending installation mapping failed; inspect the current identity and revision privately.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
