import { Prisma } from "@prisma/client";
import {
  addRetentionDays,
  getShopifyFinancialRetentionDays,
} from "./compliance-config";

/** Caller must provide an interactive transaction. Primary-key candidate locks
 * skip lifecycle-owned rows, avoiding secondary-index lock-order inversion.
 * Privacy-only cleanup never removes a mapping or reopens admission.
 */
export async function deleteExpiredPendingInstallations(
  tx: Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">,
  { batchSize = 50, now = new Date() }: { batchSize?: number; now?: Date } = {},
) {
  if (!Number.isFinite(batchSize) || !Number.isFinite(now.getTime()))
    throw new Error("Invalid pending installation retention parameters");
  const take = Math.min(100, Math.max(1, Math.trunc(batchSize)));
  const cutoff = addRetentionDays(now, -getShopifyFinancialRetentionDays());
  // Raw deletion avoids Prisma's emulated relation traversal. Redaction has
  // already erased mapping audits; fail closed if that invariant is broken.
  // Stored expiry never grows, and a shorter current policy takes effect now.
  const eligible = Prisma.sql`state = 'redacted'
      AND mappedStoreId IS NULL AND installationGeneration IS NULL
      AND authenticatedAt IS NULL AND uninstalledAt IS NULL
      AND redactedAt IS NOT NULL AND redactedAt <= ${now}
      AND expiresAt IS NOT NULL
      AND (expiresAt <= ${now} OR redactedAt <= ${cutoff})
      AND NOT EXISTS (
        SELECT 1 FROM WeleticShopifyPendingInstallationChange AS audit
        WHERE audit.pendingInstallationId = WeleticShopifyPendingInstallation.id
      )`;
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyPendingInstallation FORCE INDEX (PRIMARY)
    WHERE ${eligible}
    ORDER BY id ASC LIMIT ${take} FOR UPDATE SKIP LOCKED
  `);
  if (!rows.length) return 0;
  return tx.$executeRaw(Prisma.sql`
    DELETE FROM WeleticShopifyPendingInstallation
    WHERE id IN (${Prisma.join(rows.map(({ id }) => id))}) AND ${eligible}
  `);
}
