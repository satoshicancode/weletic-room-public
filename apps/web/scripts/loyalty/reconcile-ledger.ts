import { prisma } from "@/lib/prisma";
import {
  auditStoreLedgers,
  StoreAuditSummary,
} from "@/lib/weletic/loyalty/reconciliation";
import * as fs from "fs";
import * as path from "path";

export async function runReconciliationCLI(customArgs?: string[]) {
  const args = customArgs || process.argv.slice(2);
  const autoRepair = !args.includes("--no-repair");
  const quarantineFatal = !args.includes("--no-quarantine");
  const storeArg = args.find((a) => a.startsWith("--store="));
  const targetStoreId = storeArg ? storeArg.split("=")[1] : undefined;

  console.log(
    `[Reconciliation CLI] Starting ledger audit (autoRepair=${autoRepair}, quarantineFatal=${quarantineFatal})...`,
  );

  const stores = targetStoreId
    ? [{ id: targetStoreId }]
    : await prisma.weleticShopifyStore.findMany({ select: { id: true } });

  console.log(`[Reconciliation CLI] Auditing ${stores.length} store(s)...`);

  const reports: StoreAuditSummary[] = [];

  for (const store of stores) {
    const summary = await auditStoreLedgers(store.id, {
      autoRepair,
      quarantineFatal,
    });
    reports.push(summary);

    console.log(`\n--- Store: ${store.id} ---`);
    console.log(`Total Accounts: ${summary.totalAccounts}`);
    console.log(`Clean: ${summary.cleanAccounts}`);
    console.log(`Auto-Repaired: ${summary.repairedAccounts}`);
    console.log(`Quarantined: ${summary.quarantinedAccounts}`);
    console.log(`Anomalies Found: ${summary.anomalies.length}`);
  }

  // Output JSON report
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.join(process.cwd(), "reports", "loyalty-recon");
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const reportPath = path.join(outputDir, `recon-report-${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2), "utf8");
    console.log(`\n[Reconciliation CLI] Full report written to: ${reportPath}`);
  } catch (err) {
    console.warn(`[Reconciliation CLI] Could not write report file:`, err);
  }

  return reports;
}

if (typeof require !== "undefined" && require.main === module) {
  runReconciliationCLI()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[Reconciliation CLI] Fatal error:", err);
      process.exit(1);
    });
}
