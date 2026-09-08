import { prisma } from "@/lib/prisma";
import { processOutboxJobsBatch } from "@/lib/weletic/loyalty/outbox";
import "dotenv-flow/config";
import { hostname } from "node:os";
import { runOutboxWorker } from "./outbox-worker-runtime";

const POLL_INTERVAL_MS = 5_000;
const workerId = `loyalty_${hostname()}_${process.pid}`;

let stopping = false;

function requestStop(signal: string) {
  if (!stopping) {
    console.info(
      `[loyalty-outbox] ${signal} received; stopping after this batch`,
    );
  }
  stopping = true;
}

process.on("SIGINT", () => requestStop("SIGINT"));
process.on("SIGTERM", () => requestStop("SIGTERM"));

async function waitForNextPoll() {
  await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}

runOutboxWorker(process.argv.slice(2), {
  workerId,
  findStore: (shopDomain) =>
    prisma.weleticShopifyStore.findUnique({
      where: { shopDomain },
      select: { id: true, shopDomain: true },
    }),
  processBatch: processOutboxJobsBatch,
  shouldStop: () => stopping,
  waitForNextPoll,
  logger: console,
})
  .catch((error) => {
    console.error("[loyalty-outbox] fatal worker error", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    console.info(`[loyalty-outbox] worker ${workerId} stopped`);
  });
