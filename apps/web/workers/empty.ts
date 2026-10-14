// Edge-safe stub for server-only and native Node markers in Cloudflare Workers
import { AsyncLocalStorage } from "node:async_hooks";

if (typeof globalThis.AsyncLocalStorage === "undefined") {
  (
    globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }
  ).AsyncLocalStorage = AsyncLocalStorage;
}

const emptyStub = {};
export default emptyStub;
export {};
