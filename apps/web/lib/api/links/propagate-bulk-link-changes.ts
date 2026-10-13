import { recordLink } from "@/lib/tinybird/record-link";
import { evictLinksBatchFromKv } from "@/lib/weletic/link-kv-cache";
import { linkCache } from "./cache";
import { ExpandedLink } from "./utils/transform-link";

export async function propagateBulkLinkChanges({
  links,
  skipRedisCache = false,
}: {
  links: ExpandedLink[];
  skipRedisCache?: boolean;
}) {
  return await Promise.all([
    // update Redis cache
    !skipRedisCache && linkCache.mset(links),
    // ensure KV cache is evicted for all modified links in batch
    evictLinksBatchFromKv(
      links.map((link) => ({ domain: link.domain, key: link.key })),
    ),
    // update Tinybird
    recordLink(links),
  ]);
}
