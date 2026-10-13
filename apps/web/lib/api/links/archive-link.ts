import { prisma } from "@/lib/prisma";
import { evictLinkFromKv } from "@/lib/weletic/link-kv-cache";
import { waitUntil } from "@vercel/functions";
import { linkCache } from "./cache";

export async function archiveLink({
  linkId,
  archived,
}: {
  linkId: string;
  archived: boolean;
}) {
  const link = await prisma.link.update({
    where: {
      id: linkId,
    },
    data: {
      archived,
    },
  });

  if (link) {
    const invalidations = Promise.allSettled([
      linkCache.invalidateMany([{ domain: link.domain, key: link.key }]),
      evictLinkFromKv({ domain: link.domain, key: link.key }),
    ]);

    try {
      waitUntil(invalidations);
    } catch {
      await invalidations;
    }
  }

  return link;
}
