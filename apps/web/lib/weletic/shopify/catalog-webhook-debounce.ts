import { qstash } from "@/lib/cron";
import { redis } from "@/lib/upstash";
import { createWeleticId } from "@/lib/weletic/ids";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";

const RELEASE_CATALOG_DEBOUNCE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

export async function enqueueDebouncedShopifyCatalogSync({
  workspaceId,
  webhookId,
}: {
  workspaceId: string;
  webhookId: string;
}) {
  const debounceKey = `weletic:shopify:sync-debounced:${workspaceId}`;
  const reservation = createWeleticId("whook_");
  const isFirstInBurst = await redis.set(debounceKey, reservation, {
    nx: true,
    ex: 20,
  });
  if (!isFirstInBurst) return false;

  try {
    await qstash.publishJSON({
      url: `${APP_DOMAIN_WITH_NGROK}/api/cron/weletic/shopify/sync`,
      body: { workspaceId },
      retries: 3,
      // A retry after an uncertain publish response is safe: QStash retains
      // this provider-side idempotency key even if the Redis reservation is
      // released so the webhook can retry a definite transport failure.
      deduplicationId: `weletic-shopify-catalog:${workspaceId}:${webhookId}`,
    });
    return true;
  } catch (error) {
    await redis
      .eval(RELEASE_CATALOG_DEBOUNCE_SCRIPT, [debounceKey], [reservation])
      .catch(() => undefined);
    throw error;
  }
}
