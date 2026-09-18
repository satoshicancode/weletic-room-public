// Development full-catalog syncs can exceed Shopify's request budget. Keep the
// provider retry outstanding until the existing durable event claim completes.
// This is not a queue acknowledgement or a production worker substitute.
export const LOCAL_CATALOG_CLAIM_MS = 30 * 60_000;

export const catalogWebhookTopics = new Set([
  "products/create",
  "products/update",
  "products/delete",
  "markets/create",
  "markets/update",
  "markets/delete",
]);

export async function localCatalogWebhookResponse(
  processing: Promise<Response>,
  retain: (work: Promise<void>) => void,
): Promise<Response> {
  const retry = () =>
    new Response(
      "[Shopify] Local catalog completion is pending; retry later.",
      { status: 503, headers: { "Retry-After": "60" } },
    );
  // A bookkeeping failure must not become an unhandled background rejection or
  // a success acknowledgement. The durable received claim remains retryable.
  const settled = processing.catch(retry);
  retain(settled.then(() => undefined));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<Response>((resolve) => {
        timer = setTimeout(() => resolve(retry()), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
