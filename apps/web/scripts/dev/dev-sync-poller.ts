import { AsyncLocalStorage } from "node:async_hooks";
if (typeof (globalThis as any).AsyncLocalStorage !== "function") {
  (globalThis as any).AsyncLocalStorage = AsyncLocalStorage;
}

import { prisma } from "@/lib/prisma";
import { reconcileWeleticShopifyDiscounts } from "@/lib/weletic/commerce/reconcile-shopify-discounts";
import "dotenv-flow/config";

const POLL_INTERVAL_MS = 30_000; // 30 seconds

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

async function runSyncCycle() {
  try {
    const stores = await prisma.weleticShopifyStore.findMany({
      where: {
        syncStatus: "succeeded",
      },
      select: {
        id: true,
        shopDomain: true,
        projectId: true,
      },
    });

    if (stores.length === 0) return;

    for (const store of stores) {
      if (!store.projectId) continue;

      try {
        const result = await reconcileWeleticShopifyDiscounts({
          workspaceId: store.projectId,
          storeId: store.id,
          autoHeal: true,
        });

        if (result.healedCount > 0) {
          console.log(
            `${colors.bold}${colors.green}[Shopify Auto-Sync]${colors.reset} 🔄 Automatically healed ${result.healedCount} out-of-sync discount(s) for ${store.shopDomain}`,
          );
        }
      } catch (storeErr: any) {
        // Silently skip if store lacks active dev connection
      }
    }
  } catch (err) {
    // Suppress background poll errors
  }
}

console.log(
  `${colors.bold}${colors.cyan}[Shopify Auto-Sync Daemon]${colors.reset} 🛡️ Continuous 2-way reconciliation poller started (Interval: 30s).`,
);

// Initial run after 5s startup delay
setTimeout(runSyncCycle, 5000);

// Recurring interval
setInterval(runSyncCycle, POLL_INTERVAL_MS);
