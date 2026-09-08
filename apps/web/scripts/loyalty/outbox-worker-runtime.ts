import type {
  OutboxBatchResult,
  OutboxWorkerOptions,
} from "@/lib/weletic/loyalty/outbox-worker";

const SHOP_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const BATCH_SIZE = 50;

export function parseOutboxWorkerArgs(args: string[]): {
  shopDomain?: string;
  once: boolean;
} {
  let shopDomain: string | undefined;
  let once = false;

  for (const arg of args) {
    if (arg === "--once") {
      if (once) throw new Error("Duplicate --once flag");
      once = true;
    } else if (arg.startsWith("--store=")) {
      if (shopDomain !== undefined) throw new Error("Duplicate --store flag");
      shopDomain = arg.slice("--store=".length);
      if (shopDomain !== shopDomain.trim() || !SHOP_DOMAIN.test(shopDomain)) {
        throw new Error(
          "--store must be an exact lowercase myshopify.com domain, without a URL, path, or whitespace",
        );
      }
    } else {
      throw new Error(
        "Unknown argument; supported flags: --store=<domain> --once",
      );
    }
  }

  return { shopDomain, once };
}

type BatchSummary = Pick<
  OutboxBatchResult,
  "processed" | "succeeded" | "failed" | "deadLettered"
>;

interface OutboxWorkerDependencies {
  workerId: string;
  findStore: (
    shopDomain: string,
  ) => Promise<{ id: string; shopDomain: string } | null>;
  processBatch: (
    options: Pick<OutboxWorkerOptions, "storeId" | "batchSize" | "workerId">,
  ) => Promise<BatchSummary>;
  shouldStop: () => boolean;
  waitForNextPoll: () => Promise<void>;
  logger: Pick<Console, "info" | "error">;
}

/** Runs the production worker loop; dependencies keep CLI safety testable offline. */
export async function runOutboxWorker(
  args: string[],
  dependencies: OutboxWorkerDependencies,
): Promise<void> {
  const { shopDomain, once } = parseOutboxWorkerArgs(args);
  const {
    workerId,
    findStore,
    processBatch,
    shouldStop,
    waitForNextPoll,
    logger,
  } = dependencies;
  let storeId: string | undefined;
  if (shopDomain !== undefined) {
    const store = await findStore(shopDomain);
    // Do not let case-insensitive DB matching or aliases widen an exact CLI scope.
    if (!store || store.shopDomain !== shopDomain || !store.id) {
      throw new Error(`No store matches the exact domain ${shopDomain}`);
    }
    storeId = store.id;
  }

  const scope = shopDomain
    ? `store=${shopDomain} storeId=${storeId}`
    : "GLOBAL (all stores)";
  logger.info(
    `[loyalty-outbox] worker ${workerId} started scope=${scope} mode=${once ? "once" : "continuous"}`,
  );

  while (!shouldStop()) {
    let result: BatchSummary | undefined;
    try {
      result = await processBatch({
        batchSize: BATCH_SIZE,
        workerId,
        ...(storeId === undefined ? {} : { storeId }),
      });
      if (once || result.processed > 0 || result.deadLettered > 0) {
        logger.info(
          `[loyalty-outbox] processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed} deadLettered=${result.deadLettered}`,
        );
      }
    } catch (error) {
      logger.error("[loyalty-outbox] batch failed", error);
      if (once) throw error;
    }

    if (once) {
      if (result && (result.failed > 0 || result.deadLettered > 0)) {
        throw new Error(
          `Outbox batch incomplete: failed=${result.failed} deadLettered=${result.deadLettered}`,
        );
      }
      return;
    }
    if (!shouldStop()) await waitForNextPoll();
  }
}
