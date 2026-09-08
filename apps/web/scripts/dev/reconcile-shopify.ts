import { AsyncLocalStorage } from "node:async_hooks";
if (typeof (globalThis as any).AsyncLocalStorage !== "function") {
  (globalThis as any).AsyncLocalStorage = AsyncLocalStorage;
}

import "dotenv-flow/config";

import { prisma } from "@/lib/prisma";
import { reconcileWeleticShopifyOrders } from "@/lib/weletic/commerce/reconcile-shopify";
import { reconcileWeleticShopifyDiscounts } from "@/lib/weletic/commerce/reconcile-shopify-discounts";

// ANSI Color Codes for terminal formatting
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  bgGreen: "\x1b[42m\x1b[30m",
  bgYellow: "\x1b[43m\x1b[30m",
  bgRed: "\x1b[41m\x1b[37m",
  bgBlue: "\x1b[44m\x1b[37m",
};

interface ParsedArgs {
  workspaceId?: string;
  type: "orders" | "discounts" | "all";
  autoHeal: boolean;
  dryRun: boolean;
  json: boolean;
  limit: number;
  help: boolean;
}

function parseCommandLineArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  const result: ParsedArgs = {
    type: "all",
    autoHeal: false,
    dryRun: false,
    json: false,
    limit: 100,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--workspaceId" || arg === "-w") {
      result.workspaceId = args[++i];
    } else if (arg.startsWith("--workspaceId=")) {
      result.workspaceId = arg.split("=")[1];
    } else if (arg === "--type" || arg === "-t") {
      const typeVal = args[++i]?.toLowerCase();
      if (
        typeVal === "orders" ||
        typeVal === "discounts" ||
        typeVal === "all"
      ) {
        result.type = typeVal;
      }
    } else if (arg.startsWith("--type=")) {
      const typeVal = arg.split("=")[1]?.toLowerCase();
      if (
        typeVal === "orders" ||
        typeVal === "discounts" ||
        typeVal === "all"
      ) {
        result.type = typeVal;
      }
    } else if (arg === "--auto-heal" || arg === "--heal") {
      result.autoHeal = true;
    } else if (arg === "--dry-run") {
      result.dryRun = true;
      result.autoHeal = false;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--limit" || arg === "-l") {
      result.limit = parseInt(args[++i], 10) || 100;
    } else if (arg.startsWith("--limit=")) {
      result.limit = parseInt(arg.split("=")[1], 10) || 100;
    }
  }

  return result;
}

function printHelp() {
  console.log(`
${colors.bold}${colors.cyan}Weletic <-> Shopify Automated Reconciliation Engine (CLI)${colors.reset}

${colors.bold}Usage:${colors.reset}
  pnpm reconcile:shopify [options]
  tsx scripts/dev/reconcile-shopify.ts [options]

${colors.bold}Options:${colors.reset}
  -w, --workspaceId <id>       Target specific workspace / project ID (defaults to all active stores)
  -t, --type <type>            Reconciliation target: "orders", "discounts", or "all" (default: "all")
      --auto-heal, --heal      Automatically repair detected drifts across DB and Shopify
      --dry-run                Scan and report drifts without modifying state (forces autoHeal=false)
      --json                   Output structured JSON results for programmatic ingestion / CI
  -l, --limit <number>         Maximum batch limit for records to reconcile (default: 100)
  -h, --help                   Display this help message

${colors.bold}Examples:${colors.reset}
  pnpm reconcile:shopify --workspaceId ws_clw1234567 --type all --auto-heal
  pnpm reconcile:shopify --type discounts --dry-run
  pnpm reconcile:shopify --type orders --json
`);
}

async function main() {
  const args = parseCommandLineArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Find target stores
  const stores = await prisma.weleticShopifyStore.findMany({
    where: {
      ...(args.workspaceId && {
        OR: [{ projectId: args.workspaceId }, { id: args.workspaceId }],
      }),
      syncStatus: "succeeded",
    },
    include: {
      project: { select: { id: true, name: true, slug: true } },
      program: { select: { id: true, name: true } },
    },
  });

  if (stores.length === 0) {
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            error: "NO_ACTIVE_STORES",
            message: `No active Shopify stores found${args.workspaceId ? ` for workspace ${args.workspaceId}` : ""}.`,
          },
          null,
          2,
        ),
      );
    } else {
      console.error(
        `${colors.red}${colors.bold}Error:${colors.reset} No active Shopify stores found${args.workspaceId ? ` for workspace: ${args.workspaceId}` : ""}.`,
      );
    }
    process.exit(1);
  }

  const effectiveAutoHeal = args.dryRun ? false : args.autoHeal;
  const executionSummary: Array<{
    storeId: string;
    workspaceId: string;
    shopDomain: string;
    orders?: any;
    discounts?: any;
  }> = [];

  if (!args.json) {
    console.log(`
${colors.bold}${colors.cyan}═══════════════════════════════════════════════════════════════════════${colors.reset}
${colors.bold}${colors.cyan}🛍️   WELETIC <-> SHOPIFY AUTOMATED RECONCILIATION ENGINE${colors.reset}
${colors.bold}${colors.cyan}═══════════════════════════════════════════════════════════════════════${colors.reset}
  Mode:       ${args.dryRun ? `${colors.yellow}DRY-RUN (Scan Only)${colors.reset}` : effectiveAutoHeal ? `${colors.green}ACTIVE AUTO-HEALING${colors.reset}` : `${colors.blue}SCAN ONLY${colors.reset}`}
  Target:     ${colors.magenta}${args.type.toUpperCase()}${colors.reset}
  Stores:     ${colors.bold}${stores.length}${colors.reset} store(s) identified
`);
  }

  for (const store of stores) {
    if (!args.json) {
      console.log(
        `${colors.bold}───────────────────────────────────────────────────────────────────────${colors.reset}`,
      );
      console.log(
        `🏪 Store: ${colors.bold}${store.shopDomain}${colors.reset} (${store.project?.name || store.projectId})`,
      );
      console.log(
        `   Workspace ID: ${colors.dim}${store.projectId}${colors.reset} | Program: ${colors.dim}${store.program?.name || store.programId}${colors.reset}`,
      );
      console.log(
        `${colors.bold}───────────────────────────────────────────────────────────────────────${colors.reset}`,
      );
    }

    const storeSummary: {
      storeId: string;
      workspaceId: string;
      shopDomain: string;
      orders?: any;
      discounts?: any;
    } = {
      storeId: store.id,
      workspaceId: store.projectId,
      shopDomain: store.shopDomain,
    };

    // 1. Order Financial Reconciliation
    if (args.type === "orders" || args.type === "all") {
      if (!args.json) {
        process.stdout.write(`⏳ Scanning and reconciling commerce orders... `);
      }
      try {
        const orderResult = await reconcileWeleticShopifyOrders({
          workspaceId: store.projectId,
          limit: args.limit,
        });
        storeSummary.orders = orderResult;

        if (!args.json) {
          console.log(`${colors.green}DONE${colors.reset}`);
          console.log(
            `   • Orders Checked:   ${colors.bold}${orderResult.checked}${colors.reset}`,
          );
          console.log(
            `   • Open Issues:      ${orderResult.open > 0 ? `${colors.red}${orderResult.open}${colors.reset}` : `${colors.green}0${colors.reset}`}`,
          );
          console.log(
            `   • Resolved Issues:  ${colors.green}${orderResult.resolved}${colors.reset}`,
          );
        }
      } catch (err: any) {
        storeSummary.orders = { error: err.message || String(err) };
        if (!args.json) {
          console.log(`${colors.red}FAILED${colors.reset}`);
          console.error(
            `   ${colors.red}Order error:${colors.reset}`,
            err.message || err,
          );
        }
      }
    }

    // 2. Discount Codes Reconciliation
    if (args.type === "discounts" || args.type === "all") {
      if (!args.json) {
        process.stdout.write(`⏳ Scanning and reconciling discount codes... `);
      }
      try {
        const discountResult = await reconcileWeleticShopifyDiscounts({
          workspaceId: store.projectId,
          storeId: store.id,
          autoHeal: effectiveAutoHeal,
          limit: args.limit,
        });
        storeSummary.discounts = discountResult;

        if (!args.json) {
          console.log(`${colors.green}DONE${colors.reset}`);
          console.log(
            `   • Total Scanned:    ${colors.bold}${discountResult.scannedCount}${colors.reset}`,
          );
          console.log(
            `   • In-Sync:          ${colors.green}${colors.bold}${discountResult.driftStates.inSync}${colors.reset}`,
          );
          console.log(`   • Desync Breakdown:`);
          console.log(
            `     - Orphaned in Weletic (Missing in Shopify):  ${discountResult.driftStates.orphanedInWeletic > 0 ? `${colors.red}${discountResult.driftStates.orphanedInWeletic}${colors.reset}` : `${colors.gray}0${colors.reset}`}`,
          );
          console.log(
            `     - Orphaned in Shopify (Missing in DB):       ${discountResult.driftStates.orphanedInShopify > 0 ? `${colors.yellow}${discountResult.driftStates.orphanedInShopify}${colors.reset}` : `${colors.gray}0${colors.reset}`}`,
          );
          console.log(
            `     - Status Desync (Shopify Active / DB Off):   ${discountResult.driftStates.statusDesyncShopifyActive > 0 ? `${colors.yellow}${discountResult.driftStates.statusDesyncShopifyActive}${colors.reset}` : `${colors.gray}0${colors.reset}`}`,
          );
          console.log(
            `     - Status Desync (DB Active / Shopify Off):   ${discountResult.driftStates.statusDesyncShopifyInactive > 0 ? `${colors.yellow}${discountResult.driftStates.statusDesyncShopifyInactive}${colors.reset}` : `${colors.gray}0${colors.reset}`}`,
          );
          console.log(
            `   • Manual Shopify Cleanup: ${discountResult.manualCleanupCount > 0 ? `${colors.yellow}${colors.bold}${discountResult.manualCleanupCount}${colors.reset} ${colors.gray}(report-only)${colors.reset}` : `${colors.gray}0${colors.reset}`}`,
          );

          if (discountResult.issues.length > 0) {
            console.log(
              `\n   ${colors.bold}Detected Drift Issues (${discountResult.issues.length}):${colors.reset}`,
            );
            for (const issue of discountResult.issues) {
              const sevBadge =
                issue.severity === "critical"
                  ? `${colors.bgRed} CRITICAL ${colors.reset}`
                  : `${colors.bgYellow} WARNING  ${colors.reset}`;
              const healBadge = issue.healed
                ? `${colors.green}[HEALED: ${issue.healingAction || "repaired"}]${colors.reset}`
                : issue.details.requiresManualCleanup === true
                  ? `${colors.yellow}[MANUAL SHOPIFY CLEANUP]${colors.reset}`
                  : `${colors.red}[UNRESOLVED]${colors.reset}`;

              console.log(
                `     ${sevBadge} Code: ${colors.bold}${issue.code}${colors.reset} | State: ${colors.magenta}${issue.driftState}${colors.reset} ${healBadge}`,
              );
            }
          }

          if (effectiveAutoHeal && discountResult.healedCount > 0) {
            console.log(
              `\n   ${colors.bgGreen} AUTO-HEAL SUMMARY ${colors.reset} Successfully healed ${colors.bold}${discountResult.healedCount}${colors.reset} out-of-sync discount(s).`,
            );
          }
          if (discountResult.manualCleanupCount > 0) {
            console.log(
              `   ${colors.yellow}No Shopify discount was changed automatically. Verify ownership in Shopify Admin, clean up the exact code manually, then rerun reconciliation.${colors.reset}`,
            );
          }
        }
      } catch (err: any) {
        storeSummary.discounts = { error: err.message || String(err) };
        if (!args.json) {
          console.log(`${colors.red}FAILED${colors.reset}`);
          console.error(
            `   ${colors.red}Discount error:${colors.reset}`,
            err.message || err,
          );
        }
      }
    }

    executionSummary.push(storeSummary);
  }

  if (args.json) {
    console.log(JSON.stringify({ stores: executionSummary }, null, 2));
  } else {
    console.log(`
${colors.bold}${colors.cyan}═══════════════════════════════════════════════════════════════════════${colors.reset}
${colors.bold}${colors.green}✓ Reconciliation run completed across ${stores.length} store(s).${colors.reset}
${colors.bold}${colors.cyan}═══════════════════════════════════════════════════════════════════════${colors.reset}
`);
  }
}

main().catch((error) => {
  console.error("Unhandled CLI Error:", error);
  process.exit(1);
});
