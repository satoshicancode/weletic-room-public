import { prisma } from "@/lib/prisma";
import {
  auditHistoricalBackfill,
  repairHistoricalBackfillStore,
} from "@/lib/weletic/loyalty/backfill-repair";

type CliOptions = {
  apply: boolean;
  environment: string | null;
  merchantConfirmation: string | null;
  store: string | null;
};

function readOptions(argv: string[]): CliOptions {
  const value = (name: string) =>
    argv
      .find((argument) => argument.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null;
  return {
    apply: argv.includes("--apply"),
    environment: value("--environment"),
    merchantConfirmation: value("--merchant-confirmation"),
    store: value("--store"),
  };
}

async function resolveStore(value: string) {
  return prisma.weleticShopifyStore.findFirst({
    where: { OR: [{ id: value }, { shopDomain: value }] },
    select: { id: true, shopDomain: true },
  });
}

async function main() {
  const options = readOptions(process.argv.slice(2));
  if (!options.apply) {
    const store = options.store ? await resolveStore(options.store) : null;
    if (options.store && !store) {
      throw new Error(`Shopify store '${options.store}' was not found.`);
    }
    const report = await auditHistoricalBackfill({
      ...(store ? { storeId: store.id } : {}),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode =
      report.totals.unresolved > 0 ||
      report.totals.replayPending > 0 ||
      report.totals.repairable > 0
        ? 2
        : 0;
    return;
  }

  if (!options.store) {
    throw new Error(
      "--store=<store ID or shop domain> is required with --apply",
    );
  }
  if (
    !options.environment ||
    !["staging", "production"].includes(options.environment)
  ) {
    throw new Error(
      "--environment=staging or --environment=production is required with --apply",
    );
  }
  const store = await resolveStore(options.store);
  if (!store)
    throw new Error(`Shopify store '${options.store}' was not found.`);
  if (options.merchantConfirmation !== store.shopDomain) {
    throw new Error(
      `--merchant-confirmation must exactly equal '${store.shopDomain}'`,
    );
  }

  const result = await repairHistoricalBackfillStore(store.id);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode =
    result.report.totals.unresolved > 0 ||
    result.report.totals.replayPending > 0 ||
    result.report.totals.repairable > 0
      ? 2
      : 0;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
