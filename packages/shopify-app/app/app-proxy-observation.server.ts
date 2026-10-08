import {
  appProxyObservationSchema,
  assertFreshAppProxyTimestamp,
} from "@weletic/contracts/shopify";
import { weleticApiJson } from "./weletic-api.server";

const observationAttempts = new Map<
  string,
  { retryAt: number; inFlight?: Promise<void> }
>();
const OBSERVATION_TIMEOUT_MS = 1_500;
const OBSERVATION_RETRY_MS = 1_000;
const OBSERVATION_SUCCESS_COOLDOWN_MS = 5_000;
const MAX_OBSERVATION_ATTEMPTS = 512;

/** Call only AFTER Shopify SDK signature verification. Never infer identity from body JSON. */
export async function recordVerifiedAppProxyRoute(
  request: Request,
  sessionShop: string | undefined,
) {
  const params = new URL(request.url).searchParams;
  for (const key of ["shop", "path_prefix", "timestamp", "signature"])
    if (params.getAll(key).length !== 1)
      throw new Response("Ambiguous proxy identity", { status: 400 });
  const timestamp = params.get("timestamp")!;
  if (!/^[1-9][0-9]{0,10}$/.test(timestamp))
    throw new Response("Invalid proxy timestamp", { status: 400 });
  const input = appProxyObservationSchema.parse({
    shop: params.get("shop"),
    appId: process.env.SHOPIFY_API_KEY,
    pathPrefix: params.get("path_prefix"),
    timestamp: Number(timestamp),
  });
  if (!sessionShop || sessionShop !== input.shop)
    throw new Response("Proxy identity mismatch", { status: 401 });
  assertFreshAppProxyTimestamp(input.timestamp, new Date());
  const key = `${input.appId}\n${input.shop}\n${input.pathPrefix}`;
  const now = Date.now();
  for (const [cachedKey, cached] of observationAttempts) {
    if (!cached.inFlight && cached.retryAt <= now)
      observationAttempts.delete(cachedKey);
  }
  const existing = observationAttempts.get(key);
  if (existing?.retryAt && existing.retryAt > Date.now()) return;
  if (existing?.inFlight) return existing.inFlight;
  // Never evict an in-flight or cooldown entry: that would let duplicate
  // storefront requests bypass deduplication. If full, defer this observation;
  // a later request can retry after an entry expires.
  if (observationAttempts.size >= MAX_OBSERVATION_ATTEMPTS) return;

  let task: Promise<void>;
  task = weleticApiJson("/api/internal/shopify/installation/proxy-route", {
    method: "POST",
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(OBSERVATION_TIMEOUT_MS),
  })
    .then(() => {
      const current = observationAttempts.get(key);
      if (current?.inFlight === task)
        observationAttempts.set(key, {
          retryAt: Date.now() + OBSERVATION_SUCCESS_COOLDOWN_MS,
        });
    })
    .catch(() => {
      const current = observationAttempts.get(key);
      if (current?.inFlight === task)
        observationAttempts.set(key, {
          retryAt: Date.now() + OBSERVATION_RETRY_MS,
        });
    });
  observationAttempts.set(key, { retryAt: 0, inFlight: task });
  await task;
}
