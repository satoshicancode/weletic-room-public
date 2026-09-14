import { runOutboxWorker } from "../../apps/web/scripts/loyalty/outbox-worker-runtime";

// Exercise the production polling/shutdown loop without importing Prisma,
// production transports, installation secrets or the live CLI entrypoint.
let stopping = false;
let batches = 0;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});
runOutboxWorker(["--store=container-probe.myshopify.com"], {
  workerId: "synthetic-container-worker",
  findStore: async (shopDomain) => ({ id: "synthetic-store", shopDomain }),
  processBatch: async () => {
    batches += 1;
    console.info("Synthetic batch started");
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { processed: 0, succeeded: 0, failed: 0, deadLettered: 0 };
  },
  shouldStop: () => stopping || batches >= 3,
  waitForNextPoll: () => new Promise((resolve) => setTimeout(resolve, 100)),
  logger: console,
})
  .then(() => console.info("Synthetic worker stopped after batch completion"))
  .catch(() => {
    console.error("Synthetic worker probe failed");
    process.exitCode = 1;
  });
