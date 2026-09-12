import { prisma } from "@/lib/prisma";
import { bootstrapCompanyStore } from "@/lib/weletic/shopify/company-store-bootstrap";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: "string" },
      shop: { type: "string" },
      pending: { type: "string" },
      generation: { type: "string" },
      revision: { type: "string" },
      operator: { type: "string" },
      reason: { type: "string" },
      "expected-preview": { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  const result = await bootstrapCompanyStore({
    appId: values.app,
    shop: values.shop,
    pendingInstallationId: values.pending,
    expectedInstallationGeneration: values.generation,
    expectedRevision: Number(values.revision),
    operator: values.operator,
    reason: values.reason,
    expectedPreview: values["expected-preview"],
    apply: values.apply,
  });
  // Private operator preview only: no credentials or customer data.
  console.log(JSON.stringify(result));
}
main()
  .catch(() => {
    console.error(
      "Company-store bootstrap failed; privately recheck the pending identity, lifecycle and preview.",
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
