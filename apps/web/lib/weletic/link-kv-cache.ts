/**
 * Link KV Cache Eviction and Synchronization Utility
 *
 * Enforces Invariant 2 (Soft-Delete Coherence) by ensuring Cloudflare KV
 * entries are immediately purged or tombstoned when links are disabled or deleted.
 */

export interface EvictLinkOptions {
  domain: string;
  key: string;
  accountId?: string;
  apiToken?: string;
  namespaceId?: string;
}

export interface LinkIdentity {
  domain: string;
  key: string;
}

/**
 * Builds canonical KV lookup key: link:${domain}:${key.toLowerCase()}
 */
export function buildKvKey(domain: string, key: string): string {
  const cleanDomain = domain
    .replace(/^www\./, "")
    .split(":")[0]
    .toLowerCase();
  return `link:${cleanDomain}:${key.toLowerCase()}`;
}

/**
 * Evicts a single link key from Cloudflare KV.
 * 1. Uses native worker binding (globalThis.LINKS_KV) if present.
 * 2. Falls back to Cloudflare KV REST API if credentials are provided in env.
 */
export async function evictLinkFromKv(
  options: EvictLinkOptions,
): Promise<boolean> {
  const { domain, key } = options;
  if (!domain || !key) return false;

  const kvKey = buildKvKey(domain, key);

  // 1. Native Cloudflare Worker Binding
  const kv = (globalThis as any).LINKS_KV;
  if (kv && typeof kv.delete === "function") {
    try {
      await kv.delete(kvKey);
      return true;
    } catch (err) {
      console.warn(
        `[link-kv-cache] Failed to delete KV key ${kvKey} via worker binding:`,
        err,
      );
    }
  }

  // 2. Cloudflare REST API Fallback (for Node.js / Vercel runtime)
  const accountId =
    options.accountId ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    process.env.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID;
  const apiToken =
    options.apiToken ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CLOUDFLARE_WORKERS_API_TOKEN;
  const namespaceId =
    options.namespaceId ||
    process.env.CLOUDFLARE_LINKS_KV_NAMESPACE_ID ||
    process.env.CLOUDFLARE_LINKS_KV_ID ||
    process.env.LINKS_KV_NAMESPACE_ID ||
    "weletic-links-kv-prod";

  if (accountId && apiToken && namespaceId) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(kvKey)}`;
      const res = await fetch(url, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${apiToken}`,
        },
      });
      return res.ok;
    } catch (err) {
      console.warn(
        `[link-kv-cache] Failed to delete KV key ${kvKey} via REST API:`,
        err,
      );
    }
  }

  return false;
}

/**
 * Batch-evicts multiple links from Cloudflare KV.
 */
export async function evictLinksBatchFromKv(
  links: LinkIdentity[],
  options?: { accountId?: string; apiToken?: string; namespaceId?: string },
): Promise<{ evictedCount: number }> {
  if (!links || links.length === 0) return { evictedCount: 0 };

  const kvKeys = Array.from(
    new Set(links.map((l) => buildKvKey(l.domain, l.key))),
  );

  // 1. Native Worker Binding
  const kv = (globalThis as any).LINKS_KV;
  if (kv && typeof kv.delete === "function") {
    try {
      await Promise.allSettled(kvKeys.map((k) => kv.delete(k)));
      return { evictedCount: kvKeys.length };
    } catch (err) {
      console.warn(
        "[link-kv-cache] Failed batch KV delete via worker binding:",
        err,
      );
    }
  }

  // 2. Cloudflare REST API Bulk Delete
  const accountId =
    options?.accountId ||
    process.env.CLOUDFLARE_ACCOUNT_ID ||
    process.env.NEXT_PUBLIC_CLOUDFLARE_ACCOUNT_ID;
  const apiToken =
    options?.apiToken ||
    process.env.CLOUDFLARE_API_TOKEN ||
    process.env.CLOUDFLARE_WORKERS_API_TOKEN;
  const namespaceId =
    options?.namespaceId ||
    process.env.CLOUDFLARE_LINKS_KV_NAMESPACE_ID ||
    process.env.CLOUDFLARE_LINKS_KV_ID ||
    process.env.LINKS_KV_NAMESPACE_ID ||
    "weletic-links-kv-prod";

  if (accountId && apiToken && namespaceId) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/bulk/delete`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(kvKeys),
      });
      if (res.ok) {
        return { evictedCount: kvKeys.length };
      }
    } catch (err) {
      console.warn("[link-kv-cache] Failed bulk delete via REST API:", err);
    }
  }

  return { evictedCount: 0 };
}

/**
 * Sets a tombstone entry in KV for a soft-deleted link.
 * Allows edge redirector to return HTTP 404 in <15ms without querying D1.
 */
export async function tombstoneLinkInKv(
  link: { domain: string; key: string; disabledAt?: string | Date | null },
  ttlSeconds: number = 300,
): Promise<boolean> {
  const kvKey = buildKvKey(link.domain, link.key);
  const disabledAtStr =
    typeof link.disabledAt === "string"
      ? link.disabledAt
      : link.disabledAt instanceof Date
        ? link.disabledAt.toISOString()
        : new Date().toISOString();

  const tombstonePayload = JSON.stringify({
    id: `tombstone_${Date.now()}`,
    projectId: "",
    url: "",
    disabledAt: disabledAtStr,
  });

  const kv = (globalThis as any).LINKS_KV;
  if (kv && typeof kv.put === "function") {
    try {
      await kv.put(kvKey, tombstonePayload, { expirationTtl: ttlSeconds });
      return true;
    } catch (err) {
      console.warn(
        `[link-kv-cache] Failed to put tombstone for ${kvKey}:`,
        err,
      );
    }
  }

  return false;
}
